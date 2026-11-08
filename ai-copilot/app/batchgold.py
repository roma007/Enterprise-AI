"""批量结果的金标导出与比对（AI-24）。

解决的是现场最常见的一段手工活：
批量处理完 → 导出结果 → 人工核对 → 再手工对比准确率。

这里只做两件事：
1. 导出「金标模板」：每条 run 一行，gold_* 留空，pred_* 带系统值，text 带原文。
2. 导入填好的 CSV：按 run_id 找系统值，逐字段比对，输出字段级准确率。

边界：
- 只比对填了 gold 的字段；没填的字段不参与，不拿空值惩罚。
- 结果只代表这一批人工标注样本，不是客户整体准确率。
"""
from __future__ import annotations

import csv
import io
import json
import uuid
from datetime import datetime

from . import db
from .config import ROOT
from .schema import FIELD_KEYS, LABELS, normalize_for_compare
from .store import get_batch

EVAL_DIR = ROOT / "data" / "batch_evals"


def _batch_rows(batch_id: str) -> list[dict]:
    """金标模板/比对当前只支持托书；发票字段不同，先不做半套。"""
    batch = get_batch(batch_id)
    if not batch:
        raise ValueError("批次不存在")
    if (batch.get("kind") or "booking") != "booking":
        raise ValueError("金标导出/比对当前只支持托书批次")
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT bi.filename, bi.run_id, r.raw_text, r.fields_json"
            " FROM batch_items bi JOIN runs r ON r.id = bi.run_id"
            " WHERE bi.batch_id=? AND bi.status='extracted' AND bi.run_id IS NOT NULL"
            " ORDER BY bi.filename",
            (batch_id,),
        ).fetchall()
    out = []
    for row in rows:
        try:
            fields = json.loads(row["fields_json"] or "{}")
        except json.JSONDecodeError:
            fields = {}
        out.append({
            "file": row["filename"],
            "run_id": row["run_id"],
            "text": row["raw_text"] or "",
            "pred": {k: str((fields.get(k) or {}).get("value") or "")
                     for k in FIELD_KEYS},
        })
    return out


def export_template(batch_id: str) -> str:
    rows = _batch_rows(batch_id)
    if not rows:
        raise ValueError("该批次还没有已识别的结果")
    buf = io.StringIO()
    buf.write("\ufeff")
    writer = csv.writer(buf)
    writer.writerow(["run_id", "file", "text"]
                    + [f"gold_{k}" for k in FIELD_KEYS]
                    + [f"pred_{k}" for k in FIELD_KEYS])
    for row in rows:
        writer.writerow([row["run_id"], row["file"], row["text"]]
                        + ["" for _ in FIELD_KEYS]
                        + [row["pred"][k] for k in FIELD_KEYS])
    return buf.getvalue()


def evaluate_csv(batch_id: str, text: str, actor: str = "") -> dict:
    rows = _batch_rows(batch_id)
    if not rows:
        raise ValueError("该批次还没有已识别的结果")
    by_run = {r["run_id"]: r for r in rows}

    reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff")))
    if not reader.fieldnames:
        raise ValueError("CSV 没有表头")
    gold_cols = [c for c in reader.fieldnames if c.startswith("gold_")]
    if not gold_cols:
        raise ValueError("CSV 缺少 gold_ 列；请先用「导出金标模板」")

    per_field = {k: {"correct": 0, "total": 0, "missing": 0} for k in FIELD_KEYS}
    used = 0
    skipped = 0
    record_exact = 0
    for row in reader:
        run_id = (row.get("run_id") or "").strip()
        target = by_run.get(run_id)
        if not target:
            skipped += 1
            continue
        gold = {}
        for col in gold_cols:
            key = col[5:]
            value = (row.get(col) or "").strip()
            if key in per_field and value:
                gold[key] = value
        if not gold:
            skipped += 1
            continue
        used += 1
        all_ok = True
        for key, expect in gold.items():
            got = target["pred"].get(key, "")
            ok = normalize_for_compare(key, got) == normalize_for_compare(key, expect)
            per_field[key]["total"] += 1
            if ok:
                per_field[key]["correct"] += 1
            else:
                all_ok = False
                if not got:
                    per_field[key]["missing"] += 1
        if all_ok:
            record_exact += 1

    if not used:
        raise ValueError("CSV 里没有可比对的金标；请至少填写一个 gold_ 字段")

    total_c = sum(v["correct"] for v in per_field.values())
    total_t = sum(v["total"] for v in per_field.values())
    by_field = [
        {"field": k, "label": LABELS[k],
         "accuracy": round(v["correct"] / v["total"], 4) if v["total"] else None,
         "total": v["total"], "missing": v["missing"]}
        for k, v in per_field.items() if v["total"]
    ]
    by_field.sort(key=lambda x: (x["accuracy"] if x["accuracy"] is not None else 1))

    result = {
        "batch_id": batch_id,
        "records": used,
        "skipped": skipped,
        "field_accuracy": round(total_c / total_t, 4) if total_t else 0.0,
        "record_exact_rate": round(record_exact / used, 4) if used else 0.0,
        "evaluated_fields": total_t,
        "by_field": by_field,
        "warning": "人工金标比对；只代表本批样本，不是客户整体准确率。",
    }

    EVAL_DIR.mkdir(parents=True, exist_ok=True)
    eval_id = uuid.uuid4().hex[:10]
    payload = {"id": eval_id, "ts": datetime.now().isoformat(timespec="seconds"),
               "actor": actor, **result}
    (EVAL_DIR / f"{batch_id}-{eval_id}.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    result["eval_id"] = eval_id
    return result
