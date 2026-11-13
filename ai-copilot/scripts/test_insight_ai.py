"""经营洞察 AI 解读自检：数字锁定、ID 覆盖、措辞边界、失败回退。

不启动服务、不调用真实模型：用假模型输出验证校验与回退。
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.pop("DATABASE_URL", None)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import insight_ai  # noqa: E402
from app.insight import demo  # noqa: E402
from app.llm import LLMResult  # noqa: E402

ok = True


def chk(name: str, cond: bool, extra: str = "") -> None:
    global ok
    print(f"  {'✓' if cond else '✗'} {name}{('  ' + extra) if extra else ''}")
    ok = ok and cond


RESULT = demo()["result"]
CANDIDATES = insight_ai._candidates(RESULT)


def run_llm(payload: dict) -> dict:
    with patch.object(insight_ai, "settings", SimpleNamespace(llm_enabled=True)), \
         patch.object(insight_ai.th, "get_bool", return_value=True), \
         patch.object(insight_ai, "chat_json",
                      return_value=LLMResult(text=json.dumps(payload, ensure_ascii=False),
                                             tokens=321, ok=True)):
        return insight_ai.explain(RESULT)


GOOD = {
    "brief": "本期 24 单，毛利 56,760 元，毛利率 72.2%。"
             "有 1,418 元成本未归集，当前毛利可能被高估。"
             "逾期未收 25,200 元，3 家客户需要催收。"
             "建议先补 1,418 元成本归集，再核对 1 单亏损。",
    "priorities": [
        {"id": "I1", "why": "亏损金额明确，先核对成本归集和报价。"},
        {"id": "I2", "why": "成本未归集会让毛利偏高，先补录再重跑。"},
        {"id": "I3", "why": "逾期金额最大，先催逾期最久的客户。"},
    ],
    "actions": [
        {"id": "I1", "owner": "财务", "when": "本周", "action": "核对亏损单的成本与报价"},
        {"id": "I2", "owner": "财务", "when": "本周", "action": "补录成本并重跑毛利"},
        {"id": "I3", "owner": "财务", "when": "本周", "action": "按账龄清单联系客户"},
    ],
}

print("经营洞察 AI 解读自检")

# 1. 未启用模型：回退规则模板，但结构完整
with patch.object(insight_ai, "settings", SimpleNamespace(llm_enabled=False)), \
     patch.object(insight_ai.th, "get_bool", return_value=True):
    out = insight_ai.explain(RESULT)
chk("模型未配置时回退", out["source"] == "rule" and out["fallback"] is True)
chk("回退仍有 3–5 句简报",
    3 <= len([x for x in out["brief"].replace("。", "。|").split("|") if x.strip()]) <= 5)
chk("回退覆盖全部异常",
    {x["id"] for x in out["priorities"]} == {x["id"] for x in CANDIDATES})
chk("回退动作也有责任人和时间",
    all(x["owner"] and x["when"] for x in out["actions"]))

# 2. 合法模型输出：接受，并保留规则指标
out = run_llm(GOOD)
chk("合法输出被接受", out["ok"] is True and out["source"] == "llm+rule")
chk("合法输出保留 3–5 句", out["brief"].count("。") >= 3)
chk("合法输出覆盖全部异常",
    {x["id"] for x in out["priorities"]} == {x["id"] for x in CANDIDATES})
chk("token 计量回传", out["tokens"] == 321)

# 3. 编造数字：必须回退
bad = json.loads(json.dumps(GOOD, ensure_ascii=False))
bad["brief"] = bad["brief"].replace("本期 24 单", "本期 25 单")
out = run_llm(bad)
chk("编造数字被拦截", out["source"] == "rule" and "数字" in out["error"])

# 4. 未知异常编号：必须回退
bad = json.loads(json.dumps(GOOD, ensure_ascii=False))
bad["priorities"][0]["id"] = "I9"
out = run_llm(bad)
chk("未知异常编号被拦截", out["source"] == "rule" and "未知异常编号" in out["error"])

# 5. 法律/付款承诺：必须回退
bad = json.loads(json.dumps(GOOD, ensure_ascii=False))
bad["brief"] = bad["brief"] + "我们保证回款。"
out = run_llm(bad)
chk("付款承诺被拦截", out["source"] == "rule" and "不允许" in out["error"])

# 6. 规则结果里的“最长逾期”应为全局最长，不是金额最高客户的天数
overdue = next(x for x in RESULT["insights"] if "逾期未收" in x["title"])
global_max = max(c["max_overdue_days"] for c in RESULT["overdue_clients"])
top_max = RESULT["overdue_clients"][0]["max_overdue_days"]
chk("最长逾期取全局值", f"{global_max} 天" in overdue["detail"]
    and (top_max == global_max or f"{top_max} 天" not in overdue["detail"]))

print()
print("全部通过" if ok else "有失败项")
sys.exit(0 if ok else 1)
