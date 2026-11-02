"""地址校验（B5）。

集卡托书里最常见的地址错误，不是"写错一个字"这么简单：
- 北仑写成北仓 → 司机跑到完全不同的地方
- 上海市北仑区 → 行政区和城市对不上
- 洋山港配宁波市 → 港区与城市对不上
- 提箱地和卸货地一模一样 → 复制粘贴漏改

**刻意保守**：
- 区县一致性只覆盖项目常见的宁波/上海/杭州/苏州/嘉兴/舟山，
  其他城市没有词表就不猜，宁可漏报也不误报
- 除"提卸同址"外，其余一律 warn，不阻断单据
- 词表是人工整理的子集，不是权威行政区划；上线前需按客户常跑区域补

数据来源：公开行政区划 + 项目交付中遇到的真实错法（见 docs/运维手册.md）。
"""
from __future__ import annotations

import re

from .schema import Check

# 城市 → 区县（只覆盖常见区域；不在表里的城市不参与一致性校验）
DISTRICTS: dict[str, tuple[str, ...]] = {
    "宁波": ("海曙", "江北", "北仑", "镇海", "鄞州", "奉化",
             "余姚", "慈溪", "宁海", "象山"),
    "上海": ("黄浦", "徐汇", "长宁", "静安", "普陀", "虹口", "杨浦", "闵行",
             "宝山", "嘉定", "浦东新区", "金山", "松江", "青浦", "奉贤", "崇明"),
    "杭州": ("上城", "拱墅", "西湖", "滨江", "萧山", "余杭", "临平", "钱塘",
             "富阳", "临安", "桐庐", "淳安", "建德"),
    "苏州": ("姑苏", "虎丘", "吴中", "相城", "吴江", "常熟", "张家港",
             "昆山", "太仓"),
    "嘉兴": ("南湖", "秀洲", "嘉善", "海盐", "海宁", "平湖", "桐乡"),
    "舟山": ("定海", "普陀", "岱山", "嵊泗"),
}

# 一个区县名可能属于多个城市时（如普陀），不做冲突判断
_AMBIGUOUS = {"普陀"}

CITY_ALIASES = {
    "宁波": ("宁波",),
    "上海": ("上海",),
    "杭州": ("杭州",),
    "苏州": ("苏州",),
    "嘉兴": ("嘉兴",),
    "舟山": ("舟山",),
}

# 港区/堆场 → 合理城市。用于"洋山港 + 宁波市"这类跨区错误。
TERMINALS: dict[str, set[str]] = {
    "北仑": {"宁波", "浙江"},
    "大榭": {"宁波", "浙江"},
    "梅山": {"宁波", "浙江"},
    "穿山": {"宁波", "浙江"},
    "镇海": {"宁波", "浙江"},
    "洋山": {"上海", "舟山", "浙江"},
    "外高桥": {"上海"},
    "芦潮港": {"上海"},
    "盛东": {"上海"},
    "冠东": {"上海"},
    "太仓港": {"苏州", "江苏", "太仓"},
    "乍浦": {"嘉兴", "浙江"},
}

# 常见错别字 / 同音字（保守：只列确定的）
TYPOS: dict[str, str] = {
    "北仓": "北仑",
    "北轮": "北仑",
    "北伦": "北仑",
    "大谢": "大榭",
    "眉山": "梅山",
    "川山": "穿山",
    "阳山": "洋山",
    "外高侨": "外高桥",
    "太昌": "太仓",
    "乍蒲": "乍浦",
    "震海": "镇海",
    "奉华": "奉化",
    "慈奚": "慈溪",
    "余遥": "余姚",
    "勤州": "鄞州",
}

# 这些词出现，说明地址至少有个可定位的落点
PLACE_WORDS = (
    "市", "区", "县", "镇", "乡", "街道", "路", "街", "道", "号", "村",
    "园", "港", "堆场", "码头", "仓库", "仓", "工业区", "开发区", "新区",
    "大道", "公路", "高速", "口岸", "保税",
)

# 常见镇/街道（宁波为主），用来判断"春晓码头"这类短地址是否够具体
TOWNS = (
    "春晓", "小港", "大碶", "新碶", "柴桥", "霞浦", "白峰", "郭巨",
    "蛟川", "招宝山", "骆驼", "庄市", "姜山", "集士港", "高桥", "横街",
    "古林", "洞桥", "江口", "爵溪", "西周", "石浦", "观海卫", "周巷",
    "泗门", "陆埠", "丈亭", "临江", "滨海", "明州",
)


def _cities_in(text: str) -> list[str]:
    return [c for c, aliases in CITY_ALIASES.items()
            if any(a in text for a in aliases)]


def _districts_in(text: str) -> dict[str, list[str]]:
    """返回 {区县: [所属城市...]}。"""
    out: dict[str, list[str]] = {}
    for city, names in DISTRICTS.items():
        for d in names:
            if d in text:
                out.setdefault(d, []).append(city)
    return out


def _provinces_in(text: str) -> set[str]:
    return {p for p in ("浙江省", "江苏省", "上海市") if p in text}


def check_one(value: str, field: str, label: str) -> list[Check]:
    """校验单个地址字段。"""
    text = (value or "").strip()
    if not text:
        return []
    # 纯英文地址（如 "Beilun Depot 3"）不套中文词表，避免误报；
    # 英文地址的一致性校验需要另一套别名表，当前明确不支持。
    if not re.search(r"[\u4e00-\u9fff]", text):
        return []
    checks: list[Check] = []

    # 1. 错别字
    for wrong, right in TYPOS.items():
        if wrong in text:
            checks.append(Check(
                level="warn", code="W_ADDR_TYPO", field=field,
                message=f"{label}「{text}」里出现「{wrong}」，应为「{right}」，请核对",
            ))

    # 2. 城市 / 区县一致性
    cities = _cities_in(text)
    districts = _districts_in(text)
    for d, owners in districts.items():
        if d in _AMBIGUOUS or len(owners) != 1:
            continue
        wrong_cities = [c for c in cities if c not in owners]
        if wrong_cities:
            checks.append(Check(
                level="warn", code="W_ADDR_DISTRICT_MISMATCH", field=field,
                message=(f"{label}写的是「{wrong_cities[0]}」，但「{d}」属于"
                         f"「{owners[0]}」，请核对"),
            ))

    # 3. 港区 / 堆场与城市一致性
    for term, allowed in TERMINALS.items():
        if term not in text:
            continue
        wrong = [c for c in cities if c not in allowed]
        if wrong:
            checks.append(Check(
                level="warn", code="W_ADDR_PORT_CONFLICT", field=field,
                message=(f"{label}出现「{term}」，与城市「{wrong[0]}」不匹配，"
                         f"请确认是否跑错港区"),
            ))

    # 4. 省市冲突（同时写了两个省/直辖市）
    provs = _provinces_in(text)
    if len(provs) > 1:
        checks.append(Check(
            level="warn", code="W_ADDR_PROVINCE_CONFLICT", field=field,
            message=f"{label}同时出现多个省市（{'、'.join(sorted(provs))}），请核对",
        ))

    # 5. 完整性：只写到城市 / 太短 / 没有任何可定位的落点
    #    「北仑」「洋山港」「春晓码头」虽然短，但已经能定位，不报
    specific = bool(districts) or any(t in text for t in TERMINALS) \
        or any(t in text for t in TOWNS)
    has_place = any(w in text for w in PLACE_WORDS) or specific
    city_only = bool(cities) and not specific and len(text) <= 5
    if specific:
        pass
    elif city_only:
        checks.append(Check(
            level="warn", code="W_ADDR_INCOMPLETE", field=field,
            message=f"{label}只写到「{text}」，缺区县/堆场/门牌，司机无法定位",
        ))
    elif len(text) < 4 or not has_place:
        checks.append(Check(
            level="warn", code="W_ADDR_INCOMPLETE", field=field,
            message=f"{label}「{text}」缺少区县、道路或园区，司机可能找不到",
        ))

    return checks


def check_addresses(pickup: str, delivery: str) -> list[Check]:
    """校验提箱地与卸货地。"""
    checks = check_one(pickup, "pickup_addr", "提箱/装货地")
    checks.extend(check_one(delivery, "delivery_addr", "卸货/送货地"))

    a = re.sub(r"\s+", "", (pickup or ""))
    b = re.sub(r"\s+", "", (delivery or ""))
    if a and b and len(a) >= 4 and a == b:
        checks.append(Check(
            level="error", code="E_ADDR_SAME", field="delivery_addr",
            message="提箱地与卸货地完全相同，疑似复制后漏改",
        ))
    return checks
