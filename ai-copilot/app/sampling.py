"""分层抽样（B6）。

问题：让单证员"随便抽 400 份"，抽出来的样本一定偏——
- 都从最上面那几个月拿（最近的、最好找的）
- 都挑格式规整的（好扫的）
- 都避开盖章的（省事）

偏了的样本跑出来的准确率，不能代表全年。

做法：按「月份 × 客户 × 格式」分层，按层内数量比例分配名额，
        每层至少 1 份（只要层数 ≤ 目标数），并输出可打印的清单。
"""
from __future__ import annotations

import csv
import io
import random
from collections import defaultdict


def _stratum(item: dict, keys: tuple[str, ...]) -> str:
    return " / ".join(str(item.get(k) or "未填") for k in keys)


def plan(
    items: list[dict],
    target: int,
    keys: tuple[str, ...] = ("month", "client", "format"),
    seed: int = 7,
) -> dict:
    """按比例分层抽样，返回选中的条目与覆盖情况。"""
    if not items:
        return {"selected": [], "stats": {}, "warnings": ["没有候选条目"]}
    target = max(1, min(target, len(items)))

    groups: dict[str, list[dict]] = defaultdict(list)
    for it in items:
        groups[_stratum(it, keys)].append(it)

    strata = sorted(groups.items(), key=lambda kv: -len(kv[1]))
    warnings: list[str] = []

    if len(strata) > target:
        warnings.append(
            f"分层数 {len(strata)} 大于目标样本量 {target}，只能覆盖前 {target} 层"
        )
        strata = strata[:target]

    # 按比例分配，每层至少 1
    total = sum(len(v) for _, v in strata)
    quotas: dict[str, int] = {}
    for name, rows in strata:
        quotas[name] = max(1, round(target * len(rows) / total))

    # 配额超出目标时，从最大的层开始削
    while sum(quotas.values()) > target:
        name = max(quotas, key=lambda k: quotas[k] if quotas[k] > 1 else -1)
        if quotas[name] <= 1:
            break
        quotas[name] -= 1
    # 配额不足时补给最大的层
    while sum(quotas.values()) < target:
        name = max(quotas, key=lambda k: len(groups[k]))
        if quotas[name] >= len(groups[name]):
            break
        quotas[name] += 1

    rnd = random.Random(seed)
    selected: list[dict] = []
    for name, rows in strata:
        q = min(quotas.get(name, 1), len(rows))
        picked = rnd.sample(rows, q) if q < len(rows) else list(rows)
        for it in picked:
            selected.append({**it, "stratum": name})

    uncovered = [n for n, _ in strata if quotas.get(n, 0) == 0]
    if uncovered:
        warnings.append(f"{len(uncovered)} 个层没有被覆盖：{', '.join(uncovered[:3])}…")

    counts = defaultdict(int)
    for it in selected:
        counts[it["stratum"]] += 1

    return {
        "selected": selected,
        "stats": {
            "candidates": len(items),
            "target": target,
            "selected": len(selected),
            "strata_total": len(groups),
            "strata_covered": len({it["stratum"] for it in selected}),
            "coverage": round(len({it["stratum"] for it in selected}) / len(groups), 4),
            "by_stratum": dict(sorted(counts.items(), key=lambda kv: -kv[1])),
        },
        "warnings": warnings,
    }


def manifest_csv(selected: list[dict], keys: tuple[str, ...] = ("month", "client", "format")) -> str:
    """生成可打印的抽样清单：档案室照着勾。"""
    buf = io.StringIO()
    buf.write("\ufeff")
    w = csv.writer(buf)
    w.writerow(["序号", "分层", "月份", "客户", "格式", "文件名", "已找到", "扫描质量", "备注"])
    for i, it in enumerate(selected, 1):
        w.writerow([
            i, it.get("stratum", ""),
            it.get("month", ""), it.get("client", ""), it.get("format", ""),
            it.get("filename", it.get("id", "")),
            "", "", "",
        ])
    return buf.getvalue()


def demo_inventory(months=3, clients=5, formats=3, seed=3) -> list[dict]:
    """造一份"档案室台账"，用于演示抽样效果。"""
    rnd = random.Random(seed)
    out = []
    ms = [f"2026-{m:02d}" for m in range(8, 8 + months)]
    cs = [f"客户{c}" for c in "ABCDE"[:clients]]
    fs = ["纸质托书", "微信截图", "Excel"][:formats]
    i = 0
    for m in ms:
        for c in cs:
            for f in fs:
                n = rnd.randint(2, 28)
                for _ in range(n):
                    i += 1
                    out.append({
                        "id": f"AR{i:04d}",
                        "filename": f"{c}-{m}-{i:04d}",
                        "month": m, "client": c, "format": f,
                    })
    return out
