"""地址校验（B5）。

集卡托书里最常见的地址错误，不是"写错一个字"这么简单：
- 北仑写成北仓 → 司机跑到完全不同的地方
- 上海市北仑区 → 行政区和城市对不上
- 洋山港配宁波市 → 港区与城市对不上
- 提箱地和卸货地一模一样 → 复制粘贴漏改

**刻意保守**：
- 区县一致性只覆盖 `pack.geo` 里的城市；其他城市没有词表就不猜，宁可漏报也不误报
- 除"提卸同址"外，其余一律 warn，不阻断单据
- 词表是人工整理的子集，不是权威行政区划；上线前按客户常跑区域补

数据来源：`packs/<id>/geo.json`（按客户常跑区域维护）+ 公开行政区划 + 交付中遇到的真实错法。
"""
from __future__ import annotations

import re

from .pack import active_pack
from .schema import Check

_GEO = active_pack().geo

# 城市 → 区县（只覆盖 pack 里配置的区域；不在表里的城市不参与一致性校验）
DISTRICTS: dict[str, tuple[str, ...]] = {
    city: tuple(names) for city, names in (_GEO.get("cities") or {}).items()
}

# 一个区县名可能属于多个城市时（如普陀），不做冲突判断
_AMBIGUOUS = set(_GEO.get("ambiguous") or ())

CITY_ALIASES: dict[str, tuple[str, ...]] = {
    city: tuple(aliases) for city, aliases in (_GEO.get("city_aliases") or {}).items()
}

# 港区/堆场 → 合理城市。用于"洋山港 + 宁波市"这类跨区错误。
TERMINALS: dict[str, set[str]] = {
    term: set(cities) for term, cities in (_GEO.get("terminals") or {}).items()
}

# 常见错别字 / 同音字（保守：只列确定的）
TYPOS: dict[str, str] = dict(_GEO.get("typos") or {})

# 这些词出现，说明地址至少有个可定位的落点
PLACE_WORDS = tuple(_GEO.get("place_words") or ())

# 常见镇/街道，用来判断"春晓码头"这类短地址是否够具体
TOWNS = tuple(_GEO.get("towns") or ())


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
