"""遥测存储：记录每次解析与人工修正。

这不是"日志"，是"证据"：
- 字段级准确率、人工修正率 → 直接喂给交付平台的 POC 结论与 ValueRecord
- token 与耗时 → 算 AI 单均成本
- 修正明细 → 反哺评测集与提示词
- review_level + handle_ms → 分级审批与"到底省了多少工时"
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
import uuid

from . import db
from datetime import datetime, timedelta, timezone

from .config import settings
from .rules import RISK_KEYS
from .schema import Draft

_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id          TEXT PRIMARY KEY,
    ts          TEXT NOT NULL,
    engine      TEXT NOT NULL,
    text_hash   TEXT NOT NULL,
    chars       INTEGER NOT NULL,
    elapsed_ms  INTEGER NOT NULL,
    tokens      INTEGER NOT NULL,
    errors      INTEGER NOT NULL,
    warns       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL,
    ts          TEXT NOT NULL,
    field       TEXT NOT NULL,
    auto_value  TEXT,
    final_value TEXT,
    changed     INTEGER NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(id)
);
CREATE INDEX IF NOT EXISTS idx_feedback_run ON feedback(run_id);
CREATE TABLE IF NOT EXISTS inbound (
    id          TEXT PRIMARY KEY,
    ts          TEXT NOT NULL,
    source      TEXT NOT NULL,
    text_hash   TEXT NOT NULL,
    preview     TEXT,
    run_id      TEXT
);
CREATE INDEX IF NOT EXISTS idx_inbound_hash ON inbound(text_hash);
CREATE TABLE IF NOT EXISTS wecom_msgs (
    msg_id      TEXT PRIMARY KEY,
    ts          TEXT NOT NULL,
    kind        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'received',
    note        TEXT
);
CREATE TABLE IF NOT EXISTS learn_queue (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    ts          TEXT NOT NULL,
    reason      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    gold_json   TEXT,
    labeled_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_learn_status ON learn_queue(status);
CREATE TABLE IF NOT EXISTS batches (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    note        TEXT,
    kind        TEXT DEFAULT 'booking',
    created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS batch_items (
    id          TEXT PRIMARY KEY,
    batch_id    TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
    filename    TEXT NOT NULL,
    path        TEXT,
    status      TEXT NOT NULL DEFAULT 'pending',
    run_id      TEXT,
    error       TEXT,
    note        TEXT,
    updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_batch_items ON batch_items(batch_id, status);
CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL UNIQUE,
    name        TEXT,
    role        TEXT NOT NULL DEFAULT 'viewer',
    pw_hash     TEXT NOT NULL,
    pw_salt     TEXT NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    last_login  TEXT
);
CREATE TABLE IF NOT EXISTS user_sessions (
    jti         TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    revoked     INTEGER NOT NULL DEFAULT 0,
    ua          TEXT,
    ip          TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id);
CREATE TABLE IF NOT EXISTS run_revisions (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL,
    ts          TEXT NOT NULL,
    actor       TEXT,
    action      TEXT NOT NULL,
    version     INTEGER,
    before_json TEXT,
    after_json  TEXT,
    note        TEXT,
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_revisions_run ON run_revisions(run_id, ts);
CREATE TABLE IF NOT EXISTS delivery_outbox (
    id              TEXT PRIMARY KEY,
    created_at      TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    experiment_id   TEXT,
    dataset_name    TEXT,
    payload_json    TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    response_json   TEXT,
    sent_at         TEXT,
    worker          TEXT,
    lease_until     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON delivery_outbox(status, created_at);
CREATE TABLE IF NOT EXISTS app_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT,
    updated_by  TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    ref_id      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    worker      TEXT,
    lease_until INTEGER,
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT,
    params_json TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE (kind, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, lease_until, created_at);
CREATE TABLE IF NOT EXISTS login_attempts (
    key           TEXT PRIMARY KEY,
    fails         INTEGER NOT NULL DEFAULT 0,
    first_at      TEXT NOT NULL,
    locked_until  TEXT
);
CREATE TABLE IF NOT EXISTS pilot_reviews (
    id                TEXT PRIMARY KEY,
    ts                TEXT NOT NULL,
    actor             TEXT,
    kind              TEXT NOT NULL,
    document_id       TEXT,
    status            TEXT NOT NULL DEFAULT 'confirmed',
    summary_json      TEXT,
    document_json     TEXT,
    differences_json  TEXT,
    decisions_json    TEXT,
    idempotency_key   TEXT NOT NULL UNIQUE,
    delivery_status   TEXT NOT NULL DEFAULT 'not_pushed',
    delivery_response TEXT
);
CREATE INDEX IF NOT EXISTS idx_pilot_reviews_ts ON pilot_reviews(ts);
"""

# 增量列：老库自动补，不用重建
_EXTRA_COLUMNS = (
    ("runs", "review_level", "TEXT DEFAULT 'single'"),
    ("runs", "handle_ms", "INTEGER"),
    ("runs", "forced", "INTEGER DEFAULT 0"),
    ("runs", "confirmed", "INTEGER DEFAULT 0"),
    ("runs", "model", "TEXT DEFAULT ''"),
    ("runs", "prompt_ver", "TEXT DEFAULT ''"),
    ("runs", "pipeline_ver", "TEXT DEFAULT ''"),
    ("runs", "raw_text", "TEXT"),
    ("runs", "fields_json", "TEXT"),
    ("runs", "inbound_id", "TEXT"),
    ("runs", "version", "INTEGER DEFAULT 0"),
    ("runs", "kind", "TEXT DEFAULT 'booking'"),
    ("learn_queue", "corrected", "INTEGER DEFAULT 0"),
    ("learn_queue", "labeled_by", "TEXT DEFAULT ''"),
    ("batches", "kind", "TEXT DEFAULT 'booking'"),
    ("batches", "cancel_requested", "INTEGER DEFAULT 0"),
    ("batches", "status", "TEXT DEFAULT 'idle'"),
    ("jobs", "params_json", "TEXT"),
    ("delivery_outbox", "worker", "TEXT"),
    ("delivery_outbox", "lease_until", "INTEGER"),
    ("runs", "actor", "TEXT DEFAULT ''"),
    ("runs", "confirmed_by", "TEXT DEFAULT ''"),
    ("runs", "source_file", "TEXT DEFAULT ''"),
)


_conn = db.connect


def _cleanup_orphans(conn) -> int:
    """清掉历史孤儿行（外键启用前产生的）。返回删除条数。"""
    total = 0
    for sql in (
        "DELETE FROM feedback WHERE run_id NOT IN (SELECT id FROM runs)",
        "DELETE FROM run_revisions WHERE run_id NOT IN (SELECT id FROM runs)",
        "DELETE FROM learn_queue WHERE run_id NOT IN (SELECT id FROM runs)",
        "DELETE FROM user_sessions WHERE user_id NOT IN (SELECT id FROM users)",
        "DELETE FROM batch_items WHERE batch_id NOT IN (SELECT id FROM batches)",
    ):
        total += conn.execute(sql).rowcount
    return total


def init_db() -> None:
    if db.BACKEND == "sqlite":
        # journal_mode 是持久属性，设一次即可；必须在写事务之前设置
        with _conn() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")

    with _conn() as conn:
        if db.BACKEND == "postgres":
            # 多实例同时启动时串行化 DDL，避免 ALTER TABLE 互相等锁死锁
            conn.execute("SELECT pg_advisory_xact_lock(727242)")
        conn.executescript(_SCHEMA)
        if db.BACKEND == "postgres":
            for table, col, decl in _EXTRA_COLUMNS:
                exists = conn.execute(
                    "SELECT 1 FROM information_schema.columns"
                    " WHERE table_schema='public' AND table_name=?"
                    " AND column_name=?", (table, col)
                ).fetchone()
                if not exists:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
        else:
            for table, col, decl in _EXTRA_COLUMNS:
                cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
                if col not in cols:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
        removed = _cleanup_orphans(conn)
        if removed:
            print(f"[db] 清理孤儿行 {removed} 条")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def save_run(raw: str, draft: Draft, kind: str = "booking", actor: str = "",
             source_file: str = "") -> str:
    run_id = uuid.uuid4().hex[:12]
    text_hash = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]
    fields_json = json.dumps(
        {k: {"value": v.value, "confidence": v.confidence, "source": v.source}
         for k, v in draft.fields.items()},
        ensure_ascii=False,
    )
    with _conn() as conn:
        conn.execute(
            "INSERT INTO runs (id, ts, engine, text_hash, chars, elapsed_ms, tokens,"
            " errors, warns, review_level, model, prompt_ver, pipeline_ver,"
            " raw_text, fields_json, kind, actor, source_file)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                run_id,
                _now(),
                draft.engine,
                text_hash,
                len(raw),
                draft.elapsed_ms,
                draft.tokens,
                sum(1 for c in draft.checks if c.level == "error"),
                sum(1 for c in draft.checks if c.level == "warn"),
                draft.review_level,
                draft.model,
                draft.prompt_version,
                draft.pipeline_version,
                raw,
                fields_json,
                kind,
                actor,
                source_file,
            ),
        )
        # 入口捕获过同一份原文 → 关联，用于算绕过率
        conn.execute(
            "UPDATE inbound SET run_id=? WHERE run_id IS NULL AND text_hash=?",
            (run_id, text_hash),
        )

    # D5：可疑样本自动进标注池
    reason = learn_reason(draft)
    if reason:
        enqueue_learn(run_id, reason)
    return run_id


def latest_unconfirmed_run(actor: str) -> dict | None:
    """企业微信「回复确认」用：取该用户最近一条未确认记录。"""
    with _conn() as conn:
        row = conn.execute(
            "SELECT id, fields_json FROM runs"
            " WHERE confirmed=0 AND actor=? ORDER BY ts DESC LIMIT 1",
            (actor,),
        ).fetchone()
    if not row:
        return None
    try:
        fields = json.loads(row["fields_json"] or "{}")
    except json.JSONDecodeError:
        fields = {}
    auto = {k: ((v or {}).get("value") or "") for k, v in fields.items()}
    return {"id": row["id"], "auto": auto}


def record_inbound(text: str, source: str = "wecom") -> dict:
    """记录一次"来单"。

    入口唯一化的关键：所有托书先进这张表，再由系统处理。
    没有对应确认记录的 inbound，就是"绕过"。
    """
    inbound_id = uuid.uuid4().hex[:12]
    text_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
    with _conn() as conn:
        conn.execute(
            "INSERT INTO inbound (id, ts, source, text_hash, preview) VALUES (?,?,?,?,?)",
            (inbound_id, _now(), source, text_hash, text[:40]),
        )
    return {"id": inbound_id, "text_hash": text_hash}


def update_inbound_text(inbound_id: str, text: str) -> None:
    """图片先以占位文本入 inbound，OCR 完成后补成真实原文。

    inbound.id 不变，所以绕过率统计不会因为"先占位再识别"多算一条。
    """
    text_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
    with _conn() as conn:
        conn.execute(
            "UPDATE inbound SET text_hash=?, preview=? WHERE id=?",
            (text_hash, text[:40], inbound_id),
        )


def claim_wecom_msg(msg_id: str, kind: str) -> bool:
    """企业微信消息幂等：同一 MsgId 只处理一次。

    企业微信在 5 秒内收不到响应会重试 3 次；没有这张表，
    一条图片会被 OCR 三遍、生成三条 run。
    """
    if not msg_id:
        return True
    with _conn() as conn:
        cur = conn.execute(
            "INSERT INTO wecom_msgs (msg_id, ts, kind, status)"
            " VALUES (?,?,?,'received') ON CONFLICT (msg_id) DO NOTHING",
            (msg_id, _now(), kind),
        )
        return cur.rowcount == 1


def mark_wecom_msg(msg_id: str, status: str, note: str = "") -> None:
    if not msg_id:
        return
    with _conn() as conn:
        conn.execute(
            "UPDATE wecom_msgs SET status=?, note=? WHERE msg_id=?",
            (status, note[:200], msg_id),
        )


class AlreadyConfirmed(Exception):
    """B3：这张单已经被别人确认过，且这次提交的内容不同。"""

    def __init__(self, run_id: str, version: int):
        self.run_id = run_id
        self.version = version
        super().__init__(f"{run_id} 已被确认（version {version}）")


class NotConfirmed(RuntimeError):
    """撤销时发现这张单并未确认（可能已被别人撤销）。"""


class VersionMismatch(RuntimeError):
    """撤销时版本已变化，说明期间有人重新确认过。"""


def _record_revision(conn: sqlite3.Connection, run_id: str, action: str,
                     actor: str, before: dict, after: dict, note: str = "") -> None:
    """修订流水：append-only。撤销不删历史，只追加一条反向记录。"""
    conn.execute(
        "INSERT INTO run_revisions (id, run_id, ts, actor, action, version,"
        " before_json, after_json, note) VALUES (?,?,?,?,?,?,?,?,?)",
        (
            uuid.uuid4().hex[:12], run_id, _now(), actor, action,
            after.get("version"),
            json.dumps(before, ensure_ascii=False),
            json.dumps(after, ensure_ascii=False),
            note or "",
        ),
    )


def undo_confirm(run_id: str, actor: str = "", note: str = "",
                 expected_version: int | None = None) -> dict:
    """撤销一次确认（B2）。

    为什么不是"删掉这条记录"：
    - 确认这个动作本身发生过，删掉等于篡改审计
    - 所以 runs 回到未确认、feedback 清空、learn_queue 回到 pending，
      但 run_revisions 里留一条 action='undo'，before_json 保存被撤回的内容

    为什么清 feedback 而不是打标记：
    - 所有指标（修正率、字段准确率）都按 feedback 统计，
      留一条"已作废但仍在表里"的记录，早晚会污染某个没加过滤的查询
    - 被撤回的明细完整存在 before_json 里，没有丢失
    """
    with _conn() as conn:
        row = conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        if not row:
            raise LookupError("未找到该单据")

        if expected_version is not None and int(row["version"] or 0) != int(expected_version):
            raise VersionMismatch(
                f"版本已变化（当前 {row['version']}，请求 {expected_version}），请刷新后再操作"
            )

        fb = [dict(x) for x in conn.execute(
            "SELECT field, auto_value, final_value, changed, ts FROM feedback"
            " WHERE run_id=? ORDER BY ts", (run_id,)
        ).fetchall()]
        gold_row = conn.execute(
            "SELECT status, reason, gold_json, corrected, labeled_at"
            " FROM learn_queue WHERE id=?", (run_id,)
        ).fetchone()

        before = {
            "confirmed": int(row["confirmed"] or 0),
            "confirmed_by": row["confirmed_by"] or "",
            "version": int(row["version"] or 0),
            "handle_ms": row["handle_ms"],
            "forced": int(row["forced"] or 0),
            "feedback": fb,
            "gold": json.loads(gold_row["gold_json"]) if gold_row and gold_row["gold_json"] else None,
        }

        # 条件更新：两个人同时点撤销，只有一个能成功
        cur = conn.execute(
            "UPDATE runs SET confirmed=0, confirmed_by='', handle_ms=NULL, forced=0,"
            " version=COALESCE(version,0)+1 WHERE id=? AND confirmed=1",
            (run_id,),
        )
        if cur.rowcount == 0:
            raise NotConfirmed("这张单当前不是已确认状态，可能已被撤销")

        conn.execute("DELETE FROM feedback WHERE run_id=?", (run_id,))
        # 金标回到待标注：撤销意味着"这条标注不可信"
        conn.execute(
            "UPDATE learn_queue SET status='pending', gold_json=NULL,"
            " labeled_at=NULL, corrected=0 WHERE id=?",
            (run_id,),
        )

        new_version = int(row["version"] or 0) + 1
        after = {
            "confirmed": 0, "confirmed_by": "", "version": new_version,
            "handle_ms": None, "forced": 0, "feedback": [], "gold": None,
        }
        _record_revision(conn, run_id, "undo", actor, before, after, note)

    return {
        "ok": True, "run_id": run_id, "version": new_version,
        "restored_fields": len(fb),
        "note": "已撤销确认；该单回到未确认，金标回到待标注",
    }


def revisions(run_id: str, limit: int = 100) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT v.id, v.ts, v.actor, v.action, v.version, v.before_json,"
            " v.after_json, v.note, u.name AS actor_name, u.email AS actor_email"
            " FROM run_revisions v LEFT JOIN users u ON u.id = v.actor"
            f" WHERE v.run_id=? ORDER BY v.ts DESC, v.{db.ROW_ORDER} DESC LIMIT ?",
            (run_id, limit),
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["before"] = json.loads(d.pop("before_json") or "{}")
        except json.JSONDecodeError:
            d["before"] = {}
        try:
            d["after"] = json.loads(d.pop("after_json") or "{}")
        except json.JSONDecodeError:
            d["after"] = {}
        out.append(d)
    return out


def confirmed_recent(limit: int = 100) -> list[dict]:
    """可撤销列表：最近确认过的单，带确认人姓名。"""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT r.id, r.ts, r.kind, r.review_level, r.version, r.handle_ms,"
            " r.confirmed_by, substr(r.raw_text,1,80) AS preview,"
            " u.name AS actor_name, u.email AS actor_email"
            " FROM runs r LEFT JOIN users u ON u.id = r.confirmed_by"
            f" WHERE r.confirmed=1 ORDER BY r.ts DESC, r.{db.ROW_ORDER} DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def save_feedback(
    run_id: str,
    auto: dict[str, str],
    final: dict[str, str],
    handle_ms: int | None = None,
    actor: str = "",
) -> dict:
    changed = {k: (auto.get(k, ""), v) for k, v in final.items() if (auto.get(k, "") or "") != (v or "")}
    ts = _now()

    with _conn() as conn:
        row = conn.execute(
            "SELECT confirmed, review_level, version, handle_ms, forced, confirmed_by"
            " FROM runs WHERE id=?", (run_id,)
        ).fetchone()
        level = (row["review_level"] if row else "") or "single"

        if row and row["confirmed"]:
            # B3：已经确认过。内容一致 → 幂等返回；内容不同 → 409，让人自己看
            prev = conn.execute(
                "SELECT gold_json FROM learn_queue WHERE id=?", (run_id,)
            ).fetchone()
            current = {k: v for k, v in final.items() if v}
            try:
                prev_gold = json.loads(prev["gold_json"]) if prev and prev["gold_json"] else None
            except json.JSONDecodeError:
                prev_gold = None
            if prev_gold is not None and prev_gold == current:
                return {
                    "run_id": run_id, "review_level": level, "fields": len(auto),
                    "changed": 0, "correction_rate": 0.0, "changed_fields": [],
                    "handle_ms": handle_ms, "idempotent": True,
                    "version": int(row["version"] or 1),
                }
            raise AlreadyConfirmed(run_id, int(row["version"] or 1))

        conn.execute(
            "UPDATE runs SET confirmed=1, handle_ms=?, forced=?, confirmed_by=?,"
            " version=COALESCE(version,0)+1 WHERE id=?",
            (handle_ms, 1 if level == "blocked" else 0, actor, run_id),
        )
        for key, (a, f) in changed.items():
            conn.execute(
                "INSERT INTO feedback (id, run_id, ts, field, auto_value, final_value, changed)"
                " VALUES (?,?,?,?,?,?,1)",
                (uuid.uuid4().hex[:12], run_id, ts, key, a, f),
            )

        old_version = int(row["version"] or 0) if row else 0
        gold = {k: v for k, v in final.items() if v}
        _record_revision(
            conn, run_id, "confirm", actor,
            before={
                "confirmed": 0, "confirmed_by": "", "version": old_version,
                "handle_ms": row["handle_ms"] if row else None,
                "forced": row["forced"] if row else 0,
                "feedback": [], "gold": None,
            },
            after={
                "confirmed": 1, "confirmed_by": actor, "version": old_version + 1,
                "handle_ms": handle_ms,
                "forced": 1 if level == "blocked" else 0,
                "feedback": [{"field": k, "auto": a, "final": f}
                             for k, (a, f) in changed.items()],
                "gold": gold,
            },
        )

    total = len(auto)
    # D5：人工确认即产出一条金标；改过的单要单独标记（那才是难例）
    label_run(run_id, final, corrected=bool(changed), actor=actor)
    return {
        "run_id": run_id,
        "review_level": level,
        "fields": total,
        "changed": len(changed),
        "correction_rate": round(len(changed) / total, 4) if total else 0.0,
        "changed_fields": list(changed.keys()),
        "handle_ms": handle_ms,
        "idempotent": False,
        "version": old_version + 1,
    }


def ops_counts() -> dict:
    """给 /metrics 用的计数快照。缺表时返回 0，不影响服务。"""
    out: dict = {"review": {}, "batch": {}, "items": {}, "learn": {},
                 "outbox": {}, "users_active": 0, "sessions_active": 0,
                 "runs": 0, "runs_confirmed": 0, "feedback_changed": 0}
    with _conn() as conn:
        def scalar(sql: str, args=()):
            try:
                row = conn.execute(sql, args).fetchone()
                return (next(iter(row.values())) if row else 0) or 0
            except Exception:  # noqa: BLE001
                return 0

        out["runs"] = scalar("SELECT COUNT(*) FROM runs")
        out["runs_confirmed"] = scalar("SELECT COUNT(*) FROM runs WHERE confirmed=1")
        out["feedback_changed"] = scalar("SELECT COUNT(*) FROM feedback WHERE changed=1")
        for row in conn.execute(
            "SELECT review_level, COUNT(*) n FROM runs GROUP BY review_level"
        ):
            out["review"][row["review_level"] or "unknown"] = row["n"]
        out["batch"]["total"] = scalar("SELECT COUNT(*) FROM batches")
        for row in conn.execute("SELECT status, COUNT(*) n FROM batch_items GROUP BY status"):
            out["items"][row["status"] or "unknown"] = row["n"]
        for row in conn.execute("SELECT status, COUNT(*) n FROM learn_queue GROUP BY status"):
            out["learn"][row["status"] or "unknown"] = row["n"]
        for row in conn.execute("SELECT status, COUNT(*) n FROM delivery_outbox GROUP BY status"):
            out["outbox"][row["status"] or "unknown"] = row["n"]
        out["users_active"] = scalar("SELECT COUNT(*) FROM users WHERE active=1")
        out["sessions_active"] = scalar(
            "SELECT COUNT(*) FROM user_sessions WHERE revoked=0 AND expires_at > ?",
            (int(time.time()),),
        )
    return out


def metrics(baseline_sec: float = 180.0) -> dict:
    """指标中心：这是第 6 个月老板问"省了多少"时，唯一能拿出来的东西。"""
    with _conn() as conn:
        r = conn.execute(
            "SELECT COUNT(*) n,"
            " COALESCE(SUM(tokens),0) tokens,"
            " COALESCE(AVG(elapsed_ms),0) avg_ms,"
            " COALESCE(SUM(CASE WHEN review_level='auto' THEN 1 ELSE 0 END),0) auto_n,"
            " COALESCE(SUM(CASE WHEN review_level='single' THEN 1 ELSE 0 END),0) single_n,"
            " COALESCE(SUM(CASE WHEN review_level='double' THEN 1 ELSE 0 END),0) double_n,"
            " COALESCE(SUM(CASE WHEN review_level='blocked' THEN 1 ELSE 0 END),0) blocked_n,"
            " COALESCE(SUM(confirmed),0) confirmed_n,"
            " COALESCE(SUM(forced),0) forced_n,"
            " COALESCE(AVG(handle_ms),0) avg_handle"
            " FROM runs"
        ).fetchone()
        fb = conn.execute(
            "SELECT COUNT(*) n, COALESCE(SUM(changed),0) ch FROM feedback"
        ).fetchone()
        saved = conn.execute(
            "SELECT COALESCE(SUM(CASE WHEN handle_ms / 1000.0 < ?"
            " THEN ? - handle_ms / 1000.0 ELSE 0 END),0) s"
            " FROM runs WHERE handle_ms IS NOT NULL",
            (baseline_sec, baseline_sec),
        ).fetchone()
        daily = conn.execute(
            "SELECT substr(ts,1,10) d, COUNT(*) n, COALESCE(SUM(confirmed),0) c"
            " FROM runs GROUP BY d ORDER BY d DESC LIMIT 30"
        ).fetchall()
        inbound = conn.execute(
            "SELECT COUNT(*) n,"
            " COALESCE(SUM(CASE WHEN i.run_id IS NOT NULL AND r.confirmed=1 THEN 1 ELSE 0 END),0) done"
            " FROM inbound i LEFT JOIN runs r ON r.id = i.run_id"
        ).fetchone()

    # 修正率的分母必须是"已确认单的全部非空字段"，不是"被改过的字段"。
    # 否则每次改动都会把修正率推到 100%，看起来像系统全错。
    with _conn() as conn:
        rows = conn.execute(
            "SELECT fields_json FROM runs WHERE confirmed=1"
        ).fetchall()
    filled = 0
    for row in rows:
        try:
            fields = json.loads(row["fields_json"] or "{}")
        except json.JSONDecodeError:
            continue
        filled += sum(1 for v in fields.values() if (v or {}).get("value"))
    changed = fb["ch"] or 0
    correction_rate = round(changed / filled, 4) if filled else 0.0

    in_n = inbound["n"] or 0
    in_done = inbound["done"] or 0
    bypass_rate = round((in_n - in_done) / in_n, 4) if in_n else 0.0
    n = r["n"] or 0
    confirmed = r["confirmed_n"] or 0
    return {
        "tickets_parsed": n,
        "tickets_confirmed": confirmed,
        "tokens": r["tokens"],
        "avg_parse_ms": round(float(r["avg_ms"] or 0), 1),
        "avg_handle_sec": round(float(r["avg_handle"] or 0) / 1000.0, 1) if confirmed else 0,
        "review_levels": {
            "auto": r["auto_n"], "single": r["single_n"],
            "double": r["double_n"], "blocked": r["blocked_n"],
        },
        "auto_pass_rate": round((r["auto_n"] or 0) / n, 4) if n else 0.0,
        "forced_n": r["forced_n"],
        "correction_rate": correction_rate,
        "baseline_manual_sec": baseline_sec,
        "saved_hours": round(float(saved["s"] or 0) / 3600.0, 2),
        "inbound_count": in_n,
        "inbound_confirmed": in_done,
        "bypass_rate": bypass_rate,
        # C4 告警：超过 20% 说明"人挑活"已经影响到实际价值
        "bypass_alert": bypass_rate > 0.2,
        "daily": [dict(x) for x in daily],
    }


def confirmed_tickets(limit: int = 5000) -> list[dict]:
    """导出用：已确认单据的标准字段。"""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT fields_json FROM runs WHERE confirmed=1 ORDER BY ts DESC LIMIT ?",
            (limit,),
        ).fetchall()
    out = []
    for r in rows:
        try:
            fields = json.loads(r["fields_json"] or "{}")
        except json.JSONDecodeError:
            continue
        out.append({k: (v or {}).get("value") or "" for k, v in fields.items()})
    return out


def find_by_booking_no(no: str, limit: int = 800) -> dict | None:
    """按委托单号找最近一张已确认的单（改单要用它当基准）。"""
    target = "".join(ch for ch in (no or "") if ch.isalnum()).upper()
    if not target:
        return None
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id, ts, fields_json FROM runs WHERE confirmed=1 ORDER BY ts DESC LIMIT ?",
            (limit,),
        ).fetchall()
    for r in rows:
        try:
            fields = json.loads(r["fields_json"] or "{}")
        except json.JSONDecodeError:
            continue
        got = ((fields.get("booking_no") or {}).get("value") or "")
        if "".join(ch for ch in got if ch.isalnum()).upper() == target:
            return {
                "run_id": r["id"],
                "ts": r["ts"],
                "fields": {k: (v or {}).get("value") or "" for k, v in fields.items()},
            }
    return None


def enqueue_learn(run_id: str, reason: str) -> None:
    """把"可疑样本"放进标注池。可疑 = 需复核 / 有阻断 / 靠容错抽出来的。"""
    with _conn() as conn:
        conn.execute(
            "INSERT INTO learn_queue (id, run_id, ts, reason, status)"
            " VALUES (?,?,?,?,'pending') ON CONFLICT (id) DO NOTHING",
            (run_id, run_id, _now(), reason),
        )


def learn_reason(draft: Draft) -> str | None:
    """判断这一单值不值得进标注池。"""
    if draft.review_level == "blocked":
        return "blocked"
    if any((v.source or "").startswith("fuzzy") for v in draft.fields.values()):
        return "fuzzy_match"
    if draft.review_level == "double":
        return "low_confidence"
    if "检测到" in (draft.note or "") and "票" in (draft.note or ""):
        return "multi_ticket"
    return None


def label_run(run_id: str, gold: dict[str, str], reason: str = "confirmed",
              corrected: bool = False, actor: str = "") -> None:
    """人工确认 = 一条金标。这是"越用越准"的唯一来源。

    corrected=True 表示人改过——这类才是真正的难例；
    人直接点确认的，说明系统本来就对，价值在于"覆盖了新格式"，不在于提分。
    """
    gold_json = json.dumps({k: v for k, v in gold.items() if v}, ensure_ascii=False)
    ts = _now()
    with _conn() as conn:
        cur = conn.execute(
            "UPDATE learn_queue SET status='labeled', gold_json=?, labeled_at=?,"
            " corrected=?, labeled_by=? WHERE id=?",
            (gold_json, ts, 1 if corrected else 0, actor, run_id),
        )
        if cur.rowcount == 0:
            conn.execute(
                "INSERT INTO learn_queue"
                " (id, run_id, ts, reason, status, gold_json, labeled_at,"
                " corrected, labeled_by) VALUES (?,?,?,?,'labeled',?,?,?,?)"
                " ON CONFLICT (id) DO UPDATE SET status='labeled',"
                " gold_json=EXCLUDED.gold_json, labeled_at=EXCLUDED.labeled_at,"
                " corrected=EXCLUDED.corrected, labeled_by=EXCLUDED.labeled_by",
                (run_id, run_id, ts, reason, gold_json, ts,
                 1 if corrected else 0, actor),
            )


def learn_item(run_id: str) -> dict | None:
    """标注工作台需要的一条完整数据：原文、系统抽取、现有金标。"""
    with _conn() as conn:
        q = conn.execute(
            "SELECT q.id, q.run_id, q.ts, q.reason, q.status, q.gold_json,"
            " q.labeled_at, q.corrected, q.labeled_by,"
            " r.raw_text, r.fields_json, r.kind, r.review_level, r.confirmed,"
            " r.errors, r.warns, u.name AS labeler_name, u.email AS labeler_email,"
            " COALESCE((SELECT i.source FROM inbound i WHERE i.run_id=q.run_id"
            " ORDER BY i.ts DESC LIMIT 1),'') AS source,"
            " COALESCE((SELECT b.name FROM batch_items bi"
            " JOIN batches b ON b.id=bi.batch_id"
            " WHERE bi.run_id=q.run_id LIMIT 1),'') AS batch_name"
            " FROM learn_queue q JOIN runs r ON r.id = q.run_id"
            " LEFT JOIN users u ON u.id = q.labeled_by WHERE q.id=?",
            (run_id,),
        ).fetchone()
    if not q:
        return None
    d = dict(q)
    d["fields"] = json.loads(d.pop("fields_json") or "{}")
    try:
        d["gold"] = json.loads(d.pop("gold_json") or "null")
    except json.JSONDecodeError:
        d["gold"] = None
    d.pop("raw_text_full", None)
    return d


def label_item(run_id: str, gold: dict[str, str], actor: str = "",
               note: str = "") -> dict:
    """人工标注一条金标（B1）。

    corrected 由系统自动判断：金标与系统抽取值有差异 = 难例。
    这个标记直接决定导出到评测集时它是"提分样本"还是"覆盖新格式"。
    """
    if not isinstance(gold, dict):
        raise ValueError("gold 必须是对象")
    gold = {str(k): str(v or "").strip() for k, v in gold.items()}
    gold = {k: v for k, v in gold.items() if v}

    with _conn() as conn:
        row = conn.execute(
            "SELECT q.status, q.gold_json, r.fields_json"
            " FROM learn_queue q JOIN runs r ON r.id=q.run_id WHERE q.id=?",
            (run_id,),
        ).fetchone()
        if not row:
            raise LookupError("未找到该标注项")
        try:
            auto = json.loads(row["fields_json"] or "{}")
        except json.JSONDecodeError:
            auto = {}
        auto_vals = {k: (v or {}).get("value") or "" for k, v in auto.items()}
        corrected = any(auto_vals.get(k, "") != v for k, v in gold.items())
        try:
            old_gold = json.loads(row["gold_json"]) if row["gold_json"] else None
        except json.JSONDecodeError:
            old_gold = None

        ts = _now()
        conn.execute(
            "UPDATE learn_queue SET status='labeled', gold_json=?, labeled_at=?,"
            " corrected=?, labeled_by=? WHERE id=?",
            (json.dumps(gold, ensure_ascii=False), ts,
             1 if corrected else 0, actor, run_id),
        )
        _record_revision(
            conn, run_id, "label", actor,
            before={"status": row["status"], "gold": old_gold},
            after={"status": "labeled", "gold": gold},
            note=note,
        )

    return {"ok": True, "id": run_id, "status": "labeled",
            "corrected": corrected, "fields": len(gold)}


def ignore_item(run_id: str, actor: str = "", note: str = "") -> dict:
    """跳过一条：不进训练集，但从待标注里移除。"""
    with _conn() as conn:
        row = conn.execute(
            "SELECT status FROM learn_queue WHERE id=?", (run_id,)
        ).fetchone()
        if not row:
            raise LookupError("未找到该标注项")
        conn.execute("UPDATE learn_queue SET status='ignored' WHERE id=?", (run_id,))
        _record_revision(
            conn, run_id, "ignore", actor,
            before={"status": row["status"]},
            after={"status": "ignored"}, note=note,
        )
    return {"ok": True, "id": run_id, "status": "ignored"}


def _learn_filter_sql(source: str = "", batch_id: str = "") -> tuple[str, list]:
    """学习队列/统计的公共筛选条件。

    - source: 按 inbound.source 过滤；`__none__` 表示没有来单记录的单
    - batch_id: 按批次过滤（通过 batch_items.run_id 关联）
    """
    where = ""
    args: list = []
    if source == "__none__":
        where += " AND NOT EXISTS (SELECT 1 FROM inbound i WHERE i.run_id=q.run_id)"
    elif source:
        where += (
            " AND EXISTS (SELECT 1 FROM inbound i"
            " WHERE i.run_id=q.run_id AND i.source=?)"
        )
        args.append(source)
    if batch_id:
        where += (
            " AND EXISTS (SELECT 1 FROM batch_items bi"
            " WHERE bi.run_id=q.run_id AND bi.batch_id=?)"
        )
        args.append(batch_id)
    return where, args


def learn_queue(status: str = "pending", limit: int = 100,
                source: str = "", batch_id: str = "") -> list[dict]:
    extra, fargs = _learn_filter_sql(source, batch_id)
    sql = (
        "SELECT q.id, q.run_id, q.ts, q.reason, q.status, q.gold_json,"
        " q.corrected, q.labeled_by, u.name AS labeler_name,"
        " r.kind, r.review_level, r.engine, substr(r.raw_text,1,80) AS preview,"
        " COALESCE((SELECT i.source FROM inbound i WHERE i.run_id=q.run_id"
        " ORDER BY i.ts DESC LIMIT 1),'') AS source,"
        " COALESCE((SELECT bi.batch_id FROM batch_items bi"
        " WHERE bi.run_id=q.run_id LIMIT 1),'') AS batch_id,"
        " COALESCE((SELECT b.name FROM batch_items bi"
        " JOIN batches b ON b.id=bi.batch_id"
        " WHERE bi.run_id=q.run_id LIMIT 1),'') AS batch_name"
        " FROM learn_queue q LEFT JOIN runs r ON r.id = q.run_id"
        " LEFT JOIN users u ON u.id = q.labeled_by"
        " WHERE q.status = ?" + extra +
        " ORDER BY q.ts DESC LIMIT ?"
    )
    with _conn() as conn:
        rows = conn.execute(sql, [status] + fargs + [limit]).fetchall()
    return [dict(r) for r in rows]


def learn_stats(source: str = "", batch_id: str = "") -> dict:
    extra, fargs = _learn_filter_sql(source, batch_id)
    with _conn() as conn:
        rows = conn.execute(
            "SELECT status, reason, COUNT(*) n, COALESCE(SUM(corrected),0) c"
            " FROM learn_queue q WHERE 1=1" + extra +
            " GROUP BY status, reason",
            fargs,
        ).fetchall()
    out = {"pending": 0, "labeled": 0, "ignored": 0, "corrected": 0, "by_reason": {}}
    for r in rows:
        out[r["status"]] = out.get(r["status"], 0) + r["n"]
        if r["status"] == "labeled":
            out["by_reason"][r["reason"]] = r["n"]
            out["corrected"] += r["c"] or 0
    out["total"] = out.get("pending", 0) + out.get("labeled", 0) + out.get("ignored", 0)
    return out


def learn_filter_options() -> dict:
    """标注台的筛选选项：来源与批次，附带当前队列条数。"""
    with _conn() as conn:
        src_rows = conn.execute(
            "SELECT COALESCE(i.source,'') AS source, COUNT(DISTINCT q.id) AS n"
            " FROM learn_queue q LEFT JOIN inbound i ON i.run_id = q.run_id"
            " GROUP BY COALESCE(i.source,'') ORDER BY n DESC"
        ).fetchall()
        batch_rows = conn.execute(
            "SELECT bi.batch_id AS id, b.name AS name, COUNT(DISTINCT q.id) AS n"
            " FROM learn_queue q JOIN batch_items bi ON bi.run_id = q.run_id"
            " JOIN batches b ON b.id = bi.batch_id"
            " GROUP BY bi.batch_id, b.name ORDER BY n DESC"
        ).fetchall()
    return {
        "sources": [dict(r) for r in src_rows],
        "batches": [dict(r) for r in batch_rows],
    }


def learn_export(limit: int = 2000) -> str:
    """导出成评测集格式（JSONL），可直接追加到 samples/ 后被 evalrun 使用。"""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT q.run_id, q.reason, q.gold_json, q.corrected, r.raw_text"
            " FROM learn_queue q JOIN runs r ON r.id = q.run_id"
            " WHERE q.status='labeled' AND q.gold_json IS NOT NULL"
            " ORDER BY q.ts DESC LIMIT ?",
            (limit,),
        ).fetchall()
    lines = []
    for r in rows:
        try:
            gold = json.loads(r["gold_json"])
        except json.JSONDecodeError:
            continue
        lines.append(json.dumps({
            "id": r["run_id"],
            "title": f"真实{'修正' if r['corrected'] else '确认'} · {r['reason']}",
            "raw": r["raw_text"] or "",
            "gold": gold,
            "corrected": bool(r["corrected"]),
        }, ensure_ascii=False))
    return "\n".join(lines)


def find_amend_candidates(fields: dict, days: int = 3, limit: int = 5) -> list[dict]:
    """B1：客户没写原单号时，按"箱号 / 客户 + 近 N 天"反查原单。

    只给候选，不替用户决定——猜错比不猜更糟。
    """
    def norm(s: str) -> str:
        return "".join(ch for ch in (s or "") if ch.isalnum()).upper()

    mine = {x for x in re.split(r"[,，、;；\s]+", fields.get("container_no") or "") if x}
    mine = {norm(x) for x in mine}
    client = norm(fields.get("client") or "")
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds")
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id, ts, fields_json FROM runs WHERE confirmed=1 AND ts >= ?"
            " ORDER BY ts DESC LIMIT 200",
            (since,),
        ).fetchall()

    out = []
    for r in rows:
        try:
            f = json.loads(r["fields_json"] or "{}")
        except json.JSONDecodeError:
            continue
        vals = {k: ((v or {}).get("value") or "") for k, v in f.items()}
        theirs = {norm(x) for x in re.split(r"[,，、;；\s]+", vals.get("container_no", "")) if x}

        # 客户名用包含匹配：抽取时可能把"这票有变"粘在客户名后面
        theirs_client = norm(vals.get("client", ""))
        same_client = bool(client and theirs_client and min(len(client), len(theirs_client)) >= 4
                           and (client in theirs_client or theirs_client in client))

        score, why = 0.0, []
        if mine and theirs and (mine & theirs):
            score += 0.9
            why.append("箱号一致")
        if same_client:
            score += 0.6
            why.append("客户一致")
        if score <= 0:
            continue
        out.append({
            "run_id": r["id"],
            "ts": r["ts"],
            "score": round(min(1.0, score), 2),
            "reason": "+".join(why),
            "booking_no": vals.get("booking_no", ""),
            "client": vals.get("client", ""),
            "container_no": vals.get("container_no", ""),
            "fields": vals,
        })

    out.sort(key=lambda x: (-x["score"], x["ts"]))
    return out[:limit]


def create_batch(name: str, note: str = "", kind: str = "booking") -> dict:
    batch_id = uuid.uuid4().hex[:12]
    kind = kind if kind in {"booking", "invoice"} else "booking"
    with _conn() as conn:
        conn.execute(
            "INSERT INTO batches (id, name, note, kind, created_at) VALUES (?,?,?,?,?)",
            (batch_id, name, note, kind, _now()),
        )
    return {"id": batch_id, "name": name, "note": note, "kind": kind}


def add_batch_items(batch_id: str, filenames: list[str]) -> list[dict]:
    out = []
    with _conn() as conn:
        for fn in filenames:
            item_id = uuid.uuid4().hex[:12]
            conn.execute(
                "INSERT INTO batch_items (id, batch_id, filename, status, updated_at)"
                " VALUES (?,?,?,'pending',?)",
                (item_id, batch_id, fn, _now()),
            )
            out.append({"id": item_id, "filename": fn})
    return out


def update_item(item_id: str, status: str, **fields) -> None:
    allowed = {"run_id", "error", "path", "note"}
    sets = ["status=?", "updated_at=?"]
    vals: list = [status, _now()]
    for k, v in fields.items():
        if k in allowed:
            sets.append(f"{k}=?")
            vals.append(v)
    vals.append(item_id)
    with _conn() as conn:
        conn.execute(f"UPDATE batch_items SET {', '.join(sets)} WHERE id=?", vals)


def batch_items(batch_id: str, status: str | None = None) -> list[dict]:
    sql = "SELECT * FROM batch_items WHERE batch_id=?"
    args: list = [batch_id]
    if status:
        sql += " AND status=?"
        args.append(status)
    sql += f" ORDER BY {db.ROW_ORDER}"
    with _conn() as conn:
        return [dict(r) for r in conn.execute(sql, args).fetchall()]


def get_batch(batch_id: str) -> dict | None:
    with _conn() as conn:
        row = conn.execute("SELECT * FROM batches WHERE id=?", (batch_id,)).fetchone()
    return dict(row) if row else None


def list_batches(limit: int = 50) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT b.id, b.name, COALESCE(b.kind,'booking') kind, b.created_at,"
            " (SELECT COUNT(*) FROM batch_items i WHERE i.batch_id=b.id) total,"
            " (SELECT COUNT(*) FROM batch_items i WHERE i.batch_id=b.id AND i.status='extracted') done,"
            " (SELECT COUNT(*) FROM batch_items i WHERE i.batch_id=b.id AND i.status='failed') failed"
            " FROM batches b ORDER BY b.created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def failed_items(limit: int = 500) -> list[dict]:
    """B7：跨批次的失败队列，避免要一个批次一个批次去翻。"""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT i.id, i.batch_id, b.name AS batch_name, i.filename, i.error, i.updated_at"
            " FROM batch_items i LEFT JOIN batches b ON b.id = i.batch_id"
            " WHERE i.status='failed' ORDER BY i.updated_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def requeue_failed(batch_id: str | None = None) -> int:
    """把失败项重新排回 pending。batch_id 为空时处理全部批次。"""
    with _conn() as conn:
        if batch_id:
            cur = conn.execute(
                "UPDATE batch_items SET status='pending', error=NULL, updated_at=?"
                " WHERE status='failed' AND batch_id=?",
                (_now(), batch_id),
            )
        else:
            cur = conn.execute(
                "UPDATE batch_items SET status='pending', error=NULL, updated_at=?"
                " WHERE status='failed'",
                (_now(),),
            )
    return cur.rowcount


def confirmed_waybills(limit: int = 5000) -> list[dict]:
    """对账用：系统里已确认的运单（托书类）。"""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id, ts, fields_json FROM runs"
            " WHERE confirmed=1 AND COALESCE(kind,'booking')='booking'"
            " ORDER BY ts DESC LIMIT ?",
            (limit,),
        ).fetchall()
    out = []
    for r in rows:
        try:
            f = json.loads(r["fields_json"] or "{}")
        except json.JSONDecodeError:
            continue
        out.append({
            "run_id": r["id"],
            "ts": r["ts"],
            "booking_no": (f.get("booking_no") or {}).get("value") or "",
            "container_no": (f.get("container_no") or {}).get("value") or "",
            "client": (f.get("client") or {}).get("value") or "",
            "freight": (f.get("freight") or {}).get("value") or "",
        })
    return out


# ---------------- 用户与会话（A1） ----------------

def create_user(email: str, name: str, role: str, pw_hash: str, pw_salt: str) -> str:
    uid = uuid.uuid4().hex[:12]
    with _conn() as conn:
        conn.execute(
            "INSERT INTO users (id, email, name, role, pw_hash, pw_salt, active, created_at)"
            " VALUES (?,?,?,?,?,?,1,?)",
            (uid, email.strip().lower(), name, role, pw_hash, pw_salt, _now()),
        )
    return uid


def get_user_by_email(email: str) -> dict | None:
    with _conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE email=?", (email.strip().lower(),)).fetchone()
    return dict(row) if row else None


def get_user(uid: str) -> dict | None:
    with _conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    return dict(row) if row else None


def list_users() -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id, email, name, role, active, created_at, last_login"
            " FROM users ORDER BY created_at"
        ).fetchall()
    return [dict(r) for r in rows]


def update_user(uid: str, **fields) -> None:
    allowed = {"name", "role", "active"}
    sets, vals = [], []
    for k, v in fields.items():
        if k in allowed and v is not None:
            sets.append(f"{k}=?")
            vals.append(v)
    if not sets:
        return
    vals.append(uid)
    with _conn() as conn:
        conn.execute(f"UPDATE users SET {', '.join(sets)} WHERE id=?", vals)


def set_password(uid: str, pw_hash: str, pw_salt: str) -> None:
    with _conn() as conn:
        conn.execute("UPDATE users SET pw_hash=?, pw_salt=? WHERE id=?", (pw_hash, pw_salt, uid))


def touch_login(uid: str) -> None:
    with _conn() as conn:
        conn.execute("UPDATE users SET last_login=? WHERE id=?", (_now(), uid))


def count_users() -> int:
    with _conn() as conn:
        return conn.execute("SELECT COUNT(*) c FROM users").fetchone()["c"]


# ---------------- 登录失败锁定（D3） ----------------

def login_locked(key: str) -> int:
    """返回剩余锁定秒数；0 表示未锁定。"""
    with _conn() as conn:
        row = conn.execute(
            "SELECT locked_until FROM login_attempts WHERE key=?", (key,)
        ).fetchone()
    if not row or not row["locked_until"]:
        return 0
    try:
        until = datetime.fromisoformat(row["locked_until"])
    except ValueError:
        return 0
    remain = int((until - datetime.now(timezone.utc)).total_seconds())
    return max(0, remain)


def record_login_failure(key: str, max_fails: int = 5, lock_seconds: int = 900,
                         window_seconds: int = 900) -> int:
    """记一次失败；达到阈值返回锁定秒数，否则 0。"""
    now = datetime.now(timezone.utc)
    ts = now.isoformat(timespec="seconds")
    with _conn() as conn:
        row = conn.execute(
            "SELECT fails, first_at FROM login_attempts WHERE key=?", (key,)
        ).fetchone()
        if not row:
            conn.execute(
                "INSERT INTO login_attempts (key, fails, first_at, locked_until)"
                " VALUES (?,1,?,NULL)", (key, ts),
            )
            return 0
        try:
            first = datetime.fromisoformat(row["first_at"])
        except ValueError:
            first = now
        if (now - first).total_seconds() > window_seconds:
            conn.execute(
                "UPDATE login_attempts SET fails=1, first_at=?, locked_until=NULL"
                " WHERE key=?", (ts, key),
            )
            return 0
        fails = int(row["fails"] or 0) + 1
        locked_until = None
        if fails >= max_fails:
            locked_until = (now + timedelta(seconds=lock_seconds)).isoformat(timespec="seconds")
        conn.execute(
            "UPDATE login_attempts SET fails=?, locked_until=? WHERE key=?",
            (fails, locked_until, key),
        )
    return lock_seconds if locked_until else 0


def clear_login_failures(key: str) -> None:
    with _conn() as conn:
        conn.execute("DELETE FROM login_attempts WHERE key=?", (key,))


def create_session(jti: str, user_id: str, expires_at: int, ua: str = "", ip: str = "") -> None:
    with _conn() as conn:
        conn.execute(
            "INSERT INTO user_sessions (jti, user_id, created_at, expires_at, ua, ip)"
            " VALUES (?,?,?,?,?,?)",
            (jti, user_id, _now(), expires_at, ua[:200], ip[:64]),
        )


def session_valid(jti: str) -> bool:
    with _conn() as conn:
        row = conn.execute(
            "SELECT revoked, expires_at FROM user_sessions WHERE jti=?", (jti,)
        ).fetchone()
    if not row:
        return False
    import time as _t
    return not row["revoked"] and row["expires_at"] > int(_t.time())


def revoke_session(jti: str) -> None:
    with _conn() as conn:
        conn.execute("UPDATE user_sessions SET revoked=1 WHERE jti=?", (jti,))


def revoke_user_sessions(user_id: str, except_jti: str = "") -> int:
    with _conn() as conn:
        if except_jti:
            cur = conn.execute(
                "UPDATE user_sessions SET revoked=1 WHERE user_id=? AND jti<>? AND revoked=0",
                (user_id, except_jti),
            )
        else:
            cur = conn.execute(
                "UPDATE user_sessions SET revoked=1 WHERE user_id=? AND revoked=0", (user_id,)
            )
    return cur.rowcount


# ---------------- 多实例任务队列（D7） ----------------

def enqueue_job(kind: str, ref_id: str, params: dict | None = None) -> dict | None:
    """入队（幂等）。已有活跃任务时返回 None，避免重复跑。"""
    now = _now()
    epoch = int(time.time())
    params_json = json.dumps(params or {}, ensure_ascii=False)
    with _conn() as conn:
        row = conn.execute(
            "INSERT INTO jobs (id, kind, ref_id, status, created_at, updated_at,"
            " params_json) VALUES (?,?,?,'pending',?,?,?)"
            " ON CONFLICT (kind, ref_id) DO UPDATE SET"
            " status='pending', worker=NULL, lease_until=NULL,"
            " last_error=NULL, params_json=EXCLUDED.params_json, updated_at=?"
            " WHERE jobs.status IN ('pending','done','failed')"
            " OR (jobs.status='running' AND jobs.lease_until < ?)"
            " RETURNING *",
            (uuid.uuid4().hex[:12], kind, ref_id, now, now, params_json, now, epoch),
        ).fetchone()
    return dict(row) if row else None


def claim_job(worker: str, lease_seconds: int = 90) -> dict | None:
    """抢占一个任务。两个实例同时抢，只有一个 rowcount=1。"""
    now = int(time.time())
    until = now + lease_seconds
    ts = _now()
    for _ in range(3):
        with _conn() as conn:
            row = conn.execute(
                "SELECT id FROM jobs WHERE status='pending'"
                " OR (status='running' AND lease_until < ?)"
                " ORDER BY created_at LIMIT 1", (now,)
            ).fetchone()
            if not row:
                return None
            cur = conn.execute(
                "UPDATE jobs SET status='running', worker=?, lease_until=?,"
                " attempts=attempts+1, updated_at=?"
                " WHERE id=? AND (status='pending'"
                " OR (status='running' AND lease_until < ?))",
                (worker, until, ts, row["id"], now),
            )
            if cur.rowcount:
                return dict(conn.execute(
                    "SELECT * FROM jobs WHERE id=?", (row["id"],)
                ).fetchone())
    return None


def renew_job(job_id: str, worker: str, lease_seconds: int = 90) -> None:
    with _conn() as conn:
        conn.execute(
            "UPDATE jobs SET lease_until=?, updated_at=?"
            " WHERE id=? AND worker=? AND status='running'",
            (int(time.time()) + lease_seconds, _now(), job_id, worker),
        )


def finish_job(job_id: str, worker: str, status: str = "done",
               error: str = "") -> None:
    with _conn() as conn:
        conn.execute(
            "UPDATE jobs SET status=?, lease_until=NULL, last_error=?, updated_at=?"
            " WHERE id=? AND worker=?",
            (status, error[:1000], _now(), job_id, worker),
        )


def job_active(kind: str, ref_id: str) -> bool:
    now = int(time.time())
    with _conn() as conn:
        row = conn.execute(
            "SELECT 1 FROM jobs WHERE kind=? AND ref_id=?"
            " AND (status='pending' OR (status='running' AND lease_until >= ?))",
            (kind, ref_id, now),
        ).fetchone()
    return bool(row)


def get_job(kind: str, ref_id: str) -> dict | None:
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM jobs WHERE kind=? AND ref_id=?", (kind, ref_id)
        ).fetchone()
    return dict(row) if row else None


def list_jobs(limit: int = 100) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id, kind, ref_id, status, worker, lease_until, attempts,"
            " last_error, created_at, updated_at FROM jobs"
            " ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in rows]


def set_batch_status(batch_id: str, status: str,
                     cancel_requested: int | None = None) -> None:
    sets = ["status=?"]
    args: list = [status]
    if cancel_requested is not None:
        sets.append("cancel_requested=?")
        args.append(cancel_requested)
    args.append(batch_id)
    with _conn() as conn:
        conn.execute(f"UPDATE batches SET {', '.join(sets)} WHERE id=?", args)


def batch_cancel_requested(batch_id: str) -> bool:
    with _conn() as conn:
        row = conn.execute(
            "SELECT cancel_requested FROM batches WHERE id=?", (batch_id,)
        ).fetchone()
    return bool(row and row["cancel_requested"])


# ---------------- 回写交付平台（B4） ----------------

def outbox_add(idempotency_key: str, payload: dict, experiment_id: str = "",
               dataset_name: str = "") -> tuple[dict, bool]:
    """入发件箱。返回 (记录, 是否新建)。同一幂等键只入一次。"""
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM delivery_outbox WHERE idempotency_key=?",
            (idempotency_key,),
        ).fetchone()
        if row:
            # 永久失败（契约/配置问题）修好后允许重新排队；已发送的保持原样
            if row["status"] == "failed":
                conn.execute(
                    "UPDATE delivery_outbox SET status='pending', last_error=''"
                    " WHERE id=?", (row["id"],)
                )
                row = conn.execute(
                    "SELECT * FROM delivery_outbox WHERE id=?", (row["id"],)
                ).fetchone()
            return dict(row), False
        oid = uuid.uuid4().hex[:12]
        conn.execute(
            "INSERT INTO delivery_outbox (id, created_at, idempotency_key,"
            " experiment_id, dataset_name, payload_json, status)"
            " VALUES (?,?,?,?,?,?,'pending')",
            (oid, _now(), idempotency_key, experiment_id, dataset_name,
             json.dumps(payload, ensure_ascii=False)),
        )
        row = conn.execute("SELECT * FROM delivery_outbox WHERE id=?", (oid,)).fetchone()
    return dict(row), True


def outbox_claim(worker: str, limit: int = 20,
                 lease_seconds: int = 120) -> list[dict]:
    """抢占待发送项（多实例安全）。"""
    now = int(time.time())
    until = now + lease_seconds
    claimed: list[dict] = []
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id FROM delivery_outbox"
            " WHERE status='pending' OR (status='sending' AND lease_until < ?)"
            " ORDER BY created_at LIMIT ?", (now, limit)
        ).fetchall()
        for row in rows:
            cur = conn.execute(
                "UPDATE delivery_outbox SET status='sending', worker=?, lease_until=?"
                " WHERE id=? AND (status='pending'"
                " OR (status='sending' AND lease_until < ?))",
                (worker, until, row["id"], now),
            )
            if cur.rowcount:
                got = conn.execute(
                    "SELECT * FROM delivery_outbox WHERE id=?", (row["id"],)
                ).fetchone()
                claimed.append(dict(got))
    return claimed


def outbox_pending(limit: int = 20) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM delivery_outbox WHERE status='pending'"
            " ORDER BY created_at LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in rows]


def outbox_mark(oid: str, status: str, error: str = "",
                response: dict | None = None) -> None:
    with _conn() as conn:
        conn.execute(
            "UPDATE delivery_outbox SET status=?, attempts=attempts+1,"
            " last_error=?, response_json=COALESCE(?, response_json),"
            " sent_at=CASE WHEN ?='sent' THEN ? ELSE sent_at END,"
            " worker=NULL, lease_until=NULL WHERE id=?",
            (status, error[:1000], json.dumps(response, ensure_ascii=False)
             if response is not None else None, status, _now(), oid),
        )


def outbox_status(limit: int = 20) -> dict:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT status, COUNT(*) n FROM delivery_outbox GROUP BY status"
        ).fetchall()
        recent = conn.execute(
            "SELECT id, created_at, idempotency_key, dataset_name, status,"
            " attempts, last_error, sent_at FROM delivery_outbox"
            " ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
    counts = {"pending": 0, "sending": 0, "sent": 0, "failed": 0}
    for r in rows:
        counts[r["status"]] = r["n"]
    return {"counts": counts, "recent": [dict(r) for r in recent]}


def audit(run_id: str) -> dict:
    """C2：还原一张单的完整链路——谁、何时、用什么版本、改了什么。"""
    with _conn() as conn:
        r = conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        if not r:
            return {}
        fb = conn.execute(
            "SELECT field, auto_value, final_value, ts FROM feedback"
            " WHERE run_id=? ORDER BY ts",
            (run_id,),
        ).fetchall()
    row = dict(r)
    try:
        row["fields"] = json.loads(row.pop("fields_json") or "{}")
    except json.JSONDecodeError:
        row["fields"] = {}
    row["corrections"] = [dict(x) for x in fb]
    row["revisions"] = revisions(run_id)
    return row


def audit_csv(limit: int = 1000) -> str:
    """C2：把"改了什么"导出成表格，交给客户或内部复核。"""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT r.id AS run_id, r.ts, r.engine, r.model, r.prompt_ver, r.pipeline_ver,"
            " r.review_level, r.confirmed, f.field, f.auto_value, f.final_value"
            " FROM runs r LEFT JOIN feedback f ON f.run_id = r.id AND f.changed = 1"
            " ORDER BY r.ts DESC LIMIT ?",
            (limit,),
        ).fetchall()
    head = ["run_id", "ts", "engine", "model", "prompt_ver", "pipeline_ver",
            "review_level", "confirmed", "field", "auto_value", "final_value"]
    lines = [",".join(head)]
    for x in rows:
        d = dict(x)
        lines.append(",".join(
            '"%s"' % str(d.get(c, "") if d.get(c) is not None else "").replace('"', '""')
            for c in head
        ))
    return "\n".join(lines)


def risk_sim(monthly_tickets: int, penalty: float, threshold: float,
             hourly_cost: float = 45.0, baseline_sec: float = 180.0) -> dict:
    """C5 风险模拟：如果取消人工确认，会怎样？

    不辩论，直接算给老板看。
    口径：
    - 用已确认的单当样本，看"若按 threshold 自动通过"会放过哪些**实际被人改过**的单
    - 错单率 = 被放过的错单 / 被放过的总单
    - 月损失 = 月票量 × 错单率 × 单次罚款
    - 省下的成本 = 月票量 × 自动通过率 × 单票确认耗时 × 时薪
    """
    with _conn() as conn:
        rows = conn.execute(
            "SELECT r.id, r.fields_json, r.handle_ms, r.review_level,"
            " (SELECT COUNT(*) FROM feedback f WHERE f.run_id=r.id AND f.changed=1) AS chg"
            " FROM runs r WHERE r.confirmed=1"
        ).fetchall()

    total = auto_pass = bad_auto = 0
    handle_sum = 0
    handle_n = 0

    for row in rows:
        try:
            fields = json.loads(row["fields_json"] or "{}")
        except json.JSONDecodeError:
            continue
        if not any((fields.get(k) or {}).get("value") for k in RISK_KEYS):
            continue
        total += 1
        # 与 C1 保持同一口径：能不能直过，看分级审批结果，而不是另算一套阈值
        if row["review_level"] == "auto":
            auto_pass += 1
            if row["chg"]:
                bad_auto += 1
        if row["handle_ms"]:
            handle_sum += row["handle_ms"]
            handle_n += 1

    if total == 0:
        return {"ok": False, "reason": "还没有已确认的单，无法测算"}

    if auto_pass == 0:
        return {
            "ok": False,
            "reason": f"当前 {total} 单里没有一单达到自动通过阈值（{threshold:.0%}），"
                      "无法测算取消人工确认的后果。需要更多规整样本，或调低阈值再试。",
        }

    auto_rate = auto_pass / total
    # 0 错单不等于 0 风险。用 Laplace 平滑：n 次里 0 次失败，真实错误率的
    # 上界大约是 1/(n+2)，而不是 0。否则会拿 12 个样本替客户背书"可以取消人工"。
    error_rate = (bad_auto + 1) / (auto_pass + 2)
    observed_error_rate = bad_auto / auto_pass if auto_pass else 0.0
    bad_tickets = monthly_tickets * auto_rate * error_rate
    monthly_loss = bad_tickets * penalty
    avg_handle_sec = (handle_sum / handle_n / 1000.0) if handle_n else 60.0
    # 省的是"基线 − 实际"，不是"实际耗时"
    saved_hours = monthly_tickets * auto_rate * max(0.0, baseline_sec - avg_handle_sec) / 3600.0
    saved_money = saved_hours * hourly_cost
    net = saved_money - monthly_loss

    return {
        "ok": True,
        "threshold": threshold,
        "samples": total,
        "auto_pass_rate": round(auto_rate, 4),
        "error_rate_among_auto": round(error_rate, 4),
        "observed_error_rate": round(observed_error_rate, 4),
        "sample_auto_pass": auto_pass,
        "monthly_tickets": monthly_tickets,
        "expected_bad_tickets": round(bad_tickets, 2),
        "penalty_per_error": penalty,
        "expected_monthly_loss": round(monthly_loss, 2),
        "monthly_review_hours_saved": round(saved_hours, 2),
        "monthly_review_cost_saved": round(saved_money, 2),
        "net_monthly": round(net, 2),
        "verdict": (
            "不建议取消人工确认" if net < 0 else
            "可以在小范围试运行，但必须保留抽检" if net < saved_money * 0.3 else
            "数据支持取消大部分人工确认"
        ),
        "basis": "样本为已确认单据；错单率采用 Laplace 平滑（观测 0 错单也不等于 0 风险）。",
    }


def report_md(baseline_sec: float = 180.0, hourly_cost: float = 45.0) -> str:
    m = metrics(baseline_sec)
    saved_money = m["saved_hours"] * hourly_cost
    lines = [
        "# 智单 · 运行月报",
        "",
        f"> 生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M')}",
        f"> 基线口径：人工单票 {baseline_sec:.0f} 秒，人工时薪 {hourly_cost:.0f} 元",
        "",
        "## 一、处理量",
        "",
        "| 指标 | 数值 |",
        "|---|---|",
        f"| 解析票数 | {m['tickets_parsed']} |",
        f"| 已确认票数 | {m['tickets_confirmed']} |",
        f"| 平均出稿耗时 | {m['avg_parse_ms']} ms |",
        f"| 平均确认耗时 | {m['avg_handle_sec']} 秒/单 |",
        "",
        "## 二、分级审批分布（C1）",
        "",
        "| 级别 | 单数 | 说明 |",
        "|---|---|---|",
        f"| 自动通过 | {m['review_levels']['auto']} | 风险字段（箱号/箱型/箱量/截港/电话）全部 ≥90%，无人介入 |",
        f"| 单人确认 | {m['review_levels']['single']} | 有提醒，或风险字段不够确定 |",
        f"| 双人复核 | {m['review_levels']['double']} | 必填或风险字段置信度 <80% |",
        f"| 强行通过 | {m['forced_n']} | 存在阻断项，已留痕 |",
        "",
        f"**自动通过率：{m['auto_pass_rate']:.1%}** —— 这是「省了多少人力」的真正来源。",
        "",
        "## 三、质量",
        "",
        "| 指标 | 数值 |",
        "|---|---|",
        f"| 人工修正率 | {m['correction_rate']:.1%} |",
        "",
        "## 四、价值",
        "",
        "| 项 | 数值 |",
        "|---|---|",
        f"| 累计节省工时 | **{m['saved_hours']} 小时** |",
        f"| 折算金额 | **{saved_money:,.0f} 元** |",
        "",
        "> 计算方式：Σ max(0, 基线 {0:.0f}s − 实际确认耗时)，只统计已确认的票。".format(baseline_sec),
        "",
        "## 五、绕过率（C4）",
        "",
        "| 项 | 数值 |",
        "|---|---|",
        f"| 入口捕获来单 | {m['inbound_count']} |",
        f"| 完成确认 | {m['inbound_confirmed']} |",
        f"| **绕过率** | **{m['bypass_rate']:.1%}** |",
        "",
        ("⚠️ 绕过率超过 20%：说明人只把简单单交给系统，难单自己录了。"
         "**此时上面的『节省工时』是被高估的。**"
         if m["bypass_alert"] else
         "绕过率正常（≤20%）。"),
        "",
        "## 六、说明",
        "",
        "- 基线必须用客户真实工时校准，默认值仅为演示口径。",
        "- 避开「跳过系统」的票不计入本表，因此本表**高估**节省量，需配合绕过率（C4）一起看。",
        "- 本表统计整条链路（OCR + 规则 + 人工确认）相对人工基线的节省，不拆分大模型单独贡献。",
    ]
    return "\n".join(lines)


def stats() -> dict:
    with _conn() as conn:
        runs = conn.execute("SELECT COUNT(*) c, COALESCE(SUM(tokens),0) t, COALESCE(AVG(elapsed_ms),0) e FROM runs").fetchone()
        fb = conn.execute("SELECT COUNT(*) n, COALESCE(SUM(changed),0) ch FROM feedback").fetchone()
    n_fields = fb["n"] or 0
    return {
        "runs": runs["c"],
        "tokens": runs["t"],
        "avg_elapsed_ms": round(runs["e"], 1),
        "feedback_rows": n_fields,
        "corrected_rows": fb["ch"] or 0,
        "correction_rate": round((fb["ch"] or 0) / n_fields, 4) if n_fields else 0.0,
    }


def queue(limit: int = 50) -> list[dict]:
    """人工兜底队列：需复核但还没确认的单（D2 的"低置信转人工"落点）。"""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id, ts, review_level, errors, warns, chars, preview"
            " FROM (SELECT id, ts, review_level, errors, warns, chars,"
            "       substr(raw_text,1,40) AS preview FROM runs"
            "       WHERE confirmed=0 AND review_level IN ('double','blocked'))"
            " ORDER BY ts DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def recent(n: int = 20) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id, ts, engine, chars, elapsed_ms, tokens, errors, warns,"
            " review_level, handle_ms, forced"
            " FROM runs ORDER BY ts DESC LIMIT ?",
            (n,),
        ).fetchall()
    return [dict(r) for r in rows]


def dump_feedback(limit: int = 500) -> str:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT run_id, ts, field, auto_value, final_value FROM feedback"
            " WHERE changed=1 ORDER BY ts DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return json.dumps([dict(r) for r in rows], ensure_ascii=False, indent=2)


def _review_to_dict(row) -> dict:
    d = dict(row)
    for key, default in (
        ("summary_json", "{}"),
        ("document_json", "{}"),
        ("differences_json", "[]"),
        ("decisions_json", "[]"),
    ):
        raw = d.pop(key, None)
        try:
            d[key[:-5]] = json.loads(raw or default)
        except (TypeError, json.JSONDecodeError):
            d[key[:-5]] = json.loads(default)
    return d


def save_pilot_review(
    kind: str,
    document: dict,
    differences: list[dict],
    decisions: list[dict],
    actor: str = "",
    summary: dict | None = None,
    status: str = "confirmed",
) -> dict:
    """保存试点一复核结果；按内容幂等。"""
    material = json.dumps(
        {"kind": kind, "document": document, "differences": differences, "decisions": decisions},
        sort_keys=True,
        ensure_ascii=False,
    )
    key = hashlib.sha256(material.encode("utf-8")).hexdigest()[:32]
    review_id = uuid.uuid4().hex[:12]
    with _conn() as conn:
        existing = conn.execute(
            "SELECT * FROM pilot_reviews WHERE idempotency_key = ?", (key,)
        ).fetchone()
        if existing:
            return {**_review_to_dict(existing), "duplicate": True}
        conn.execute(
            "INSERT INTO pilot_reviews"
            " (id, ts, actor, kind, document_id, status, summary_json, document_json,"
            "  differences_json, decisions_json, idempotency_key)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                review_id,
                _now(),
                actor,
                kind,
                str(document.get("document_id") or ""),
                status,
                json.dumps(summary or {}, ensure_ascii=False),
                json.dumps(document, ensure_ascii=False),
                json.dumps(differences, ensure_ascii=False),
                json.dumps(decisions, ensure_ascii=False),
                key,
            ),
        )
    return {**get_pilot_review(review_id), "duplicate": False}


def get_pilot_review(review_id: str) -> dict | None:
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM pilot_reviews WHERE id = ?", (review_id,)
        ).fetchone()
    return _review_to_dict(row) if row else None


def list_pilot_reviews(limit: int = 50) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM pilot_reviews ORDER BY ts DESC LIMIT ?", (limit,)
        ).fetchall()
    return [_review_to_dict(r) for r in rows]


def mark_pilot_review_delivery(review_id: str, status: str, response: dict | None) -> dict | None:
    with _conn() as conn:
        conn.execute(
            "UPDATE pilot_reviews SET delivery_status = ?, delivery_response = ? WHERE id = ?",
            (status, json.dumps(response or {}, ensure_ascii=False), review_id),
        )
    return get_pilot_review(review_id)
