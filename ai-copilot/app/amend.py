"""改单处理（D9）。

现实：客户不会重新发一张完整托书，他发的是
    "原单 HY-1105 有变：1. 箱型改40HQ 2. 加一个箱号 MSCU7654329 3. 截港延到11月8号18点 其他不变"

这类消息如果当普通托书解析，只能抽到碎片：客户名没有、地址没有、运单号也变了。

做法：
1. 认出这是"改单通知"，取出原单号
2. 用普通抽取拿到"变更后的值"
3. 与原单逐字段比对，产出 (旧值 → 新值) 的 diff
4. 特殊动词（加/新增/去掉）走增删语义，不是覆盖
"""
from __future__ import annotations

import re

from .schema import FIELD_KEYS, LABELS, normalize_for_compare

AMEND_HINT = re.compile(r"(改单|变更|修改|更正|有变|改成|改为|换箱|换船|延到|推迟|提前)")
BASE_PATTERNS = (
    re.compile(r"原(?:委托单|单号|单|托书)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9\-]{2,})"),
    re.compile(r"(?:对|按|参照)\s*([A-Za-z0-9][A-Za-z0-9\-]{2,})\s*(?:这张|该单|原单)"),
)

ADD_WORDS = ("加一个", "加一", "新增", "增加", "再加", "补一个", "追加")
DEL_WORDS = ("去掉", "删除", "取消这个", "删掉")


def is_amend(text: str) -> bool:
    return bool(AMEND_HINT.search(text))


def base_booking_no(text: str) -> str | None:
    for pat in BASE_PATTERNS:
        m = pat.search(text)
        if m:
            return m.group(1)
    return None


def _verb_for(text: str, value: str) -> str:
    """判断某个值是"加"还是"删"，还是普通覆盖。"""
    idx = text.find(value)
    window = text[max(0, idx - 8): idx] if idx >= 0 else ""
    if any(w in window for w in DEL_WORDS):
        return "remove"
    if any(w in window for w in ADD_WORDS):
        return "add"
    return "set"


def _split_multi(v: str) -> list[str]:
    return [x for x in re.split(r"[,，、;；\s]+", v or "") if x]


SOFT_FIELDS = {"client", "pickup_addr", "delivery_addr", "cargo_desc",
               "vessel_voyage", "remark", "factory_contact"}


def _same_ish(old: str, new: str) -> bool:
    """改单里常见"客户：宏远国际货代 这票有变"——多出来的只是语气词，不是真改动。"""
    if not old or not new:
        return False
    if old == new:
        return True
    if old in new and len(new) - len(old) <= 8:
        return True
    if new in old and len(old) - len(new) <= 8:
        return True
    return False


def apply_changes(text: str, original: dict, changes: dict) -> tuple[dict, list[dict]]:
    """把变更套到原单上，返回 (合并结果, diff 列表)。"""
    merged = dict(original)
    diff: list[dict] = []

    for key in FIELD_KEYS:
        if key == "booking_no":
            continue
        new = (changes.get(key) or "").strip()
        if not new:
            continue
        old = (merged.get(key) or "").strip()
        if normalize_for_compare(key, new) == normalize_for_compare(key, old):
            continue
        if key in SOFT_FIELDS and _same_ish(old, new):
            continue

        verb = _verb_for(text, new)

        if key in {"container_no", "seal_no"} and verb in {"add", "remove"}:
            old_items = _split_multi(old)
            new_items = _split_multi(new)
            if verb == "add":
                result = list(dict.fromkeys(old_items + new_items))
            else:
                result = [x for x in old_items if x.upper() not in {y.upper() for y in new_items}]
            value = ",".join(result)
            action = "新增" if verb == "add" else "删除"
        else:
            value = new
            action = "修改"

        merged[key] = value
        diff.append({
            "field": key,
            "label": LABELS[key],
            "old": old,
            "new": value,
            "action": action,
        })

    return merged, diff
