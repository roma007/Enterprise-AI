"""任务 pack_id 锁定 + 忙时禁止切包自检（AI-61 复盘遗留）。

用临时 SQLite 库，不碰 data/copilot.db。
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

ok = True


def chk(name: str, cond: bool, extra: str = "") -> None:
    global ok
    print(f"  {'✓' if cond else '✗'} {name}{('  ' + extra) if extra else ''}")
    ok = ok and cond


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["DB_PATH"] = str(Path(tmp) / "jobs.db")
        from app import pack, store

        store.init_db()

        print("入队记录 pack_id")
        job = store.enqueue_job("batch", "b1", {"use_llm": False}, pack_id="trucking")
        chk("job 已入队", bool(job), "")
        chk("pack_id=trucking", (job or {}).get("pack_id") == "trucking",
            str((job or {}).get("pack_id")))
        chk("pending_pack_jobs=1", store.pending_pack_jobs("batch") == 1,
            str(store.pending_pack_jobs("batch")))

        print("\n领取保留 pack_id")
        claimed = store.claim_job("w1")
        chk("领取成功", bool(claimed), "")
        chk("领取 pack_id=trucking", (claimed or {}).get("pack_id") == "trucking",
            str((claimed or {}).get("pack_id")))
        store.finish_job((claimed or {})["id"], "w1", "done")
        chk("完成后 pending=0", store.pending_pack_jobs("batch") == 0,
            str(store.pending_pack_jobs("batch")))

        print("\n忙时禁止切包")
        flag = {"v": True}
        pack.register_busy_check(lambda: flag["v"])
        try:
            pack.reload_pack("trucking")
            chk("应抛 PackBusy", False)
        except pack.PackBusy as exc:
            chk("应抛 PackBusy", True, str(exc))
        flag["v"] = False
        pack.reload_pack("trucking")
        chk("空闲后可切", pack.active_pack().id == "trucking", pack.active_pack().id)

    print()
    if ok:
        print("全部通过")
    else:
        print("存在失败项")
        sys.exit(1)


if __name__ == "__main__":
    main()
