"""Run the local orchard workbench with Python's standard library."""

import argparse
import json
import sqlite3
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from .orchard import QUESTIONS, TASKS, apply_turn, model_enabled, new_record, pending_items, review


ROOT = Path(__file__).resolve().parent
ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
}
MAX_REQUEST = 6 * 1024 * 1024


class Workbench(BaseHTTPRequestHandler):
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

    def load(self, record_id):
        result = self.server.db.execute("SELECT data FROM records WHERE id = ?", (record_id,)).fetchone()
        return json.loads(result[0]) if result else None

    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ASSETS:
            filename, mime = ASSETS[path]
            self.send_content(200, (ROOT / "web" / filename).read_bytes(), mime)
        elif path == "/api/config":
            self.send_json(200, {"tasks": TASKS, "mode": "model" if model_enabled() else "demo"})
        elif path.startswith("/api/records/"):
            record_id = path.removeprefix("/api/records/")
            record = self.load(record_id)
            if record is None:
                self.send_json(404, {"error": "记录不存在。"})
            else:
                self.send_json(200, self.record_response(record_id, record))
        else:
            self.send_json(404, {"error": "页面不存在。"})

    def do_POST(self):
        path = urlsplit(self.path).path
        try:
            data = self.read_json()
            if path == "/api/records":
                task = data.get("task")
                if not isinstance(task, str):
                    raise ValueError("请选择有效的巡查任务。")
                record_id, record = uuid.uuid4().hex, new_record(task)
            else:
                pieces = path.strip("/").split("/")
                if len(pieces) != 4 or pieces[:2] != ["api", "records"] or pieces[3] not in {"turn", "review"}:
                    self.send_json(404, {"error": "接口不存在。"})
                    return
                record_id, action = pieces[2:]
                record = self.load(record_id)
                if record is None:
                    self.send_json(404, {"error": "记录不存在。"})
                    return
                if data.get("version") != record["version"] or data.get("status") != record["status"]:
                    self.send_json(409, {"error": "记录已在其他页面更新，请刷新后重试。"})
                    return
                if action == "turn":
                    apply_turn(record, data.get("message", ""), data.get("image", ""))
                else:
                    operation = data.get("action")
                    if not isinstance(operation, str):
                        raise ValueError("请选择有效的复核操作。")
                    review(record, operation)
            with self.server.db:
                self.server.db.execute("INSERT OR REPLACE INTO records(id, data) VALUES (?, ?)",
                                       (record_id, json.dumps(record, ensure_ascii=False)))
            self.send_json(200, self.record_response(record_id, record))
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
        except (OSError, KeyError, IndexError, TypeError, AttributeError):
            self.send_json(502, {"error": "处理失败，当前记录未修改。请核对模型配置或稍后重试。"})


def main():
    parser = argparse.ArgumentParser(description="陇上果巡本地演示工作台")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--db", type=Path, default=ROOT.parent / ".orchard" / "records.sqlite3")
    args = parser.parse_args()
    args.db.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(args.db)
    try:
        db.execute("CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
        with HTTPServer(("127.0.0.1", args.port), Workbench) as server:
            server.db = db
            print(f"http://127.0.0.1:{server.server_port}", flush=True)
            server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        db.close()


if __name__ == "__main__":
    main()
