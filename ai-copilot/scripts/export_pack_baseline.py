"""行业包导出 / 规范化（round-trip）。

Step 0 时它从代码常量反推 `packs/trucking/`；Step 2 起代码已改为读 pack，
本脚本改为**把当前 pack 重新格式化写出**，用于：
- 统一 JSON 缩进/排序，方便 review；
- 导出某个 pack 给客户/伙伴；
- 确认 `load_pack()` 读进来的内容能原样写回（配合 `pack_snapshot.py`）。

不会从代码反推字段或口径；改 pack 请直接改 `packs/<id>/*.json`。

用法：
    cd ai-copilot
    PYTHONPATH=. .venv/bin/python scripts/export_pack_baseline.py [pack_id]
"""
from __future__ import annotations

import json
import sys
from dataclasses import asdict

from app.pack import PACKS_DIR, active_pack, load_pack


def main() -> None:
    pack_id = sys.argv[1] if len(sys.argv) > 1 else None
    pack = active_pack() if pack_id is None else load_pack(pack_id)
    pack_dir = PACKS_DIR / pack.id

    def write(name: str, payload: object) -> None:
        (pack_dir / name).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    # pack.json 的 description/documents 不在 Pack 对象里，原样保留。
    meta = json.loads((pack_dir / "pack.json").read_text(encoding="utf-8"))
    meta.update({
        "id": pack.id,
        "name": pack.name,
        "version": pack.version,
        "settings_refs": list(pack.settings_refs),
    })
    write("pack.json", meta)

    raw_fields = json.loads((pack_dir / "fields.json").read_text(encoding="utf-8"))
    write("fields.json", {
        doc: {
            "label": (raw_fields.get(doc) or {}).get("label", doc),
            "fields": [asdict(spec) for spec in specs],
        }
        for doc, specs in pack.documents.items()
    })

    write("rules.json", {
        "validations": [
            {"id": r.id, "type": r.type, "level": r.level, **r.params}
            for r in pack.validations
        ],
        "review": pack.review,
    })

    write("reconcile.json", pack.reconcile)
    # 可选领域：为空就不写文件，保持“部分 pack”形态。
    for name, payload in (
        ("aging.json", pack.aging),
        ("fees.json", pack.fees),
        ("cost.json", pack.cost),
        ("geo.json", pack.geo),
        ("acceptance.json", pack.acceptance),
    ):
        if payload:
            write(name, payload)

    print(f"已导出 {pack_dir}")


if __name__ == "__main__":
    main()
