"""评测跑批。

存在的意义：没有这个脚本，demo 就只是"看起来能用"。
有了它，你才能在客户面前说"字段级准确率 X%，人工修正 Y 秒/单"。

注意：默认样本是合成样本。**合成样本上跑出的高准确率不构成对外结论**，
必须用客户真实托书替换 samples/bookings.jsonl 后重跑。
"""
from __future__ import annotations

import json
from pathlib import Path

from .extract import extract
from .schema import BLOCKING_KEYS, FIELD_KEYS, LABELS, normalize_for_compare

SAMPLE_PATH = Path(__file__).resolve().parent.parent / "samples" / "bookings.jsonl"
HOLDOUT_PATH = Path(__file__).resolve().parent.parent / "samples" / "bookings_holdout.jsonl"


def load_samples(path: Path | None = None) -> list[dict]:
    path = path or SAMPLE_PATH
    items = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("//"):
            items.append(json.loads(line))
    return items


def run_eval(path: Path | None = None, mode: str = "merged") -> dict:
    samples = load_samples(path)
    per_field: dict[str, dict] = {
        k: {"correct": 0, "total": 0, "missing": 0} for k in FIELD_KEYS
    }
    record_exact = 0
    blocking_correct = 0
    blocking_total = 0
    engine = ""

    for s in samples:
        draft = extract(s["raw"], mode=mode)
        engine = draft.engine
        gold: dict[str, str] = s.get("gold", {})
        all_ok = True
        for key, expect in gold.items():
            if key not in per_field:
                continue
            got = draft.fields.get(key)
            got_val = got.value if got else None
            ok = normalize_for_compare(key, got_val) == normalize_for_compare(key, expect)
            per_field[key]["total"] += 1
            if ok:
                per_field[key]["correct"] += 1
            else:
                all_ok = False
                if not got_val:
                    per_field[key]["missing"] += 1
            if key in BLOCKING_KEYS:
                blocking_total += 1
                blocking_correct += 1 if ok else 0
        if all_ok:
            record_exact += 1

    total_c = sum(v["correct"] for v in per_field.values())
    total_t = sum(v["total"] for v in per_field.values())

    by_field = [
        {
            "field": k,
            "label": LABELS[k],
            "accuracy": round(v["correct"] / v["total"], 4) if v["total"] else None,
            "total": v["total"],
            "missing": v["missing"],
        }
        for k, v in per_field.items()
        if v["total"]
    ]
    by_field.sort(key=lambda x: (x["accuracy"] if x["accuracy"] is not None else 1))

    return {
        "engine": engine,
        "mode": mode,
        "samples": len(samples),
        "field_accuracy": round(total_c / total_t, 4) if total_t else 0.0,
        "record_exact_rate": round(record_exact / len(samples), 4) if samples else 0.0,
        "blocking_accuracy": round(blocking_correct / blocking_total, 4) if blocking_total else 0.0,
        "evaluated_fields": total_t,
        "by_field": by_field,
        "warning": "合成样本结果，不构成对外结论；需用客户真实托书替换后重跑。",
    }


def run_compare(path: Path | None = None) -> dict:
    """三种模式对照：规则 / 模型 / 合并。

    这是回答"模型到底补了什么、规则到底拦了什么"的唯一办法。
    没有模型 Key 时 llm 一行为 None，不伪造数字。
    """
    out: dict[str, dict | None] = {}
    for mode in ("rule", "llm", "merged"):
        try:
            out[mode] = run_eval(path, mode=mode)
        except Exception as exc:  # noqa: BLE001
            out[mode] = {"error": f"{type(exc).__name__}: {exc}"}
    if out.get("llm") and out["llm"].get("engine") == "llm-unavailable":
        out["llm"] = None
    return out


def run_all() -> dict:
    """同时跑调优集与留出集，并对留出集做三模式对照。

    调优集反映"规则写到多细"，留出集反映"换一批格式还准不准"。
    对外只报留出集，调优集仅作对照 —— 这是 POC 的基本纪律。
    """
    tuned = run_eval(SAMPLE_PATH)
    holdout = run_eval(HOLDOUT_PATH) if HOLDOUT_PATH.exists() else None
    compare = run_compare(HOLDOUT_PATH) if HOLDOUT_PATH.exists() else None
    return {"tuned": tuned, "holdout": holdout, "compare": compare}


if __name__ == "__main__":
    print(json.dumps(run_all(), ensure_ascii=False, indent=2))
