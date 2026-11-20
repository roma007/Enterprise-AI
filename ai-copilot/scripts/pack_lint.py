"""行业包结构自检（Step 0）。

只检查 pack 自身是否自洽，不证明“与代码行为一致”——后者由
`scripts/pack_snapshot.py` 负责。

用法：
    cd ai-copilot
    PYTHONPATH=. .venv/bin/python scripts/pack_lint.py [packs/trucking]
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from app import thresholds

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PACK = ROOT / "packs" / "trucking"

FIELD_KINDS = {"text", "datetime", "number", "enum"}
NORMALIZERS = {
    "text", "number", "amount", "datetime",
    "container_list", "container_type", "so_no", "alnum_upper",
}
VALIDATORS = {
    "builtin.required", "builtin.iso6346", "builtin.qty_match",
    "builtin.enum", "builtin.regex", "builtin.geo",
    "builtin.deadline", "builtin.ordering",
}
LEVELS = {"error", "warn", "info"}

ok = True


def chk(name: str, cond: bool, extra: str = "") -> None:
    global ok
    print(f"  {'✓' if cond else '✗'} {name}{('  ' + extra) if extra else ''}")
    ok = ok and cond


def load(pack_dir: Path, name: str) -> dict:
    path = pack_dir / name
    if not path.exists():
        chk(f"{name} 存在", False)
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        chk(f"{name} 是合法 JSON", False, str(exc))
        return {}


def main() -> None:
    pack_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PACK
    print(f"行业包自检：{pack_dir}")

    pack = load(pack_dir, "pack.json")
    fields = load(pack_dir, "fields.json")
    rules = load(pack_dir, "rules.json")
    reconcile = load(pack_dir, "reconcile.json")
    aging = load(pack_dir, "aging.json")
    fees = load(pack_dir, "fees.json")
    cost = load(pack_dir, "cost.json")
    geo = load(pack_dir, "geo.json")
    acceptance = load(pack_dir, "acceptance.json")

    # ---- pack.json ----
    print("\n[pack.json]")
    chk("id 非空", bool(pack.get("id")))
    chk("version 非空", bool(pack.get("version")))
    chk("documents 是列表", isinstance(pack.get("documents"), list))
    refs = pack.get("settings_refs") or []
    missing = [r for r in refs if r not in thresholds.BY_KEY]
    chk("settings_refs 全部存在", not missing, f"缺失：{missing}" if missing else "")

    # ---- fields.json ----
    print("\n[fields.json]")
    all_fields: dict[str, dict] = {}
    for doc in ("booking", "invoice"):
        block = fields.get(doc) or {}
        items = block.get("fields") or []
        chk(f"{doc} 有字段", bool(items), f"{len(items)} 个")
        keys = [f.get("key") for f in items]
        chk(f"{doc} key 唯一", len(keys) == len(set(keys)))
        for f in items:
            key = f.get("key") or "<空>"
            chk(f"{doc}.{key} label 非空", bool(f.get("label")))
            chk(f"{doc}.{key} kind 合法", f.get("kind") in FIELD_KINDS, str(f.get("kind")))
            chk(f"{doc}.{key} normalize 合法", f.get("normalize") in NORMALIZERS, str(f.get("normalize")))
            all_fields[key] = f

    # ---- rules.json ----
    print("\n[rules.json]")
    validations = rules.get("validations") or []
    chk("validations 非空", bool(validations), f"{len(validations)} 条")
    ids = [v.get("id") for v in validations]
    chk("validation id 唯一", len(ids) == len(set(ids)))
    for v in validations:
        vid = v.get("id") or "<空>"
        vtype = v.get("type")
        chk(f"{vid} type 已知", vtype in VALIDATORS, str(vtype))
        chk(f"{vid} level 合法", v.get("level") in LEVELS, str(v.get("level")))

        field = v.get("field")
        if field:
            chk(f"{vid} 字段存在", field in all_fields, field)
        for f in v.get("fields") or []:
            chk(f"{vid} 字段存在", f in all_fields, f)
        for f in v.get("fallback_fields") or []:
            chk(f"{vid} fallback 字段存在", f in all_fields, f)

        src = v.get("fields_from")
        if src:
            chk(f"{vid} fields_from 可解析", src.startswith("settings:") and src.split(":", 1)[1] in thresholds.BY_KEY, str(src))
        src = v.get("enabled_from")
        if src:
            chk(f"{vid} enabled_from 可解析", src.startswith("settings:") and src.split(":", 1)[1] in thresholds.BY_KEY, str(src))

        if vtype == "builtin.enum":
            chk(f"{vid} values 非空", bool(v.get("values")))
        if vtype == "builtin.regex":
            try:
                re.compile(v.get("pattern") or "")
                chk(f"{vid} pattern 可编译", True)
            except re.error as exc:
                chk(f"{vid} pattern 可编译", False, str(exc))
        if vtype == "builtin.deadline":
            chk(f"{vid} warn_hours > 0", float(v.get("warn_hours") or 0) > 0)

    review = rules.get("review") or {}
    for f in review.get("risk_fields") or []:
        chk("risk_fields 字段存在", f in all_fields, f)
    low = review.get("low_conf_warn")
    chk("low_conf_warn 在 [0,1]", isinstance(low, (int, float)) and 0 <= low <= 1, str(low))

    # ---- reconcile.json ----
    print("\n[reconcile.json]")
    st = reconcile.get("statement") or {}
    chk("header_hints 非空", bool(st.get("header_hints")))
    chk("positional 非空", bool(st.get("positional")))
    chk("amount_fields 非空", bool(st.get("amount_fields")))
    chk("match.keys 非空", bool((reconcile.get("match") or {}).get("keys")))
    chk("statuses 非空", bool(reconcile.get("statuses")))

    # ---- aging / fees / cost ----
    print("\n[aging.json / fees.json / cost.json]")
    chk("aging.header_hints 非空", bool(aging.get("header_hints")))
    chk("fees.header_hints 非空", bool(fees.get("header_hints")))
    chk("fees.builtin_fees 非空", bool(fees.get("builtin_fees")))
    chk("cost.revenue_hints 非空", bool(cost.get("revenue_hints")))
    chk("cost.cost_hints 非空", bool(cost.get("cost_hints")))

    # ---- geo.json ----
    print("\n[geo.json]")
    cities = geo.get("cities") or {}
    chk("cities 非空", bool(cities))
    chk("terminals 是字典", isinstance(geo.get("terminals"), dict))
    for district in geo.get("ambiguous") or []:
        hit = any(district in names for names in cities.values())
        chk(f"ambiguous {district} 能在 cities 找到", hit)

    # ---- acceptance.json ----
    print("\n[acceptance.json]")
    for key in ("field_accuracy", "correction_seconds", "diff_recall", "false_positive_rate"):
        item = acceptance.get(key) or {}
        target = item.get("target")
        chk(f"{key}.target 是数字", isinstance(target, (int, float)), str(target))
        if key != "correction_seconds" and isinstance(target, (int, float)):
            chk(f"{key}.target 在 [0,1]", 0 <= target <= 1, str(target))
        if key == "correction_seconds" and isinstance(target, (int, float)):
            chk(f"{key}.target > 0", target > 0, str(target))
    for name, item in (acceptance.get("samples") or {}).items():
        chk(f"samples.{name}.min > 0", float((item or {}).get("min") or 0) > 0)

    print()
    if ok:
        print("全部通过")
    else:
        print("存在失败项")
        sys.exit(1)


if __name__ == "__main__":
    main()
