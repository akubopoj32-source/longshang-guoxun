"""Read-only SQLite overview and controlled maintenance for the local workbench."""

import re
import sqlite3
from datetime import datetime, timezone
from uuid import uuid4

from .storage import RECORD_LIST_COLUMNS, RECORD_LIST_FROM


PAGE_SIZE = 20
RECORD_STATUSES = ("draft", "pending", "returned", "confirmed")
BACKUP_SUFFIX = re.compile(r"[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}\.sqlite3")


class DatabaseAdmin:
    def __init__(self, store):
        self.store = store
        self.backup_dir = store.path.parent / f"{store.path.stem}.backups"
        self.backup_prefix = f"{store.path.stem}-"

    def overview(self, filters):
        status = filters.get("status", [""])[0]
        needle = filters.get("q", [""])[0].strip().removeprefix("#").lower()
        raw_page = filters.get("page", ["1"])[0]
        if (status and status not in RECORD_STATUSES or len(needle) > 80
                or not re.fullmatch(r"[1-9][0-9]{0,7}", raw_page)):
            raise ValueError("请检查筛选条件。搜索词最多 80 个字符。")
        predicate = """WHERE (? = '' OR status = ?) AND
            (? = '' OR instr(records.id, ?) > 0 OR instr(lower(coalesce(location, '')), ?) > 0
             OR instr(lower(coalesce(inspectors.display_name, '')), ?) > 0
             OR instr(lower(coalesce(inspectors.username, '')), ?) > 0)
        """
        arguments = (status, status, needle, needle, needle, needle, needle)
        with self.store.connection() as db:
            db.row_factory = sqlite3.Row
            db.execute("BEGIN")
            counts = dict.fromkeys(RECORD_STATUSES, 0)
            counts.update(db.execute("SELECT status, count(*) FROM record_summaries GROUP BY status").fetchall())
            total = db.execute(f"SELECT count(*) {RECORD_LIST_FROM} {predicate}", arguments).fetchone()[0]
            pages = max(1, (total + PAGE_SIZE - 1) // PAGE_SIZE)
            page = min(int(raw_page), pages)
            rows = db.execute(f"""SELECT {RECORD_LIST_COLUMNS} {RECORD_LIST_FROM} {predicate}
                ORDER BY activity_order DESC, sequence DESC LIMIT ? OFFSET ?
            """, (*arguments, PAGE_SIZE, (page - 1) * PAGE_SIZE)).fetchall()
            inspector_count = db.execute("SELECT count(*) FROM inspectors").fetchone()[0]
            version = db.execute("PRAGMA user_version").fetchone()[0]
            journal = db.execute("PRAGMA journal_mode").fetchone()[0]
        return {
            "database": {"path": str(self.store.path), "schema_version": version, "journal_mode": journal},
            "counts": {"records": sum(counts.values()), "by_status": counts, "inspectors": inspector_count},
            "records": [dict(row) for row in rows], "page": page, "pages": pages, "total": total,
            "backup_path": str(self.backup_dir), "backups": self.backups(),
        }

    def backups(self):
        if not self.backup_dir.is_dir():
            return []
        files = [path for path in self.backup_dir.iterdir() if path.name.startswith(self.backup_prefix)
                 and BACKUP_SUFFIX.fullmatch(path.name.removeprefix(self.backup_prefix)) and path.is_file()]
        descriptions = []
        for path in sorted(files, reverse=True):
            try:
                descriptions.append(self.backup_info(path))
            except FileNotFoundError:
                continue
            if len(descriptions) == 10:
                break
        return descriptions

    @staticmethod
    def backup_info(path):
        info = path.stat()
        return {"name": path.name, "bytes": info.st_size,
                "created_at": datetime.fromtimestamp(info.st_mtime, timezone.utc).isoformat(timespec="seconds")}

    def create_backup(self):
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path = self.backup_dir / f"{self.backup_prefix}{timestamp}-{uuid4().hex[:8]}.sqlite3"
        temporary = path.with_suffix(".tmp")
        self.store.backup(temporary)
        try:
            temporary.rename(path)
        except OSError:
            temporary.unlink(missing_ok=True)
            raise
        return self.backup_info(path)

    def check(self):
        with self.store.connection() as db:
            db.execute("BEGIN")
            if db.execute("PRAGMA quick_check(1)").fetchone()[0] != "ok":
                return {"status": "issues", "message": "SQLite 文件完整性检查发现异常。"}
            if db.execute("PRAGMA foreign_key_check").fetchone():
                return {"status": "issues", "message": "记录或账号之间的关联存在异常。"}
            missing_summary = db.execute("""SELECT 1 FROM records LEFT JOIN record_summaries USING (id)
                WHERE record_summaries.id IS NULL LIMIT 1
            """).fetchone()
            if missing_summary:
                return {"status": "issues", "message": "存在缺少查询索引的巡查记录。"}
        return {"status": "ok", "message": "文件完整性、数据关联和记录索引均通过校验。"}
