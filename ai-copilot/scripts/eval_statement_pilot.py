#!/usr/bin/env python3
"""试点一评测：对账单/结算单抽取 + 差异识别。

只依赖 Python 标准库，可直接在客户数据上跑。

用法（从仓库根目录）：

  python3 ai-copilot/scripts/eval_statement_pilot.py \
    --kind statement \
    --gold 会客包/试点一/samples/statement_gold.example.jsonl \
    --pred 会客包/试点一/samples/statement_pred.example.jsonl \
    --diff-gold 会客包/试点一/samples/differences_gold.example.jsonl \
    --diff-pred 会客包/试点一/samples/differences_pred.example.jsonl \
    --out 会客包/试点一/reports/statement_eval.json

加 --strict：低于验收阈值时退出码 1，可直接接 CI。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

NUMERIC_TOL = 0.01

HEADER_FIELDS = {
    "statement": [
        "statement_no",
        "customer_name",
        "period_start",
        "period_end",
        "currency",
        "total_amount",
    ],
    "settlement": [
        "settlement_no",
        "carrier_name",
        "period_start",
        "period_end",
        "currency",
        "total_amount",
    ],
}

LINE_FIELDS = {
    "statement": [
        "waybill_no",
        "container_no",
        "container_type",
        "amount",
        "tax_amount",
        "total_amount",
        "due_date",
    ],
    "settlement": [
        "trip_no",
        "waybill_no",
        "plate_no",
        "route",
        "container_type",
        "quantity",
        "unit_price",
        "amount",
        "deduction",
    ],
}

NUMERIC_FIELDS = {
    "total_amount",
    "amount",
    "tax_amount",
    "quantity",
    "unit_price",
    "deduction",
}
DATE_FIELDS = {"period_start", "period_end", "due_date"}

THRESHOLDS = {
    "header_accuracy": 0.98,
    "line_field_accuracy_matched": 0.95,
    "line_recall": 0.98,
    "total_amount_accuracy": 1.0,
    "diff_recall": 0.95,
    "diff_precision": 0.95,
}


def load_jsonl(path: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for i, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"{path}:{i} JSON 解析失败：{exc}") from exc
        if not isinstance(obj, dict):
            raise SystemExit(f"{path}:{i} 不是 JSON 对象")
        rows.append(obj)
    return rows


def norm_text(value: Any) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip().upper()


def norm_date(value: Any) -> str:
    s = norm_text(value)
    if not s:
        return ""
    m = re.match(r"^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$", s)
    if m:
        return f"{int(m.group(1)):04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    return s


def norm_number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def same_field(field: str, gold: Any, pred: Any) -> bool:
    if field in NUMERIC_FIELDS:
        g = norm_number(gold)
        p = norm_number(pred)
        if g is None and p is None:
            return True
        if g is None or p is None:
            return False
        return abs(g - p) <= NUMERIC_TOL
    if field in DATE_FIELDS:
        return norm_date(gold) == norm_date(pred)
    return norm_text(gold) == norm_text(pred)


def line_key(kind: str, line: dict[str, Any]) -> str:
    if kind == "statement":
        return norm_text(line.get("waybill_no")) or norm_text(line.get("container_no"))
    return norm_text(line.get("trip_no")) or norm_text(line.get("waybill_no"))


def match_lines(
    kind: str,
    gold_lines: list[dict[str, Any]],
    pred_lines: list[dict[str, Any]],
) -> tuple[list[tuple[dict, dict]], list[dict], list[dict]]:
    remaining = list(pred_lines)
    pairs: list[tuple[dict, dict]] = []
    missing: list[dict] = []

    for gold in gold_lines:
        key = line_key(kind, gold)
        found = None
        if key:
            for i, pred in enumerate(remaining):
                if line_key(kind, pred) == key:
                    found = i
                    break
        if found is None:
            missing.append(gold)
            continue
        pairs.append((gold, remaining.pop(found)))

    return pairs, missing, remaining


def evaluate(
    kind: str,
    gold_docs: list[dict[str, Any]],
    pred_docs: list[dict[str, Any]],
    gold_diffs: list[dict[str, Any]],
    pred_diffs: list[dict[str, Any]],
) -> dict[str, Any]:
    gold_by_id = {str(d.get("document_id")): d for d in gold_docs}
    pred_by_id = {str(d.get("document_id")): d for d in pred_docs}
    all_ids = sorted(set(gold_by_id) | set(pred_by_id))

    header_total = 0
    header_correct = 0
    line_field_total = 0
    line_field_correct = 0
    gold_line_total = 0
    pred_line_total = 0
    matched_line_total = 0
    total_amount_total = 0
    total_amount_correct = 0
    missing_docs: list[str] = []
    extra_docs: list[str] = []

    for doc_id in all_ids:
        gold = gold_by_id.get(doc_id)
        pred = pred_by_id.get(doc_id)
        if gold is None:
            extra_docs.append(doc_id)
            pred_line_total += len(pred.get("lines", [])) if pred else 0
            continue
        if pred is None:
            missing_docs.append(doc_id)

        gold_lines = gold.get("lines", [])
        pred_lines = pred.get("lines", []) if pred else []
        gold_line_total += len(gold_lines)
        pred_line_total += len(pred_lines)

        # 表头
        for field in HEADER_FIELDS[kind]:
            header_total += 1
            if pred is not None and same_field(field, gold.get(field), pred.get(field)):
                header_correct += 1

        # 金额合计
        total_amount_total += 1
        if pred is not None and same_field("total_amount", gold.get("total_amount"), pred.get("total_amount")):
            total_amount_correct += 1

        # 明细
        pairs, _missing, _extra = match_lines(kind, gold_lines, pred_lines)
        matched_line_total += len(pairs)
        for gold_line, pred_line in pairs:
            for field in LINE_FIELDS[kind]:
                line_field_total += 1
                if same_field(field, gold_line.get(field), pred_line.get(field)):
                    line_field_correct += 1

    header_accuracy = header_correct / header_total if header_total else 0.0
    line_field_accuracy = line_field_correct / line_field_total if line_field_total else 0.0
    line_recall = matched_line_total / gold_line_total if gold_line_total else 0.0
    line_precision = matched_line_total / pred_line_total if pred_line_total else 0.0
    total_amount_accuracy = total_amount_correct / total_amount_total if total_amount_total else 0.0

    # 差异只保留当前 kind 的文档，避免把对账单差异算进结算单评测
    doc_ids = {norm_text(x) for x in (set(gold_by_id) | set(pred_by_id))}
    gold_diffs = [d for d in gold_diffs if norm_text(d.get("document_id")) in doc_ids]
    pred_diffs = [d for d in pred_diffs if norm_text(d.get("document_id")) in doc_ids]

    # 差异：按 (document_id, waybill_no, type) 匹配
    def diff_key(d: dict[str, Any]) -> tuple[str, str, str]:
        return (
            norm_text(d.get("document_id")),
            norm_text(d.get("waybill_no")),
            norm_text(d.get("type")),
        )

    gold_set = {diff_key(d) for d in gold_diffs}
    pred_set = {diff_key(d) for d in pred_diffs}
    inter = gold_set & pred_set
    diff_recall = len(inter) / len(gold_set) if gold_set else 0.0
    diff_precision = len(inter) / len(pred_set) if pred_set else 0.0
    diff_fp_rate = 1.0 - diff_precision if pred_set else 0.0

    metrics = {
        "documents": {
            "gold": len(gold_docs),
            "pred": len(pred_docs),
            "matched": len(set(gold_by_id) & set(pred_by_id)),
            "missing": missing_docs,
            "extra": extra_docs,
        },
        "header_accuracy": round(header_accuracy, 4),
        "line_field_accuracy_matched": round(line_field_accuracy, 4),
        "line_recall": round(line_recall, 4),
        "line_precision": round(line_precision, 4),
        "total_amount_accuracy": round(total_amount_accuracy, 4),
        "diff_recall": round(diff_recall, 4),
        "diff_precision": round(diff_precision, 4),
        "diff_false_positive_rate": round(diff_fp_rate, 4),
        "counts": {
            "gold_lines": gold_line_total,
            "pred_lines": pred_line_total,
            "matched_lines": matched_line_total,
            "gold_differences": len(gold_set),
            "pred_differences": len(pred_set),
            "matched_differences": len(inter),
        },
    }

    failures = [
        key
        for key, target in THRESHOLDS.items()
        if metrics[key] < target
    ]
    metrics["thresholds"] = THRESHOLDS
    metrics["failed_thresholds"] = failures
    return metrics


def render_markdown(kind: str, metrics: dict[str, Any]) -> str:
    rows = [
        ("表头字段准确率", metrics["header_accuracy"], THRESHOLDS["header_accuracy"], True),
        ("明细字段准确率（匹配行）", metrics["line_field_accuracy_matched"], THRESHOLDS["line_field_accuracy_matched"], True),
        ("明细行召回率", metrics["line_recall"], THRESHOLDS["line_recall"], True),
        ("明细行精确率", metrics["line_precision"], None, True),
        ("金额合计准确率", metrics["total_amount_accuracy"], THRESHOLDS["total_amount_accuracy"], True),
        ("差异召回率", metrics["diff_recall"], THRESHOLDS["diff_recall"], True),
        ("差异精确率", metrics["diff_precision"], THRESHOLDS["diff_precision"], True),
        ("差异误报率", metrics["diff_false_positive_rate"], 0.05, False),
    ]
    lines = [
        f"# 试点一评测报告 · {kind}",
        "",
        "| 指标 | 值 | 目标 | 状态 |",
        "|---|---:|---:|---|",
    ]
    for label, value, target, higher_is_better in rows:
        if target is None:
            status = "—"
            target_text = "—"
        else:
            ok = value >= target if higher_is_better else value <= target
            status = "✅" if ok else "❌"
            target_text = f"{target:.0%}" if higher_is_better else f"≤{target:.0%}"
        lines.append(f"| {label} | {value:.2%} | {target_text} | {status} |")
    counts = metrics["counts"]
    lines += [
        "",
        f"- 文档：gold {metrics['documents']['gold']} / pred {metrics['documents']['pred']} / 匹配 {metrics['documents']['matched']}",
        f"- 明细：gold {counts['gold_lines']} / pred {counts['pred_lines']} / 匹配 {counts['matched_lines']}",
        f"- 差异：gold {counts['gold_differences']} / pred {counts['pred_differences']} / 匹配 {counts['matched_differences']}",
    ]
    if metrics["documents"]["missing"]:
        lines.append(f"- 缺失文档：{', '.join(metrics['documents']['missing'])}")
    if metrics["documents"]["extra"]:
        lines.append(f"- 多余文档：{', '.join(metrics['documents']['extra'])}")
    if metrics["failed_thresholds"]:
        lines.append(f"- 未达标：{', '.join(metrics['failed_thresholds'])}")
    else:
        lines.append("- 全部阈值通过")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", choices=["statement", "settlement"], required=True)
    parser.add_argument("--gold", required=True)
    parser.add_argument("--pred", required=True)
    parser.add_argument("--diff-gold", default="")
    parser.add_argument("--diff-pred", default="")
    parser.add_argument("--out", default="")
    parser.add_argument("--out-md", default="")
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()

    gold_docs = load_jsonl(args.gold)
    pred_docs = load_jsonl(args.pred)
    gold_diffs = load_jsonl(args.diff_gold) if args.diff_gold else []
    pred_diffs = load_jsonl(args.diff_pred) if args.diff_pred else []

    metrics = evaluate(args.kind, gold_docs, pred_docs, gold_diffs, pred_diffs)
    report = {"kind": args.kind, "gold": args.gold, "pred": args.pred, "metrics": metrics}
    markdown = render_markdown(args.kind, metrics)

    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.out_md:
        out_md = Path(args.out_md)
        out_md.parent.mkdir(parents=True, exist_ok=True)
        out_md.write_text(markdown, encoding="utf-8")

    print(markdown)
    if args.strict and metrics["failed_thresholds"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
