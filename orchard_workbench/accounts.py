"""Inspector credentials and revocable sessions for the shared workbench."""

import hashlib
import re
import secrets
import sqlite3
from time import time


PASSWORD_ROUNDS = 600_000
SESSION_LIFETIME = 12 * 60 * 60
LOGIN_WINDOW = 60
LOGIN_LIMIT = 10
USERNAME = re.compile(r"[a-z0-9_.-]{3,32}")
SESSION_TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")
DUMMY_SALT = secrets.token_bytes(16)


class AccountError(Exception):
    def __init__(self, message, status, code):
        super().__init__(message)
        self.status = status
        self.code = code


def session_expired():
    return AccountError("登录已失效，请重新登录。", 401, "session_expired")


def initialize_accounts(db):
    db.execute("""CREATE TABLE inspectors (
        id INTEGER PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        salt BLOB NOT NULL,
        password_hash BLOB NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at INTEGER NOT NULL
    )""")
    db.execute("""CREATE TABLE inspector_sessions (
        token_hash BLOB PRIMARY KEY,
        inspector_id INTEGER NOT NULL REFERENCES inspectors(id),
        expires_at INTEGER NOT NULL
    )""")
    db.execute("CREATE INDEX inspector_session_owner ON inspector_sessions(inspector_id)")
    db.execute("CREATE INDEX inspector_session_expiry ON inspector_sessions(expires_at)")
    db.execute("""CREATE TABLE inspector_login_attempts (
        address TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL
    )""")
    db.execute("ALTER TABLE records ADD COLUMN owner_id INTEGER REFERENCES inspectors(id)")
    db.execute("CREATE INDEX records_owner ON records(owner_id)")


def _password_hash(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PASSWORD_ROUNDS)


def _new_password(password):
    if not isinstance(password, str) or not 10 <= len(password) <= 128 or not password.strip():
        raise ValueError("密码须为 10 至 128 个字符。")
    salt = secrets.token_bytes(16)
    return salt, _password_hash(password, salt)


def _display_name(value):
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 40 or not value.isprintable():
        raise ValueError("姓名须为 1 至 40 个可显示字符。")
    return value.strip()


def find_session(db, token_hash):
    return db.execute("""SELECT inspectors.id, username, display_name
        FROM inspector_sessions JOIN inspectors ON inspectors.id = inspector_id
        WHERE token_hash = ? AND expires_at > ? AND active = 1
    """, (token_hash, int(time()))).fetchone()


class InspectorAccounts:
    def __init__(self, store):
        self.store = store

    def has_inspectors(self):
        with self.store.connection() as db:
            return db.execute("SELECT 1 FROM inspectors LIMIT 1").fetchone() is not None

    def list(self):
        with self.store.connection() as db:
            db.row_factory = sqlite3.Row
            rows = db.execute("""SELECT id, username, display_name, active, created_at,
                (SELECT count(*) FROM records WHERE owner_id = inspectors.id) AS record_count
                FROM inspectors ORDER BY active DESC, username
            """).fetchall()
        return [dict(row) for row in rows]

    def create(self, username, display_name, password):
        username = username.strip().lower() if isinstance(username, str) else ""
        if not USERNAME.fullmatch(username):
            raise ValueError("账号须为 3 至 32 位字母、数字、点号、下划线或短横线。")
        display_name = _display_name(display_name)
        salt, password_hash = _new_password(password)
        with self.store.connection() as db:
            cursor = db.execute("""INSERT INTO inspectors (username, display_name, salt, password_hash, created_at)
                VALUES (?, ?, ?, ?, ?) ON CONFLICT(username) DO NOTHING
            """, (username, display_name, salt, password_hash, int(time())))
            if cursor.rowcount != 1:
                raise AccountError("该巡查账号已存在。", 409, "username_exists")

    def update(self, inspector_id, action, data):
        if action == "rename":
            statement = "UPDATE inspectors SET display_name = ? WHERE id = ?"
            values = (_display_name(data.get("display_name")), inspector_id)
        elif action == "active" and type(data.get("active")) is bool:
            statement = "UPDATE inspectors SET active = ? WHERE id = ?"
            values = (data["active"], inspector_id)
        elif action == "reset_password":
            statement = "UPDATE inspectors SET salt = ?, password_hash = ? WHERE id = ?"
            values = (*_new_password(data.get("password")), inspector_id)
        else:
            raise ValueError("人员管理操作无效。")
        with self.store.connection() as db:
            if db.execute(statement, values).rowcount != 1:
                raise AccountError("巡查人员不存在。", 404, "not_found")
            if action == "reset_password" or (action == "active" and not data["active"]):
                db.execute("DELETE FROM inspector_sessions WHERE inspector_id = ?", (inspector_id,))

    def login(self, address, username, password):
        username = username.strip().lower() if isinstance(username, str) else ""
        if not USERNAME.fullmatch(username) or not isinstance(password, str) or not 1 <= len(password) <= 128:
            raise AccountError("账号或密码不正确。", 401, "invalid_credentials")
        now = int(time())
        with self.store.connection() as db:
            db.execute("DELETE FROM inspector_login_attempts WHERE window_start <= ?", (now - LOGIN_WINDOW,))
            attempt = db.execute("""INSERT INTO inspector_login_attempts VALUES (?, ?, 1)
                ON CONFLICT(address) DO UPDATE SET attempts = attempts + 1
                WHERE attempts < ?
            """, (address, now, LOGIN_LIMIT)).rowcount
            row = db.execute("SELECT id, salt, password_hash FROM inspectors WHERE username = ? AND active = 1",
                             (username,)).fetchone()
        if attempt != 1:
            raise AccountError("登录尝试过于频繁，请稍后再试。", 429, "login_limited")
        candidate = _password_hash(password, row[1] if row else DUMMY_SALT)
        if not secrets.compare_digest(candidate, row[2] if row else bytes(32)) or row is None:
            raise AccountError("账号或密码不正确。", 401, "invalid_credentials")
        token = secrets.token_urlsafe(32)
        hashed = self.hash_token(token)
        with self.store.connection() as db:
            db.execute("DELETE FROM inspector_sessions WHERE expires_at <= ?", (now,))
            cursor = db.execute("""INSERT INTO inspector_sessions (token_hash, inspector_id, expires_at)
                SELECT ?, id, ? FROM inspectors WHERE id = ? AND password_hash = ? AND active = 1
            """, (hashed, now + SESSION_LIFETIME, row[0], row[2]))
            if cursor.rowcount != 1:
                raise session_expired()
            inspector = find_session(db, hashed)
        return {"token": token, "user": {"username": inspector[1], "display_name": inspector[2]}}

    @staticmethod
    def hash_token(token):
        return hashlib.sha256(token.encode("ascii")).digest() if SESSION_TOKEN.fullmatch(token) else None

    def authenticate(self, token_hash):
        with self.store.connection() as db:
            inspector = find_session(db, token_hash)
        if inspector is None:
            raise session_expired()
        return inspector

    def logout(self, token_hash):
        with self.store.connection() as db:
            db.execute("DELETE FROM inspector_sessions WHERE token_hash = ?", (token_hash,))
