"""行业包快照自检（Step 1）。

两层检查：
1. **加载 round-trip**：`active_pack()` 解析出来的对象与 `packs/<id>/*.json` 逐项一致；
2. **代码接线**：`schema` / `invoice` / `rules` 确实使用 pack 的值；
   尚未接线的 `reconcile` / `aging` / `fees` / `cost` / `geo` 仍与 pack 对照，
   Step 2 接线后会自动变成 round-trip。

行为等价由 `scripts/test_pack_wiring.py`、`smoke.sh`、`make eval` 证明。

用法：
    cd ai-copilot
    PYTHONPATH=. .venv/bin/python scripts/pack_snapshot.py [pack_id]
"""
from __future__ import annotations

import json
import sys
from dataclasses import asdict
from pathlib import Path

from app import address_check, aging, fees, invoice, margin, reconcile, rules, schema
from app.pack import PACKS_DIR, active_pack, load_pack

RAW_FILES = (
    "pack.json", "fields.json", "rules.json", "reconcile.json",
    "aging.json", "fees.json", "cost.json", "geo.json", "acceptance.json",
)

ok = True


def chk(name: str, cond: bool, extra: str = "") -> None:
    global ok
    print(f"  {'✓' if cond else '✗'} {name}{('  ' + extra) if extra else ''}")
    ok = ok and cond


def eq(name: str, got, expected) -> None:
    if got == expected:
        chk(name, True)
        return
    chk(name, False)
    print(f"      got     = {got!r}")
    print(f"      expected= {expected!r}")


def main() -> None:
    pack_id = sys.argv[1] if len(sys.argv) > 1 else None
    pack = active_pack() if pack_id is None else load_pack(pack_id)
    base = PACKS_DIR / pack.id
    print(f"快照对照：{base}")

    raw = {name: json.loads((base / name).read_text(encoding="utf-8")) for name in RAW_FILES}

    print("\n[加载 round-trip / 字段]")
    eq("booking 字段", [asdict(s) for s in pack.documents["booking"]],
       raw["fields.json"]["booking"]["fields"])
    eq("invoice 字段", [asdict(s) for s in pack.documents["invoice"]],
       raw["fields.json"]["invoice"]["fields"])

    print("\n[加载 round-trip / 校验]")
    raw_rules = raw["rules.json"]["validations"]
    chk("规则数量", len(pack.validations) == len(raw_rules), f"{len(pack.validations)} vs {len(raw_rules)}")
    for spec, expected in zip(pack.validations, raw_rules):
        eq(f"rule {spec.id} id/type/level",
           (spec.id, spec.type, spec.level),
           (expected.get("id"), expected.get("type"), expected.get("level")))
        params = {k: v for k, v in expected.items() if k not in {"id", "type", "level"}}
        eq(f"rule {spec.id} params", spec.params, params)
    eq("review", pack.review, raw["rules.json"]["review"])

    print("\n[加载 round-trip / 口径]")
    for attr, filename in (
        ("reconcile", "reconcile.json"),
        ("aging", "aging.json"),
        ("fees", "fees.json"),
        ("cost", "cost.json"),
        ("geo", "geo.json"),
        ("acceptance", "acceptance.json"),
    ):
        eq(attr, getattr(pack, attr), raw[filename])

    print("\n[代码接线 / schema]")
    eq("schema.PACK_ID", schema.PACK_ID, pack.id)
    eq("schema.PACK_VERSION", schema.PACK_VERSION, pack.version)
    eq("schema.SPECS", list(schema.SPECS), list(pack.documents["booking"]))
    eq("schema.BLOCKING_KEYS", list(schema.BLOCKING_KEYS),
       [f.key for f in pack.documents["booking"] if f.blocking])
    eq("invoice.INVOICE_SPECS", list(invoice.INVOICE_SPECS), list(pack.documents["invoice"]))
    eq("invoice.INV_BLOCKING", list(invoice.INV_BLOCKING),
       [f.key for f in pack.documents["invoice"] if f.blocking])

    print("\n[代码接线 / rules]")
    by_id = {r.id: r for r in pack.validations}
    eq("rules.RISK_KEYS", list(rules.RISK_KEYS), list(pack.review.get("risk_fields") or []))
    eq("rules.VALID_TYPES", set(rules.VALID_TYPES),
       set(by_id["container_type"].params.get("values") or []))
    eq("rules.SEAL_RE", rules.SEAL_RE.pattern, by_id["seal_format"].params.get("pattern"))
    eq("rules.PHONE_RE", rules.PHONE_RE.pattern, by_id["phone_format"].params.get("pattern"))
    eq("rules.CLOSING_WARN_HOURS", rules.CLOSING_WARN_HOURS, float(by_id["closing"].params.get("warn_hours")))
    eq("rules.LOW_CONF_WARN", rules.LOW_CONF_WARN, float(pack.review.get("low_conf_warn")))
    chk("rules.VALIDATORS 覆盖 pack 类型", all(r.type in rules.VALIDATORS for r in pack.validations))

    print("\n[尚未接线的模块：仍与 pack 对照，Step 2 接线]")
    eq("reconcile header_hints", {k: list(v) for k, v in reconcile._HINTS.items()},
       pack.reconcile["statement"]["header_hints"])
    eq("reconcile positional", [v for _, v in sorted(reconcile.POSITIONAL_DEFAULT.items())],
       pack.reconcile["statement"]["positional"])
    eq("reconcile amount_fields", list(reconcile.SYSTEM_AMOUNT_FIELDS),
       pack.reconcile["statement"]["amount_fields"])
    eq("reconcile statuses", dict(reconcile.STATUS_LABELS), pack.reconcile["statuses"])
    eq("aging header_hints", {k: list(v) for k, v in aging._HINTS.items()},
       pack.aging["header_hints"])
    eq("fees header_hints", {k: list(v) for k, v in fees._HINTS.items()},
       pack.fees["header_hints"])
    eq("fees builtin_fees", sorted(fees.BUILTIN_FEES), pack.fees["builtin_fees"])
    eq("cost revenue_hints", {k: list(v) for k, v in margin._REVENUE_HINTS.items()},
       pack.cost["revenue_hints"])
    eq("cost cost_hints", {k: list(v) for k, v in margin._COST_HINTS.items()},
       pack.cost["cost_hints"])
    eq("geo cities", {k: list(v) for k, v in address_check.DISTRICTS.items()},
       pack.geo["cities"])
    eq("geo city_aliases", {k: list(v) for k, v in address_check.CITY_ALIASES.items()},
       pack.geo["city_aliases"])
    eq("geo terminals", {k: sorted(v) for k, v in address_check.TERMINALS.items()},
       pack.geo["terminals"])
    eq("geo ambiguous", sorted(address_check._AMBIGUOUS), pack.geo["ambiguous"])
    eq("geo typos", dict(address_check.TYPOS), pack.geo["typos"])
    eq("geo place_words", list(address_check.PLACE_WORDS), pack.geo["place_words"])
    eq("geo towns", list(address_check.TOWNS), pack.geo["towns"])

    print()
    if ok:
        print("快照一致：pack 加载、代码接线与 JSON 源逐项相同")
    else:
        print("快照不一致：先修 pack 或接线，不要进入下一步")
        sys.exit(1)


if __name__ == "__main__":
    main()
