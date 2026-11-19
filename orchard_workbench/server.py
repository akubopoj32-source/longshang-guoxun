"""Run the local orchard workbench with Python's standard library."""

import argparse
import base64
import json
import os
import secrets
import sqlite3
import sys
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .extraction import ModelUnavailable, model_enabled
from .knowledge import answer_question, source_url
from .orchard import QUESTIONS, TASKS, apply_turn, evidence_alerts, new_record, pending_items, review, review_field
from .storage import RecordStore
from .voice import MAX_AUDIO_BYTES, transcribe, transcription_enabled


ROOT = Path(__file__).resolve().parent
ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
}
MAX_REQUEST = 6 * 1024 * 1024
MAX_TRANSCRIBE_REQUEST = ((MAX_AUDIO_BYTES + 2) // 3) * 4 + 4096


class Workbench(BaseHTTPRequestHandler):
    def authorized(self):
        token = self.server.local_token
        supplied = self.headers.get("X-Orchard-Token", "").encode()
        if not token or secrets.compare_digest(supplied, token):
            return True
        self.send_json(403, {"error": "当前请求没有工作台访问权限。"})
        return False

    def send_content(self, status, content, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; img-src 'self' data: blob:; "
                         "object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(content)

    def send_json(self, status, data):
        self.send_content(status, json.dumps(data, ensure_ascii=False).encode(),
                          "application/json; charset=utf-8")

    def mobile_record(self, record):
        """Trim a record for the mini program: keep the evidence chain, drop bulk."""
        latest_review = record["reviews"][-1] if record["reviews"] else {}
        alerts = evidence_alerts(record)
        return {
            "task": record["task"], "version": record["version"], "status": record["status"],
            "fields": {key: {"value": field["value"], "status": field["status"],
                             "review_version": field.get("review_version"),
                             "evidence": field.get("evidence", [])}
                       for key, field in record["fields"].items()},
            "turns": [{
                "id": turn["id"], "message": turn["message"], "has_image": bool(turn.get("image")),
                "visual": turn.get("visual", ""), "photo_quality": turn.get("photo_quality", "unassessed"),
                "extraction_mode": turn.get("extraction_mode"), "visible_count": turn.get("visible_count"),
                "photo_unavailable": turn.get("photo_unavailable", False), "time": turn.get("time"),
            } for turn in record["turns"]],
            "revisions": record["revisions"],
            "reviews": record["reviews"],
            "field_reviews": [
                {"version": entry["version"], "field": entry["field"], "action": entry["action"],
                 "note": entry["note"], "before": entry["before"], "after": entry["after"],
                 "alerts": entry["alerts"], "time": entry["time"]}
                for entry in record.get("field_reviews", [])
            ],
            "turn_count": len(record["turns"]),
            "photo_count": sum(bool(turn["image"]) for turn in record["turns"]),
            "review_note": latest_review.get("note", ""),
            "evidence_alerts": alerts,
        }

    def record_response(self, record_id, record):
        response = {"id": record_id, "record": record, "pending": pending_items(record),
                    "questions": [QUESTIONS[key] for key in record["questions"]]}
        if urlsplit(self.path).query == "view=mobile":
            response["record"] = self.mobile_record(record)
        else:
            response["evidence_alerts"] = evidence_alerts(record)
        return response

    def read_json(self, limit=MAX_REQUEST):
        if self.headers.get_content_type() != "application/json":
            raise ValueError("请求格式应为 JSON。")
        size = int(self.headers.get("Content-Length", "0"))
        if not 0 < size <= limit:
            raise ValueError("请求为空或文件过大。")
        data = json.loads(self.rfile.read(size))
        if not isinstance(data, dict):
            raise ValueError("请求格式不正确。")
        return data

    def stale_record(self):
        self.send_json(409, {"error": "记录已在其他页面更新，请刷新后重试。"})

    def database_error(self, error):
        code = getattr(error, "sqlite_errorcode", 0) & 0xFF
        # Python 3.10 exposes lock failures via the error message.
        if code in (5, 6) or str(error).startswith(("database is locked", "database table is locked", "database schema is locked")):
            self.send_json(503, {"error": "巡查数据库繁忙，请稍后重试。", "code": "database_busy"})
        else:
            self.log_error("Database error: %s", error)
            self.send_json(500, {"error": "巡查数据库无法访问，请检查存储后重试。", "code": "database_unavailable"})

    def do_GET(self):
        if not self.authorized():
            return
        try:
            self.get_resource()
        except sqlite3.Error as error:
            self.database_error(error)

    def get_resource(self):
        target = urlsplit(self.path)
        path = target.path
        if path in ASSETS:
            filename, mime = ASSETS[path]
            self.send_content(200, (ROOT / "web" / filename).read_bytes(), mime)
        elif path == "/api/config":
            self.send_json(200, {
                "tasks": TASKS,
                "mode": "model" if model_enabled() else "demo",
                "voice": transcription_enabled(),
            })
        elif path == "/api/health":
            self.server.store.check()
            self.send_json(200, {"status": "ok"})
        elif path == "/api/knowledge/source":
            ids = parse_qs(target.query).get("id", [])
            url = source_url(ids[0]) if len(ids) == 1 else None
            if url is None:
                self.send_json(404, {"error": "资料来源不存在。"})
                return
            self.send_response(302)
            self.send_header("Location", url)
            self.send_header("Content-Length", "0")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
        elif path == "/api/records":
            self.send_json(200, {"records": self.server.store.list_records()})
        elif path.startswith("/api/records/"):
            record_id, _, attachment = path.removeprefix("/api/records/").partition("/")
            saved = self.server.store.load(record_id)
            if saved is None:
                self.send_json(404, {"error": "记录不存在。"})
            elif attachment:
                self.send_record_photo(saved[0], attachment)
            else:
                self.send_json(200, self.record_response(record_id, saved[0]))
        else:
            self.send_json(404, {"error": "页面不存在。"})

    def send_record_photo(self, record, attachment):
        parts = attachment.split("/")
        if len(parts) == 3 and parts[0] == "turns" and parts[2] == "photo":
            for turn in record["turns"]:
                if str(turn["id"]) == parts[1] and turn.get("image"):
                    header, _, payload = turn["image"].partition(",")
                    mime = {"data:image/jpeg;base64": "image/jpeg", "data:image/png;base64": "image/png",
                            "data:image/webp;base64": "image/webp"}.get(header)
                    if mime:
                        try:
                            content = base64.b64decode(payload, validate=True)
                        except ValueError:
                            break
                        self.send_content(200, content, mime)
                        return
        self.send_json(404, {"error": "原图不存在。"})

    def do_POST(self):
        if not self.authorized():
            return
        path = urlsplit(self.path).path
        try:
            data = self.read_json(MAX_TRANSCRIBE_REQUEST if path == "/api/transcribe" else MAX_REQUEST)
            if path == "/api/knowledge/ask":
                self.send_json(200, answer_question(data.get("question")))
                return
            if path == "/api/transcribe":
                # Stateless: transcription never touches the stored record.
                audio = data.get("audio", "")
                hint = data.get("hint", "")
                if not isinstance(hint, str):
                    raise ValueError("场景提示格式不正确。")
                transcript, _ = transcribe(audio, hint[:200])
                self.send_json(200, {"transcript": transcript})
                return
            write_version = None
            if path == "/api/records":
                task = data.get("task")
                if not isinstance(task, str):
                    raise ValueError("请选择有效的巡查任务。")
                record_id, record = uuid.uuid4().hex, new_record(task)
            else:
                pieces = path.strip("/").split("/")
                if len(pieces) != 4 or pieces[:2] != ["api", "records"] or pieces[3] not in {"turn", "review", "field-review"}:
                    self.send_json(404, {"error": "接口不存在。"})
                    return
                record_id, action = pieces[2:]
                saved = self.server.store.load(record_id)
                if saved is None:
                    self.send_json(404, {"error": "记录不存在。"})
                    return
                record, write_version = saved
                if data.get("version") != record["version"] or data.get("status") != record["status"]:
                    self.stale_record()
                    return
                if action == "turn":
                    rules_only = data.get("rules_only", False)
                    if not isinstance(rules_only, bool):
                        raise ValueError("本轮处理方式无效。")
                    apply_turn(record, data.get("message", ""), data.get("image", ""), rules_only=rules_only)
                elif action == "field-review":
                    review_field(record, data.get("field"), data.get("action"),
                                 data.get("value", ""), data.get("note", ""))
                else:
                    operation = data.get("action")
                    if not isinstance(operation, str):
                        raise ValueError("请选择有效的复核操作。")
                    review(record, operation, data.get("note", ""))
            record["updated_at"] = datetime.now(timezone.utc).isoformat()
            if not self.server.store.save(record_id, record, write_version):
                self.stale_record()
                return
            self.send_json(200, self.record_response(record_id, record))
        except ModelUnavailable as error:
            self.send_json(error.status, {"error": str(error), "code": "model_unavailable"})
        except sqlite3.Error as error:
            self.database_error(error)
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
        except (OSError, KeyError, IndexError, TypeError, AttributeError):
            self.send_json(502, {"error": "处理失败，当前记录未修改。请核对模型配置或稍后重试。"})


def main():
    parser = argparse.ArgumentParser(description="陇上果巡本地演示工作台")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", choices=("127.0.0.1", "0.0.0.0"), default="127.0.0.1")
    parser.add_argument("--db", type=Path, default=ROOT.parent / ".orchard" / "records.sqlite3")
    parser.add_argument("--backup", type=Path, help="将数据库备份到指定的新文件后退出")
    parser.add_argument("--exit-on-stdin-close", action="store_true")
    args = parser.parse_args()
    store = RecordStore(args.db)
    try:
        if args.backup:
            store.backup(args.backup)
            print(f"数据库备份已保存至 {args.backup}")
            return
        if backup := store.initialize():
            print(f"数据库已迁移，原库备份位于 {backup}", file=sys.stderr)
    except (OSError, sqlite3.Error) as error:
        parser.exit(1, f"巡查数据库无法初始化或备份：{error}\n")
    try:
        with ThreadingHTTPServer((args.host, args.port), Workbench) as server:
            server.store = store
            server.local_token = os.getenv("ORCHARD_LOCAL_TOKEN", "").encode()
            if args.exit_on_stdin_close:
                def stop_when_parent_exits():
                    sys.stdin.buffer.read()
                    server.shutdown()

                threading.Thread(target=stop_when_parent_exits, daemon=True).start()
            print(f"http://{args.host}:{server.server_port}", flush=True)
            server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
