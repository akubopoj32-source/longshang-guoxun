"""SQLite records, indexed list summaries, and consistent backups."""

import json
import sqlite3
from contextlib import closing, contextmanager
from uuid import uuid4

from .accounts import find_session, initialize_accounts, session_expired


SCHEMA_VERSION = 2
SUMMARY_COLUMNS = "id, task, location, status, activity_at"
SUMMARY_SELECT = """
    SELECT id, json_extract(data, '$.task'), json_extract(data, '$.fields.location.value'),
           json_extract(data, '$.status'), COALESCE(json_extract(data, '$.updated_at'), CASE
               WHEN COALESCE(julianday(json_extract(data, '$.reviews[#-1].time')), 0)
                    >= COALESCE(julianday(json_extract(data, '$.turns[#-1].time')), 0)
               THEN COALESCE(json_extract(data, '$.reviews[#-1].time'), json_extract(data, '$.turns[#-1].time'))
               ELSE json_extract(data, '$.turns[#-1].time')
           END)
    FROM records
"""


class RecordStore:
    def __init__(self, path):
        self.path = path.resolve()

    @contextmanager
    def connection(self, *, create=False):
        mode = "rwc" if create else "rw"
        with closing(sqlite3.connect(f"{self.path.as_uri()}?mode={mode}", uri=True, timeout=5)) as db, db:
            db.execute("PRAGMA foreign_keys = ON")
            db.execute("PRAGMA synchronous = FULL")
            yield db

    def initialize(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection(create=True) as db:
            if db.execute("PRAGMA journal_mode = WAL").fetchone()[0] != "wal":
                raise sqlite3.OperationalError("无法开启 SQLite WAL 模式。")
            db.execute("BEGIN IMMEDIATE")
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version == SCHEMA_VERSION:
                return None
            if version not in (0, 1):
                raise sqlite3.OperationalError(f"当前程序不支持数据库版本 {version}。")

            backup_path = None
            if db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'records'").fetchone():
                backup_path = self.path.with_name(f"{self.path.stem}.before-v{version + 1}-{uuid4().hex[:8]}.sqlite3")
                self.backup(backup_path)

            if version == 0:
                self.initialize_summaries(db)
            initialize_accounts(db)
            db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            return backup_path

    @staticmethod
    def initialize_summaries(db):
        db.execute("CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
        db.execute("""
            CREATE TABLE record_summaries (
                sequence INTEGER PRIMARY KEY,
                id TEXT NOT NULL UNIQUE REFERENCES records(id) ON DELETE CASCADE,
                task TEXT NOT NULL,
                location TEXT,
                status TEXT NOT NULL,
                activity_at TEXT,
                activity_order REAL GENERATED ALWAYS AS (julianday(activity_at)) VIRTUAL,
                write_version INTEGER NOT NULL DEFAULT 0
            )
            """)
        db.execute(f"INSERT INTO record_summaries ({SUMMARY_COLUMNS}) {SUMMARY_SELECT} ORDER BY rowid")
        db.execute("CREATE INDEX record_summaries_activity ON record_summaries(activity_order DESC, sequence DESC)")
        for event in ("INSERT", "UPDATE"):
            db.execute(f"""
                CREATE TRIGGER records_summary_{event.lower()} AFTER {event} ON records BEGIN
                    INSERT INTO record_summaries ({SUMMARY_COLUMNS})
                    {SUMMARY_SELECT} WHERE id = NEW.id
                    ON CONFLICT(id) DO UPDATE SET
                        task = excluded.task,
                        location = excluded.location, status = excluded.status, activity_at = excluded.activity_at,
                        write_version = record_summaries.write_version + 1;
                END
                """)

    def backup(self, destination):
        destination = destination.resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open("xb"):
            pass
        try:
            with closing(sqlite3.connect(self.path.as_uri() + "?mode=ro", uri=True)) as source:
                with closing(sqlite3.connect(destination)) as target:
                    source.backup(target)
                    if target.execute("PRAGMA quick_check(1)").fetchone()[0] != "ok":
                        raise sqlite3.DatabaseError("数据库备份未通过完整性检查。")
        except (OSError, sqlite3.Error):
            destination.unlink()
            raise

    def check(self):
        with self.connection() as db:
            db.execute("SELECT id FROM record_summaries LIMIT 1").fetchone()

    def load(self, record_id, *, owner_id=None):
        scope = " AND records.owner_id = ?" if owner_id is not None else ""
        args = (record_id, owner_id) if owner_id is not None else (record_id,)
        with self.connection() as db:
            row = db.execute("""
                SELECT records.data, record_summaries.write_version
                FROM records JOIN record_summaries USING (id) WHERE records.id = ?
                """ + scope, args).fetchone()
        if row is None:
            return None
        try:
            return json.loads(row[0]), row[1]
        except json.JSONDecodeError as error:
            raise sqlite3.DatabaseError("巡查记录不是有效的 JSON。") from error

    def list_records(self, *, owner_id=None):
        scope = "WHERE records.owner_id = ?" if owner_id is not None else ""
        args = (owner_id,) if owner_id is not None else ()
        with self.connection() as db:
            db.row_factory = sqlite3.Row
            rows = db.execute(f"""
                SELECT records.id, task, location, status, activity_at,
                       inspectors.display_name AS inspector_name, inspectors.username AS inspector_username
                FROM records JOIN record_summaries USING (id)
                LEFT JOIN inspectors ON records.owner_id = inspectors.id
                {scope}
                ORDER BY activity_order DESC, sequence DESC
                """, args).fetchall()
        return [dict(row) for row in rows]

    def save(self, record_id, record, expected_write_version=None, *, owner_id=None, session_hash=None):
        data = json.dumps(record, ensure_ascii=False)
        with self.connection() as db:
            if session_hash is not None:
                db.execute("BEGIN IMMEDIATE")
                session = find_session(db, session_hash)
                if session is None or session[0] != owner_id:
                    raise session_expired()
            if expected_write_version is None:
                db.execute("INSERT INTO records (id, data, owner_id) VALUES (?, ?, ?)", (record_id, data, owner_id))
                return True
            result = db.execute("""
                UPDATE records SET data = ? WHERE id = ? AND (? IS NULL OR owner_id = ?) AND EXISTS (
                    SELECT 1 FROM record_summaries WHERE id = ? AND write_version = ?
                )
                """, (data, record_id, owner_id, owner_id, record_id, expected_write_version))
            return result.rowcount == 1
