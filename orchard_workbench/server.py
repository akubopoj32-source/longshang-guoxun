"""Run the local orchard workbench with Python's standard library."""

import argparse
import json
import os
import secrets
import sqlite3
import sys
import threading
import uuid
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from .extraction import ModelUnavailable, model_enabled
from .orchard import QUESTIONS, TASKS, apply_turn, evidence_alerts, new_record, pending_items, review, review_field


ROOT = Path(__file__).resolve().parent
ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
}
MAX_REQUEST = 6 * 1024 * 1024


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

    def record_response(self, record_id, record):
        return {"id": record_id, "record": record, "pending": pending_items(record),
                "evidence_alerts": evidence_alerts(record),
                "questions": [QUESTIONS[key] for key in record["questions"]]}

    def read_json(self):
        if self.headers.get_content_type() != "application/json":
            raise ValueError("请求格式应为 JSON。")
        size = int(self.headers.get("Content-Length", "0"))
        if not 0 < size <= MAX_REQUEST:
            raise ValueError("请求为空或文件过大。")
        data = json.loads(self.rfile.read(size))
        if not isinstance(data, dict):
            raise ValueError("请求格式不正确。")
        return data

    @contextmanager
    def database(self):
        with closing(sqlite3.connect(self.server.db_path)) as db, db:
            yield db

    def load(self, record_id):
        with self.database() as db:
            result = db.execute("SELECT data FROM records WHERE id = ?", (record_id,)).fetchone()
        return result[0] if result else None

    def stale_record(self):
        self.send_json(409, {"error": "记录已在其他页面更新，请刷新后重试。"})

    def list_records(self):
        with self.database() as db:
            rows = db.execute("""
            WITH summaries AS (
                SELECT id, rowid,
                       json_extract(data, '$.task') AS task,
                       json_extract(data, '$.fields.location.value') AS location,
                       json_extract(data, '$.status') AS status,
                       json_extract(data, '$.updated_at') AS updated_at,
                       json_extract(data, '$.turns[#-1].time') AS last_turn,
                       json_extract(data, '$.reviews[#-1].time') AS last_review
                FROM records
            )
            SELECT id, task, location, status,
                   COALESCE(updated_at, CASE
                       WHEN COALESCE(julianday(last_review), 0) >= COALESCE(julianday(last_turn), 0)
                       THEN COALESCE(last_review, last_turn)
                       ELSE last_turn
                   END) AS activity_at
            FROM summaries
            ORDER BY julianday(activity_at) DESC, rowid DESC
            """).fetchall()
        return [{"id": record_id, "task": task, "location": location,
                 "status": status, "activity_at": activity_at}
                for record_id, task, location, status, activity_at in rows]

    def do_GET(self):
        if not self.authorized():
            return
        path = urlsplit(self.path).path
        if path in ASSETS:
            filename, mime = ASSETS[path]
            self.send_content(200, (ROOT / "web" / filename).read_bytes(), mime)
        elif path == "/api/config":
            self.send_json(200, {"tasks": TASKS, "mode": "model" if model_enabled() else "demo"})
        elif path == "/api/health":
            self.send_json(200, {"status": "ok"})
        elif path == "/api/records":
            self.send_json(200, {"records": self.list_records()})
        elif path.startswith("/api/records/"):
            record_id = path.removeprefix("/api/records/")
            saved = self.load(record_id)
            if saved is None:
                self.send_json(404, {"error": "记录不存在。"})
            else:
                self.send_json(200, self.record_response(record_id, json.loads(saved)))
        else:
            self.send_json(404, {"error": "页面不存在。"})

    def do_POST(self):
        if not self.authorized():
            return
        path = urlsplit(self.path).path
        try:
            data = self.read_json()
            saved = None
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
                saved = self.load(record_id)
                if saved is None:
                    self.send_json(404, {"error": "记录不存在。"})
                    return
                record = json.loads(saved)
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
            encoded = json.dumps(record, ensure_ascii=False)
            with self.database() as db:
                if saved is None:
                    db.execute("INSERT INTO records(id, data) VALUES (?, ?)", (record_id, encoded))
                else:
                    changed = db.execute("UPDATE records SET data = ? WHERE id = ? AND data = ?",
                                         (encoded, record_id, saved)).rowcount
            if saved is not None and not changed:
                self.stale_record()
                return
            self.send_json(200, self.record_response(record_id, record))
        except ModelUnavailable as error:
            self.send_json(error.status, {"error": str(error), "code": "model_unavailable"})
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
        except (OSError, KeyError, IndexError, TypeError, AttributeError):
            self.send_json(502, {"error": "处理失败，当前记录未修改。请核对模型配置或稍后重试。"})


def main():
    parser = argparse.ArgumentParser(description="陇上果巡本地演示工作台")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", choices=("127.0.0.1", "0.0.0.0"), default="127.0.0.1")
    parser.add_argument("--db", type=Path, default=ROOT.parent / ".orchard" / "records.sqlite3")
    parser.add_argument("--exit-on-stdin-close", action="store_true")
    args = parser.parse_args()
    args.db.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(args.db)) as db, db:
        db.execute("CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
    try:
        with ThreadingHTTPServer((args.host, args.port), Workbench) as server:
            server.db_path = args.db
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
