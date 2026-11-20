"""规则抽取行为快照：迁移/重构前后逐字段对比。

用法：
    cd ai-copilot
    PYTHONPATH=. .venv/bin/python scripts/snapshot_extract.py /tmp/extract_baseline.json
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.evalrun import HOLDOUT_PATH, SAMPLE_PATH, load_samples  # noqa: E402
from app.extract import extract  # noqa: E402


def snapshot() -> dict:
    out = {}
    for name, path in (("tuned", SAMPLE_PATH), ("holdout", HOLDOUT_PATH)):
        rows = []
        for item in load_samples(path):
            d = extract(item["raw"], mode="rule", allow_llm=False)
            rows.append({
                "raw": item["raw"],
                "fields": {
                    k: {"value": v.value, "confidence": v.confidence, "source": v.source}
                    for k, v in d.fields.items()
                },
                "checks": [c.model_dump() for c in d.checks],
                "review_level": d.review_level,
            })
        out[name] = rows
    return out


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/extract_baseline.json")
    target.write_text(json.dumps(snapshot(), ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"written {target}")
