"""TMS 写回：通用适配层 + 发件箱（AI-26 的可验证部分）。

边界：
- 不假设客户 TMS 的字段名；发给对方的是一份**固定契约**的 JSON。
- 客户只需在自己的适配器里把 `booking.*` 映射到 TMS 字段。
- 真实 TMS 接口文档、鉴权方式、字段映射仍需客户提供；这里证明的是
  发件箱、幂等、重试、4xx/5xx 分类，不是“已对接某家 TMS”。

环境/配置：
- `tms.enabled`、`tms.endpoint`、`tms.token`、`tms.timeout_sec`
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
import uuid
from datetime import datetime, timezone

import httpx

from . import db
from . import thresholds as th

SCHEMA = "ai-copilot/tms-generic-v1"
_worker_started = False


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def enabled() -> bool:
    return th.get_bool("tms.enabled") and bool(th.get_text("tms.endpoint").strip())


def status() -> dict:
    endpoint = th.get_text("tms.endpoint").strip()
    return {
        "enabled": enabled(),
        "endpoint": endpoint,
        "token_set": bool(th.get_text("tms.token").strip()),
        "schema": SCHEMA,
        "outbox": _counts(),
    }


def _counts() -> dict:
    try:
        with db.connect() as conn:
            rows = conn.execute(
                "SELECT status, COUNT(*) n FROM tms_outbox GROUP BY status"
            ).fetchall()
        return {r["status"]: int(r["n"]) for r in rows}
    except Exception:  # noqa: BLE001 — 状态接口不能因为表未建而挂
        return {}


def _run(run_id: str) -> dict:
    with db.connect() as conn:
        row = conn.execute(
            "SELECT id, ts, version, confirmed, confirmed_by, review_level,"
            " fields_json, engine, kind FROM runs WHERE id=?",
            (run_id,),
        ).fetchone()
    if not row:
        raise LookupError("单据不存在")
    if not row["confirmed"]:
        raise ValueError("单据尚未确认，不能推送 TMS")
    return dict(row)


def build_payload(run_id: str) -> dict:
    row = _run(run_id)
    try:
        fields = json.loads(row["fields_json"] or "{}")
    except json.JSONDecodeError:
        fields = {}
    booking = {}
    for key, item in fields.items():
        value = str((item or {}).get("value") or "").strip()
        if value:
            booking[key] = value
    material = json.dumps(
        {"run": row["id"], "version": row["version"], "booking": booking},
        sort_keys=True, ensure_ascii=False,
    )
    key = hashlib.sha256(material.encode("utf-8")).hexdigest()[:32]
    return {
        "schema": SCHEMA,
        "idempotency_key": key,
        "run_id": row["id"],
        "version": int(row["version"] or 0),
        "kind": row["kind"] or "booking",
        "booking": booking,
        "review_level": row["review_level"] or "",
        "confirmed_by": row["confirmed_by"] or "",
        "run_ts": row["ts"],
        "source": "ai-copilot",
    }


def enqueue(run_id: str) -> tuple[dict, bool]:
    if not enabled():
        raise ValueError("TMS 写回未启用或未配置 endpoint")
    payload = build_payload(run_id)
    with db.connect() as conn:
        row = conn.execute(
            "SELECT * FROM tms_outbox WHERE run_id=? AND version=?",
            (run_id, payload["version"]),
        ).fetchone()
        if row:
            # 4xx 失败通常是配置/契约问题；修好后允许重新推送。
            if row["status"] == "failed":
                conn.execute(
                    "UPDATE tms_outbox SET status='pending', last_error='' WHERE id=?",
                    (row["id"],),
                )
                row = conn.execute(
                    "SELECT * FROM tms_outbox WHERE id=?", (row["id"],)
                ).fetchone()
            return dict(row), False
        oid = uuid.uuid4().hex[:12]
        conn.execute(
            "INSERT INTO tms_outbox (id, created_at, run_id, version,"
            " idempotency_key, payload_json, status) VALUES (?,?,?,?,?,?,'pending')",
            (oid, _now(), run_id, payload["version"],
             payload["idempotency_key"], json.dumps(payload, ensure_ascii=False)),
        )
        row = conn.execute("SELECT * FROM tms_outbox WHERE id=?", (oid,)).fetchone()
    return dict(row), True


def _claim(worker: str, limit: int = 20, lease: int = 120) -> list[dict]:
    now = int(time.time())
    until = now + lease
    out = []
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT id FROM tms_outbox WHERE status='pending'"
            " OR (status='sending' AND lease_until < ?) ORDER BY created_at LIMIT ?",
            (now, limit),
        ).fetchall()
        for row in rows:
            cur = conn.execute(
                "UPDATE tms_outbox SET status='sending', worker=?, lease_until=?"
                " WHERE id=? AND (status='pending'"
                " OR (status='sending' AND lease_until < ?))",
                (worker, until, row["id"], now),
            )
            if cur.rowcount:
                got = conn.execute(
                    "SELECT * FROM tms_outbox WHERE id=?", (row["id"],)
                ).fetchone()
                out.append(dict(got))
    return out


def _mark(oid: str, status: str, error: str = "", response: dict | None = None) -> None:
    with db.connect() as conn:
        conn.execute(
            "UPDATE tms_outbox SET status=?, attempts=attempts+1, last_error=?,"
            " response_json=COALESCE(?, response_json),"
            " sent_at=CASE WHEN ?='sent' THEN ? ELSE sent_at END,"
            " worker=NULL, lease_until=NULL WHERE id=?",
            (status, error[:1000],
             json.dumps(response, ensure_ascii=False) if response is not None else None,
             status, _now(), oid),
        )


def _send(payload: dict) -> tuple[str, str, dict | None]:
    endpoint = th.get_text("tms.endpoint").strip()
    token = th.get_text("tms.token").strip()
    timeout = float(th.get("tms.timeout_sec") or 10)
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        resp = httpx.post(endpoint, json=payload, headers=headers, timeout=timeout)
    except Exception as exc:  # noqa: BLE001 — 网络问题可重试
        return "pending", f"{type(exc).__name__}: {exc}", None
    try:
        body = resp.json()
    except ValueError:
        body = None
    if 200 <= resp.status_code < 300:
        return "sent", "", body
    if 400 <= resp.status_code < 500:
        return "failed", f"HTTP {resp.status_code}: {resp.text[:300]}", body
    return "pending", f"HTTP {resp.status_code}: {resp.text[:300]}", body


def flush(limit: int = 20) -> dict:
    if not enabled():
        return {"ok": False, "error": "TMS 写回未启用或未配置 endpoint",
                **status()}
    worker = f"tms-{uuid.uuid4().hex[:6]}"
    sent = failed = pending = 0
    details = []
    for row in _claim(worker, limit):
        try:
            payload = json.loads(row["payload_json"])
        except json.JSONDecodeError:
            _mark(row["id"], "failed", "payload_json 解析失败")
            failed += 1
            continue
        state, error, body = _send(payload)
        _mark(row["id"], state, error, body)
        if state == "sent":
            sent += 1
        elif state == "failed":
            failed += 1
        else:
            pending += 1
        details.append({"id": row["id"], "run_id": row["run_id"],
                        "status": state, "error": error})
    return {"ok": True, "sent": sent, "failed": failed,
            "pending": pending, "details": details}


def send_one(oid: str) -> dict:
    """只发指定发件箱记录，不顺手把别人的待发项一起发掉。"""
    worker = f"tms-{uuid.uuid4().hex[:6]}"
    until = int(time.time()) + 120
    with db.connect() as conn:
        cur = conn.execute(
            "UPDATE tms_outbox SET status='sending', worker=?, lease_until=?"
            " WHERE id=? AND (status='pending'"
            " OR (status='sending' AND lease_until < ?))",
            (worker, until, oid, int(time.time())),
        )
        if not cur.rowcount:
            row = conn.execute("SELECT * FROM tms_outbox WHERE id=?", (oid,)).fetchone()
            return {"status": (row["status"] if row else "missing"),
                    "error": (row["last_error"] if row else "")}
        row = conn.execute("SELECT * FROM tms_outbox WHERE id=?", (oid,)).fetchone()
    try:
        payload = json.loads(row["payload_json"])
    except json.JSONDecodeError:
        _mark(oid, "failed", "payload_json 解析失败")
        return {"status": "failed", "error": "payload_json 解析失败"}
    state, error, body = _send(payload)
    _mark(oid, state, error, body)
    return {"status": state, "error": error}


def push(run_id: str) -> dict:
    row, created = enqueue(run_id)
    state = send_one(row["id"])
    return {"ok": state["status"] == "sent", "created": created,
            "outbox_id": row["id"], "status": state["status"],
            "error": state.get("error", ""), "result": state}


def test_endpoint() -> dict:
    if not th.get_bool("tms.enabled"):
        return {"ok": False, "error": "未启用 TMS 写回"}
    if not th.get_text("tms.endpoint").strip():
        return {"ok": False, "error": "未配置 endpoint"}
    payload = {"schema": SCHEMA, "test": True,
               "message": "智单 TMS 连通性测试，不需要建单"}
    started = time.time()
    state, error, body = _send(payload)
    return {"ok": state == "sent", "status": state, "error": error,
            "response": body, "elapsed_ms": int((time.time() - started) * 1000)}


def recent(limit: int = 20) -> list[dict]:
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT id, created_at, run_id, version, status, attempts,"
            " last_error, sent_at, response_json FROM tms_outbox"
            " ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
    out = []
    for row in rows:
        item = dict(row)
        try:
            item["response"] = json.loads(item.pop("response_json") or "null")
        except json.JSONDecodeError:
            item["response"] = None
        out.append(item)
    return out


def _loop() -> None:
    time.sleep(60)
    while True:
        try:
            if enabled():
                flush(20)
        except Exception:  # noqa: BLE001 — 后台任务不能拖垮服务
            pass
        time.sleep(60)


def start_worker() -> None:
    global _worker_started
    if _worker_started:
        return
    _worker_started = True
    threading.Thread(target=_loop, daemon=True, name="tms-outbox").start()
