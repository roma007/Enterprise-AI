"""规则抽取逐字段回归（AI-61 复盘遗留）。

基线：`samples/extract_rule_baseline.json`（由 `scripts/snapshot_extract.py` 生成）。
任何时候改 extract 元数据/通用抽取器，都必须先跑本测试，确认没有意外改变。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.evalrun import HOLDOUT_PATH, SAMPLE_PATH, load_samples  # noqa: E402
from app.extract import extract  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
BASELINE = ROOT / "samples" / "extract_rule_baseline.json"

ok = True
checks = 0
fails = 0


def chk(name: str, cond: bool, extra: str = "") -> None:
    global ok, checks, fails
    checks += 1
    if cond:
        return
    ok = False
    fails += 1
    print(f"  ✗ {name}{('  ' + extra) if extra else ''}")


def view(draft) -> dict:
    return {
        "fields": {
            k: {"value": v.value, "confidence": v.confidence, "source": v.source}
            for k, v in draft.fields.items()
        },
        "checks": [c.model_dump() for c in draft.checks],
        "review_level": draft.review_level,
    }


def main() -> None:
    base = json.loads(BASELINE.read_text(encoding="utf-8"))
    for split, path in (("tuned", SAMPLE_PATH), ("holdout", HOLDOUT_PATH)):
        samples = load_samples(path)
        expected = base[split]
        chk(f"{split} 样本数", len(samples) == len(expected),
            f"{len(samples)} vs {len(expected)}")
        for i, (item, exp) in enumerate(zip(samples, expected)):
            got = view(extract(item["raw"], mode="rule", allow_llm=False))
            want = {
                "fields": exp["fields"],
                "checks": exp["checks"],
                "review_level": exp["review_level"],
            }
            if got == want:
                chk(f"{split}#{i}", True)
                continue
            chk(f"{split}#{i} 整体一致", False)
            for key in exp["fields"]:
                if got["fields"].get(key) != exp["fields"][key]:
                    chk(f"{split}#{i}.{key}", False,
                        f"{got['fields'].get(key)} != {exp['fields'][key]}")
            if got["checks"] != exp["checks"]:
                chk(f"{split}#{i}.checks", False, "checks 有差异")
            if got["review_level"] != exp["review_level"]:
                chk(f"{split}#{i}.review", False,
                    f"{got['review_level']} != {exp['review_level']}")

    print(f"\n{checks} 项断言，失败 {fails} 项")
    if ok:
        print("全部通过")
    else:
        print("存在失败项：改抽取后请确认差异是有意的，再重生成基线")
        sys.exit(1)


if __name__ == "__main__":
    main()
