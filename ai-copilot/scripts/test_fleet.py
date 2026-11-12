"""车队能源/线路决策自检：公开资料、合成数据口径、AI 数字锁定与回退。"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.pop("DATABASE_URL", None)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import fleet_ai  # noqa: E402
from app.fleet import demo  # noqa: E402
from app.llm import LLMResult  # noqa: E402

ok = True


def chk(name: str, cond: bool, extra: str = "") -> None:
    global ok
    print(f"  {'✓' if cond else '✗'} {name}{('  ' + extra) if extra else ''}")
    ok = ok and cond


RESULT = demo()
CANDIDATES = fleet_ai._candidates(RESULT)


def run_llm(payload: dict) -> dict:
    with patch.object(fleet_ai, "settings", SimpleNamespace(llm_enabled=True)), \
         patch.object(fleet_ai.th, "get_bool", return_value=True), \
         patch.object(fleet_ai, "chat_json",
                      return_value=LLMResult(text=json.dumps(payload, ensure_ascii=False),
                                             tokens=999, ok=True)):
        return fleet_ai.explain(RESULT)


GOOD = {
    "brief": "示例假设下，单箱综合成本 566 元，毛利率 13.5%。"
             "能源成本占运输成本 30.8%，空驶率 10.5%。"
             "盐田线电动重卡续航余量仅 12%，补能未解决前不宜替换。",
    "priorities": [
        {"id": f"I{i}", "why": "示例规则判定；先小范围验证，不要一次性改车队结构。"}
        for i in range(1, len(CANDIDATES) + 1)
    ],
    "actions": [
        {"id": f"I{i}", "owner": "运营", "when": "本月",
         "action": "先补真实数据，再做单线路对比"}
        for i in range(1, len(CANDIDATES) + 1)
    ],
}

print("车队能源/线路决策自检")

# 1. 公开资料缓存
from app import xiefeng_public  # noqa: E402

public = RESULT["public"]
with patch.object(xiefeng_public, "LIVE_PATH", Path("/nonexistent/xiefeng.json")):
    seed = xiefeng_public.load()
chk("离线时回退仓库种子", seed["source_mode"] == "seed" and len(seed["sources"]) >= 4)
chk("公开资料来源存在", public["source_total"] >= 4)
chk("公开资料有成功抓取", public["source_ok"] >= 1)
chk("公开资料包含港口信号", "北滘港" in (public.get("signals") or {}).get("ports", []))

# 2. 合成数据口径
chk("合成数据标记", RESULT["synthetic"] is True)
chk("三条线路", len(RESULT["routes"]) == 3)
chk("四种车型", len(RESULT["vehicles"]) == 4)
chk("线路×车型组合", len(RESULT["pairs"]) == 12)
chk("人力环节", len(RESULT["labor"]) == 7)
chk("成本为正且可复算",
    all(x["cost_per_teu"] > 0 and 0 <= x["energy_share"] <= 1
        for x in RESULT["vehicles"]))
chk("电动重卡在长途线不能直接跑",
    next(x for x in RESULT["pairs"]
         if x["route"].endswith("盐田港") and x["energy"] == "电")["feasible"] != "可跑")
chk("电动重卡在短途线可跑",
    next(x for x in RESULT["pairs"]
         if x["route"].endswith("南沙港") and x["energy"] == "电")["feasible"] == "可跑")
chk("大马力/小马力成本有差异",
    next(x["cost_per_teu"] for x in RESULT["vehicles"] if "大马力" in x["vehicle"]) !=
    next(x["cost_per_teu"] for x in RESULT["vehicles"] if "小马力" in x["vehicle"]))

# 3. 模型未配置：回退规则模板，但结构完整
with patch.object(fleet_ai, "settings", SimpleNamespace(llm_enabled=False)), \
     patch.object(fleet_ai.th, "get_bool", return_value=True):
    out = fleet_ai.explain(RESULT)
chk("模型未配置时回退", out["source"] == "rule" and out["fallback"] is True)
chk("回退简报说明示例", "示例" in out["brief"])
chk("回退覆盖全部异常",
    {x["id"] for x in out["priorities"]} == {x["id"] for x in CANDIDATES})
chk("回退动作带责任人和时间",
    all(x["owner"] and x["when"] for x in out["actions"]))

# 4. 合法模型输出
out = run_llm(GOOD)
chk("合法输出被接受", out["ok"] is True and out["source"] == "llm+rule")
chk("合法输出覆盖全部异常",
    {x["id"] for x in out["priorities"]} == {x["id"] for x in CANDIDATES})
chk("token 计量回传", out["tokens"] == 999)

# 5. 编造数字
bad = json.loads(json.dumps(GOOD, ensure_ascii=False))
bad["brief"] = bad["brief"].replace("566 元", "999 元")
out = run_llm(bad)
chk("编造数字被拦截", out["source"] == "rule" and "数字" in out["error"])

# 6. 缺少“示例/假设”
bad = json.loads(json.dumps(GOOD, ensure_ascii=False))
bad["brief"] = "单箱综合成本 566 元，毛利率 13.5%。能源成本占运输成本 30.8%。盐田线补能未解决前不宜替换。"
out = run_llm(bad)
chk("未说明示例被拦截", out["source"] == "rule" and "示例" in out["error"])

# 7. 绝对化承诺
bad = json.loads(json.dumps(GOOD, ensure_ascii=False))
bad["brief"] = bad["brief"] + "保证能省钱。"
out = run_llm(bad)
chk("绝对化承诺被拦截", out["source"] == "rule" and "不允许" in out["error"])

print()
print("全部通过" if ok else "有失败项")
sys.exit(0 if ok else 1)
