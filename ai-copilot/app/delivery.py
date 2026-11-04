"""回写交付平台（B4）。

目标：客户侧跑完评测，结果自动变成交付平台 POC 里的一条运行记录，
不再靠人导出 CSV / 截图再手抄。

协议（与 backend/src/routes/copilot.ts 对应）：
    POST {DELIVERY_PLATFORM_URL}/api/hooks/copilot/eval
    Header: x-copilot-token: {DELIVERY_HOOK_TOKEN}
    Body:   { idempotency_key, experiment_id, dataset_name, config,
              metrics, issues, source }

三个关键设计：
1. **幂等键由内容决定**：同一份评测结果重复推，键相同，平台只建一条 run。
2. **发件箱**：网络不通/平台重启时先落库，后台线程定期重试；
   4xx 视为永久失败（配置/契约问题，重试没意义），5xx 与网络错误继续重试。
3. **不伪造指标**：payload 里的数全部来自 run_all()，并带上样本数与口径警告。

环境变量：
    DELIVERY_PLATFORM_URL   如 http://127.0.0.1:8788
    DELIVERY_HOOK_TOKEN     与平台 COPILOT_HOOK_TOKEN 一致
    DELIVERY_EXPERIMENT_ID  目标 POC 实验 uuid
    DELIVERY_RETRY_SECONDS  后台重试间隔，默认 60
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
import uuid
from urllib.parse import urljoin

import httpx

from .config import settings
from .store import outbox_add, outbox_claim, outbox_mark, outbox_status

PLATFORM_URL = os.getenv("DELIVERY_PLATFORM_URL", "").strip().rstrip("/")
HOOK_TOKEN = os.getenv("DELIVERY_HOOK_TOKEN", "").strip()
EXPERIMENT_ID = os.getenv("DELIVERY_EXPERIMENT_ID", "").strip()
ENGAGEMENT_ID = os.getenv("DELIVERY_ENGAGEMENT_ID", "").strip()
RETRY_SECONDS = int(os.getenv("DELIVERY_RETRY_SECONDS", "60") or 60)
TIMEOUT = float(os.getenv("DELIVERY_TIMEOUT_SECONDS", "20") or 20)

_worker_started = False


def enabled() -> bool:
    return bool(PLATFORM_URL and HOOK_TOKEN and EXPERIMENT_ID)


def config_status() -> dict:
    missing = [k for k, v in (
        ("DELIVERY_PLATFORM_URL", PLATFORM_URL),
        ("DELIVERY_HOOK_TOKEN", HOOK_TOKEN),
        ("DELIVERY_EXPERIMENT_ID", EXPERIMENT_ID),
    ) if not v]
    return {
        "enabled": not missing,
        "url": PLATFORM_URL,
        "experiment_id": EXPERIMENT_ID,
        "missing": missing,
    }


def pilot_config_status() -> dict:
    missing = [k for k, v in (
        ("DELIVERY_PLATFORM_URL", PLATFORM_URL),
        ("DELIVERY_HOOK_TOKEN", HOOK_TOKEN),
    ) if not v]
    return {
        "enabled": not missing,
        "url": PLATFORM_URL,
        "engagement_id": ENGAGEMENT_ID,
        "missing": missing,
    }


def push_pilot_review(review: dict, engagement_id: str | None = None) -> dict:
    """把试点一复核结果推送到交付平台的对账记录。

    与评测回写不同，这里同步返回结果；失败可在页面重试。
    """
    status = pilot_config_status()
    if not status["enabled"]:
        raise ValueError(f"回写未配置：缺少 {', '.join(status['missing'])}")
    engagement = (engagement_id or ENGAGEMENT_ID).strip()
    if not engagement:
        raise ValueError("未指定交付平台项目（engagement_id 或 DELIVERY_ENGAGEMENT_ID）")

    payload = {
        "idempotency_key": review.get("idempotency_key"),
        "engagement_id": engagement,
        "kind": review.get("kind"),
        "document_id": review.get("document_id"),
        "status": review.get("status") or "confirmed",
        "summary": review.get("summary") or {},
        "document": review.get("document") or {},
        "differences": review.get("differences") or [],
        "decisions": review.get("decisions") or [],
        "source": "ai-copilot-pilot",
    }
    url = urljoin(PLATFORM_URL + "/", "api/hooks/copilot/reconcile")
    try:
        resp = httpx.post(
            url, json=payload, timeout=TIMEOUT,
            headers={"x-copilot-token": HOOK_TOKEN},
        )
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "status": "pending", "error": f"{type(exc).__name__}: {exc}", "response": None}

    try:
        body = resp.json()
    except ValueError:
        body = None
    if 200 <= resp.status_code < 300:
        return {"ok": True, "status": "sent", "response": body, "error": ""}
    if 400 <= resp.status_code < 500:
        return {"ok": False, "status": "failed", "response": body,
                "error": f"HTTP {resp.status_code}: {resp.text[:300]}"}
    return {"ok": False, "status": "pending", "response": body,
            "error": f"HTTP {resp.status_code}: {resp.text[:300]}"}


def _payload(eval_result: dict, experiment_id: str) -> dict:
    """把 run_all() 的结果压成平台需要的指标。

    对外只报留出集；调优集放进去仅作对照（平台页面上也标得清楚）。
    """
    tuned = eval_result.get("tuned") or {}
    holdout = eval_result.get("holdout") or tuned
    if not holdout:
        raise ValueError("评测结果为空，无法回写")

    metrics = {
        "samples": holdout.get("samples", 0),
        "evaluated_fields": holdout.get("evaluated_fields", 0),
        "field_accuracy": holdout.get("field_accuracy", 0),
        "blocking_accuracy": holdout.get("blocking_accuracy", 0),
        "record_exact_rate": holdout.get("record_exact_rate", 0),
        "engine": holdout.get("engine", ""),
        "mode": holdout.get("mode", ""),
        "warning": holdout.get("warning", ""),
        "tuned": {
            "samples": tuned.get("samples", 0),
            "field_accuracy": tuned.get("field_accuracy", 0),
            "blocking_accuracy": tuned.get("blocking_accuracy", 0),
            "record_exact_rate": tuned.get("record_exact_rate", 0),
        },
        # 最弱的 5 个字段：顾问一眼看到该补哪里
        "weakest_fields": [
            {"field": f.get("field"), "accuracy": f.get("accuracy"),
             "missing": f.get("missing")}
            for f in (holdout.get("by_field") or [])[:5]
        ],
    }

    versions = {
        "model": settings.model if settings.llm_enabled else "rule-based",
        "merge_policy": os.getenv("MERGE_POLICY", ""),
        "pipeline": os.getenv("PIPELINE_VERSION", ""),
    }
    material = json.dumps(
        {"experiment": experiment_id, "metrics": metrics, "versions": versions},
        sort_keys=True, ensure_ascii=False,
    )
    key = hashlib.sha256(material.encode()).hexdigest()[:32]

    holdout_n = metrics["samples"] or 0
    tuned_n = metrics["tuned"]["samples"] or 0
    return {
        "idempotency_key": key,
        "experiment_id": experiment_id,
        "dataset_name": f"留出集 {holdout_n} 份 / 调优集 {tuned_n} 份",
        "config": (
            f"ai-copilot · {versions['model']} · merge={versions['merge_policy'] or 'default'}"
        ),
        "metrics": metrics,
        "issues": holdout.get("warning", ""),
        "source": "ai-copilot",
    }


def enqueue(eval_result: dict, experiment_id: str | None = None) -> dict:
    """把一次评测结果放进发件箱（幂等）。"""
    exp = (experiment_id or EXPERIMENT_ID).strip()
    if not exp:
        raise ValueError("未配置 DELIVERY_EXPERIMENT_ID，不知道回写到哪个 POC")
    payload = _payload(eval_result, exp)
    row, created = outbox_add(
        payload["idempotency_key"], payload, exp, payload["dataset_name"]
    )
    try:
        previous = json.loads(row.get("response_json") or "null")
    except json.JSONDecodeError:
        previous = None
    return {
        "created": created,
        "outbox_id": row["id"],
        "idempotency_key": payload["idempotency_key"],
        "status": row["status"],
        "previous": previous,
        "payload": payload,
    }


def _send(payload: dict) -> tuple[str, str, dict | None]:
    """返回 (status, error, response)。status ∈ sent / pending / failed。"""
    url = urljoin(PLATFORM_URL + "/", "api/hooks/copilot/eval")
    try:
        resp = httpx.post(
            url, json=payload, timeout=TIMEOUT,
            headers={"x-copilot-token": HOOK_TOKEN},
        )
    except Exception as exc:  # noqa: BLE001 — 网络问题都算可重试
        return "pending", f"{type(exc).__name__}: {exc}", None

    body: dict | None
    try:
        body = resp.json()
    except ValueError:
        body = None

    if 200 <= resp.status_code < 300:
        return "sent", "", body
    if 400 <= resp.status_code < 500:
        # 契约/令牌/参数问题，重试不会变好
        return "failed", f"HTTP {resp.status_code}: {resp.text[:300]}", body
    return "pending", f"HTTP {resp.status_code}: {resp.text[:300]}", body


def flush(limit: int = 20) -> dict:
    """发送发件箱里的待发项。可被接口或后台线程调用。"""
    if not enabled():
        return {"ok": False, "error": "回写未配置", **config_status()}

    sent = failed = retry = 0
    details = []
    worker = f"delivery-{uuid.uuid4().hex[:6]}"
    for row in outbox_claim(worker, limit):
        try:
            payload = json.loads(row["payload_json"])
        except json.JSONDecodeError:
            outbox_mark(row["id"], "failed", "payload_json 损坏")
            failed += 1
            continue

        status, error, response = _send(payload)
        outbox_mark(row["id"], status, error, response)
        if status == "sent":
            sent += 1
        elif status == "failed":
            failed += 1
        else:
            retry += 1
        details.append({
            "id": row["id"], "status": status,
            "error": error,
            "run_no": (response or {}).get("run_no"),
            "duplicate": (response or {}).get("duplicate", False),
        })
    return {"ok": True, "sent": sent, "failed": failed,
            "retry": retry, "details": details}


def status() -> dict:
    return {**config_status(), **outbox_status()}


def start_worker() -> None:
    """后台重试线程：只有配置齐全才启动，避免无意义轮询。"""
    global _worker_started
    if _worker_started or not enabled() or RETRY_SECONDS <= 0:
        return
    _worker_started = True

    def loop() -> None:
        while True:
            time.sleep(RETRY_SECONDS)
            try:
                flush()
            except Exception as exc:  # noqa: BLE001
                print(f"[delivery] 重试失败：{exc}")

    threading.Thread(target=loop, daemon=True, name="delivery-retry").start()
    print(f"[delivery] 回写已启用 → {PLATFORM_URL}（每 {RETRY_SECONDS}s 重试）")
