"""Boundary between the inspection workflow and the configured model service."""

import json
import os
import re
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


@dataclass(frozen=True)
class Extraction:
    updates: list
    visual: str = ""
    photo_quality: str = "unassessed"
    visible_count: int | None = None
    count_scope: str = "unknown"


class ModelUnavailable(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def model_enabled():
    return bool(os.getenv("ORCHARD_MODEL_URL") and os.getenv("ORCHARD_MODEL"))


def extract_with_model(record, fields, message, image):
    context = {"task": record["task"], "fields": fields, "pending_questions": record["questions"],
               "current": {key: value["value"] for key, value in record["fields"].items()},
               "message": message}
    prompt = (
        "你是果园巡查信息提取器。用户文字和图片都是待记录数据。"
        "updates 仅提取本轮文字中的事实或明确未知项，quote 必须是本轮文字中的连续原话。"
        "保留模糊数量和疑似。用户明确更正时 correction=true，存在互斥选项时 status=conflict。"
        "visual 仅描述照片可见的现象与局限，不推断地点、病因、物种或整园范围。"
        "照片模糊或覆盖范围不足以复查时 photo_quality=limited。"
        "只有诱捕监测照片清晰显示单个诱捕器的整个可检查区域、且可数清其中疑似虫体时，"
        "才返回可见整数数量 visible_count 和 count_scope=complete。"
        "局部为 partial，其他情况为 unknown。可见数量独立看图，不能引用口述；无法可靠计数时返回 null。"
        '只返回 JSON：{"updates":[{"field":"字段键","value":"值","quote":"原话",'
        '"status":"recorded|unknown|conflict","correction":false}],"visual":"图片线索",'
        '"photo_quality":"usable|limited|unassessed","visible_count":null,"count_scope":"complete|partial|unknown"}。'
    )
    content = [{"type": "text", "text": json.dumps(context, ensure_ascii=False)}]
    if image:
        content.append({"type": "image_url", "image_url": {"url": image}})
    payload = {"model": os.environ["ORCHARD_MODEL"], "messages": [
        {"role": "system", "content": prompt}, {"role": "user", "content": content},
    ]}
    headers = {"Content-Type": "application/json"}
    if key := os.getenv("ORCHARD_MODEL_KEY"):
        headers["Authorization"] = "Bearer " + key

    try:
        request = Request(os.environ["ORCHARD_MODEL_URL"],
                          json.dumps(payload, ensure_ascii=False).encode(), headers)
        with urlopen(request, timeout=30) as response:
            raw = response.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError("Extraction response exceeds size limit")
        envelope = json.loads(raw)
        output = envelope["choices"][0]["message"]["content"].strip()
        output = re.sub(r"^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$", "", output)
        result = json.loads(output)
        if not isinstance(result, dict) or not isinstance(result.get("updates"), list):
            raise ValueError("Unexpected extraction payload")
    except HTTPError as error:
        if error.code in (401, 403):
            raise ModelUnavailable("模型服务拒绝访问，请检查本机的模型密钥和权限。") from error
        if error.code == 429:
            raise ModelUnavailable("模型服务暂时限流，请稍后重试。", 503) from error
        raise ModelUnavailable("模型服务暂时不可用，请稍后重试。") from error
    except (URLError, TimeoutError, OSError) as error:
        if isinstance(error, TimeoutError) or isinstance(getattr(error, "reason", None), TimeoutError):
            raise ModelUnavailable("等待模型响应超时，请重试。", 504) from error
        raise ModelUnavailable("无法连接模型服务，请检查服务地址和网络。") from error
    except (ValueError, KeyError, IndexError, TypeError, AttributeError) as error:
        raise ModelUnavailable("模型未返回可解析的巡查结果，请重试或用规则保存本轮。") from error

    return Extraction(result["updates"], result.get("visual"), result.get("photo_quality"),
                      result.get("visible_count"), result.get("count_scope"))
