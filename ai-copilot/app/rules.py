"""行业规则引擎。

这里是"通用 AI 做不了、只有懂这行才会做"的部分：
- ISO 6346 集装箱号校验位
- 箱型合法性
- 封号格式
- 截港时间过期判断（集卡行业最真实的罚款来源）
- 箱号数量与箱量一致性

所有规则都是确定性的，不依赖模型。模型负责"抽"，规则负责"挑错"。

Step 1：校验的**顺序、参数、开关、文案**来自行业包（`packs/<id>/rules.json`）；
算法本身仍在本模块，pack 不能写任意代码。
"""
from __future__ import annotations

import re
from datetime import datetime

from . import thresholds as th
from .address_check import check_addresses
from .domain import Check, Draft, FieldValue, ValidationSpec
from .pack import current_pack, register_listener
from .schema import BLOCKING_KEYS, LABELS

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

# 兼容旧 import（store.py 用 RISK_KEYS；导出脚本/快照用其余常量）。
# 可变容器原地刷新；正则/数值在 _apply 里重绑（运行时不再依赖它们）。
VALID_TYPES: set[str] = set()
RISK_KEYS: list[str] = []
SEAL_RE = re.compile(r"[A-Za-z0-9]{5,15}")
PHONE_RE = re.compile(r"(1[3-9]\d{9}|0\d{2,3}\d{7,8})")
CLOSING_WARN_HOURS = 24.0
LOW_CONF_WARN = 0.6


def _apply(pack) -> None:
    global SEAL_RE, PHONE_RE, CLOSING_WARN_HOURS, LOW_CONF_WARN
    rules = {r.id: r for r in pack.validations}

    def params(rule_id: str) -> dict:
        rule = rules.get(rule_id)
        return rule.params if rule else {}

    VALID_TYPES.clear()
    VALID_TYPES.update(params("container_type").get("values") or ())
    RISK_KEYS[:] = list(pack.review.get("risk_fields") or ())
    SEAL_RE = re.compile(params("seal_format").get("pattern") or r"[A-Za-z0-9]{5,15}")
    PHONE_RE = re.compile(params("phone_format").get("pattern") or r"(1[3-9]\d{9}|0\d{2,3}\d{7,8})")
    CLOSING_WARN_HOURS = float(params("closing").get("warn_hours") or 24)
    LOW_CONF_WARN = float(pack.review.get("low_conf_warn") or 0.6)


_apply(current_pack())
register_listener(_apply)


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


# ---------- 校验器 ----------

def _val(draft: Draft, key: str | None) -> str:
    if not key:
        return ""
    fv = draft.fields.get(key)
    return (fv.value or "").strip() if fv else ""


def _setting_ref(ref: str | None) -> str | None:
    if isinstance(ref, str) and ref.startswith("settings:"):
        return ref.split(":", 1)[1]
    return None


def _enabled(rule: ValidationSpec) -> bool:
    ref = _setting_ref(rule.params.get("enabled_from"))
    return th.get_bool(ref) if ref else True


def _required_fields(rule: ValidationSpec) -> list[str]:
    fallback = list(rule.params.get("fallback_fields") or BLOCKING_KEYS)
    ref = _setting_ref(rule.params.get("fields_from"))
    fields = (th.get_list(ref) or fallback) if ref else fallback
    # 切包后 settings 里可能还留着旧包的字段；过滤掉当前包不存在的 key。
    known = {s.key for s in current_pack().documents["booking"]}
    selected = [k for k in fields if k in known]
    return selected or fallback


def _msg(rule: ValidationSpec, key: str = "message", **kwargs) -> str:
    template = rule.params.get(key) or ""
    try:
        return template.format(**kwargs)
    except (KeyError, IndexError, ValueError):
        return template


def _required(rule: ValidationSpec, draft: Draft, now: datetime) -> list[Check]:
    checks: list[Check] = []
    code = rule.params.get("code") or "E_REQUIRED"
    for key in _required_fields(rule):
        if not _val(draft, key):
            checks.append(Check(
                level=rule.level, code=code, field=key,
                message=_msg(rule, label=LABELS.get(key, key)),
            ))
    return checks


def _low_confidence(rule: ValidationSpec, draft: Draft, now: datetime) -> list[Check]:
    threshold = (
        float(current_pack().review.get("low_conf_warn") or 0.6)
        if rule.params.get("threshold_from") == "review.low_conf_warn"
        else float(rule.params.get("threshold") or 0.6)
    )
    code = rule.params.get("code") or "W_LOW_CONF"
    checks: list[Check] = []
    for key, fv in draft.fields.items():
        if fv.value and 0 < fv.confidence < threshold:
            checks.append(Check(
                level=rule.level, code=code, field=key,
                message=_msg(rule, label=LABELS.get(key, key), confidence=fv.confidence),
            ))
    return checks


def _split_containers(raw: str) -> list[str]:
    return [c for c in re.split(r"[,，;；\s]+", raw) if c]


def _iso6346(rule: ValidationSpec, draft: Draft, now: datetime) -> list[Check]:
    field = rule.params.get("field") or "container_no"
    raw = _val(draft, field)
    if not raw:
        return []
    code = rule.params.get("code") or "E_CONTAINER_CHECKSUM"
    checks: list[Check] = []
    for c in _split_containers(raw):
        if not container_is_valid(c):
            checks.append(Check(
                level=rule.level, code=code, field=field,
                message=_msg(rule, value=c),
            ))
    return checks


def _qty_match(rule: ValidationSpec, draft: Draft, now: datetime) -> list[Check]:
    compare_to = rule.params.get("compare_to") or "container_no"
    raw = _val(draft, compare_to)
    if not raw:
        return []
    items = _split_containers(raw)
    qty = re.sub(r"\D", "", _val(draft, rule.params.get("field") or "container_qty"))
    if qty and int(qty) != len(items):
        return [Check(
            level=rule.level, code=rule.params.get("code") or "W_QTY_MISMATCH",
            field=rule.params.get("field") or "container_qty",
            message=_msg(rule, qty=qty, count=len(items)),
        )]
    return []


def _enum(rule: ValidationSpec, draft: Draft, now: datetime) -> list[Check]:
    field = rule.params.get("field")
    raw = _val(draft, field).replace(" ", "").upper()
    if not raw:
        return []
    for alias, target in (rule.params.get("aliases") or {}).items():
        raw = raw.replace(alias, target)
    if raw not in set(rule.params.get("values") or ()):
        return [Check(
            level=rule.level, code=rule.params.get("code") or "W_ENUM",
            field=field, message=_msg(rule, value=raw),
        )]
    return []


def _regex(rule: ValidationSpec, draft: Draft, now: datetime) -> list[Check]:
    field = rule.params.get("field")
    raw = _val(draft, field)
    if not raw:
        return []
    pattern = re.compile(rule.params.get("pattern") or "")
    strip = rule.params.get("strip")
    items = re.split(r"[,，;；\s]+", raw) if rule.params.get("split") else [raw]
    code = rule.params.get("code") or "W_FORMAT"
    checks: list[Check] = []
    for item in items:
        value = re.sub(strip, "", item) if strip else item
        if value and not pattern.fullmatch(value):
            checks.append(Check(
                level=rule.level, code=code, field=field,
                message=_msg(rule, value=value),
            ))
    return checks


def _geo(rule: ValidationSpec, draft: Draft, now: datetime) -> list[Check]:
    fields = rule.params.get("fields") or ["pickup_addr", "delivery_addr"]
    return check_addresses(_val(draft, fields[0]), _val(draft, fields[1]))


def _deadline(rule: ValidationSpec, draft: Draft, now: datetime) -> list[Check]:
    field = rule.params.get("field")
    closing = parse_datetime(_val(draft, field), now)
    if not closing:
        return []
    if closing < now:
        return [Check(
            level=rule.level, code=rule.params.get("code") or "E_CLOSING_PASSED",
            field=field, message=_msg(rule, time=fmt(closing)),
        )]
    warn_hours = float(rule.params.get("warn_hours") or 24)
    if (closing - now).total_seconds() < warn_hours * 3600:
        hours = (closing - now).total_seconds() / 3600
        return [Check(
            level="warn", code=rule.params.get("code_warn") or "W_CLOSING_SOON",
            field=field, message=_msg(rule, "message_warn", hours=hours),
        )]
    return []


def _ordering(rule: ValidationSpec, draft: Draft, now: datetime) -> list[Check]:
    fields = rule.params.get("fields") or []
    if len(fields) < 2:
        return []
    a = parse_datetime(_val(draft, fields[0]), now)
    b = parse_datetime(_val(draft, fields[1]), now)
    if a and b and a > b:
        return [Check(
            level=rule.level, code=rule.params.get("code") or "W_ORDERING",
            field=fields[0], message=_msg(rule),
        )]
    return []


VALIDATORS = {
    "builtin.required": _required,
    "builtin.low_confidence": _low_confidence,
    "builtin.iso6346": _iso6346,
    "builtin.qty_match": _qty_match,
    "builtin.enum": _enum,
    "builtin.regex": _regex,
    "builtin.geo": _geo,
    "builtin.deadline": _deadline,
    "builtin.ordering": _ordering,
}


def run_checks(draft: Draft, now: datetime | None = None) -> list[Check]:
    now = now or datetime.now()
    checks: list[Check] = []
    for rule in current_pack().validations:
        if not _enabled(rule):
            continue
        fn = VALIDATORS.get(rule.type)
        if fn is None:
            raise RuntimeError(f"未知校验器：{rule.type}")
        checks.extend(fn(rule, draft, now))
    return checks


def apply_rules(draft: Draft, now: datetime | None = None) -> Draft:
    draft.checks = run_checks(draft, now)
    draft.review_level = decide_review_level(draft)
    return draft


# ---------- 分级审批（C1） ----------

# 判据不是"全对"，而是"高代价字段全对"：
# 箱号错了要被码头退回、截港错了要误船、箱型错了要重新派车——这些才是罚款来源。
# 地址写错最多返工一次，不构成"必须双人复核"的理由。
# 风险字段来自 pack.review.risk_fields；阈值仍由 settings 管。
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

    risk_keys = tuple(current_pack().review.get("risk_fields") or ())
    required = th.get_list("rules.required") or list(BLOCKING_KEYS)
    watch = set(required) | set(risk_keys)
    low = [draft.fields[k].confidence for k in watch
           if k in draft.fields and draft.fields[k].value]
    if low and min(low) < low_floor:
        return "double"

    warns = any(c.level == "warn" for c in draft.checks)
    risk = [draft.fields[k].confidence for k in risk_keys if k in draft.fields and draft.fields[k].value]

    if not warns and risk and min(risk) >= auto_floor:
        return "auto"
    return "single"


def new_field(value: str | None, confidence: float, source: str) -> FieldValue:
    return FieldValue(value=(value.strip() if value else None), confidence=confidence, source=source)
