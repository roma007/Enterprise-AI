#!/usr/bin/env python3
"""试点一闭环：抽取 → 规则比对 → 差异解释 → 输出可评测 JSONL。

从仓库根目录运行：
  python3 ai-copilot/scripts/pilot_flow.py

默认不调用大模型；配置了 LLM 时解释会自动走 llm+rule。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COPILOT = ROOT / "ai-copilot"
sys.path.insert(0, str(COPILOT))

from app.diff_explain import explain_differences  # noqa: E402
from app.reconcile import reconcile  # noqa: E402
from app.settlement import parse_rates, settle  # noqa: E402
from app.settlement_extract import (  # noqa: E402
    parse_settlement_text,
    to_bills,
    to_differences as settlement_differences,
)
from app.statement import (  # noqa: E402
    parse_statement_text,
    to_differences as statement_differences,
    to_reconcile_rows,
)

SAMPLES = ROOT / "会客包" / "试点一" / "samples"
OUT = ROOT / "会客包" / "试点一" / "reports"


def load_jsonl(path: Path) -> list[dict]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n",
        encoding="utf-8",
    )


def count(rows: list[dict], key: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for row in rows:
        value = str(row.get(key) or "unknown")
        out[value] = out.get(value, 0) + 1
    return out


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)

    # 1) 对账单
    statement_text = (SAMPLES / "statement_raw.example.txt").read_text(encoding="utf-8")
    statement_doc = parse_statement_text(
        statement_text,
        document_id="stmt-demo-001",
        source_format="text",
    )
    waybills = load_jsonl(SAMPLES / "waybills.example.jsonl")
    reconcile_result = reconcile(to_reconcile_rows(statement_doc), waybills)
    statement_diffs = explain_differences(
        statement_differences(statement_doc, reconcile_result),
        context={"kind": "statement", "customer_name": statement_doc.get("customer_name")},
    )
    write_jsonl(OUT / "statement_extracted.example.jsonl", [statement_doc])
    write_jsonl(OUT / "statement_differences.example.jsonl", statement_diffs)

    # 2) 结算单
    settlement_text = (SAMPLES / "settlement_raw.example.txt").read_text(encoding="utf-8")
    settlement_doc = parse_settlement_text(
        settlement_text,
        document_id="set-demo-001",
        source_format="text",
    )
    rates = parse_rates((SAMPLES / "contract_rates.example.txt").read_text(encoding="utf-8"))
    settlement_result = settle(rates, to_bills(settlement_doc))
    settlement_diffs = explain_differences(
        settlement_differences(settlement_doc, settlement_result),
        context={"kind": "settlement", "carrier_name": settlement_doc.get("carrier_name")},
    )
    write_jsonl(OUT / "settlement_extracted.example.jsonl", [settlement_doc])
    write_jsonl(OUT / "settlement_differences.example.jsonl", settlement_diffs)

    summary = {
        "statement": {
            "document_id": statement_doc["document_id"],
            "lines": len(statement_doc["lines"]),
            "warnings": statement_doc.get("warnings", []),
            "reconcile": reconcile_result["summary"],
            "differences": len(statement_diffs),
            "difference_types": count(statement_diffs, "type"),
            "explanation_sources": count(statement_diffs, "source"),
        },
        "settlement": {
            "document_id": settlement_doc["document_id"],
            "lines": len(settlement_doc["lines"]),
            "warnings": settlement_doc.get("warnings", []),
            "settle": settlement_result["summary"],
            "differences": len(settlement_diffs),
            "difference_types": count(settlement_diffs, "type"),
            "explanation_sources": count(settlement_diffs, "source"),
        },
        "outputs": {
            "statement_extracted": str(OUT / "statement_extracted.example.jsonl"),
            "statement_differences": str(OUT / "statement_differences.example.jsonl"),
            "settlement_extracted": str(OUT / "settlement_extracted.example.jsonl"),
            "settlement_differences": str(OUT / "settlement_differences.example.jsonl"),
        },
    }
    (OUT / "pilot_flow_summary.example.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
