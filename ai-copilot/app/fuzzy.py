"""字段名容错匹配（D14）。

问题（模拟演练中实测）：
    印刷体照片里，"箱号" 经常被认成 "第号"，"截港时间" 被认成 "藏港时间"。
    值其实识别对了，但键名错一个字，整个字段就抽不出来。
    这类错误**拉对比度救不回来**，只能靠容错匹配。

做法：标签模糊 + 值形态 双重判定
    - 标签：与标准字段名做相似度（SequenceMatcher）
    - 值：必须通过该字段的形态校验（箱号要过 ISO 6346，时间要能解析，电话要像电话）
    双关才能认。只靠相似度会把"箱号"和"封号"混起来（只差一个字）。

只用它**补空**，绝不覆盖精确匹配到的值。
"""
from __future__ import annotations

import re
from difflib import SequenceMatcher

from .schema import FieldValue

ALIASES: dict[str, tuple[str, ...]] = {
    "client": ("客户", "货代", "委托方", "委托单位", "客户名称"),
    "booking_no": ("委托单号", "单号", "托书号", "订单号"),
    "container_no": ("箱号", "柜号", "集装箱号"),
    "container_type": ("箱型", "柜型", "箱形"),
    "container_qty": ("箱量", "箱数", "柜量", "数量"),
    "seal_no": ("封号", "铅封号", "封条号"),
    "closing_time": ("截港时间", "截关时间", "截港", "截关"),
    "loading_window": ("装柜时间", "装货时间", "装箱时间"),
    "pickup_addr": ("提箱地", "装货地", "提箱地址", "提空箱点"),
    "delivery_addr": ("卸货地", "送货地", "目的地", "卸货地址"),
    "vessel_voyage": ("船名航次", "船名"),
    "cargo_desc": ("品名", "货物"),
    "gross_weight": ("毛重", "重量"),
    "freight": ("运费", "报价"),
    "factory_contact": ("联系人",),
    "factory_phone": ("联系电话", "电话", "手机"),
    "remark": ("备注", "要求"),
}

# 这些字段的值形态弱，光靠相似度容易认错，阈值要更高
SOFT_KEYS = {"client", "pickup_addr", "delivery_addr", "remark", "cargo_desc", "vessel_voyage"}

_ALL_ALIAS = {a for v in ALIASES.values() for a in v}


def _valid(key: str, value: str) -> bool:
    v = value.strip()
    if not v:
        return False
    if key in {"container_no"}:
        from .rules import container_is_valid
        items = [x for x in re.split(r"[,，、;；\s]+", v) if x]
        return bool(items) and any(container_is_valid(x) for x in items)
    if key == "container_type":
        return bool(re.search(r"(20|40|45)\s*(GP|HQ|HC|RF|OT|FR|TK|尺|寸|H)", v.upper()))
    if key in {"closing_time", "loading_window"}:
        from .rules import parse_datetime
        return parse_datetime(v) is not None
    if key == "factory_phone":
        return len(re.sub(r"\D", "", v)) >= 7
    if key == "seal_no":
        return bool(re.fullmatch(r"[A-Za-z0-9\-]{4,15}", v.strip()))
    if key in {"gross_weight", "freight", "container_qty"}:
        return bool(re.search(r"\d", v))
    if key == "booking_no":
        return bool(re.search(r"\d{2,}", v))
    # 软字段：有中文或字母即可
    return bool(re.search(r"[\u4e00-\u9fa5A-Za-z]{2,}", v))


def _tidy(v: str) -> str:
    v = re.split(r"\s{2,}", v.strip())[0]
    return v.strip("：:，,；;。 ")


def _shape_score(key: str, value: str) -> float:
    """值形态的"特异性"：越像某类字段，分越高。

    "号：SL8823101" 这种只有单字的标签，"封号"和"单号"相似度一样，
    只能靠值的形态来分：纯字母数字短串更像封号，带连字符/长串更像单号。
    """
    v = value.strip()
    if key == "container_no":
        return 3.0
    if key in {"closing_time", "loading_window"}:
        return 3.0
    if key == "factory_phone":
        return 3.0
    if key == "container_type":
        return 3.0
    if key == "seal_no":
        return 2.5 if re.fullmatch(r"[A-Za-z0-9]{4,15}", v) else 0.0
    if key == "booking_no":
        return 1.0 if re.search(r"\d{2,}", v) else 0.0
    return 0.5


def fuzzy_fill(text: str, existing: dict) -> dict[str, FieldValue]:
    """给还没抽到的字段做容错补抽。"""
    out: dict[str, FieldValue] = {}

    for line in text.splitlines():
        # 一行里可能挤了两个字段（"船名：xxx  藏港时间：yyy"），按连续空格切开逐个试
        for seg in re.split(r"\s{2,}", line.strip()):
            m = re.match(r"^\s*([^\s:：]{1,8})\s*[:：]\s*(.+)$", seg)
            if not m:
                continue
            label, value = m.group(1).strip(), _tidy(m.group(2))
            if label in _ALL_ALIAS:
                continue  # 精确路径已经处理过

            best: tuple[str, float, str] | None = None
            best_ratio = 0.0
            for key, aliases in ALIASES.items():
                if key in out:
                    continue
                fv = existing.get(key)
                if fv is not None and fv.value:
                    continue
                ratio = max(SequenceMatcher(None, label, a).ratio() for a in aliases)
                if ratio < 0.6:
                    continue
                if not _valid(key, value):
                    continue
                if ratio < (0.8 if key in SOFT_KEYS else 0.6):
                    continue
                score = ratio + 0.15 * _shape_score(key, value)
                if best is None or score > best[1]:
                    best = (key, score, value)
                    best_ratio = ratio

            if best:
                key, _score, value = best
                out[key] = FieldValue(
                    value=value,
                    confidence=round(min(0.78, 0.5 + best_ratio * 0.3), 2),
                    source="fuzzy",
                )

    return out
