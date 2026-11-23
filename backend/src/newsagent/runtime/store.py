"""使用 SQLite 原子写入事件与运行摘要。"""

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from ..contracts import models as m
from .state import apply_event, empty_detail, to_summary

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL,
    title TEXT NOT NULL, request_json TEXT NOT NULL, initial_json TEXT NOT NULL,
    summary_json TEXT NOT NULL, last_event_seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_order ON runs(created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS events (
    run_id TEXT REFERENCES runs(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
    ts TEXT NOT NULL, type TEXT NOT NULL, data_json TEXT NOT NULL,
    PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS run_meter (
    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    usage_json TEXT NOT NULL, short_answer TEXT
);
CREATE TABLE IF NOT EXISTS report_checks (
    run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
    version INTEGER NOT NULL, findings_json TEXT NOT NULL, PRIMARY KEY (run_id, version)
);
CREATE TABLE IF NOT EXISTS checkpoints (
    run_id TEXT REFERENCES runs(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
    step TEXT NOT NULL, round INTEGER NOT NULL, state_json TEXT NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY (run_id, seq)
);
"""


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        with self.connection() as db:
            db.executescript(SCHEMA)

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path)
        try:
            with db:
                db.execute("PRAGMA foreign_keys=ON")
                yield db
        finally:
            db.close()

    def create(self, summary: m.RunSummary) -> None:
        payload = summary.model_dump_json()
        with self.connection() as db:
            db.execute(
                "INSERT INTO runs VALUES (?,?,?,?,?,?,?,0)",
                (
                    summary.id,
                    summary.created_at,
                    summary.status,
                    summary.title,
                    summary.request.model_dump_json(),
                    payload,
                    payload,
                ),
            )

    def append(self, event: m.RunEvent, state: m.RunDetail) -> None:
        with self.connection() as db:
            db.execute(
                "INSERT INTO events VALUES (?,?,?,?,?)",
                (
                    event.run_id,
                    event.seq,
                    event.ts,
                    event.type,
                    event.data.model_dump_json(),
                ),
            )
            db.execute(
                "UPDATE runs SET status=?, title=?, summary_json=?, last_event_seq=? WHERE id=?",
                (
                    state.status,
                    state.title,
                    to_summary(state).model_dump_json(),
                    event.seq,
                    event.run_id,
                ),
            )

    def events(self, run_id: str, after: int = 0, limit: int = -1) -> list[m.RunEvent]:
        import json

        with self.connection() as db:
            rows = db.execute(
                "SELECT seq,ts,type,data_json FROM events WHERE run_id=? AND seq>? "
                "ORDER BY seq LIMIT ?",
                (run_id, after, limit),
            ).fetchall()
        return [
            m.EVENT_ADAPTER.validate_python(
                {
                    "run_id": run_id,
                    "seq": seq,
                    "ts": ts,
                    "type": kind,
                    "data": json.loads(data),
                }
            )
            for seq, ts, kind, data in rows
        ]

    def checkpoint(self, state: m.RunDetail, step: str, round_number: int, at: str) -> None:
        with self.connection() as db:
            db.execute(
                "INSERT OR REPLACE INTO checkpoints VALUES (?,?,?,?,?,?)",
                (
                    state.id,
                    state.last_event_seq,
                    step,
                    round_number,
                    state.model_dump_json(),
                    at,
                ),
            )

            db.execute(
                "DELETE FROM checkpoints WHERE run_id=? AND seq NOT IN "
                "(SELECT seq FROM checkpoints WHERE run_id=? ORDER BY seq DESC LIMIT 5)",
                (state.id, state.id),
            )

    def revision(self, run_id: str) -> int | None:
        with self.connection() as db:
            row = db.execute("SELECT last_event_seq FROM runs WHERE id=?", (run_id,)).fetchone()
        return int(row[0]) if row else None

    def detail(self, run_id: str, through: int | None = None) -> m.RunDetail | None:
        with self.connection() as db:
            initial = db.execute("SELECT initial_json FROM runs WHERE id=?", (run_id,)).fetchone()
            if initial is None:
                return None
            last = db.execute(
                "SELECT state_json FROM checkpoints WHERE run_id=? AND (? IS NULL OR seq<=?) "
                "ORDER BY seq DESC LIMIT 1",
                (run_id, through, through),
            ).fetchone()
        state = (
            m.RunDetail.model_validate_json(last[0])
            if last
            else empty_detail(m.RunSummary.model_validate_json(initial[0]))
        )
        for event in self.events(run_id, state.last_event_seq):
            if through is not None and event.seq > through:
                break
            state = apply_event(state, event)
        return state

    def before_round(self, run_id: str, round_number: int) -> m.RunDetail | None:
        with self.connection() as db:
            row = db.execute(
                "SELECT MIN(seq) FROM events WHERE run_id=? AND type='step.started' "
                "AND json_extract(data_json,'$.step')='plan' "
                "AND json_extract(data_json,'$.round')=?",
                (run_id, round_number),
            ).fetchone()
        return self.detail(run_id, through=row[0] - 1) if row and row[0] else None

    def list(
        self,
        statuses: list[str] | None = None,
        query: str = "",
        limit: int = 50,
        cursor: tuple[str, str] | None = None,
    ) -> list[m.RunSummary]:
        conditions: list[str] = []
        params: list[str | int] = []
        if statuses:
            placeholders = ",".join("?" for _ in statuses)
            conditions.append(f"status IN ({placeholders})")
            params.extend(statuses)
        if query:
            conditions.append(
                "(instr(lower(title),lower(?))>0 OR "
                "instr(lower(json_extract(request_json,'$.question')),lower(?))>0)"
            )
            params.extend((query, query))
        if cursor:
            conditions.append("(created_at,id)<(?,?)")
            params.extend(cursor)
        where = " WHERE " + " AND ".join(conditions) if conditions else ""
        with self.connection() as db:
            rows = db.execute(
                "SELECT summary_json FROM runs"
                + where
                + " ORDER BY created_at DESC,id DESC LIMIT ?",
                [*params, limit],
            )
            return [m.RunSummary.model_validate_json(row[0]) for row in rows]

    def delete(self, run_id: str) -> None:
        with self.connection() as db:
            db.execute("DELETE FROM runs WHERE id=?", (run_id,))

    def by_tag(self, tag: str) -> m.RunSummary | None:
        with self.connection() as db:
            row = db.execute(
                "SELECT summary_json FROM runs WHERE EXISTS "
                "(SELECT 1 FROM json_each(request_json,'$.tags') WHERE value=?) "
                "ORDER BY created_at DESC LIMIT 1",
                (tag,),
            ).fetchone()
        return m.RunSummary.model_validate_json(row[0]) if row else None

    def last_checkpoint(self, run_id: str) -> tuple[str, int] | None:
        with self.connection() as db:
            row = db.execute(
                "SELECT step,round FROM checkpoints WHERE run_id=? ORDER BY seq DESC LIMIT 1",
                (run_id,),
            ).fetchone()
        return (row[0], row[1]) if row else None

    def save_meter(self, run_id: str, usage: m.BudgetUsage) -> None:
        with self.connection() as db:
            db.execute(
                "INSERT INTO run_meter(run_id,usage_json) VALUES (?,?) "
                "ON CONFLICT(run_id) DO UPDATE SET usage_json=excluded.usage_json",
                (run_id, usage.model_dump_json()),
            )

    def metered(self, run_id: str) -> m.BudgetUsage | None:
        with self.connection() as db:
            row = db.execute(
                "SELECT usage_json FROM run_meter WHERE run_id=?", (run_id,)
            ).fetchone()
        return m.BudgetUsage.model_validate_json(row[0]) if row else None

    def set_short_answer(self, run_id: str, value: str) -> None:
        with self.connection() as db:
            db.execute("UPDATE run_meter SET short_answer=? WHERE run_id=?", (value, run_id))

    def short_answer(self, run_id: str) -> str | None:
        with self.connection() as db:
            row = db.execute(
                "SELECT short_answer FROM run_meter WHERE run_id=?", (run_id,)
            ).fetchone()
        return row[0] if row else None

    def save_report_checks(self, run_id: str, version: int, payload: str) -> None:
        with self.connection() as db:
            db.execute(
                "INSERT OR REPLACE INTO report_checks VALUES (?,?,?)", (run_id, version, payload)
            )

    def report_checks(self, run_id: str, version: int) -> str:
        with self.connection() as db:
            row = db.execute(
                "SELECT findings_json FROM report_checks WHERE run_id=? AND version=?",
                (run_id, version),
            ).fetchone()
        return str(row[0]) if row else "[]"

    def ready(self) -> bool:
        try:
            with self.connection() as db:
                return db.execute("SELECT 1 FROM runs LIMIT 1").fetchone() in (None, (1,))
        except sqlite3.Error:
            return False
