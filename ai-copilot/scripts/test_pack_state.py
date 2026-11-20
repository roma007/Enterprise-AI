"""行业包激活状态自检（Step 4）。

只用临时目录，不碰 `data/active_pack.json` / `data/pack_history.json`。

用法：
    cd ai-copilot
    PYTHONPATH=. .venv/bin/python scripts/test_pack_state.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import pack_state  # noqa: E402

ok = True


def chk(name: str, cond: bool, extra: str = "") -> None:
    global ok
    print(f"  {'✓' if cond else '✗'} {name}{('  ' + extra) if extra else ''}")
    ok = ok and cond


def main() -> None:
    if pack_state.db.BACKEND != "sqlite":
        print("  - 当前是 PostgreSQL 后端，跳过文件态测试")
        return

    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        pack_state.PATH = base / "active_pack.json"
        pack_state.HISTORY_PATH = base / "pack_history.json"

        print("激活与历史")
        pack_state.set_active("freight_audit", actor="u1", reason="试切换")
        chk("active=freight_audit", pack_state.get_active_id() == "freight_audit")
        chk("state 带 actor", pack_state.get_state().get("updated_by") == "u1")
        chk("history=1", len(pack_state.history()) == 1)

        pack_state.set_active("trucking", actor="u2", reason="切回集卡")
        chk("active=trucking", pack_state.get_active_id() == "trucking")
        chk("history=2", len(pack_state.history()) == 2)
        chk("最新在前", pack_state.history()[0]["to_id"] == "trucking")

        print("\n回滚")
        pack_state.rollback(actor="u3", reason="撤销最近一次")
        chk("回滚到 freight_audit", pack_state.get_active_id() == "freight_audit")
        chk("history=3", len(pack_state.history()) == 3)

        oldest = pack_state.history()[-1]
        pack_state.rollback(oldest["id"], actor="u4", reason="回到默认")
        chk("回滚到默认（空）", pack_state.get_active_id() == "")
        chk("history=4", len(pack_state.history()) == 4)

        print("\n非法输入")
        try:
            pack_state.rollback("no-such-id", actor="u5")
            chk("不存在的记录应报错", False)
        except ValueError:
            chk("不存在的记录应报错", True)

        print("\n空历史")
        pack_state.HISTORY_PATH.unlink()
        try:
            pack_state.rollback(actor="u6")
            chk("空历史应报错", False)
        except ValueError:
            chk("空历史应报错", True)

    print()
    if ok:
        print("全部通过")
    else:
        print("存在失败项")
        sys.exit(1)


if __name__ == "__main__":
    main()
