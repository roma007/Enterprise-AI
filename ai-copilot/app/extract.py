"""托书抽取。

两条通道：
1. LLM（语义通道）—— 处理口语、缺标签、多句混写、隐含信息
2. 规则（格式通道）—— 处理强格式字段：箱号、封号、箱型、电话、时间

合并策略：**强格式字段以规则为准**（模型容易编格式），语义字段以 LLM 为准。
这样既保留模型的理解力，又不会出现"箱号被模型编造"这种致命问题。
"""
from __future__ import annotations

import hashlib
import re
import time
import unicodedata

from .config import settings
from .llm import chat_json, mask, parse_json_loose
from .normalize import canonicalize, canon_qty
from .rules import (
    apply_rules,
    containers_in,
    fmt,
    parse_datetime,
)
from .pack import current_pack
from .schema import BLOCKING_KEYS, FIELD_KEYS, SPECS, Draft, FieldValue, empty_draft

# 规则通道有最终裁决权的字段（无论置信度）
RULE_AUTHORITATIVE = {
    "container_no", "container_type", "container_qty", "seal_no",
    "factory_phone", "closing_time", "loading_window", "gross_weight",
}

# 合并策略（默认 fill_only）：
#   fill_only —— 规则先跑，模型**只补空字段，不覆盖已有值**
#   floor     —— 规则置信度 ≥ RULE_FLOOR 时规则优先，否则模型覆盖
#   llm_wins  —— 模型优先（强格式字段仍以规则为准）
# 依据：28 份样本实验，fill_only 在两个集合上都不低于纯规则；
#       llm_wins / floor 在调优集上最多掉 3.7 个百分点。见 README §四。
MERGE_POLICY = __import__("os").getenv("MERGE_POLICY", "fill_only").strip().lower()
from . import thresholds as _th  # noqa: E402

# 管线版本：规则逻辑或合并策略变了就 +1，审计时用来定位"当时跑的哪一版"
PIPELINE_VERSION = "0.5.0"

_SYSTEM_PROMPT = """你是港口集卡（拖车）运输公司的资深单证员，负责把客户发来的托书整理成结构化订单。

要求：
1. 只抽取原文中明确存在或可直接推断的信息，绝不编造。
2. 无法确定的字段，value 设为 null，confidence 设为 0。
3. confidence 表示你对这个值的把握：明确写出 0.95，需要推断 0.7，模糊 0.4。
4. 时间统一输出 "YYYY-MM-DD HH:MM"；没有年份时按最近一次合理时间推断。
5. 箱号统一大写、去掉空格；多个箱号用英文逗号分隔。
6. 只输出 JSON，不要任何解释文字。

输出格式：
{"fields": {"client": {"value": "...", "confidence": 0.95}, ...}}
"""


def _field_catalog() -> str:
    lines = []
    for s in SPECS:
        lines.append(f'- {s.key}（{s.label}）: {s.hint}；示例 "{s.example}"')
    return "\n".join(lines)


def prompt_version() -> str:
    """提示词版本 = 内容短哈希。改一个字，版本就变，审计不会记错版本。"""
    base = _SYSTEM_PROMPT + _field_catalog()
    return "p" + hashlib.sha256(base.encode("utf-8")).hexdigest()[:8]


# ---------------- 规则通道 ----------------

def _lines(text: str) -> list[str]:
    return [ln.strip() for ln in text.splitlines() if ln.strip()]


_SEP_RE = re.compile(r"[，,；;|。]")


def _clean(v: str, limit: int, split: bool = True) -> str:
    v = v.strip()
    v = re.sub(r"[。\.\s]+$", "", v)
    v = v.strip("：:，,；;")
    if split:
        v = _SEP_RE.split(v)[0].strip()
        v = re.sub(r"[。\.\s]+$", "", v)
    return v[:limit]


def _grab(text: str, keys: tuple[str, ...], limit: int = 60, split: bool = True) -> str | None:
    """三级抓取，从严到宽。

    1) 行首 key + 分隔符       —— "客户：宏远国际货代"
    2) 行内任意位置 key+分隔符 —— "Client / 客户：环宇供应链"
    3) key 后接空白            —— "单号 HT-2026-1105"
    键必须按"长键在前"排列，避免"单号"抢先命中"委托单号"。
    """
    for line in _lines(text):
        for k in keys:
            m = re.match(rf"^{re.escape(k)}\s*[:：|｜]\s*(.+)$", line)
            if m:
                v = _clean(m.group(1), limit, split)
                if v:
                    return v
    for k in keys:
        # 前面不能紧贴中文或字母，否则"海通货代"里的"货代"会被当成字段名
        m = re.search(rf"(?<![\u4e00-\u9fa5A-Za-z]){re.escape(k)}\s*[:：|｜]\s*([^\n]+)", text)
        if m:
            v = _clean(m.group(1), limit, split)
            if v:
                return v
    for k in keys:
        m = re.search(rf"(?<![\u4e00-\u9fa5A-Za-z]){re.escape(k)}[ \t]+([^\n]+)", text)
        if m:
            v = _clean(m.group(1), limit, split)
            if v:
                return v
    return None


def _looks_like_datetime(v: str) -> bool:
    """地址字段里不该出现日期。"到11月8号" 这种会被误当送达地。"""
    return bool(re.search(r"\d{1,2}\s*[月/.\-]\s*\d{1,2}\s*[日号]?", v)) or \
        bool(re.search(r"\d{1,2}\s*[:：]\s*\d{2}", v))


def _dt_near(text: str, keys: tuple[str, ...]) -> str | None:
    low = text.lower()
    for line in _lines(text):
        ll = line.lower()
        for k in keys:
            pos = ll.find(k.lower())
            if pos < 0:
                continue
            # 同一行可能写了两个时间（装柜 / 截港）。必须从关键词之后找，
            # 否则「装柜时间 11-06 08:00  截港时间 11-07 18:00」会取到装柜时间。
            dt = parse_datetime(line[pos:])
            if dt:
                return fmt(dt)
            dt = parse_datetime(line)
            if dt:
                return fmt(dt)
    # 兜底：整段里找关键词附近的时间（跨行的情况）
    for k in keys:
        idx = low.find(k.lower())
        if idx >= 0:
            dt = parse_datetime(text[idx: idx + 60])
            if dt:
                return fmt(dt)
    return None


# OCR 会把相邻两个字段粘成一个文本框（"家用电器毛重：18600"），
# 模型也可能把两个字段写在同一个 value 里。这里在"下一个字段名+冒号"处截断。
_STOP_WORDS = tuple(sorted({
    *[s.label for s in SPECS],
    "电话", "手机", "传真", "邮箱", "备注", "箱号", "封号", "箱型", "箱量",
    "船名", "品名", "毛重", "运费", "截港", "截关", "装柜", "提箱", "卸货", "送货",
    "单号", "编号", "订单号",
}, key=len, reverse=True))
_STOP_RE = re.compile(
    "|".join(re.escape(w) for w in _STOP_WORDS) + r"(?=\s*[:：|])|"
    + "|".join(re.escape(w) for w in _STOP_WORDS) + r"(?=[A-Za-z0-9])"
)


def _cut_stop(v: str) -> str:
    m = _STOP_RE.search(v, 1)
    return v[:m.start()].strip(" ：:，,") if m else v


_EXTRACT_TYPES = {
    "label", "verb", "regex", "amount", "datetime", "phone",
    "container", "seal", "quantity", "container_type",
}


def _render_template(template: str, m: re.Match) -> str:
    def repl(g):
        try:
            return m.group(int(g.group(1))) or ""
        except IndexError:
            return ""
    return re.sub(r"\{(\d+)\}", repl, str(template))


def _qty_from_segment(seg: str) -> str | None:
    nums = re.findall(r"\d+", seg)
    if not nums:
        return None
    return nums[-1] if re.search(r"(GP|HQ|HC|RF|OT|FR|TK)", seg, re.IGNORECASE) else nums[0]


def _postprocess(value: str, meta: dict) -> str | None:
    v = (value or "").strip()
    if not v:
        return None
    prefix = meta.get("prefix")
    if prefix and not v.upper().startswith(str(prefix).upper()):
        v = f"{prefix}{v}"
    kind = meta.get("postprocess")
    if kind == "container_type":
        v = v.replace(" ", "").upper().replace("HC", "HQ")
    elif kind == "seal_tokens":
        toks = [t.strip() for t in re.split(r"[、,，\s]+", v) if t.strip()]
        toks = [t for t in toks if re.fullmatch(r"[A-Za-z0-9\-]{4,15}", t)]
        v = ",".join(toks) if toks else ""
    elif kind == "name":
        v = re.sub(r"^(?:改成|改为|换成|是|为)", "", v).strip()
        if re.search(r"[\d+]", v):
            m = re.match(r"^[\u4e00-\u9fa5]{2,4}", v)
            if m:
                v = m.group(0)
    elif kind == "remark":
        v = re.sub(r"[;；]\s*", "，", v)
    elif kind == "number":
        v = v.replace(",", "")
    if not v:
        return None
    if meta.get("strip_datetime") and _looks_like_datetime(v):
        return None
    if meta.get("cut", True):
        v = _cut_stop(v)
    return v.strip() or None


def _run_strategy(text: str, meta: dict) -> tuple[str, float] | None:
    if not meta:
        return None
    kind = meta.get("type") or "label"
    if kind not in _EXTRACT_TYPES:
        return None
    conf = float(meta.get("confidence", 0.8))

    for pattern in meta.get("patterns") or []:
        try:
            m = re.search(pattern, text, re.IGNORECASE | re.MULTILINE)
        except re.error:
            continue
        if not m:
            continue
        group = int(meta.get("group", 1))
        value = m.group(group) if m.groups() else m.group(0)
        value = _postprocess(value, meta)
        if value:
            return value, conf

    if kind == "container_type":
        for rule in meta.get("rules") or []:
            try:
                m = re.search(rule.get("pattern", ""), text, re.IGNORECASE | re.MULTILINE)
            except re.error:
                continue
            if not m:
                continue
            value = _postprocess(
                _render_template(rule.get("value", ""), m),
                {**meta, **rule},
            )
            if value:
                return value, float(rule.get("confidence", conf))
        return None

    if kind == "quantity":
        for rule in meta.get("rules") or []:
            try:
                m = re.search(rule.get("pattern", ""), text, re.IGNORECASE | re.MULTILINE)
            except re.error:
                continue
            if not m:
                continue
            group = int(rule.get("group", 1))
            raw = m.group(group) if m.groups() else m.group(0)
            value = _qty_from_segment(raw) if rule.get("postprocess") == "qty_segment" else canon_qty(raw)
            value = _postprocess(value, {**meta, **rule, "postprocess": None})
            if value:
                return value, float(rule.get("confidence", conf))
        return None

    keywords = tuple(meta.get("keywords") or ())

    if kind == "amount":
        for kw in keywords:
            m = re.search(rf"(?:{re.escape(kw)})\s*[:：]?\s*([\d.,]+)", text, re.IGNORECASE)
            if m:
                value = _postprocess(m.group(1), meta)
                if value:
                    return value, conf
        return None

    if kind == "datetime":
        value = _dt_near(text, keywords)
        value = _postprocess(value, meta) if value else None
        return (value, conf) if value else None

    if kind == "phone":
        m = re.search(r"(?<!\d)((?:\+?86[-\s]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4})(?!\d)", text)
        if not m:
            m = re.search(r"(?<!\d)((?:0\d{2,3})[-\s]?\d{7,8})(?!\d)", text)
        if not m:
            return None
        digits = re.sub(r"[^\d]", "", m.group(1))
        if digits.startswith("86") and len(digits) == 13:
            digits = digits[2:]
        return digits, conf

    if kind == "container":
        found = containers_in(text)
        if found:
            return _postprocess(",".join(dict.fromkeys(found)), meta), conf
        return None

    # label / verb / seal
    value = _grab(text, keywords, meta.get("limit", 80), split=meta.get("split", True))
    value = _postprocess(value, meta) if value else None
    return (value, conf) if value else None


def _generic_extract(text: str, spec) -> tuple[str, float] | None:
    """按字段的 extract 声明做通用规则抽取。

    只实现固定几种抽取器，pack 不能写任意代码。
    """
    meta = getattr(spec, "extract", None) or {}
    if not meta:
        return None
    strategies = meta.get("strategies")
    if strategies:
        for strategy in strategies:
            got = _run_strategy(text, strategy)
            if got:
                return got
        return None
    return _run_strategy(text, meta)


def extract_by_rules(text: str) -> dict[str, FieldValue]:
    out: dict[str, FieldValue] = {k: FieldValue() for k in FIELD_KEYS}

    def put(key: str, value: str | None, conf: float) -> None:
        if key not in out or not value:
            return
        out[key] = FieldValue(value=value.strip(), confidence=conf, source="rule")

    for spec in SPECS:
        got = _generic_extract(text, spec)
        if got:
            put(spec.key, got[0], got[1])

    # D14：字段名容错匹配。只补空，绝不覆盖精确匹配到的值。
    try:
        from .fuzzy import fuzzy_fill
        for k, fv in fuzzy_fill(text, out).items():
            if k in out and not out[k].value:
                out[k] = fv
    except Exception:
        pass

    return out


# ---------------- LLM 通道 ----------------

def extract_by_llm(text: str) -> tuple[dict[str, FieldValue], int, str]:
    user = (
        f"字段清单：\n{_field_catalog()}\n\n"
        f"托书原文：\n```\n{mask(text)}\n```"
    )
    res = chat_json(_SYSTEM_PROMPT, user)
    if not res.ok:
        return {}, 0, res.error
    data = parse_json_loose(res.text)
    raw_fields = data.get("fields") or {}
    out: dict[str, FieldValue] = {}
    for key in FIELD_KEYS:
        item = raw_fields.get(key)
        if isinstance(item, dict):
            v = item.get("value")
            c = item.get("confidence", 0.0)
        elif isinstance(item, str):
            v, c = item, 0.6
        else:
            continue
        if v in (None, "", "null", "None", "-"):
            continue
        try:
            conf = max(0.0, min(1.0, float(c)))
        except (TypeError, ValueError):
            conf = 0.6
        out[key] = FieldValue(value=str(v).strip(), confidence=conf, source="llm")
    return out, res.tokens, ""


def _needs_llm(draft: Draft) -> bool:
    """规则已经够好就不必花 10 秒和一笔 token 去调模型。

    触发条件（任一）：
    - 有任何必填字段没抽到
    - 有任何已抽字段置信度低于阈值
    """
    for key in BLOCKING_KEYS:
        fv = draft.fields.get(key)
        if not fv or not fv.value:
            return True
    return any(fv.value and fv.confidence < settings.llm_conf_floor
               for fv in draft.fields.values())


def _stamp(draft: Draft) -> Draft:
    """打上审计标记：谁跑出来的、哪版提示词、哪版管线。"""
    draft.model = settings.model if draft.engine.startswith("llm:") else ""
    draft.prompt_version = prompt_version()
    draft.pipeline_version = PIPELINE_VERSION
    pack = current_pack()
    draft.pack_id = pack.id
    draft.pack_version = pack.version
    return draft


def extract(text: str, mode: str = "merged", allow_llm: bool = True) -> Draft:
    """mode:
    - merged（默认）：规则 + 模型，按 MERGE_POLICY 合并（默认模型只补空）
    - rule：只用规则，用于对照
    - llm：只用模型，用于对照（模型不可用时返回空草稿并标注）

    allow_llm=False 时即使配了模型也不调用——演示现场要速度就用它。
    """
    started = time.perf_counter()
    # NFKC：全角数字/字母/冒号/括号统一成半角。托书里全角字符极常见，
    # 不归一化会导致正则和模型都抽不出来。
    text = unicodedata.normalize("NFKC", (text or "")).strip()

    if mode == "llm":
        if not text:
            draft = empty_draft()
        elif not settings.llm_enabled:
            draft = empty_draft()
            draft.engine = "llm-unavailable"
        else:
            llm_fields, tokens, _err = extract_by_llm(text)
            draft = empty_draft()
            for key, fv in llm_fields.items():
                if fv.value:
                    draft.fields[key] = fv
            draft.engine = f"llm:{settings.model}"
            draft.tokens = tokens
        apply_rules(draft)
        draft.elapsed_ms = int((time.perf_counter() - started) * 1000)
        return _stamp(draft)

    draft = empty_draft() if not text else Draft(fields=extract_by_rules(text))
    engine = "rule-based-v1"
    tokens = 0

    strategy = settings.llm_strategy
    should_call = mode != "rule" and allow_llm and settings.llm_enabled and bool(text)
    if should_call and strategy == "off":
        should_call = False
    if should_call and strategy == "auto" and not _needs_llm(draft):
        should_call = False
        draft.note = "规则已覆盖必填且置信度足够，跳过模型"

    if should_call:
        llm_fields, tokens, err = extract_by_llm(text)
        if llm_fields:
            engine = f"llm:{settings.model}"
            rule_fields = draft.fields
            for key, fv in llm_fields.items():
                if not fv.value:
                    continue
                rule_fv = rule_fields.get(key)
                if MERGE_POLICY == "fill_only":
                    # 规则已有值就保留，模型只补规则漏掉的
                    if rule_fv and rule_fv.value:
                        continue
                else:
                    # 1) 强格式字段永远以规则为准
                    if key in RULE_AUTHORITATIVE and rule_fv and rule_fv.value:
                        continue
                    # 2) floor 策略下，规则够自信就不让模型覆盖
                    if MERGE_POLICY == "floor" and rule_fv and rule_fv.value \
                            and rule_fv.confidence >= _th.get("booking.rule_floor"):
                        continue
                rule_fields[key] = fv
            draft.fields = rule_fields
        elif err:
            draft.note = f"模型调用失败，已降级为规则引擎：{err[:80]}"

    draft.engine = engine
    draft.tokens = tokens
    notes = canonicalize(draft.fields)   # D7：先归一再校验
    if notes:
        draft.note = (draft.note + "；" if draft.note else "") + f"归一 {len(notes)} 项"
    apply_rules(draft)

    # D8：多票检测。不自动切，只提示——切错比不切更糟。
    try:
        from .splitter import count_tickets, split_tickets
        n = count_tickets(text)
        if n >= 2 and len(split_tickets(text)) >= 2:
            draft.note = (draft.note + "；" if draft.note else "") + f"检测到 {n} 票，当前只解析了第一票"
    except Exception:
        pass

    draft.elapsed_ms = int((time.perf_counter() - started) * 1000)
    return _stamp(draft)
