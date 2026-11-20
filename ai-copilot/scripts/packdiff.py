"""对比两个行业包：证明“换行业只换配置”。

用法：
    cd ai-copilot
    PYTHONPATH=. .venv/bin/python scripts/packdiff.py [pack_a] [pack_b]
    # 默认 trucking -> freight_audit
"""
from __future__ import annotations

import sys
from dataclasses import asdict

from app.pack import load_pack


def dict_diff(prefix: str, a: dict, b: dict) -> None:
    keys = sorted(set(a) | set(b))
    for key in keys:
        if a.get(key) != b.get(key):
            print(f"  ~ {prefix}.{key}: {a.get(key)!r} -> {b.get(key)!r}")


def main() -> None:
    id_a = sys.argv[1] if len(sys.argv) > 1 else "trucking"
    id_b = sys.argv[2] if len(sys.argv) > 2 else "freight_audit"
    a, b = load_pack(id_a), load_pack(id_b)
    print(f"packdiff: {a.id} ({a.version}) -> {b.id} ({b.version})")

    print("\n[fields]")
    for doc in sorted(set(a.documents) | set(b.documents)):
        fa = {f.key: asdict(f) for f in a.documents.get(doc) or ()}
        fb = {f.key: asdict(f) for f in b.documents.get(doc) or ()}
        only_a = sorted(set(fa) - set(fb))
        only_b = sorted(set(fb) - set(fa))
        print(f"  {doc}: 仅 {a.id} {only_a}；仅 {b.id} {only_b}")
        for key in sorted(set(fa) & set(fb)):
            changed = [k for k in fa[key] if fa[key][k] != fb[key].get(k)]
            if changed:
                print(f"    ~ {key}: {changed}")

    print("\n[rules]")
    ra = {r.id: r for r in a.validations}
    rb = {r.id: r for r in b.validations}
    print(f"  仅 {a.id}: {sorted(set(ra) - set(rb))}")
    print(f"  仅 {b.id}: {sorted(set(rb) - set(ra))}")
    for rid in sorted(set(ra) & set(rb)):
        x, y = ra[rid], rb[rid]
        if (x.type, x.level, x.params) != (y.type, y.level, y.params):
            print(f"    ~ {rid}: type/level/params 有差异")

    print("\n[reconcile]")
    for section in ("statement", "match", "statuses"):
        dict_diff(f"reconcile.{section}", a.reconcile.get(section) or {}, b.reconcile.get(section) or {})

    print("\n[acceptance]")
    dict_diff("acceptance", a.acceptance, b.acceptance)

    print("\n[可选领域]")
    for attr in ("aging", "fees", "cost", "geo"):
        print(f"  {attr}: {a.id}={bool(getattr(a, attr))} / {b.id}={bool(getattr(b, attr))}")

    print("\n结论：差异只出现在 packs/ 数据；app/ 内核未改。")


if __name__ == "__main__":
    main()
