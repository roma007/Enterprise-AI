"""B5 地址校验自检。

覆盖：
- 正常地址不误报（用现有样本里的真实写法）
- 错别字 / 区县与城市冲突 / 港区与城市冲突 / 提卸同址
- 短地址或缺少落点的提醒

用法：
    PYTHONPATH=. .venv/bin/python scripts/test_address.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.address_check import check_addresses  # noqa: E402

ok = True


def chk(name: str, cond: bool, extra: str = "") -> None:
    global ok
    print(f"  {'✓' if cond else '✗'} {name}{('  ' + extra) if extra else ''}")
    ok = ok and cond


def codes(pickup: str, delivery: str) -> list[str]:
    return [c.code for c in check_addresses(pickup, delivery)]


print("正常地址不误报")
valid = [
    ("北仑港区二期堆场", "宁波北仑春晓工业园3号仓"),
    ("北仑三期堆场", "宁波杭州湾新区滨海二路 66 号"),
    ("穿山港区堆场", "宁波鄞州经济开发区金谷北路 128 号"),
    ("北仑小港街道江南路 88 号", "春晓码头"),
    ("大榭港区堆场", "宁波象山爵溪街道工业区"),
    ("梅山港区堆场", "宁波镇海蛟川街道临江路 77 号"),
    ("北仑二期堆场", "宁波奉化江口街道工业园"),
    ("洋山港盛东码头", "上海市浦东新区临港大道 1 号"),
]
for p, d in valid:
    chk(f"{p[:10]} → {d[:12]}", codes(p, d) == [], str(codes(p, d)))

print("纯英文地址不硬套中文词表")
chk("Beilun Depot 3 → Ningbo Zhenhai",
    codes("Beilun Depot 3", "Ningbo Zhenhai") == [],
    str(codes("Beilun Depot 3", "Ningbo Zhenhai")))

print("错别字")
c = codes("北仓二期堆场", "宁波北仑春晓")
chk("北仓 → 北仑", "W_ADDR_TYPO" in c, str(c))
c = codes("大谢港区", "宁波北仑")
chk("大谢 → 大榭", "W_ADDR_TYPO" in c, str(c))
c = codes("洋山港", "上海浦东新区")
chk("正常洋山不误报错别字", "W_ADDR_TYPO" not in c, str(c))
chk("「洋山港」够定位，不报过短", "W_ADDR_INCOMPLETE" not in c, str(c))

print("区县与城市冲突")
c = codes("上海市北仑区某堆场", "上海市浦东新区")
chk("上海市 + 北仑区", "W_ADDR_DISTRICT_MISMATCH" in c, str(c))
c = codes("宁波市浦东新区某路 1 号", "宁波北仑")
chk("宁波市 + 浦东新区", "W_ADDR_DISTRICT_MISMATCH" in c, str(c))
c = codes("舟山市普陀区", "宁波北仑")
chk("普陀（多市共有）不武断报错", "W_ADDR_DISTRICT_MISMATCH" not in c, str(c))

print("港区与城市冲突")
# 只判断「同一个地址字段内」的冲突：
# 提箱洋山、卸货宁波是正常业务，不能跨字段乱报
c = codes("宁波市洋山港", "宁波北仑")
chk("宁波市 + 洋山港（同字段）", "W_ADDR_PORT_CONFLICT" in c, str(c))
c = codes("上海市北仑区某路", "宁波北仑")
chk("上海市 + 北仑（同字段）", "W_ADDR_PORT_CONFLICT" in c, str(c))
c = codes("上海洋山港", "上海市浦东新区")
chk("上海 + 洋山港放行", "W_ADDR_PORT_CONFLICT" not in c, str(c))
c = codes("洋山港盛东码头", "宁波市北仑区")
chk("提箱洋山、卸货宁波是正常业务", "W_ADDR_PORT_CONFLICT" not in c, str(c))

print("提卸同址")
c = codes("宁波北仑春晓工业园3号仓", "宁波北仑春晓工业园3号仓")
chk("完全相同 → error", "E_ADDR_SAME" in c, str(c))
c = codes("宁波北仑春晓工业园3号仓", "宁波北仑春晓工业园 3 号仓")
chk("仅空格不同也算同址", "E_ADDR_SAME" in c, str(c))

print("完整性")
c = codes("北仑", "宁波北仑")
chk("「北仑」够定位，不报过短", "W_ADDR_INCOMPLETE" not in c, str(c))
c = codes("宁波", "春晓码头")
chk("「宁波」过短", "W_ADDR_INCOMPLETE" in c, str(c))
c = codes("二期", "北仑春晓")
chk("「二期」无落点", "W_ADDR_INCOMPLETE" in c, str(c))

print("真正走一遍规则引擎")
from app.extract import extract  # noqa: E402
d = extract(
    "客户：测试\n委托单号：T1\n箱型：40HQ\n箱量：1\n箱号：CSQU3054383\n"
    "提箱地：北仓二期堆场\n卸货地：上海市北仑区某路\n截港时间：2026-12-07 18:00",
    allow_llm=False,
)
found = {c.code for c in d.checks}
chk("规则引擎带出地址告警", "W_ADDR_TYPO" in found and "W_ADDR_DISTRICT_MISMATCH" in found, str(sorted(found)))
chk("有告警时不会自动通过", d.review_level != "auto", d.review_level)

print()
print("全部通过" if ok else "有失败项")
sys.exit(0 if ok else 1)
