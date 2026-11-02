"""发票识别与校验（04b）。

复用托书那套底座（LLM 网关、OCR、队列、分级审批、留痕），只换两样东西：
- 字段清单（schema）
- 校验规则（税号校验位、金额勾稽、税率）

关键设计：
1. 发票比托书**更需要确定性校验**——金额算错、税号写错，是要退票和补税的。
   所以这里规则占的比重比托书更高，模型只负责"把字认出来并归位"。
2. 金额一律用 Decimal 处理，不用 float。0.01 的误差在发票上是错误。
3. 税号校验用 GB 32100 统一社会信用代码算法（mod 31）。
"""
from __future__ import annotations

import re
import time
import unicodedata
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

from .config import settings
from .llm import chat_json, mask, parse_json_loose
from .schema import Check, Draft, FieldValue

PIPELINE_VERSION = "0.1.0"


@dataclass(frozen=True)
class InvField:
    key: str
    label: str
    hint: str = ""
    example: str = ""
    blocking: bool = False


INVOICE_SPECS: tuple[InvField, ...] = (
    InvField("invoice_code", "发票代码", "10-12 位数字，全电发票可能没有", "033002100311"),
    InvField("invoice_no", "发票号码", "8 位或 20 位数字", "12345678", blocking=True),
    InvField("invoice_date", "开票日期", "YYYY-MM-DD", "2026-10-28"),
    InvField("invoice_type", "发票类型", "专票/普票/电子普票/全电发票", "增值税专用发票"),
    InvField("buyer_name", "购买方名称", "付款方公司全称", "宁波宏运集卡运输有限公司"),
    InvField("buyer_tax_id", "购买方税号", "18 位统一社会信用代码", "9133020662M3QQRL4D", blocking=True),
    InvField("seller_name", "销售方名称", "开票方公司全称", "宁波北仑中石化加油站"),
    InvField("seller_tax_id", "销售方税号", "18 位统一社会信用代码", "91330200TF3NLDC9HT"),
    InvField("amount", "金额（不含税）", "不含税金额", "1234.56", blocking=True),
    InvField("tax_rate", "税率", "0.13 / 0.09 / 0.06 / 0.03 / 0.01", "0.13"),
    InvField("tax_amount", "税额", "增值税额", "160.49"),
    InvField("total_amount", "价税合计", "金额 + 税额", "1395.05", blocking=True),
    InvField("item_summary", "货物或服务", "品名摘要", "0# 柴油"),
    InvField("check_code", "校验码", "专票 20 位", ""),
    InvField("remark", "备注", "", ""),
)

INVOICE_KEYS = tuple(s.key for s in INVOICE_SPECS)
INV_LABELS = {s.key: s.label for s in INVOICE_SPECS}
INV_SPEC = {s.key: s for s in INVOICE_SPECS}
INV_BLOCKING = tuple(s.key for s in INVOICE_SPECS if s.blocking)

VALID_RATES = {"0", "0.01", "0.03", "0.05", "0.06", "0.09", "0.13"}

# ---------- 统一社会信用代码校验（GB 32100） ----------

_USCC_CHARS = "0123456789ABCDEFGHJKLMNPQRTUWXY"
_USCC_WEIGHTS = (1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28)


def uscc_valid(code: str) -> tuple[bool, str]:
    code = (code or "").strip().upper()
    if len(code) == 15:          # 老税号，不做校验位
        return re.fullmatch(r"\d{15}", code) is not None, "15 位老税号"
    if len(code) != 18:
        return False, "长度不是 18 位"
    if any(c not in _USCC_CHARS for c in code):
        return False, "含非法字符"
    total = sum(_USCC_CHARS.index(c) * w for c, w in zip(code[:17], _USCC_WEIGHTS))
    check = 31 - (total % 31)
    if check == 31:
        check = 0
    if _USCC_CHARS[check] == code[17]:
        return True, ""
    return False, f"校验位应为 {_USCC_CHARS[check]}"


# ---------- 金额 ----------

def _dec(v: str | None) -> Decimal | None:
    if v is None:
        return None
    s = re.sub(r"[^\d.\-]", "", str(v))
    if not s or s in {"-", "."}:
        return None
    try:
        return Decimal(s).quantize(Decimal("0.01"))
    except InvalidOperation:
        return None


# ---------- 规则抽取 ----------

_LINE_KV = re.compile(r"^\s*([\u4e00-\u9fa5（）()#\s]{1,14})\s*[:：]\s*(.+?)\s*$")
_TAXID = re.compile(r"(?<![0-9A-Z])([0-9A-Z]{18})(?![0-9A-Z])")
_MONEY = re.compile(r"[-−]?\d[\d,]*\.\d{2}")


def extract_by_rules(text: str) -> dict[str, FieldValue]:
    out: dict[str, FieldValue] = {k: FieldValue() for k in INVOICE_KEYS}

    def put(key: str, value: str | None, conf: float = 0.85) -> None:
        if value:
            v = value.strip().strip("：:，,；;")
            if v:
                out[key] = FieldValue(value=v, confidence=conf, source="rule")

    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    buyer_tax_seen = False

    for ln in lines:
        m = _LINE_KV.match(ln)
        if not m:
            continue
        k, v = m.group(1).strip(), m.group(2).strip()

        if "发票代码" in k:
            put("invoice_code", re.sub(r"\D", "", v)[:12])
        elif "发票号码" in k:
            put("invoice_no", re.sub(r"\D", "", v)[:20], 0.92)
        elif "开票日期" in k or k == "日期":
            put("invoice_date", v)
        elif "发票类型" in k or k == "类型":
            put("invoice_type", v)
        elif "购买方" in k and ("名称" in k or "名" in k):
            put("buyer_name", v)
        elif "销售方" in k and ("名称" in k or "名" in k):
            put("seller_name", v)
        elif "纳税人识别号" in k or "税号" in k or k.endswith("识别号"):
            tid = re.sub(r"[^0-9A-Za-z]", "", v).upper()
            if tid:
                if not buyer_tax_seen and "购买方" not in k:
                    put("buyer_tax_id", tid, 0.95 if uscc_valid(tid)[0] else 0.75)
                    buyer_tax_seen = True
                else:
                    put("seller_tax_id", tid, 0.95 if uscc_valid(tid)[0] else 0.75)
        elif "价税合计" in k:
            mm = _MONEY.search(v)
            put("total_amount", mm.group(0) if mm else v, 0.9)
        elif "税额" in k and "合计" not in k:
            mm = _MONEY.search(v)
            put("tax_amount", mm.group(0) if mm else v, 0.88)
        elif k.strip() in {"金额", "合计金额"}:
            mm = _MONEY.search(v)
            put("amount", mm.group(0) if mm else v, 0.88)
        elif "税率" in k:
            mm = re.search(r"(\d+(?:\.\d+)?)\s*%", v)
            if mm:
                put("tax_rate", str(Decimal(mm.group(1)) / 100), 0.9)
            else:
                put("tax_rate", v, 0.75)
        elif "校验码" in k:
            put("check_code", re.sub(r"\D", "", v)[:20], 0.9)

    # 兜底：整段里找 18 位税号
    ids = _TAXID.findall(text.upper())
    if ids:
        if not out["buyer_tax_id"].value:
            out["buyer_tax_id"] = FieldValue(value=ids[0], confidence=0.7, source="regex")
        if len(ids) > 1 and not out["seller_tax_id"].value:
            out["seller_tax_id"] = FieldValue(value=ids[1], confidence=0.7, source="regex")

    # 兜底：没有"金额"标签时，用价税合计减税额倒推
    if not out["amount"].value:
        t, ta = _dec(out["total_amount"].value), _dec(out["tax_amount"].value)
        if t is not None and ta is not None:
            out["amount"] = FieldValue(value=str(t - ta), confidence=0.7, source="calc")

    return out


# ---------- 模型通道 ----------

_SYS = """你是财务共享中心的资深会计，负责把发票整理成结构化数据。

要求：
1. 只抽取票面明确存在的信息，绝不编造。
2. 金额输出为数字（两位小数），不要带货币符号和千分位。
3. 税率输出小数形式：13% → 0.13。
4. 日期输出 YYYY-MM-DD。
5. 无法确定的字段 value 设为 null，confidence 设为 0。
6. 只输出 JSON，不要解释。

输出格式：{"fields": {"invoice_no": {"value": "...", "confidence": 0.95}}}
"""


def _catalog() -> str:
    return "\n".join(f'- {s.key}（{s.label}）: {s.hint}；示例 "{s.example}"' for s in INVOICE_SPECS)


def extract_by_llm(text: str) -> tuple[dict[str, FieldValue], int]:
    user = f"字段清单：\n{_catalog()}\n\n发票原文：\n```\n{mask(text)}\n```"
    res = chat_json(_SYS, user)
    if not res.ok:
        return {}, 0
    data = parse_json_loose(res.text)
    raw = data.get("fields") or {}
    out: dict[str, FieldValue] = {}
    for key in INVOICE_KEYS:
        item = raw.get(key)
        if not isinstance(item, dict):
            continue
        v = item.get("value")
        if v in (None, "", "null", "None"):
            continue
        try:
            conf = max(0.0, min(1.0, float(item.get("confidence", 0.6))))
        except (TypeError, ValueError):
            conf = 0.6
        out[key] = FieldValue(value=str(v).strip(), confidence=conf, source="llm")
    return out, res.tokens


# ---------- 校验 ----------

def run_checks(f: dict[str, FieldValue]) -> list[Check]:
    checks: list[Check] = []

    def val(k: str) -> str:
        return (f.get(k).value or "").strip() if f.get(k) else ""

    for k in INV_BLOCKING:
        if not val(k):
            checks.append(Check(level="error", code="E_REQUIRED", field=k,
                                message=f"缺少必填项：{INV_SPEC[k].label}"))

    # 税号校验位
    for key in ("buyer_tax_id", "seller_tax_id"):
        v = val(key)
        if not v:
            continue
        ok, why = uscc_valid(v)
        if not ok:
            checks.append(Check(level="error", code="E_TAX_ID", field=key,
                                message=f"{INV_SPEC[key].label} {v} 校验失败：{why}"))

    # 金额勾稽：金额 + 税额 = 价税合计
    a, t, total = _dec(val("amount")), _dec(val("tax_amount")), _dec(val("total_amount"))
    if a is not None and t is not None and total is not None:
        if abs((a + t) - total) > Decimal("0.02"):
            checks.append(Check(
                level="error", code="E_AMOUNT_MISMATCH", field="total_amount",
                message=f"金额 {a} + 税额 {t} ≠ 价税合计 {total}（差 {a + t - total}）"))

    # 税额 = 金额 × 税率
    rate = _dec(val("tax_rate"))
    if a is not None and t is not None and rate is not None:
        expect = (a * rate).quantize(Decimal("0.01"))
        if abs(expect - t) > Decimal("0.02"):
            checks.append(Check(
                level="warn", code="W_TAX_CALC", field="tax_amount",
                message=f"按税率 {rate} 计算税额应为 {expect}，票面为 {t}"))

    # 税率合法性
    if val("tax_rate") and rate is not None and str(rate.normalize()) not in VALID_RATES:
        checks.append(Check(level="warn", code="W_RATE_UNUSUAL", field="tax_rate",
                            message=f"税率 {rate} 不在常见范围（1%/3%/5%/6%/9%/13%）"))

    # 发票号码
    inv_no = val("invoice_no")
    if inv_no and not re.fullmatch(r"\d{8}|\d{20}", inv_no):
        checks.append(Check(level="warn", code="W_INVOICE_NO", field="invoice_no",
                            message=f"发票号码 {inv_no} 位数异常（常见 8 位或 20 位）"))

    # 校验码
    if val("invoice_type") and "专" in val("invoice_type") and not val("check_code"):
        checks.append(Check(level="warn", code="W_CHECK_CODE", field="check_code",
                            message="专用发票通常有 20 位校验码，票面未识别到"))

    # 低置信度
    for k, fv in f.items():
        if fv.value and 0 < fv.confidence < 0.7:
            checks.append(Check(level="warn", code="W_LOW_CONF", field=k,
                                message=f"{INV_SPEC[k].label} 置信度偏低（{fv.confidence:.0%}）"))

    return checks


def decide_level(checks: list[Check], f: dict[str, FieldValue]) -> str:
    if any(c.level == "error" for c in checks):
        return "blocked"
    watch = ("invoice_no", "buyer_tax_id", "total_amount")
    confs = [f[k].confidence for k in watch if k in f and f[k].value]
    if confs and min(confs) < 0.8:
        return "double"
    if any(c.level == "warn" for c in checks):
        return "single"
    return "auto" if confs and min(confs) >= 0.9 else "single"


# ---------- 主入口 ----------

def extract_invoice(text: str, allow_llm: bool = True) -> Draft:
    started = time.perf_counter()
    text = unicodedata.normalize("NFKC", (text or "")).strip()
    note = ""

    fields = extract_by_rules(text) if text else {k: FieldValue() for k in INVOICE_KEYS}
    engine = "rule-based-v1"
    tokens = 0

    # 与托书同一策略：规则已覆盖必填且置信度够，就不花 5 秒调模型
    need_llm = any(not (fields.get(k) and fields[k].value) for k in INV_BLOCKING) or \
        any(fv.value and fv.confidence < 0.7 for fv in fields.values())

    if settings.llm_enabled and text and allow_llm and need_llm:
        llm_fields, tokens = extract_by_llm(text)
        if llm_fields:
            engine = f"llm:{settings.model}"
            for k, fv in llm_fields.items():
                cur = fields.get(k)
                # 规则已抽到就不覆盖（与托书同一策略）
                if cur is None or not cur.value:
                    fields[k] = fv
    elif text:
        note = "规则已覆盖必填，跳过模型" if settings.llm_enabled and allow_llm else ""

    checks = run_checks(fields)
    level = decide_level(checks, fields)

    return Draft(
        fields=fields,
        checks=checks,
        engine=engine,
        elapsed_ms=int((time.perf_counter() - started) * 1000),
        tokens=tokens,
        note=note,
        review_level=level,
        model=settings.model if engine.startswith("llm:") else "",
        pipeline_version=PIPELINE_VERSION,
    )
