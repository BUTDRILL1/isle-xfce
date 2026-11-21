from __future__ import annotations

import json
import sqlite3
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any


def _now_ms() -> int:
    return int(time.time() * 1000)


def _uuid() -> str:
    return str(uuid.uuid4())


@dataclass
class LocalButlerDB:
    db_path: Path
    _conn: sqlite3.Connection

    @staticmethod
    def open(path_or_config: str | Path | Any = None) -> "LocalButlerDB":
        if path_or_config is None or not isinstance(path_or_config, (str, Path)):
            db_path = Path.home() / ".local" / "share" / "isle" / "butler.sqlite3"
        else:
            db_path = Path(path_or_config)

        db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row

        instance = LocalButlerDB(db_path=db_path, _conn=conn)
        instance._init_schema()
        instance.cleanup_old_conversations()
        return instance

    def _init_schema(self) -> None:
        with self._conn:
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY,
                    created_at_ms INTEGER NOT NULL
                )
                """
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL,
                    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
                )
                """
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS tool_calls (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    tool_name TEXT NOT NULL,
                    args_json TEXT NOT NULL,
                    result_json TEXT,
                    status TEXT NOT NULL,
                    error TEXT,
                    started_at_ms INTEGER NOT NULL,
                    duration_ms INTEGER NOT NULL,
                    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
                )
                """
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS reminders (
                    id TEXT PRIMARY KEY,
                    message TEXT NOT NULL,
                    trigger_time_ms INTEGER NOT NULL,
                    recurrence_minutes REAL,
                    is_sent INTEGER NOT NULL DEFAULT 0,
                    created_at_ms INTEGER NOT NULL
                )
                """
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS skills (
                    id TEXT PRIMARY KEY,
                    trigger TEXT UNIQUE NOT NULL,
                    action TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL
                )
                """
            )

    def cleanup_old_conversations(self, max_age_days: int = 14) -> None:
        cutoff = _now_ms() - (max_age_days * 24 * 3600 * 1000)
        with self._conn:
            self._conn.execute("DELETE FROM conversations WHERE created_at_ms < ?", (cutoff,))

    def new_conversation(self) -> str:
        cid = _uuid()
        with self._conn:
            self._conn.execute(
                "INSERT INTO conversations (id, created_at_ms) VALUES (?, ?)",
                (cid, _now_ms()),
            )
        return cid

    def get_last_conversation(self, max_age_hours: int = 24) -> str | None:
        cutoff = _now_ms() - (max_age_hours * 3600 * 1000)
        cursor = self._conn.execute(
            "SELECT id FROM conversations WHERE created_at_ms > ? ORDER BY created_at_ms DESC LIMIT 1",
            (cutoff,),
        )
        row = cursor.fetchone()
        return row["id"] if row else None

    def add_message(self, conversation_id: str, role: str, content: str) -> None:
        with self._conn:
            self._conn.execute(
                "INSERT INTO messages (id, conversation_id, role, content, created_at_ms) VALUES (?, ?, ?, ?, ?)",
                (_uuid(), conversation_id, role, content, _now_ms()),
            )

    def list_messages(self, conversation_id: str, limit: int | None = None) -> list[dict[str, Any]]:
        if limit is not None and limit > 0:
            cursor = self._conn.execute(
                "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at_ms DESC, rowid DESC LIMIT ?",
                (conversation_id, limit),
            )
            rows = cursor.fetchall()
            return [{"role": r["role"], "content": r["content"]} for r in reversed(rows)]
        else:
            cursor = self._conn.execute(
                "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at_ms ASC, rowid ASC",
                (conversation_id,),
            )
            rows = cursor.fetchall()
            return [{"role": r["role"], "content": r["content"]} for r in rows]

    def clear_conversation(self, conversation_id: str) -> None:
        with self._conn:
            self._conn.execute("DELETE FROM messages WHERE conversation_id = ?", (conversation_id,))

    def log_tool_call(
        self,
        conversation_id: str,
        tool_name: str,
        args: dict[str, Any],
        *,
        status: str,
        result: dict[str, Any] | None = None,
        error: str | None = None,
        started_at_ms: int,
        duration_ms: int,
    ) -> None:
        with self._conn:
            self._conn.execute(
                """
                INSERT INTO tool_calls (id, conversation_id, tool_name, args_json, result_json, status, error, started_at_ms, duration_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    _uuid(),
                    conversation_id,
                    tool_name,
                    json.dumps(args, ensure_ascii=False),
                    json.dumps(result, ensure_ascii=False) if result is not None else None,
                    status,
                    error,
                    started_at_ms,
                    duration_ms,
                ),
            )

    def flush_turn(self) -> None:
        self._conn.commit()

    # --- Reminders API ---

    def create_reminder(self, message: str, trigger_time_ms: int, recurrence_minutes: float | None = None) -> str:
        rid = _uuid()
        with self._conn:
            self._conn.execute(
                """
                INSERT INTO reminders (id, message, trigger_time_ms, recurrence_minutes, is_sent, created_at_ms)
                VALUES (?, ?, ?, ?, 0, ?)
                """,
                (rid, message, trigger_time_ms, recurrence_minutes, _now_ms()),
            )
        return rid

    def get_pending_reminders(self) -> list[dict[str, Any]]:
        now = _now_ms()
        cursor = self._conn.execute(
            """
            SELECT id, message, trigger_time_ms, recurrence_minutes
            FROM reminders
            WHERE is_sent = 0 AND trigger_time_ms <= ?
            ORDER BY trigger_time_ms ASC
            """,
            (now,),
        )
        return [dict(row) for row in cursor.fetchall()]

    def mark_reminder_sent(self, reminder_id: str) -> None:
        with self._conn:
            self._conn.execute("UPDATE reminders SET is_sent = 1 WHERE id = ?", (reminder_id,))

    def snooze_reminder(self, reminder_id: str, added_time_ms: int) -> None:
        cursor = self._conn.execute("SELECT trigger_time_ms FROM reminders WHERE id = ?", (reminder_id,))
        row = cursor.fetchone()
        if row:
            current_ms = row["trigger_time_ms"]
            with self._conn:
                self._conn.execute(
                    "UPDATE reminders SET is_sent = 0, trigger_time_ms = ? WHERE id = ?",
                    (current_ms + added_time_ms, reminder_id),
                )

    def reschedule_recurring_reminder(self, reminder_id: str, recurrence_minutes: float) -> None:
        added_ms = int(recurrence_minutes * 60 * 1000)
        cursor = self._conn.execute("SELECT trigger_time_ms FROM reminders WHERE id = ?", (reminder_id,))
        row = cursor.fetchone()
        if row:
            current_ms = row["trigger_time_ms"]
            with self._conn:
                self._conn.execute(
                    "UPDATE reminders SET trigger_time_ms = ? WHERE id = ?",
                    (current_ms + added_ms, reminder_id),
                )

    def list_all_pending_reminders(self) -> list[dict[str, Any]]:
        cursor = self._conn.execute(
            """
            SELECT id, message, trigger_time_ms, recurrence_minutes
            FROM reminders
            WHERE is_sent = 0
            ORDER BY trigger_time_ms ASC
            """
        )
        return [dict(row) for row in cursor.fetchall()]

    def delete_reminder(self, reminder_id: str) -> bool:
        with self._conn:
            cursor = self._conn.execute("DELETE FROM reminders WHERE id = ?", (reminder_id,))
            return cursor.rowcount > 0

    def clear_reminders(self) -> int:
        with self._conn:
            cursor = self._conn.execute("DELETE FROM reminders WHERE is_sent = 0")
            return cursor.rowcount

    # --- Custom Skills ---

    def add_skill(self, trigger: str, action: str) -> None:
        with self._conn:
            self._conn.execute(
                """
                INSERT INTO skills (id, trigger, action, created_at_ms)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(trigger) DO UPDATE SET action = excluded.action
                """,
                (_uuid(), trigger, action, _now_ms()),
            )

    def list_skills(self) -> list[dict[str, Any]]:
        cursor = self._conn.execute("SELECT id, trigger, action FROM skills ORDER BY created_at_ms DESC")
        return [dict(row) for row in cursor.fetchall()]

    def delete_skill(self, skill_id: str) -> bool:
        with self._conn:
            cursor = self._conn.execute("DELETE FROM skills WHERE id = ?", (skill_id,))
            return cursor.rowcount > 0
