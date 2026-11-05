"""托书结构化小评测：读取一个文件夹里的 .txt 托书，逐份解析并输出 CSV。

用法：
    PYTHONPATH=. .venv/bin/python scripts/eval_booking_folder.py \
      --dir ../../会客包/试点一/托书评测模板/样本 \
      --gold ../../会客包/试点一/托书评测模板/金标.csv \
      --out data/booking_eval.csv \
      --report data/booking_eval.md

约定：
- 每份托书一个 .txt 文件，文件名去掉扩展名就是 doc_id。
- 金标 CSV 三列：doc_id,field,expected；没有金标时只输出解析结果，不算准确率。
- 这是评测工具，不写入正式库；不会产生 runs/inbound 记录。
"""
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

from app.extract import extract
from app.schema import normalize_for_compare


def load_gold(path: Path | None) -> dict[str, dict[str, str]]:
    if not path:
        return {}
    out: dict[str, dict[str, str]] = {}
    with path.open(encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            doc_id = (row.get("doc_id") or "").strip()
            field = (row.get("field") or "").strip()
            expected = (row.get("expected") or "").strip()
            if not doc_id or not field:
                continue
            out.setdefault(doc_id, {})[field] = expected
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="托书结构化小评测")
    parser.add_argument("--dir", required=True, help="托书 .txt 文件夹")
    parser.add_argument("--gold", help="金标 CSV（doc_id,field,expected）")
    parser.add_argument("--out", default="data/booking_eval.csv", help="输出 CSV")
    parser.add_argument("--report", help="可选：输出 Markdown 摘要")
    args = parser.parse_args()

    folder = Path(args.dir)
    if not folder.is_dir():
        raise SystemExit(f"目录不存在：{folder}")
    docs = sorted(p for p in folder.iterdir() if p.suffix.lower() == ".txt")
    if not docs:
        raise SystemExit(f"目录里没有 .txt：{folder}")

    gold = load_gold(Path(args.gold) if args.gold else None)
    rows: list[dict] = []
    for path in docs:
        doc_id = path.stem
        raw = path.read_text(encoding="utf-8")
        draft = extract(raw)
        values = {k: ((fv.value or "") if fv else "") for k, fv in draft.fields.items()}
        errors = [c.message for c in draft.checks if c.level == "error"]
        warns = [c.message for c in draft.checks if c.level == "warn"]
        expected = gold.get(doc_id)
        accuracy = ""
        whole = ""
        wrong = ""
        if expected:
            total = len(expected)
            correct = 0
            wrong_list: list[str] = []
            for key, want in expected.items():
                got = values.get(key, "")
                if normalize_for_compare(key, got) == normalize_for_compare(key, want):
                    correct += 1
                else:
                    wrong_list.append(f"{key}={got or '空'}（期望 {want or '空'}）")
            accuracy = f"{correct / total * 100:.1f}%"
            whole = "是" if correct == total else "否"
            wrong = "；".join(wrong_list)
        rows.append(
            {
                "doc_id": doc_id,
                "engine": draft.engine,
                "review_level": draft.review_level,
                "elapsed_ms": draft.elapsed_ms,
                "field_count": len(values),
                "filled_count": sum(1 for v in values.values() if v),
                "errors": "；".join(errors),
                "warns": "；".join(warns),
                "accuracy": accuracy,
                "whole_correct": whole,
                "wrong_fields": wrong,
                "fields_json": json.dumps(values, ensure_ascii=False),
            }
        )

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    if args.report:
        scored = [r for r in rows if r["accuracy"]]
        acc_values = [float(str(r["accuracy"]).rstrip("%")) for r in scored]
        whole_rate = (
            sum(1 for r in scored if r["whole_correct"] == "是") / len(scored) * 100
            if scored
            else 0
        )
        lines = [
            "# 托书结构化小评测",
            "",
            f"- 样本数：{len(rows)}",
            f"- 有金标：{len(scored)}",
            f"- 平均字段准确率：{sum(acc_values) / len(acc_values):.1f}%" if scored else "- 平均字段准确率：—",
            f"- 整单全对率：{whole_rate:.1f}%" if scored else "- 整单全对率：—",
            f"- 平均耗时：{sum(int(r['elapsed_ms']) for r in rows) / len(rows):.0f} ms",
            f"- 阻断单：{sum(1 for r in rows if r['review_level'] == 'blocked')}",
            "",
            "| 文件 | 引擎 | 级别 | 耗时 | 准确率 | 整单全对 | 错误 |",
            "|---|---|---|---|---|---|---|",
        ]
        for r in rows:
            lines.append(
                f"| {r['doc_id']} | {r['engine']} | {r['review_level']} | {r['elapsed_ms']} ms | {r['accuracy'] or '—'} | {r['whole_correct'] or '—'} | {r['errors'] or '—'} |"
            )
        Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        Path(args.report).write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"已输出 {out}（{len(rows)} 份）")
    if args.report:
        print(f"已输出 {args.report}")


if __name__ == "__main__":
    main()
