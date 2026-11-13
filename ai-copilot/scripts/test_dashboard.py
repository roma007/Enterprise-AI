"""经营驾驶舱自检：数据结构、样张标识、AI 数字锁定与回退。"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.pop("DATABASE_URL", None)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import dashboard_ai  # noqa: E402
from app.dashboard import demo  # noqa: E402
from app.llm import LLMResult  # noqa: E402

ok = True


def chk(name: str, cond: bool, extra: str = "") -> None:
    global ok
    print(f"  {'✓' if cond else '✗'} {name}{('  ' + extra) if extra else ''}")
    ok = ok and cond


RESULT = demo()
CANDIDATES = dashboard_ai._candidates(RESULT)


def run_llm(payload: dict) -> dict:
    with patch.object(dashboard_ai, "settings", SimpleNamespace(llm_enabled=True)), \
         patch.object(dashboard_ai.th, "get_bool", return_value=True), \
         patch.object(dashboard_ai, "chat_json",
                      return_value=LLMResult(text=json.dumps(payload, ensure_ascii=False),
                                             tokens=777, ok=True)):
        return dashboard_ai.explain(RESULT)


GOOD = {
    "brief": "示例/合成数据下，应收 78,600 元、毛利 56,760 元，毛利率 72.2%。"
             "逾期未收 25,200 元，3 家客户需催收。"
             "先处理逾期和亏损单，再补 1,418 元未归集成本。",
    "priorities": [
        {"id": f"I{i}", "why": "规则判定为需关注；先小范围核实，不要一次性改经营策略。"}
        for i in range(1, len(CANDIDATES) + 1)
    ],
    "actions": [
        {"id": f"I{i}", "owner": "财务", "when": "本月",
         "action": "先核对数据，再定处理动作"}
        for i in range(1, len(CANDIDATES) + 1)
    ],
}

print("经营驾驶舱自检")

# 1. 数据结构
chk("标题包含经营驾驶舱", "经营驾驶舱" in "经营驾驶舱")
chk("经营指标齐全", {"revenue", "cost", "profit", "margin", "overdue"} <= set(RESULT["headline"]))
chk("三个模块快照", len(RESULT["modules"]) == 3)
chk("决策卡不少于 4 条", len(RESULT["decisions"]) >= 4)
chk("数据状态不少于 4 行", len(RESULT["data_status"]) >= 4)
chk("样张明确不可加总", "不可加总" in RESULT["warning"])
chk("决策卡有来源/责任人/时间",
    all(x.get("source") and x.get("owner") and x.get("when") for x in RESULT["decisions"]))
chk("决策卡有跳转", all(x.get("link") for x in RESULT["decisions"]))

# 2. 模型未配置：回退规则模板
with patch.object(dashboard_ai, "settings", SimpleNamespace(llm_enabled=False)), \
     patch.object(dashboard_ai.th, "get_bool", return_value=True):
    out = dashboard_ai.explain(RESULT)
chk("模型未配置时回退", out["source"] == "rule" and out["fallback"] is True)
chk("回退简报说明示例/合成", "示例" in out["brief"] or "合成" in out["brief"])
chk("回退覆盖全部决策",
    {x["id"] for x in out["priorities"]} == {x["id"] for x in CANDIDATES})
chk("回退动作有责任人和时间",
    all(x["owner"] and x["when"] for x in out["actions"]))

# 3. 合法模型输出
out = run_llm(GOOD)
chk("合法输出被接受", out["ok"] is True and out["source"] == "llm+rule")
chk("合法输出覆盖全部决策",
    {x["id"] for x in out["priorities"]} == {x["id"] for x in CANDIDATES})
chk("token 计量回传", out["tokens"] == 777)

# 4. 编造数字
bad = json.loads(json.dumps(GOOD, ensure_ascii=False))
bad["brief"] = bad["brief"].replace("78,600 元", "999,999 元")
out = run_llm(bad)
chk("编造数字被拦截", out["source"] == "rule" and "数字" in out["error"])

# 5. 缺少“示例/合成”
bad = json.loads(json.dumps(GOOD, ensure_ascii=False))
bad["brief"] = "应收 78,600 元、毛利 56,760 元，毛利率 72.2%。逾期未收 25,200 元。先处理逾期和亏损单。"
out = run_llm(bad)
chk("未说明示例被拦截", out["source"] == "rule" and "示例" in out["error"])

# 6. 绝对化承诺
bad = json.loads(json.dumps(GOOD, ensure_ascii=False))
bad["brief"] = bad["brief"] + "保证能降本。"
out = run_llm(bad)
chk("绝对化承诺被拦截", out["source"] == "rule" and "不允许" in out["error"])

print()
print("全部通过" if ok else "有失败项")
sys.exit(0 if ok else 1)
