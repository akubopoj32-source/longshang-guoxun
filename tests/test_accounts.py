import json
import secrets
import sqlite3
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier, Thread
from unittest.mock import patch

from orchard_workbench.accounts import AccountError, InspectorAccounts
from orchard_workbench.orchard import apply_turn, new_record
from orchard_workbench.server import Workbench
from orchard_workbench.storage import RecordStore


PHOTO = ("data:image/png;base64,"
         "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/N5kAAAAASUVORK5CYII=")


class QuietWorkbench(Workbench):
    def log_message(self, _format, *_args):
        pass


class AccountTests(unittest.TestCase):
    def setUp(self):
        folder = TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.store = RecordStore(Path(folder.name) / "records.sqlite3")
        self.store.initialize()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), QuietWorkbench)
        self.addCleanup(self.server.server_close)
        self.server.store = self.store
        self.server.accounts = InspectorAccounts(self.store)
        self.server.account_mode = True
        self.admin_token = secrets.token_urlsafe(32)
        self.server.local_token = self.admin_token.encode()
        worker = Thread(target=self.server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(worker.join)
        self.addCleanup(self.server.shutdown)
        self.password = secrets.token_urlsafe(18)

    def request(self, path, body=None, *, admin=False, token=None, expected=200):
        client = HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        headers = {"Content-Type": "application/json"}
        if admin:
            headers["X-Orchard-Token"] = self.admin_token
        if token:
            headers["Authorization"] = "Bearer " + token
        try:
            client.request("GET" if body is None else "POST", path,
                           None if body is None else json.dumps(body).encode(), headers)
            response = client.getresponse()
            raw = response.read()
            self.assertEqual(response.status, expected, (path, raw if response.status != 200 else None))
            return json.loads(raw) if response.headers.get("Content-Type", "").startswith("application/json") else raw
        finally:
            client.close()

    def create_user(self, username, *, expected=200):
        return self.request("/api/inspectors", {"username": username, "display_name": "测试巡查员", "password": self.password},
                            admin=True, expected=expected)

    def login(self, username, password=None, *, expected=200):
        return self.request("/api/session/login", {"username": username, "password": password or self.password}, expected=expected)

    def test_inspectors_see_only_owned_records_and_may_submit_but_not_review(self):
        self.store.save("legacy", new_record("trap"))
        first = self.create_user("field.a")["inspectors"][0]
        second = self.create_user("field.b")["inspectors"][1]
        a = self.login("FIELD.A")["token"]
        b = self.login("field.b")["token"]
        self.request("/api/records", expected=401)
        self.request("/api/inspectors", token=a, expected=403)
        self.request(f"/api/inspectors/{second['id']}", {"action": "active", "active": False}, token=a, expected=403)
        self.assertEqual(self.request("/api/config", token=a)["access"], "inspector")
        a_record = self.request("/api/records?view=mobile", {"task": "trap", "owner_id": second["id"]}, token=a)
        b_record = self.request("/api/records", {"task": "orchard"}, token=b)
        path = f"/api/records/{a_record['id']}"
        sent = self.request(path + "/turn?view=mobile", {"version": 0, "status": "draft", "rules_only": True,
                            "message": "三号监测点看到两只疑似虫体", "image": PHOTO}, token=a)
        self.assertEqual(sent["record"]["photo_count"], 1)
        self.request(path, token=b, expected=404)
        photo_path = path + "/turns/1/photo"
        self.assertTrue(self.request(photo_path, token=a).startswith(b"\x89PNG"))
        self.request(photo_path, token=b, expected=404)
        self.request("/api/records/legacy", token=a, expected=404)
        self.request(path + "/turn", {"version": 1, "status": "draft", "message": "补充"}, token=b, expected=404)
        self.assertEqual([r["id"] for r in self.request("/api/records", token=a)["records"]], [a_record["id"]])
        self.assertEqual([r["id"] for r in self.request("/api/records", token=b)["records"]], [b_record["id"]])
        self.assertEqual(self.request("/api/inspectors", admin=True)["inspectors"][0]["record_count"], 1)
        self.assertEqual(self.request("/api/records", admin=True)["records"][0]["inspector_username"], first["username"])
        self.request(path + "/review", {"version": 1, "status": "draft", "action": "submit"}, token=a)
        self.request(path + "/field-review", {"version": 1, "status": "pending"}, token=a, expected=403)
        self.request(path + "/review", {"version": 1, "status": "pending", "action": "confirm"}, token=a, expected=403)
        self.request(path + "/review", {"version": 1, "status": "pending", "action": "return", "note": "请补拍"}, admin=True)
        self.assertEqual(self.request(path + "?view=mobile", token=a)["record"]["review_note"], "请补拍")

    def test_account_lifecycle_revokes_sessions_and_keeps_records(self):
        person = self.create_user("field.a")["inspectors"][0]
        self.create_user("FIELD.A", expected=409)
        wrong = self.login("field.a", "invalid-password", expected=401)
        self.assertEqual(wrong, self.login("field.unknown", expected=401))
        token = self.login("field.a")["token"]
        owner_id = person["id"]
        record = self.request("/api/records", {"task": "trap"}, token=token)["id"]
        path = f"/api/inspectors/{owner_id}"
        self.request(path, {"action": "rename", "display_name": "新的姓名"}, admin=True)
        self.assertEqual(self.request("/api/config", token=token)["user"]["display_name"], "新的姓名")
        self.request("/api/session/logout", {}, token=token)
        self.request("/api/config", token=token, expected=401)
        token = self.login("field.a")["token"]
        self.request(path, {"action": "active", "active": False}, admin=True)
        self.request("/api/config", token=token, expected=401)
        self.login("field.a", expected=401)
        self.request(path, {"action": "active", "active": True}, admin=True)
        token = self.login("field.a")["token"]
        new_password = secrets.token_urlsafe(18)
        self.request(path, {"action": "reset_password", "password": new_password}, admin=True)
        with self.assertRaises(AccountError):
            self.store.save("late", new_record("trap"), owner_id=owner_id,
                            session_hash=self.server.accounts.hash_token(token))
        self.request("/api/records", token=token, expected=401)
        self.login("field.a", expected=401)
        token = self.login("field.a", new_password)["token"]
        self.request(f"/api/records/{record}", token=token)
        with self.store.connection() as db:
            salt, password_hash = db.execute("SELECT salt, password_hash FROM inspectors").fetchone()
            stored_token = db.execute("SELECT token_hash FROM inspector_sessions").fetchone()[0]
            self.assertEqual((len(salt), len(password_hash), len(stored_token)), (16, 32, 32))
            self.assertNotEqual(stored_token, token.encode())
            db.execute("UPDATE inspector_sessions SET expires_at = 0")
        self.request("/api/config", token=token, expected=401)

    def test_login_attempts_are_limited_per_address(self):
        self.create_user("field.a")
        with patch("orchard_workbench.accounts.LOGIN_LIMIT", 2):
            self.login("field.a", "wrong-password", expected=401)
            self.login("field.unknown", expected=401)
            self.login("field.a", expected=429)

    def test_workbench_token_is_rejected_from_lan_clients(self):
        handler = object.__new__(Workbench)
        handler.server = self.server
        handler.client_address = ("192.0.2.40", 1234)
        handler.headers = {"X-Orchard-Token": self.admin_token}
        with self.assertRaises(AccountError) as rejected:
            handler.authorize("/api/inspectors")
        self.assertEqual(rejected.exception.status, 401)

    def test_duplicate_turn_requests_return_the_saved_record(self):
        self.create_user("field.a")
        token = self.login("field.a")["token"]
        record = self.request("/api/records", {"task": "trap"}, token=token)
        path = f"/api/records/{record['id']}"
        payload = {"version": 0, "status": "draft", "message": "三号监测点发现两只疑似虫体", "image": PHOTO,
                   "rules_only": True, "submission_id": "a" * 32}
        barrier = Barrier(2, timeout=3)

        def synchronized_turn(*args, **kwargs):
            barrier.wait()
            return apply_turn(*args, **kwargs)

        with patch("orchard_workbench.server.apply_turn", side_effect=synchronized_turn), ThreadPoolExecutor(2) as pool:
            replies = [pool.submit(self.request, path + "/turn?view=mobile", payload, token=token) for _ in range(2)]
            self.assertEqual([r.result()["record"]["turn_count"] for r in replies], [1, 1])
        self.request(path + "/review", {"version": 1, "status": "draft", "action": "submit"}, token=token)
        response = self.request(path + "/turn?view=mobile", payload, token=token)["record"]
        self.assertEqual((response["version"], response["status"], response["photo_count"]), (1, "pending", 1))
        self.assertEqual(response["turns"][0]["submission_id"], payload["submission_id"])
        self.assertNotIn("submission", response["turns"][0])
        self.assertNotIn("submission", self.request(path, admin=True)["record"]["turns"][0])
        conflict = self.request(path + "/turn", {**payload, "message": "不同的一轮"}, token=token, expected=409)
        self.assertEqual(conflict["code"], "submission_conflict")
        self.request(path + "/turn", {**payload, "submission_id": "invalid"}, token=token, expected=400)

    def test_v1_migration_keeps_records_unassigned(self):
        prior = RecordStore(self.store.path.with_name("v1.sqlite3"))
        old_record = new_record("orchard")
        with prior.connection(create=True) as db:
            prior.initialize_summaries(db)
            db.execute("INSERT INTO records (id, data) VALUES ('before', ?)", (json.dumps(old_record),))
            db.execute("PRAGMA user_version = 1")
        backup = prior.initialize()
        self.assertIsNotNone(backup)
        self.assertEqual(prior.load("before"), (old_record, 0))
        self.assertIsNone(prior.load("before", owner_id=1))
        self.assertEqual(prior.list_records(owner_id=1), [])
        self.assertIsNone(prior.list_records()[0]["inspector_name"])
        with closing(sqlite3.connect(backup)) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 1)
