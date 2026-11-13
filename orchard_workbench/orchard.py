"""Inspection record workflow and evidence rules."""

import base64
import re
from datetime import datetime

from .extraction import Extraction, extract_with_model, model_enabled


TASKS = {
    "trap": {"label": "诱捕监测", "fields": {
        "location": "监测点", "time": "观察时间", "observation": "现场观察",
        "quantity": "观察数量", "photo": "留图情况",
    }},
    "orchard": {"label": "果园异常", "fields": {
        "location": "地块", "time": "观察时间", "position": "地块内位置",
        "observation": "现场观察", "quantity": "影响范围", "photo": "留图情况",
    }},
}
QUESTIONS = {
    "location": "请补充或确认地块或监测点编号。",
    "time": "请补充或确认观察时间。",
    "position": "异常出现在地块内的什么位置？",
    "observation": "现场具体观察到了什么？请保留尚未确定的描述。",
    "quantity": "大概涉及多少？无法确认时可以回答「不知道」。",
    "photo": "有没有留照片？可上传照片，或说明未拍摄。",
    "photo_detail": "这张照片的细节或覆盖范围有限，能否补一张更清楚、能反映现场范围的照片？",
}
PHOTO_REPLY = re.compile(r"(?:无法|不能|不方便|没法|不便|暂时不|没有办法)(?:再)?(?:补拍|拍照|补图)")
UNKNOWN = re.compile(r"不知道|说不准|不清楚|无法确认|记不清|没数|未清点|不记得|没记|不确定")
CORRECTION = re.compile(r"说错了|更正|改成|实际上|应该是|而是|其实是")
HEDGED = re.compile(r"可能|大概|估计|也许|不确定")
COUNT_UNCERTAIN = re.compile(r"约|左右|上下|至少|至多|不到|不足|超过|将近|以上|以下|不是|并非|如果|假设|预计|"
                             r"(?:没(?:有)?|未)(?:能)?(?:看到|看见|发现|观察到)")
EXACT_TRAP_QUANTITY = re.compile(r"(?:[0-9]{1,3}|[零〇一二两三四五六七八九]|[一二两三四五六七八九]?十[一二三四五六七八九]?)\s*只")
POINT = re.compile(r"[零一二两三四五六七八九十百〇0-9]+\s*号\s*(?:诱捕监测点|诱捕点|监测点|点)")
PLOT = re.compile(r"[\u4e00-\u9fff]{0,6}?[零一二两三四五六七八九十百〇0-9]+\s*号\s*(?:地块|地)")
TIME = re.compile(r"(?:今天|昨天|前天|当天|\d{1,2}月\d{1,2}日)(?:早上|上午|中午|下午|傍晚|晚上|凌晨)?(?:\s*\d{1,2}(?:点|时)(?:半|\d{1,2}分)?)?|(?:早上|上午|中午|下午|傍晚|晚上|凌晨)(?:\s*\d{1,2}(?:点|时)(?:半|\d{1,2}分)?)?|\d{1,2}[:：]\d{2}")
QUANTITY = re.compile(r"(?:[零一二两三四五六七八九十百〇0-9]+|几|多)\s*(?:只|棵|株|处|片)")
NO_PHOTO = re.compile(r"没(?:有)?拍(?:照|摄)?|未拍(?:照|摄)?|没(?:有)?留图")
PHOTO_MENTION = re.compile(r"拍了(?:照|照片)?|已拍摄|有照片|有图")
POSITION = re.compile(r"靠路(?:边|一侧|入口)?|路边|入口(?:处)?|[东西南北]侧|边缘|中部")
OBSERVATION = re.compile(r"疑似|虫体|叶片|叶子|发黄|黄斑|枯萎|落果|异常|裂果|斑点")


def new_record(task):
    if task not in TASKS:
        raise ValueError("请选择有效的巡查任务。")
    return {
        "task": task, "version": 0, "status": "draft", "fields": {},
        "turns": [], "revisions": [], "reviews": [], "questions": [],
    }


def rule_candidates(record, message):
    candidates = []
    correction_pending = False
    for clause in re.split(r"[，。！？；,!?;\n]", message):
        clause = clause.strip()
        if not clause:
            continue
        corrected = correction_pending or bool(CORRECTION.search(clause))
        candidate_count = len(candidates)
        patterns = {"location": POINT if record["task"] == "trap" else PLOT,
                    "time": TIME, "quantity": QUANTITY}
        if record["task"] == "orchard":
            patterns["position"] = POSITION
        for field, pattern in patterns.items():
            matches = list(pattern.finditer(clause))
            if matches:
                values = [match.group().strip() for match in matches]
                value = values[-1] if corrected else " / ".join(dict.fromkeys(values))
                status = ("unknown" if field == "quantity" and value.startswith(("几", "多")) else
                          "conflict" if not corrected and (len(set(values)) > 1 or HEDGED.search(clause)) else
                          "recorded")
                candidates.append({"field": field, "value": value, "quote": clause,
                                   "status": status, "correction": corrected})
        if OBSERVATION.search(clause) and not re.search(r"没(?:有)?拍|未拍", clause):
            candidates.append({"field": "observation", "value": clause, "quote": clause,
                               "status": "recorded", "correction": corrected})
        if NO_PHOTO.search(clause) or PHOTO_MENTION.search(clause):
            candidates.append({"field": "photo", "value": "未拍摄" if NO_PHOTO.search(clause) else "巡查员称已拍摄",
                               "quote": clause, "status": "recorded", "correction": corrected})
        if UNKNOWN.search(clause):
            aliases = {"location": "地块|点位|监测点|几号", "time": "时间|几点|什么时候",
                       "position": "位置|在哪", "quantity": "数量|范围|多少|几只|几棵|没数|清点",
                       "photo": "照片|拍照|留图", "observation": "现象|异常表现"}
            fields = [key for key in TASKS[record["task"]]["fields"]
                      if re.search(aliases[key], clause)]
            if not fields and len(record["questions"]) == 1:
                fields = record["questions"]
            already = {item["field"] for item in candidates if item["quote"] == clause}
            for field in fields:
                if field not in already:
                    candidates.append({"field": field, "value": "未知", "quote": clause,
                                       "status": "unknown", "correction": False})
        correction_pending = corrected and len(candidates) == candidate_count
    return Extraction(candidates)


def validate_image(data):
    if not data:
        return ""
    if not isinstance(data, str):
        raise ValueError("图片格式不正确。")
    header, separator, content = data.partition(",")
    signatures = {"data:image/jpeg;base64": b"\xff\xd8\xff",
                  "data:image/png;base64": b"\x89PNG\r\n\x1a\n",
                  "data:image/webp;base64": b"RIFF"}
    if not separator or header not in signatures:
        raise ValueError("请上传 JPG、PNG 或 WebP 图片。")
    try:
        binary = base64.b64decode(content, validate=True)
    except ValueError as error:
        raise ValueError("无法读取图片。") from error
    if (len(binary) > 4 * 1024 * 1024 or not binary.startswith(signatures[header])
            or (header == "data:image/webp;base64" and binary[8:12] != b"WEBP")):
        raise ValueError("图片类型不符或超过 4 MB。")
    return data


def apply_candidate(record, candidate, message, turn):
    if not isinstance(candidate, dict):
        return False
    field, value, quote, status = (candidate.get(key) for key in ("field", "value", "quote", "status"))
    if not all(isinstance(item, str) for item in (field, value, quote, status)):
        return False
    if field not in TASKS[record["task"]]["fields"] or status not in {"recorded", "unknown", "conflict"}:
        return False
    if not quote.strip() or quote not in message or not value.strip() or len(value) > 500:
        return False
    if status == "recorded" and field != "photo" and value not in quote:
        return False
    before = record["fields"].get(field)
    correction = candidate.get("correction") is True and bool(CORRECTION.search(message))
    sources = [{"turn": turn, "quote": quote, "source": "text"}]
    if before and before["status"] in {"recorded", "conflict"} and not correction:
        if status == "unknown":
            return True
        if before["value"] != value or before["status"] == "conflict":
            value = " / ".join(dict.fromkeys([*before["value"].split(" / "), *value.split(" / ")]))
            status = "conflict"
        if not before.get("review_version"):
            sources = before["evidence"] + sources
    set_field(record, field, {"value": value, "status": status, "evidence": sources})
    return True


def recover_trap_quantity(record, message, turn):
    if (record["task"] != "trap" or UNKNOWN.search(message) or HEDGED.search(message)
            or COUNT_UNCERTAIN.search(message)):
        return
    candidates = [item for item in rule_candidates(record, message).updates if item["field"] == "quantity"]
    if len(candidates) != 1 or candidates[0]["status"] != "recorded":
        return
    candidate = candidates[0]
    value = candidate["value"]
    if not EXACT_TRAP_QUANTITY.fullmatch(value):
        return
    count = re.escape(value)
    if re.search(rf"(?:数量\s*(?:为|是|[:：])?\s*{count}|"
                 rf"(?:看到|看见|发现|观察到)\s*{count}\s*(?:疑似)?\s*(?:虫体|虫子))$", candidate["quote"]):
        apply_candidate(record, candidate, message, turn)


def set_field(record, field, current):
    before = record["fields"].get(field)
    if before == current:
        return
    record["fields"][field] = current
    record["revisions"].append({"version": record["version"], "field": field,
                                "before": before, "after": current})


def apply_turn(record, message, image="", extractor=None, *, rules_only=False):
    if not isinstance(message, str) or len(message) > 2000:
        raise ValueError("请输入不超过 2000 字的描述。")
    if record["status"] not in {"draft", "returned"}:
        raise ValueError("请先将记录退回补充。")
    message = message.strip()
    image = validate_image(image)
    if not message and not image:
        raise ValueError("请输入文字或上传图片。")
    if len(record["turns"]) >= 20:
        raise ValueError("单条记录最多支持 20 轮输入，请提交当前记录或新建记录。")
    if rules_only:
        result, mode = rule_candidates(record, message), "rules"
    elif extractor is not None:
        result, mode = extractor(record, message, image), "model"
        if isinstance(result, tuple):
            result = Extraction(*result)
    elif model_enabled():
        result, mode = extract_with_model(record, TASKS[record["task"]]["fields"], message, image), "model"
    else:
        result, mode = rule_candidates(record, message), "rules"
    quality = result.photo_quality if image and result.photo_quality in ("usable", "limited") else "unassessed"
    count = result.visible_count
    comparable = (record["task"] == "trap" and quality == "usable" and result.count_scope == "complete"
                  and type(count) is int and 0 <= count <= 999)
    record["version"] += 1
    turn = len(record["turns"]) + 1
    record["turns"].append({"id": turn, "message": message, "image": image,
                            "visual": result.visual[:600] if image and isinstance(result.visual, str) else "",
                            "photo_quality": quality, "extraction_mode": mode,
                            "visible_count": count if comparable else None,
                            "photo_unavailable": bool(PHOTO_REPLY.search(message)),
                            "time": datetime.now().astimezone().isoformat(timespec="seconds")})
    has_quantity = False
    for update in result.updates:
        if apply_candidate(record, update, message, turn) and update["field"] == "quantity":
            has_quantity = True
    if mode == "model" and not has_quantity:
        recover_trap_quantity(record, message, turn)
    if image:
        before = record["fields"].get("photo")
        if before and before["status"] == "recorded" and NO_PHOTO.search(message):
            set_field(record, "photo", {"value": "上传了图片，现场拍摄情况待核对", "status": "conflict",
                                        "evidence": before["evidence"] + [{"turn": turn, "source": "image"}]})
        else:
            set_field(record, "photo", {"value": "已附图片", "status": "recorded",
                                        "evidence": [{"turn": turn, "source": "image"}]})
    record["questions"] = next_questions(record)
    return record


def evidence_alerts(record):
    """Compare a definite trap count only with a complete photo from the same input."""
    quantity = record["fields"].get("quantity", {})
    if record["task"] != "trap" or quantity.get("status") != "recorded" or quantity.get("review_version"):
        return []
    match = re.fullmatch(r"(\d{1,3}|[零〇一二两三四五六七八九十])\s*只", quantity["value"])
    if not match:
        return []
    value = match[1]
    digits = dict(zip("零一二三四五六七八九", range(10))) | {"〇": 0, "两": 2, "十": 10}
    reported = int(value) if value.isdecimal() else digits[value]
    alerts = []
    for evidence in quantity["evidence"]:
        if HEDGED.search(evidence["quote"]) or re.search(r"约|左右|上下", evidence["quote"]):
            continue
        turn = record["turns"][evidence["turn"] - 1]
        visible = turn.get("visible_count")
        if visible is not None and reported != visible:
            alerts.append({"message": "口述数量与照片可见数量有差异，需人工核对",
                           "turn": turn["id"], "quote": evidence["quote"],
                           "reported": reported, "visible": visible})
    return alerts


def next_questions(record):
    missing = [key for key in TASKS[record["task"]]["fields"]
               if key not in record["fields"] or record["fields"][key]["status"] == "conflict"]
    latest_image = next((turn for turn in reversed(record["turns"]) if turn["image"]), None)
    if latest_image and latest_image.get("photo_quality") == "limited":
        unavailable = any(turn.get("photo_unavailable") for turn in record["turns"][latest_image["id"] - 1:])
        if not unavailable:
            missing.append("photo_detail")
    return missing[:1]


def review(record, action, note=""):
    if not isinstance(note, str) or len(note) > 500:
        raise ValueError("复核意见须为 500 字以内的文字。")
    transitions = {
        ("draft", "submit"): "pending", ("returned", "submit"): "pending",
        ("pending", "confirm"): "confirmed", ("pending", "return"): "returned",
        ("confirmed", "return"): "returned",
    }
    status = transitions.get((record["status"], action))
    if not status or not record["turns"]:
        raise ValueError("当前记录不能执行此操作。")
    record["status"] = status
    entry = {"version": record["version"], "action": action, "status": status,
             "time": datetime.now().astimezone().isoformat(timespec="seconds")}
    if note := note.strip():
        entry["note"] = note
    record["reviews"].append(entry)
    return record


def review_field(record, field, action, value="", note=""):
    if record["status"] != "pending":
        raise ValueError("请先将记录提交复核。")
    if not isinstance(field, str) or field not in TASKS[record["task"]]["fields"]:
        raise ValueError("请选择有效的复核字段。")
    if action not in ("confirm", "correct", "mark_unknown"):
        raise ValueError("请选择有效的字段复核操作。")
    if not isinstance(note, str) or len(note) > 500:
        raise ValueError("复核依据须为 500 字以内的文字。")
    note = note.strip()
    before = record["fields"].get(field)
    if action == "confirm":
        if not before or before["status"] != "recorded":
            raise ValueError("请填写确认后的值，或将这一项标记为待核实。")
        value, status = before["value"], "recorded"
    elif action == "correct":
        if not isinstance(value, str) or len(value) > 500 or not value.strip() or not note:
            raise ValueError("请填写更正值和更正依据，两项各不超过 500 字。")
        value, status = value.strip(), "recorded"
    else:
        value, status = "待现场核实", "unknown"

    alerts = evidence_alerts(record) if field == "quantity" else []
    record["version"] += 1
    version = record["version"]
    current = {"value": value, "status": status, "review_version": version,
               "evidence": before["evidence"] if before else []}
    set_field(record, field, current)
    record.setdefault("field_reviews", []).append({
        "version": version, "field": field, "action": action, "note": note,
        "before": before, "after": current, "alerts": alerts,
        "time": datetime.now().astimezone().isoformat(timespec="seconds"),
    })
    record["questions"] = next_questions(record)
    return record


def pending_items(record):
    fields = TASKS[record["task"]]["fields"]
    pending = [label for key, label in fields.items()
               if record["fields"].get(key, {}).get("status") != "recorded"]
    observation = record["fields"].get("observation", {}).get("value", "")
    if record["task"] == "trap" and ("疑似" in observation or "虫体" in observation):
        pending.append("虫体类别由人工核实")
    latest_image = next((turn for turn in reversed(record["turns"]) if turn["image"]), None)
    if latest_image and latest_image.get("photo_quality") == "limited":
        pending.append("图片细节或覆盖范围需人工核对")
    if alerts := evidence_alerts(record):
        pending.append(alerts[0]["message"])
    return pending
