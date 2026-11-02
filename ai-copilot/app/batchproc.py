"""批量导入与批次状态（P1 / D7）。

问题：400 份样本靠一份一份点上传，1.7 小时，还容易漏。

做法：
- 批量：一次上传 N 个文件，落到 data/batches/{批次}/，登记为 pending
- 后台处理：OCR → 抽取 → （可选）脱敏 → 存库，逐条更新状态
- 状态可查：待处理 / 处理中 / 已识别 / 失败，失败可一键重试
- 断点：处理到一半进程挂了，重启后再点一次继续处理剩余的

多实例（D7）：
- 任务状态不再放进程内存，改为 `jobs` 表 + 租约（lease）
- 每个实例跑一个 worker，抢到任务才处理；抢不到就轮询
- 取消写 `batches.cancel_requested`，任何实例都能看到
- 实例挂掉后租约过期，另一个实例自动接手（已处理项不会重跑）
- 文件仍落本地；多实例请配 S3（A6），否则别的实例读不到文件
"""
from __future__ import annotations

import json
import os
import socket
import threading
import time
import traceback
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import ocr
from .config import ROOT
from .extract import extract
from .invoice import extract_invoice
from .masking import MaskMap, fingerprint, mask_fields, mask_text
from .store import (
    _conn, add_batch_items, batch_cancel_requested, batch_items, claim_job,
    create_batch, enqueue_job, finish_job, get_batch, get_job, job_active,
    renew_job, save_run, set_batch_status, update_item,
)

BATCH_DIR = ROOT / "data" / "batches"
WORKER_ID = f"{socket.gethostname()}-{os.getpid()}-{uuid.uuid4().hex[:6]}"
POLL_SECONDS = float(os.getenv("WORKER_POLL_SECONDS", "2") or 2)
LEASE_SECONDS = int(os.getenv("JOB_LEASE_SECONDS", "300") or 300)
STALE_ITEM_MINUTES = int(os.getenv("STALE_ITEM_MINUTES", "10") or 10)

_worker_started = False


def new_batch(name: str, note: str = "", kind: str = "booking") -> dict:
    return create_batch(name.strip() or "未命名批次", note, kind)


def save_upload(batch_id: str, filename: str, data: bytes) -> dict:
    """把一个上传文件落到批次目录并登记。"""
    BATCH_DIR.mkdir(parents=True, exist_ok=True)
    target_dir = BATCH_DIR / batch_id
    target_dir.mkdir(parents=True, exist_ok=True)
    item = add_batch_items(batch_id, [filename])[0]
    suffix = Path(filename).suffix.lower() or ".bin"
    path = target_dir / f"{item['id']}{suffix}"
    path.write_bytes(data)
    update_item(item["id"], "pending", path=str(path))
    return {"id": item["id"], "filename": filename, "size": len(data)}


def start_processing(batch_id: str, use_llm: bool = False, do_mask: bool = True,
                     actor: str = "") -> bool:
    """入队。返回 False 表示已有实例在处理。"""
    job = enqueue_job("batch", batch_id, {
        "use_llm": use_llm, "do_mask": do_mask, "actor": actor,
    })
    if not job:
        return False
    set_batch_status(batch_id, "queued", cancel_requested=0)
    return True


def _reset_stale_items(batch_id: str, force: bool = False) -> None:
    """把卡在 processing 的项放回 pending。

    force=True 用于租约过期后被别的实例接手：上一个 worker 已经不在了，
    它留下的 processing 项可以安全重跑（处理本身是幂等的）。
    """
    with _conn() as conn:
        if force:
            conn.execute(
                "UPDATE batch_items SET status='pending'"
                " WHERE batch_id=? AND status='processing'", (batch_id,)
            )
            return
        cutoff = (datetime.now(timezone.utc) - timedelta(minutes=STALE_ITEM_MINUTES)) \
            .isoformat(timespec="seconds")
        conn.execute(
            "UPDATE batch_items SET status='pending'"
            " WHERE batch_id=? AND status='processing' AND updated_at < ?",
            (batch_id, cutoff),
        )


def _process(job: dict) -> None:
    batch_id = job["ref_id"]
    try:
        params = json.loads(job.get("params_json") or "{}")
    except json.JSONDecodeError:
        params = {}
    use_llm = bool(params.get("use_llm"))
    do_mask = bool(params.get("do_mask", True))
    actor = params.get("actor", "")

    batch = get_batch(batch_id) or {}
    kind = batch.get("kind") or "booking"
    mm = MaskMap()
    set_batch_status(batch_id, "running")
    _reset_stale_items(batch_id, force=int(job.get("attempts") or 0) > 1)

    try:
        while True:
            if batch_cancel_requested(batch_id):
                print(f"[batch] {batch_id} 已请求取消，停止处理")
                break
            pending = batch_items(batch_id, status="pending")
            if not pending:
                break
            item = pending[0]
            # 逐条抢占：两个实例同时拿到同一条时，只有一个能改成 processing
            with _conn() as conn:
                cur = conn.execute(
                    "UPDATE batch_items SET status='processing', updated_at=?"
                    " WHERE id=? AND status='pending'",
                    (datetime.now(timezone.utc).isoformat(timespec="seconds"), item["id"]),
                )
            if not cur.rowcount:
                continue

            renew_job(job["id"], WORKER_ID, LEASE_SECONDS)
            path = Path(item["path"] or "")
            try:
                if not path.exists():
                    update_item(item["id"], "failed", error="文件不存在")
                    continue

                res = ocr.extract(item["filename"], path.read_bytes())
                if not res.text.strip():
                    update_item(item["id"], "failed", error="未识别出文字")
                    continue

                if kind == "invoice":
                    draft = extract_invoice(res.text, allow_llm=use_llm)
                else:
                    draft = extract(res.text, allow_llm=use_llm)

                store_text = res.text
                if do_mask:
                    stored_fields = {k: (v.value or "") for k, v in draft.fields.items()}
                    masked_fields, _ = mask_fields(stored_fields, mm)
                    store_text, _ = mask_text(res.text, mm)
                    for k, fv in draft.fields.items():
                        fv.value = masked_fields.get(k) or fv.value
                    mm.save()

                run_id = save_run(store_text, draft, kind=kind, actor=actor)
                update_item(item["id"], "extracted", run_id=run_id,
                            note=f"指纹 {fingerprint(res.text)}")
                time.sleep(0.05)
            except Exception as exc:  # noqa: BLE001
                update_item(item["id"], "failed",
                            error=f"{type(exc).__name__}: {exc}"[:200])
                traceback.print_exc()

        finish_job(job["id"], WORKER_ID, "done",
                   "canceled" if batch_cancel_requested(batch_id) else "")
        set_batch_status(batch_id, "idle")
    except Exception as exc:  # noqa: BLE001
        print(f"[batch] {batch_id} 任务失败：{exc}")
        traceback.print_exc()
        finish_job(job["id"], WORKER_ID, "failed", f"{type(exc).__name__}: {exc}")
        set_batch_status(batch_id, "failed")


def _loop() -> None:
    print(f"[batch] worker 启动：{WORKER_ID}")
    while True:
        try:
            job = claim_job(WORKER_ID, LEASE_SECONDS)
            if job:
                if job["kind"] == "batch":
                    _process(job)
                else:
                    finish_job(job["id"], WORKER_ID, "failed", f"未知任务类型 {job['kind']}")
                continue
        except Exception as exc:  # noqa: BLE001
            print(f"[batch] worker 异常：{exc}")
        time.sleep(POLL_SECONDS)


def start_worker() -> None:
    """每个实例启动一个 worker；重复调用只起一个。"""
    global _worker_started
    if _worker_started:
        return
    _worker_started = True
    threading.Thread(target=_loop, daemon=True, name="batch-worker").start()


def is_running(batch_id: str) -> bool:
    return job_active("batch", batch_id)


def cancel(batch_id: str) -> bool:
    """请求取消：处理完当前这一条就停，剩下的保持 pending，可随时续跑。"""
    if not is_running(batch_id):
        return False
    set_batch_status(batch_id, get_batch(batch_id).get("status") or "running",
                     cancel_requested=1)
    return True


def detail(batch_id: str) -> dict:
    b = get_batch(batch_id)
    if not b:
        return {}
    items = batch_items(batch_id)
    counts: dict[str, int] = {}
    for it in items:
        counts[it["status"]] = counts.get(it["status"], 0) + 1
    done = counts.get("extracted", 0)
    b["items"] = items
    b["counts"] = counts
    b["running"] = is_running(batch_id)
    b["cancel_requested"] = bool(b.get("cancel_requested"))
    b["progress"] = round(done / len(items), 4) if items else 0.0
    job = get_job("batch", batch_id)
    b["job"] = {k: job.get(k) for k in ("status", "worker", "attempts", "last_error")} if job else None
    return b


def retry_failed(batch_id: str) -> int:
    n = 0
    for it in batch_items(batch_id, status="failed"):
        update_item(it["id"], "pending", error=None)
        n += 1
    return n
