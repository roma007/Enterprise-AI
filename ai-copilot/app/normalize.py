"""字段值归一（D7）。

为什么需要：同一个东西，十个客户十种写法。
- 箱型：40HQ / 40H / 40HC / 高柜 / 40尺高
- 时间：2026-11-07 18:00 / 11月7日18点 / 11/7 18:00
- 箱号：带空格、带中文顿号、大小写混写
- 箱量：2 / 两个 / 贰
不归一，同一个字段在报表里会裂成好几类，“准确率”也就没法算。

归一放在**校验之前**：先归一，再判断箱型是否合法，否则会把 40H 误报成非法箱型。
"""
from __future__ import annotations

import re

TYPE_MAP = {
    "40H": "40HQ", "45H": "45HQ", "20H": "20HQ",
    "40HC": "40HQ", "45HC": "45HQ",
    "40FT": "40GP", "20FT": "20GP",
    "高柜": "40HQ", "超高柜": "40HQ",
    "小柜": "20GP", "大柜": "40GP",
}
VALID_TYPES = {
    "20GP", "40GP", "40HQ", "45HQ", "20RF", "40RF", "45RF",
    "20OT", "40OT", "20FR", "40FR", "20TK", "40TK", "20HQ",
}
_CN_DIGIT = {"零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
             "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}


def canon_container_type(v: str | None) -> str | None:
    if not v:
        return v
    s = re.sub(r"[^0-9A-Za-z\u4e00-\u9fa5']", "", v).upper().replace("'", "")
    if s in TYPE_MAP:
        return TYPE_MAP[s]
    for alias, target in TYPE_MAP.items():
        if alias in s:
            return target
    m = re.search(r"(20|40|45)\s*(GP|HQ|HC|RF|OT|FR|TK)", s)
    if m:
        return f"{m.group(1)}{m.group(2)}".replace("HC", "HQ")
    return v.strip()


def canon_container_no(v: str | None) -> str | None:
    if not v:
        return v
    from .rules import CONTAINER_RE

    # 1) 先按标准箱号抓（空格、顿号都天然是边界）
    found = CONTAINER_RE.findall(v.upper())
    # 2) "CSQU 3054383" 这种号内带空格的写法，去掉空格再抓一遍，两次结果合并
    found += CONTAINER_RE.findall(re.sub(r"\s+", "", v.upper()))
    found = list(dict.fromkeys(found))
    if len(found) >= 1 and any(len(x) == 11 for x in found):
        return ",".join(found)

    # 3) 抓不到标准箱号（可能是残缺录入），按分隔符切分保留原样
    items = [x.upper() for x in re.split(r"[,，、;；\s]+", v) if x]
    return ",".join(dict.fromkeys(items)) if items else v


def canon_qty(v: str | None) -> str | None:
    if not v:
        return v
    s = v.strip()
    if s.isdigit():
        return str(int(s))
    if s in _CN_DIGIT:
        return str(_CN_DIGIT[s])
    m = re.search(r"[零一二两三四五六七八九十]", s)
    if m:
        return str(_CN_DIGIT[m.group(0)])
    m = re.search(r"\d+", s)
    return m.group(0) if m else v


def canon_datetime(v: str | None) -> str | None:
    if not v:
        return v
    if re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}", v.strip()):
        return v.strip()
    # 兜底交给规则引擎的时间解析
    from .rules import fmt, parse_datetime
    dt = parse_datetime(v)
    return fmt(dt) if dt else v


def canon_number(v: str | None) -> str | None:
    if not v:
        return v
    s = re.sub(r"[^\d.]", "", v)
    return s or v


_NORMALIZERS = {
    "container_type": canon_container_type,
    "container_no": canon_container_no,
    "seal_no": canon_container_no,
    "container_qty": canon_qty,
    "closing_time": canon_datetime,
    "loading_window": canon_datetime,
    "gross_weight": canon_number,
    "freight": canon_number,
    "factory_phone": lambda v: re.sub(r"[^\d]", "", v) if v else v,
}


def canonicalize(fields: dict) -> list[str]:
    """原地归一并返回被改动的字段名（用于留痕）。"""
    changed: list[str] = []
    for key, fn in _NORMALIZERS.items():
        fv = fields.get(key)
        if not fv or not fv.value:
            continue
        new = fn(fv.value)
        if new and new != fv.value:
            changed.append(f"{key}: {fv.value} → {new}")
            fv.value = new
            fv.source = f"{fv.source}+norm"
    return changed
