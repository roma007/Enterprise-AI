"""多票切分（D8）。

现实：客户一条微信里发三票货，例如

    1. 客户：宏远  单号 HY-01  40HQ 箱号 CSQU3054383
    2. 客户：海通  单号 HT-02  20GP 箱号 TCLU1234568
    3. 客户：中远  单号 ZY-03  40HQ 箱号 MSCU7654329

现在的系统会把它当成一票：箱号全塞进一个字段、箱型只取第一个、截港只取一个。
后果不是"错一点"，是"错三票"。

切分策略（从强到弱，命中即停）：
1. 编号列表（1. / 2. / 第一票 / 一、）
2. 每行出现"委托单号/单号" → 在该行切，若上一行是"客户"则带上
3. 空行分块，且每块都有单号
4. 切不开就原样返回（宁可不切，也不要切错）
"""
from __future__ import annotations

import re

BOOKING_RE = re.compile(
    r"(?<![\u4e00-\u9fa5A-Za-z])(?:委托单号|托书号|托书编号|订单号|单号|Booking\s*No\.?|Booking)"
    r"\s*[:：]\s*([A-Za-z0-9\-]{3,})",
    re.IGNORECASE,
)
BOOKING_LINE = re.compile(
    r"^\s*(?:委托单号|托书号|托书编号|订单号|单号|Booking)\s*[:：]",
    re.IGNORECASE,
)
# "原单 HY-1105 有变" 也算一票的起点，否则多票里夹改单会被粘成一票
AMEND_REF = re.compile(
    r"原(?:委托单|单号|单|托书)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9\-]{2,})"
)
HEADER_LINE = re.compile(r"^\s*(?:客户|货代|委托单位|委托方)\s*[:：]")
NUMBERED = re.compile(r"(?m)^\s*(?:\d{1,2}\s*[.、)）]|[一二三四五六七八九十]{1,2}\s*[、.]|第[一二三四五六七八九十]{1,2}\s*票)\s*")


def count_tickets(text: str) -> int:
    """用"不同的单号个数"估计票数；没单号时退回编号列表条数。"""
    nums = {m.group(1).upper() for m in BOOKING_RE.finditer(text or "")}
    nums |= {m.group(1).upper() for m in AMEND_REF.finditer(text or "")}
    if nums:
        return len(nums)
    parts = [p for p in NUMBERED.split(text or "") if p.strip()]
    return len(parts) if len(parts) > 1 else 1


def _has_booking(seg: str) -> bool:
    return bool(BOOKING_RE.search(seg) or AMEND_REF.search(seg))


def split_tickets(text: str) -> list[str]:
    text = (text or "").strip()
    if not text:
        return []

    # 1) 编号列表
    parts = [p.strip() for p in NUMBERED.split(text) if p.strip()]
    if len(parts) >= 2 and sum(1 for p in parts if _has_booking(p)) >= 2:
        return parts

    # 2) 按"单号"所在行切
    lines = text.splitlines()
    idx = [i for i, ln in enumerate(lines) if BOOKING_LINE.match(ln)]
    if len(idx) >= 2:
        starts = []
        for i in idx:
            s = i
            if i > 0 and HEADER_LINE.match(lines[i - 1]):
                s = i - 1          # 把上一行的"客户"一起带走
            starts.append(s)
        starts = sorted(set(starts))
        segs = []
        for a, b in zip(starts, starts[1:] + [len(lines)]):
            seg = "\n".join(lines[a:b]).strip()
            if seg:
                segs.append(seg)
        if len(segs) >= 2:
            return segs

    # 3) 空行分块
    blocks = [b.strip() for b in re.split(r"\n\s*\n", text) if b.strip()]
    if len(blocks) >= 2 and sum(1 for b in blocks if _has_booking(b)) >= 2:
        return blocks

    # 4) 切不开就不切
    return [text]


def is_multi(text: str) -> bool:
    return count_tickets(text) >= 2 and len(split_tickets(text)) >= 2
