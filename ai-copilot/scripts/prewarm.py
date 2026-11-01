"""演示预热：把所有样本的模型结果预先跑进缓存。

为什么需要：模型单条 5–8 秒，现场点一下要等 8 秒会冷场。
预热后同一份托书命中缓存，**1 秒内出结果**。

用法（演示前 1 天跑一次，改了提示词/换模型要重跑）：
    make prewarm
或
    PYTHONPATH=. .venv/bin/python scripts/prewarm.py
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# 必须在导入 app 之前设置：预热要把每条都真的送进模型，不能走 auto 跳过
os.environ["LLM_STRATEGY"] = "always"

from app.config import settings  # noqa: E402
from app.evalrun import HOLDOUT_PATH, SAMPLE_PATH, load_samples  # noqa: E402
from app.extract import extract  # noqa: E402

EXTRA = [ROOT / "samples" / "sim_clientA.jsonl"]


def main() -> int:
    if not settings.llm_enabled:
        print("未配置模型（LLM_API_KEY 为空），无需预热。规则引擎本身是毫秒级。")
        return 0

    paths = [SAMPLE_PATH, HOLDOUT_PATH, *[p for p in EXTRA if p.exists()]]
    total = 0
    started = time.time()
    print(f"模型：{settings.model}")
    print(f"缓存：{ROOT / 'data' / 'llm_cache.json'}\n")

    for path in paths:
        if not path.exists():
            continue
        items = load_samples(path)
        ok = 0
        for i, s in enumerate(items, 1):
            t = time.time()
            d = extract(s["raw"], allow_llm=True)
            ok += 1 if d.tokens else 0
            print(f"  [{path.name}] {i}/{len(items)} {s.get('id','')} "
                  f"{d.engine} {d.elapsed_ms}ms tokens={d.tokens}")
        total += len(items)

    print(f"\n完成：{total} 条，用时 {time.time() - started:.0f}s")
    print("提示：命中缓存时 elapsed_ms 会明显变小、tokens 仍显示原始消耗。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
