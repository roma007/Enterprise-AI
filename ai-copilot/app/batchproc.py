"""批量导入与批次状态（P1）。

问题：400 份样本靠一份一份点上传，1.7 小时，还容易漏。

做法：
- 批量：一次上传 N 个文件，落到 data/batches/{批次}/，登记为 pending
- 后台处理：OCR → 抽取 → （可选）脱敏 → 存库，逐条更新状态
- 状态可查：待处理 / 处理中 / 已识别 / 失败，失败可一键重试
- 断点：处理到一半进程挂了，重启后再点一次继续处理剩余的

设计取舍：
- 用线程而不是队列：单机演示，够用，且没有额外依赖
- 每个批次一把锁：防止重复点击导致同一条被处理两次
"""
from __future__ import annotations

import threading
import time
import traceback
from pathlib import Path

from . import ocr
from .config import ROOT
from .extract import extract
from .masking import MaskMap, fingerprint, mask_fields, mask_text
from .store import (
    add_batch_items, batch_items, create_batch, get_batch, update_item, save_run,
)

BATCH_DIR = ROOT / "data" / "batches"
_lock = threading.Lock()
_running: set[str] = set()


def new_batch(name: str, note: str = "") -> dict:
    return create_batch(name.strip() or "未命名批次", note)


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


def start_processing(batch_id: str, use_llm: bool = False, do_mask: bool = True) -> bool:
    """启动后台处理。返回 False 表示该批次已在处理中。"""
    with _lock:
        if batch_id in _running:
            return False
        _running.add(batch_id)
    t = threading.Thread(target=_run, args=(batch_id, use_llm, do_mask), daemon=True)
    t.start()
    return True


def _run(batch_id: str, use_llm: bool, do_mask: bool) -> None:
    mm = MaskMap()
    try:
        for item in batch_items(batch_id, status="pending"):
            path = Path(item["path"] or "")
            try:
                if not path.exists():
                    update_item(item["id"], "failed", error="文件不存在")
                    continue
                update_item(item["id"], "processing")

                res = ocr.extract(item["filename"], path.read_bytes())
                if not res.text.strip():
                    update_item(item["id"], "failed", error="未识别出文字")
                    continue

                draft = extract(res.text, allow_llm=use_llm)

                store_text = res.text
                if do_mask:
                    stored_fields = {k: (v.value or "") for k, v in draft.fields.items()}
                    masked_fields, _ = mask_fields(stored_fields, mm)
                    store_text, _ = mask_text(res.text, mm)
                    for k, fv in draft.fields.items():
                        fv.value = masked_fields.get(k) or fv.value
                    mm.save()

                run_id = save_run(store_text, draft)
                update_item(item["id"], "extracted", run_id=run_id,
                            note=f"指纹 {fingerprint(res.text)}")
                time.sleep(0.05)
            except Exception as exc:  # noqa: BLE001
                update_item(item["id"], "failed",
                            error=f"{type(exc).__name__}: {exc}"[:200])
                traceback.print_exc()
    finally:
        with _lock:
            _running.discard(batch_id)


def is_running(batch_id: str) -> bool:
    return batch_id in _running


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
    b["progress"] = round(done / len(items), 4) if items else 0.0
    return b


def retry_failed(batch_id: str) -> int:
    n = 0
    for it in batch_items(batch_id, status="failed"):
        update_item(it["id"], "pending", error=None)
        n += 1
    return n
