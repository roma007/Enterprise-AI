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
from .normalize import canonicalize
from .rules import (
    apply_rules,
    containers_in,
    fmt,
    parse_datetime,
)
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


_VERB_PATTERNS = {
    "client": (
        r"(?:客户|货代|委托方)(?:是|为)\s*([^\n，,；;。]+)",
    ),
    "factory_contact": (
        r"(?:联系人|Contact|Attn)\s*[:：]?\s*([\u4e00-\u9fa5A-Za-z]{2,6})",
    ),
    "pickup_addr": (
        r"(?:装柜地址|装货地址|提箱地址|提箱地点|提箱点|提空箱点)\s*[:：]\s*([^\n，,；;]+)",
        r"(?:提箱|提柜|工厂|装货|装箱)(?:在|于|是)\s*([^\n，,；;。]+)",
    ),
    "delivery_addr": (
        r"(?:卸货地址|送货地址|目的地|送达地址)\s*[:：|]\s*([^\n，,；;]+)",
        r"(?:卸货地|送货地|目的地)(?:改成|改为|换成|是|为)\s*([^\n，,；;。]+)",
        r"(?:送到|送至|送货到)\s*([^\n，,；;。]+)",
        r"(?:去|到)\s*([^\n，,；;。]{2,30}?(?:码头|仓库|堆场|园区|工厂|仓|路|街|号))",
        r"(?:去|到)\s*([\u4e00-\u9fa5]{2,8})",
    ),
    "vessel_voyage": (
        r"(?:船名航次|船名/航次|船名|航次|Vessel)\s*[:：]\s*([^\n，,；;]+)",
        r"船(?:名)?(?:是|为)\s*([^\n，,；;。]+)",
    ),
    "cargo_desc": (
        r"(?:品名|货物描述|货物|货名|商品|Commodity|Cargo)\s*[:：]\s*([^\n，,；;]+)",
        r"货(?:是|为)\s*([^\n，,；;。]+)",
    ),
}


def _looks_like_datetime(v: str) -> bool:
    """地址字段里不该出现日期。"到11月8号" 这种会被误当送达地。"""
    return bool(re.search(r"\d{1,2}\s*[月/.\-]\s*\d{1,2}\s*[日号]?", v)) or \
        bool(re.search(r"\d{1,2}\s*[:：]\s*\d{2}", v))


def _verb_grab(text: str, key: str, limit: int = 80, split: bool = True) -> str | None:
    for pattern in _VERB_PATTERNS.get(key, ()):
        m = re.search(pattern, text, re.IGNORECASE)
        if m:
            v = _clean(m.group(1), limit, split)
            if v:
                return v
    return None


def _dt_near(text: str, keys: tuple[str, ...]) -> str | None:
    low = text.lower()
    for line in _lines(text):
        ll = line.lower()
        if any(k.lower() in ll for k in keys):
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


_CN_NUM = {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
           "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}

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


def extract_by_rules(text: str) -> dict[str, FieldValue]:
    up = text.upper()
    out: dict[str, FieldValue] = {k: FieldValue() for k in FIELD_KEYS}

    def put(key: str, value: str | None, conf: float, cut: bool = True) -> None:
        if value:
            v = _cut_stop(value) if cut else value
            if v:
                out[key] = FieldValue(value=v.strip(), confidence=conf, source="rule")

    put("client", _grab(text, (
        "委托单位", "客户名称", "客户", "货代名称", "货代", "委托方", "Client",
    )), 0.8)
    if not out["client"].value:
        put("client", _verb_grab(text, "client"), 0.7)

    put("booking_no", _grab(text, (
        "委托单号", "托书编号", "托书号", "订单号", "原委托单", "原单号",
        "Booking No.", "Booking No", "Booking", "单号",
    )), 0.85)
    if not out["booking_no"].value:
        m = re.search(r"原(?:委托单|单号|单)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9\-]{2,})", text)
        if m:
            put("booking_no", m.group(1), 0.8)
    if not out["booking_no"].value:
        # "单号HT-1105" 这种没有分隔符的写法
        m = re.search(r"(?:单号|编号|订单号)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9\-]{2,})", text)
        if m:
            put("booking_no", m.group(1), 0.75)
    if not out["booking_no"].value:
        # 首行裸编号，如 "宏运-1105-1"、"HY-1105"
        m = re.search(r"^\s*([A-Za-z\u4e00-\u9fa5]{2,8}[-\s]?\d{3,}[-\d]*)", text, re.MULTILINE)
        if m:
            put("booking_no", m.group(1).strip(), 0.6)
    put("bl_no", _grab(text, ("提单号", "B/L NO", "B/L No.", "BL NO", "提单", "B/L")), 0.8)
    put("so_no", _grab(text, ("SO号", "SO NO", "S/O NO", "S/O", "SO")), 0.8)
    if not out["so_no"].value:
        m = re.search(r"(?<![A-Z])(?:SO|S/O)[-\s]?(\d{4,})", text.upper())
        if m:
            put("so_no", f"SO-{m.group(1)}", 0.6)

    # 箱型：标准写法 → 常见简写（40H/40HC）→ 口语（小柜/大柜/高柜/20尺）
    m = re.search(r"(?<!\d)(20|40|45)\s*(GP|HQ|HC|RF|OT|FR|TK)(?![A-Z])", up)
    if m:
        put("container_type", f"{m.group(1)}{m.group(2)}".replace("HC", "HQ"), 0.95)
    elif re.search(r"(?<!\d)(40|45)\s*H(?![A-Z])", up):
        put("container_type", re.search(r"(?<!\d)(40|45)\s*H(?![A-Z])", up).group(1) + "HQ", 0.85)
    elif re.search(r"高柜|40尺高|HQ", up):
        put("container_type", "40HQ", 0.65)
    elif re.search(r"小柜|20尺|20寸", up):
        put("container_type", "20GP", 0.75)
    elif re.search(r"大柜|40尺|40寸", up):
        put("container_type", "40GP", 0.65)

    # 箱量：显式声明 → 箱型×N → N×箱型 → 中文数量词
    qty = None
    m = re.search(r"(?:箱量|数量|箱数|柜量|柜数|QTY)\s*[:：|]?\s*([^\n]{1,24})", text, re.IGNORECASE)
    if m:
        seg = m.group(1)
        nums = re.findall(r"\d+", seg)
        if nums:
            # "箱型/箱量：40GP / 1" 取最后一个；"箱量：1，箱号：..." 取第一个
            qty = nums[-1] if re.search(r"(GP|HQ|HC|RF|OT|FR|TK)", seg, re.IGNORECASE) else nums[0]
    if not qty:
        m = re.search(r"(20|40|45)\s*(?:GP|HQ|HC|RF|OT|FR|TK)\s*[x×*X]\s*(\d+)", up)
        if m:
            qty = m.group(2)
    if not qty:
        m = re.search(r"(\d+)\s*[x×*X]\s*(?:20|40|45)\s*(?:GP|HQ|HC|RF|OT|FR|TK)", up)
        if m:
            qty = m.group(1)
    if not qty:
        m = re.search(r"([一二两三四五六七八九十])\s*[个x×*]?\s*(?:20|40|45)\s*(?:GP|HQ|HC|RF|OT|FR|TK)", up)
        if m:
            qty = str(_CN_NUM[m.group(1)])
    if not qty:
        m = re.search(r"(?:20|40|45)\s*(?:GP|HQ|HC|RF|OT|FR|TK)\s*([一二两三四五六七八九十])\s*个?", up)
        if m:
            qty = str(_CN_NUM[m.group(1)])
    if not qty:
        m = re.search(r"([一二两三四五六七八九十])\s*个\s*(?:小柜|大柜|高柜|柜|箱)", text)
        if m:
            qty = str(_CN_NUM[m.group(1)])
    if not qty:
        m = re.search(r"(?:小柜|大柜|高柜|柜|箱)\s*([一二两三四五六七八九十])\s*个", text)
        if m:
            qty = str(_CN_NUM[m.group(1)])
    if not qty:
        m = re.search(r"(\d+)\s*[个x×*X]\s*(?:小柜|大柜|高柜|箱|柜)", text)
        if m:
            qty = m.group(1)
    put("container_qty", qty, 0.95)

    cs = containers_in(text)
    if cs:
        put("container_no", ",".join(dict.fromkeys(cs)), 0.97, cut=False)

    seal = None
    m = re.search(
        r"(?:铅封号|封条号|封号|Seal No\.?|Seal)[^\nA-Za-z0-9]{0,10}([A-Za-z0-9、,，][A-Za-z0-9、,，\- ]{2,80})",
        text, re.IGNORECASE,
    )
    if m:
        toks = [t.strip() for t in re.split(r"[、,，\s]+", m.group(1)) if t.strip()]
        toks = [t for t in toks if re.fullmatch(r"[A-Za-z0-9\-]{4,15}", t)]
        if toks:
            seal = ",".join(toks)
    if not seal:
        seal = _grab(text, ("铅封号", "封条号", "封号", "Seal No.", "Seal"), split=False)
    put("seal_no", seal, 0.9, cut=False)

    pickup = _grab(text, (
        "提箱地址", "提空箱点", "提箱地点", "提箱点", "提箱地", "装柜地址",
        "装货地址", "装货地", "提柜", "提箱", "提空箱", "Pick up", "Pickup",
    ), 80) or _verb_grab(text, "pickup_addr")
    if pickup and _looks_like_datetime(pickup):
        pickup = None
    put("pickup_addr", pickup, 0.8)

    delivery = _grab(text, (
        "卸货地址", "送货地址", "卸货地", "送货地", "目的地", "送达地址",
        "送达", "卸货", "送货", "Delivery", "Deliver to",
    ), 80) or _verb_grab(text, "delivery_addr")
    if delivery and _looks_like_datetime(delivery):
        delivery = None
    put("delivery_addr", delivery, 0.8)

    contact = _grab(text, (
        "工厂联系人", "收货联系人", "联系人", "Contact", "Attn",
    )) or _verb_grab(text, "factory_contact")
    if contact:
        contact = re.sub(r"^(?:改成|改为|换成|是|为)", "", contact).strip()
        # "陈小姐 13600004444" / "赵经理 +86 138…" → 只留姓名
        if re.search(r"[\d+]", contact):
            m = re.match(r"^[\u4e00-\u9fa5]{2,4}", contact)
            if m:
                contact = m.group(0)
    put("factory_contact", contact, 0.8)

    m = re.search(r"(?<!\d)((?:\+?86[-\s]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4})(?!\d)", text)
    if not m:
        m = re.search(r"(?<!\d)((?:0\d{2,3})[-\s]?\d{7,8})(?!\d)", text)
    if m:
        digits = re.sub(r"[^\d]", "", m.group(1))
        if digits.startswith("86") and len(digits) == 13:
            digits = digits[2:]
        put("factory_phone", digits, 0.95)

    put("loading_window", _dt_near(text, (
        "装柜", "装箱", "装货时间", "时间窗", "Loading", "Stuffing",
    )), 0.75)
    put("closing_time", _dt_near(text, (
        "截港", "截关", "截单", "Cut off", "Cut-off", "Cutoff", "Closing", "SI cut",
    )), 0.93)
    put("vessel_voyage", _grab(text, (
        "船名航次", "船名/航次", "船名", "航次", "Vessel/Voyage", "Vessel", "Voyage",
    ), 60) or _verb_grab(text, "vessel_voyage"), 0.8)
    put("depot", _grab(text, ("提空箱点", "提箱点", "堆场", "场站", "Depot")), 0.75)
    put("cargo_desc", _grab(text, (
        "品名", "货物描述", "货物", "货名", "Commodity", "Cargo",
    )) or _verb_grab(text, "cargo_desc"), 0.8)

    m = re.search(r"(?:毛重|重量|G\.?W\.?|GROSS WEIGHT|KGS?)\s*[:：]?\s*([\d.,]+)", text, re.IGNORECASE)
    if m:
        put("gross_weight", m.group(1).replace(",", ""), 0.9)

    m = re.search(r"(?:运费|拖车费|报价|价格|单价|RATE|Freight)\s*[:：]?\s*([\d.,]+)", text, re.IGNORECASE)
    if m:
        put("freight", m.group(1).replace(",", ""), 0.85)

    remark = _grab(text, ("特殊要求", "备注", "要求", "注意", "Remark"), 160, split=False)
    if remark:
        remark = re.sub(r"[;；]\s*", "，", remark)
    put("remark", remark, 0.7, cut=False)

    # D14：字段名容错匹配。只补空，绝不覆盖精确匹配到的值。
    try:
        from .fuzzy import fuzzy_fill
        for k, fv in fuzzy_fill(text, out).items():
            if not out[k].value:
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
