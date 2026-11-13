import json
import sqlite3
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from tempfile import TemporaryDirectory

from orchard_workbench.orchard import apply_turn, new_record, review
from orchard_workbench.storage import RecordStore


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "records.sqlite3"
        self.store = RecordStore(self.path)

    def create_legacy(self, *rows):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("CREATE TABLE records (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
            db.executemany("INSERT INTO records VALUES (?, ?)", rows)

    def test_migrates_legacy_records_and_preserves_the_original_snapshot(self):
        older = new_record("trap")
        apply_turn(older, "五号点看到两只疑似虫体", rules_only=True)
        older["turns"][-1]["time"] = "2026-11-13T10:00:00+08:00"
        newer = new_record("orchard")
        newer["updated_at"] = "2026-11-13T03:00:00+00:00"
        self.create_legacy(("older", json.dumps(older)), ("newer", json.dumps(newer)))

        backup = self.store.initialize()
        self.assertIsNotNone(backup)
        self.assertIsNone(self.store.initialize())
        self.assertEqual(self.store.load("older"), (older, 0))
        self.assertEqual([row["id"] for row in self.store.list_records()], ["newer", "older"])
        self.assertEqual(self.store.list_records()[1]["location"], "五号点")
        with closing(sqlite3.connect(backup)) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM records").fetchone()[0], 2)

    def test_migration_rolls_back_when_a_legacy_record_is_invalid(self):
        self.create_legacy(("invalid", "invalid-json"))
        with self.assertRaises(sqlite3.Error):
            self.store.initialize()
        with closing(sqlite3.connect(self.path)) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT data FROM records").fetchone()[0], "invalid-json")
            self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name = 'record_summaries'").fetchone())

    def test_concurrent_reviews_keep_summary_and_record_consistent(self):
        self.store.initialize()
        record = new_record("trap")
        apply_turn(record, "五号点看到两只疑似虫体", rules_only=True)
        review(record, "submit")
        self.store.save("record", record)
        confirm, write_version = self.store.load("record")
        returned, _ = self.store.load("record")
        review(confirm, "confirm", "已核对照片")
        review(returned, "return", "需补拍")
        self.assertEqual(confirm["version"], returned["version"])
        with ThreadPoolExecutor(2) as workers:
            results = [workers.submit(self.store.save, "record", item, write_version) for item in (confirm, returned)]
            self.assertEqual(sum(result.result() for result in results), 1)

        stored, current_version = self.store.load("record")
        self.assertEqual(current_version, write_version + 1)
        self.assertEqual(self.store.list_records()[0]["status"], stored["status"])

    def test_backup_copies_a_running_database_and_rejects_existing_destinations(self):
        self.store.initialize()
        destination = self.path.with_name("snapshot.sqlite3")
        with self.store.connection() as db:
            self.store.save("record", new_record("trap"))
            self.store.backup(destination)
            self.assertEqual(db.execute("PRAGMA journal_mode").fetchone()[0], "wal")
        backup = RecordStore(destination)
        self.assertIsNone(backup.initialize())
        self.assertEqual(backup.load("record"), self.store.load("record"))
        with self.assertRaises(FileExistsError):
            self.store.backup(destination)
        self.assertEqual(backup.list_records(), self.store.list_records())
