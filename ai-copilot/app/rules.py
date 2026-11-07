"""行业规则引擎。

这里是"通用 AI 做不了、只有懂这行才会做"的部分：
- ISO 6346 集装箱号校验位
- 箱型合法性
- 封号格式
- 截港时间过期判断（集卡行业最真实的罚款来源）
- 箱号数量与箱量一致性

所有规则都是确定性的，不依赖模型。模型负责"抽"，规则负责"挑错"。
"""
from __future__ import annotations

import re
from datetime import datetime

from . import thresholds as th
from .address_check import check_addresses
from .schema import Check, Draft, FieldValue, SPEC_MAP, BLOCKING_KEYS

# ---------- ISO 6346 ----------

_LETTER_VALUE = {
    "A": 10, "B": 12, "C": 13, "D": 14, "E": 15, "F": 16, "G": 17, "H": 18,
    "I": 19, "J": 20, "K": 21, "L": 23, "M": 24, "N": 25, "O": 26, "P": 27,
    "Q": 28, "R": 29, "S": 30, "T": 31, "U": 32, "V": 34, "W": 35, "X": 36,
    "Y": 37, "Z": 38,
}
_WEIGHTS = (1, 2, 4, 8, 16, 32, 64, 128, 256, 512)

# 注意：不能用 \b。中文字符在 Unicode 下算 \w，会导致"箱号OOLU1234567"里的
# 数字前没有词边界，正则整体失效。这里用显式的字母数字环视。
CONTAINER_RE = re.compile(r"(?<![A-Z0-9])([A-Z]{4}\d{7})(?![A-Z0-9])")
VALID_TYPES = {
    "20GP", "40GP", "40HQ", "45HQ", "20RF", "40RF", "45RF",
    "20OT", "40OT", "20FR", "40FR", "20TK", "40TK",
}


def iso6346_check_digit(code: str) -> int | None:
    """返回 ISO 6346 校验位；格式不合法返回 None。"""
    code = re.sub(r"[^A-Z0-9]", "", code.upper())
    if not re.fullmatch(r"[A-Z]{4}\d{7}", code):
        return None
    total = 0
    for i, ch in enumerate(code[:10]):
        val = _LETTER_VALUE[ch] if ch.isalpha() else int(ch)
        total += val * _WEIGHTS[i]
    rem = total % 11
    return 0 if rem == 10 else rem


def container_is_valid(code: str) -> bool:
    code = re.sub(r"[^A-Z0-9]", "", code.upper())
    if not re.fullmatch(r"[A-Z]{4}\d{7}", code):
        return False
    expected = iso6346_check_digit(code)
    return expected is not None and expected == int(code[-1])


def containers_in(text: str) -> list[str]:
    """从任意文本里抓出所有箱号（忽略分隔符与中文标点）。"""
    return CONTAINER_RE.findall(text.upper())


# ---------- 时间解析 ----------

_DT_PATTERNS = (
    (re.compile(r"(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日|号)?\s*(\d{1,2})\s*[:：时点](\d{2})?"), True),
    (re.compile(r"(\d{1,2})[-/月](\d{1,2})(?:日|号)?\s*(\d{1,2})\s*[:：时点](\d{2})?"), False),
)


def parse_datetime(text: str, now: datetime | None = None) -> datetime | None:
    """把中文托书里各种时间写法归一成 datetime。"""
    if not text:
        return None
    now = now or datetime.now()
    for pattern, has_year in _DT_PATTERNS:
        m = pattern.search(text)
        if not m:
            continue
        g = m.groups()
        try:
            if has_year:
                year, month, day, hour, minute = g[0], g[1], g[2], g[3], g[4]
            else:
                month, day, hour, minute = g[0], g[1], g[2], g[3]
                year = str(now.year)
            dt = datetime(
                int(year), int(month), int(day), int(hour), int(minute or 0)
            )
            # 无年份且已过去超过 180 天，视为明年
            if not has_year and (now - dt).days > 180:
                dt = dt.replace(year=dt.year + 1)
            return dt
        except (ValueError, TypeError):
            continue

    # 兜底：OCR 常把分隔符吃掉（"2026110718:00"、"2026-11-0608:00"）。
    # 在纯数字串里滑窗找 12 位 YYYYMMDDHHMM。
    digits = re.sub(r"\D", "", text)
    for i in range(max(0, len(digits) - 11)):
        seg = digits[i:i + 12]
        y, mo, d = int(seg[:4]), int(seg[4:6]), int(seg[6:8])
        hh, mi = int(seg[8:10]), int(seg[10:12])
        if 2000 <= y <= 2100 and 1 <= mo <= 12 and 1 <= d <= 31 and hh < 24 and mi < 60:
            try:
                return datetime(y, mo, d, hh, mi)
            except ValueError:
                continue
    return None


def fmt(dt: datetime | None) -> str:
    return dt.strftime("%Y-%m-%d %H:%M") if dt else ""


# ---------- 校验 ----------

def run_checks(draft: Draft, now: datetime | None = None) -> list[Check]:
    now = now or datetime.now()
    checks: list[Check] = []
    f = draft.fields

    def val(key: str) -> str:
        v = f.get(key)
        return (v.value or "").strip() if v else ""

    # 1. 必填缺失（阻断）——字段清单可由配置中心调整
    required = th.get_list("rules.required") or list(BLOCKING_KEYS)
    for key in required:
        if not val(key):
            checks.append(Check(
                level="error", code="E_REQUIRED", field=key,
                message=f"缺少必填字段：{SPEC_MAP[key].label}",
            ))

    # 2. 低置信度字段（提醒）
    for key, fv in f.items():
        if fv.value and 0 < fv.confidence < 0.6:
            checks.append(Check(
                level="warn", code="W_LOW_CONF", field=key,
                message=f"{SPEC_MAP[key].label} 置信度偏低（{fv.confidence:.0%}），请人工核对",
            ))

    # 3. 箱号 ISO 6346 校验位（可关闭）
    raw_containers = val("container_no")
    if raw_containers and th.get_bool("rules.container_checksum"):
        items = [c for c in re.split(r"[,，;；\s]+", raw_containers) if c]
        bad = [c for c in items if not container_is_valid(c)]
        for c in bad:
            checks.append(Check(
                level="error", code="E_CONTAINER_CHECKSUM", field="container_no",
                message=f"箱号 {c} 未通过 ISO 6346 校验位验证，可能录错",
            ))
        # 箱号数量 vs 箱量
        qty = re.sub(r"\D", "", val("container_qty"))
        if qty and int(qty) != len(items):
            checks.append(Check(
                level="warn", code="W_QTY_MISMATCH", field="container_qty",
                message=f"箱量为 {qty}，但识别到 {len(items)} 个箱号，请核对",
            ))

    # 4. 箱型合法性
    ctype = val("container_type").replace(" ", "").upper()
    if ctype:
        if ctype.replace("HC", "HQ") not in VALID_TYPES:
            checks.append(Check(
                level="warn", code="W_CONTAINER_TYPE", field="container_type",
                message=f"箱型 {ctype} 不在常见取值内（20GP/40HQ/40RF 等）",
            ))

    # 5. 封号格式
    for seal in [s for s in re.split(r"[,，;；\s]+", val("seal_no")) if s]:
        if not re.fullmatch(r"[A-Za-z0-9]{5,15}", seal):
            checks.append(Check(
                level="warn", code="W_SEAL_FORMAT", field="seal_no",
                message=f"封号 {seal} 格式可疑（应为 5–15 位字母数字）",
            ))

    # 6. 电话格式
    phone = re.sub(r"[\s\-]", "", val("factory_phone"))
    if phone and not re.fullmatch(r"(1[3-9]\d{9}|0\d{2,3}\d{7,8})", phone):
        checks.append(Check(
            level="warn", code="W_PHONE", field="factory_phone",
            message=f"电话 {phone} 格式可疑",
        ))

    # 6.5 地址校验（B5）：错别字、区县与城市冲突、港区与城市冲突、提卸同址（可关闭）
    if th.get_bool("rules.address"):
        checks.extend(check_addresses(val("pickup_addr"), val("delivery_addr")))

    # 7. 截港时间（本行业最贵的错误，可关闭）
    closing = parse_datetime(val("closing_time"), now)
    if closing and th.get_bool("rules.closing"):
        if closing < now:
            checks.append(Check(
                level="error", code="E_CLOSING_PASSED", field="closing_time",
                message=f"截港时间 {fmt(closing)} 已过，此单赶不上本班船，请立即改配",
            ))
        elif (closing - now).total_seconds() < 24 * 3600:
            hours = (closing - now).total_seconds() / 3600
            checks.append(Check(
                level="warn", code="W_CLOSING_SOON", field="closing_time",
                message=f"距截港仅剩 {hours:.1f} 小时，需优先安排",
            ))

    # 8. 装柜时间窗 vs 截港时间（跟截港检查一起开关）
    window = parse_datetime(val("loading_window"), now)
    if window and closing and th.get_bool("rules.closing") and window > closing:
        checks.append(Check(
            level="warn", code="W_WINDOW_AFTER_CLOSING", field="loading_window",
            message="装柜时间晚于截港时间，时间安排矛盾",
        ))

    return checks


def apply_rules(draft: Draft, now: datetime | None = None) -> Draft:
    draft.checks = run_checks(draft, now)
    draft.review_level = decide_review_level(draft)
    return draft


# ---------- 分级审批（C1） ----------

# 判据不是"全对"，而是"高代价字段全对"：
# 箱号错了要被码头退回、截港错了要误船、箱型错了要重新派车——这些才是罚款来源。
# 地址写错最多返工一次，不构成"必须双人复核"的理由。
RISK_KEYS = (
    "container_no", "container_type", "container_qty",
    "closing_time", "factory_phone",
)
# 阈值改为运行时可调，见 app/thresholds.py（A3）


def decide_review_level(draft: Draft) -> str:
    """按风险字段的确定性 + 校验结果决定复核级别。

    - blocked：有 error（校验没过或必填缺失），必须改
    - double ：存在置信度 <0.8 的字段，需双人复核
    - single ：有 warn，或风险字段不够确定，单人确认
    - auto   ：风险字段全部 ≥0.9 且无 warn/error，直接过，不打扰人

    这不是"更严格"，恰恰相反——它让高确定性的单**不必被人看**，
    把人的注意力省下来给真正有风险的 30%。
    """
    if any(c.level == "error" for c in draft.checks):
        return "blocked"

    # 低置信度只看"必填字段 + 风险字段"：备注、品名这类选填项写得含糊，
    # 不该把整张单拉进双人复核。
    low_floor = th.get("booking.low_conf_floor")
    auto_floor = th.get("booking.risk_auto_floor")

    watch = set(th.get_list("rules.required") or BLOCKING_KEYS) | set(RISK_KEYS)
    low = [draft.fields[k].confidence for k in watch
           if k in draft.fields and draft.fields[k].value]
    if low and min(low) < low_floor:
        return "double"

    warns = any(c.level == "warn" for c in draft.checks)
    risk = [draft.fields[k].confidence for k in RISK_KEYS if k in draft.fields and draft.fields[k].value]

    if not warns and risk and min(risk) >= auto_floor:
        return "auto"
    return "single"


def new_field(value: str | None, confidence: float, source: str) -> FieldValue:
    return FieldValue(value=(value.strip() if value else None), confidence=confidence, source=source)
