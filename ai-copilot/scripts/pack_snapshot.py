"""Step 0 快照：证明 packs/trucking 与当前代码常量逐项一致。

这是“配置化没有改变行为”的机械证据：
- 字段、校验参数、对账口径、账龄/费用/成本词表、地址词表
- 全部从当前模块导入，和 JSON 对照

不证明的东西：运行时行为等价（Step 1 接线后由 smoke / eval 证明）。

用法：
    cd ai-copilot
    PYTHONPATH=. .venv/bin/python scripts/pack_snapshot.py [packs/trucking]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from app import address_check, aging, fees, margin, reconcile, rules
from app.config import ROOT
from app.invoice import INVOICE_SPECS
from app.rules import CLOSING_WARN_HOURS, LOW_CONF_WARN, PHONE_RE, RISK_KEYS, SEAL_RE, VALID_TYPES
from app.schema import BLOCKING_KEYS, SPECS

DEFAULT_PACK = ROOT / "packs" / "trucking"
FIELD_VIEW = ("key", "label", "hint", "example", "blocking", "kind")
INV_VIEW = ("key", "label", "hint", "example", "blocking")

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
    return json.loads(path.read_text(encoding="utf-8"))


def eq(name: str, got, expected) -> None:
    if got == expected:
        chk(name, True)
        return
    chk(name, False)
    print(f"      got     = {got!r}")
    print(f"      expected= {expected!r}")


def main() -> None:
    pack_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PACK
    print(f"快照对照：{pack_dir}")

    pack = load(pack_dir, "pack.json")
    fields = load(pack_dir, "fields.json")
    rules_json = load(pack_dir, "rules.json")
    rec = load(pack_dir, "reconcile.json")
    aging_json = load(pack_dir, "aging.json")
    fees_json = load(pack_dir, "fees.json")
    cost_json = load(pack_dir, "cost.json")
    geo_json = load(pack_dir, "geo.json")

    print("\n[pack.json]")
    eq("id", pack.get("id"), "trucking")
    chk("documents 覆盖 booking/invoice", {"booking", "invoice"}.issubset(set(pack.get("documents") or [])))

    print("\n[fields.json / booking]")
    booking = (fields.get("booking") or {}).get("fields") or []
    chk("booking 字段数", len(booking) == len(SPECS), f"{len(booking)} vs {len(SPECS)}")
    for got, spec in zip(booking, SPECS):
        expected = {k: getattr(spec, k) for k in FIELD_VIEW}
        eq(f"booking.{spec.key}", {k: got.get(k) for k in FIELD_VIEW}, expected)

    print("\n[fields.json / invoice]")
    invoice = (fields.get("invoice") or {}).get("fields") or []
    chk("invoice 字段数", len(invoice) == len(INVOICE_SPECS), f"{len(invoice)} vs {len(INVOICE_SPECS)}")
    for got, spec in zip(invoice, INVOICE_SPECS):
        expected = {k: getattr(spec, k) for k in INV_VIEW}
        eq(f"invoice.{spec.key}", {k: got.get(k) for k in INV_VIEW}, expected)

    print("\n[rules.json]")
    validations = {v.get("id"): v for v in (rules_json.get("validations") or [])}
    eq("校验规则 id 集合", set(validations), {
        "required", "container_checksum", "container_qty", "container_type",
        "seal_format", "phone_format", "address", "closing", "window_after_closing",
    })
    eq("required fallback_fields", validations.get("required", {}).get("fallback_fields"), list(BLOCKING_KEYS))
    eq("container_type values", sorted(validations.get("container_type", {}).get("values") or []), sorted(VALID_TYPES))
    eq("seal_format pattern", validations.get("seal_format", {}).get("pattern"), SEAL_RE.pattern)
    eq("phone_format pattern", validations.get("phone_format", {}).get("pattern"), PHONE_RE.pattern)
    eq("closing warn_hours", validations.get("closing", {}).get("warn_hours"), CLOSING_WARN_HOURS)
    eq("review.risk_fields", (rules_json.get("review") or {}).get("risk_fields"), list(RISK_KEYS))
    eq("review.low_conf_warn", (rules_json.get("review") or {}).get("low_conf_warn"), LOW_CONF_WARN)

    print("\n[reconcile.json]")
    eq("header_hints", (rec.get("statement") or {}).get("header_hints"),
       {k: list(v) for k, v in reconcile._HINTS.items()})
    eq("positional", (rec.get("statement") or {}).get("positional"),
       [v for _, v in sorted(reconcile.POSITIONAL_DEFAULT.items())])
    eq("amount_fields", (rec.get("statement") or {}).get("amount_fields"),
       list(reconcile.SYSTEM_AMOUNT_FIELDS))
    eq("match.keys", (rec.get("match") or {}).get("keys"), ["booking_no", "container_no"])
    eq("statuses", rec.get("statuses"), dict(reconcile.STATUS_LABELS))

    print("\n[aging.json]")
    eq("header_hints", aging_json.get("header_hints"),
       {k: list(v) for k, v in aging._HINTS.items()})

    print("\n[fees.json]")
    eq("header_hints", fees_json.get("header_hints"),
       {k: list(v) for k, v in fees._HINTS.items()})
    eq("builtin_fees", fees_json.get("builtin_fees"), sorted(fees.BUILTIN_FEES))

    print("\n[cost.json]")
    eq("revenue_hints", cost_json.get("revenue_hints"),
       {k: list(v) for k, v in margin._REVENUE_HINTS.items()})
    eq("cost_hints", cost_json.get("cost_hints"),
       {k: list(v) for k, v in margin._COST_HINTS.items()})

    print("\n[geo.json]")
    eq("cities", geo_json.get("cities"),
       {k: list(v) for k, v in address_check.DISTRICTS.items()})
    eq("city_aliases", geo_json.get("city_aliases"),
       {k: list(v) for k, v in address_check.CITY_ALIASES.items()})
    eq("terminals", geo_json.get("terminals"),
       {k: sorted(v) for k, v in address_check.TERMINALS.items()})
    eq("ambiguous", geo_json.get("ambiguous"), sorted(address_check._AMBIGUOUS))
    eq("typos", geo_json.get("typos"), dict(address_check.TYPOS))
    eq("place_words", geo_json.get("place_words"), list(address_check.PLACE_WORDS))
    eq("towns", geo_json.get("towns"), list(address_check.TOWNS))

    print()
    if ok:
        print("快照一致：packs/trucking 与当前代码常量逐项相同")
    else:
        print("快照不一致：先修 pack 或修代码，不要带着差异进入 Step 1")
        sys.exit(1)


if __name__ == "__main__":
    main()
