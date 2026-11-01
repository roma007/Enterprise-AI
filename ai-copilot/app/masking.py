"""脱敏（P0）。

为什么必须做成工具：400 份样本人工脱敏要 6.7 小时，而且一定会漏。
漏一个手机号，就是把客户信息带出了公司。

三条规则（来自 samples/real/README.md）
1. 公司名 / 货代名 → 客户A、客户B……  **同一实体始终同一个代号**（靠持久化映射表）
2. 手机号 → 中间四位 ****（保留后四位，便于与原单核对）
3. 身份证 / 报关单号 / 银行账号 → 等长占位符

设计取舍
- **先抽取、后脱敏**：脱敏会破坏手机号等字段的形态，影响抽取质量。
  所以流程是「原文 → 抽取 → 对存库内容脱敏」。
- 映射表单独存 `data/mask_map.json`，不进版本库、不外发。
- 保留原文哈希，用于证明"这条脱敏数据来自哪份原文"。
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from .config import ROOT

MAP_PATH = ROOT / "data" / "mask_map.json"

# 公司/货代名：后缀按长度降序，且用贪婪匹配，否则"宁波宏图国际贸易有限公司"
# 会先命中较短的"国际贸易"，留下一个孤零零的"有限公司"
_COMPANY_RE = re.compile(
    r"[\u4e00-\u9fa5A-Za-z0-9]{2,20}"
    r"(?:股份有限公司|有限责任公司|有限公司|运输公司|供应链|国际贸易|物流|货代|货运)"
)
_PHONE_RE = re.compile(r"(?<!\d)(1[3-9]\d)(\d{4})(\d{4})(?!\d)")
_TEL_RE = re.compile(r"(?<!\d)(0\d{2,3})[-\s]?(\d{3,4})(\d{4})(?!\d)")
_ID_RE = re.compile(r"(?<!\d)\d{17}[\dXx](?!\d)")
_DECL_RE = re.compile(r"(?:报关单号|报关单)\s*[:：]?\s*([A-Za-z0-9]{8,})")
_BANK_RE = re.compile(r"(?<!\d)\d{16,19}(?!\d)")
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
# 联系人姓名：托书里常见，属于个人信息，一并脱敏
_NAME_RE = re.compile(r"(联系人|收货人|工厂联系人|对接人)\s*[:：]?\s*([\u4e00-\u9fa5]{2,3})")


class MaskMap:
    """实体 → 代号 的持久映射。同一个客户永远映射到同一个代号。"""

    def __init__(self, path: Path | None = None):
        self.path = path or MAP_PATH
        self.map: dict[str, str] = {}
        self._load()

    def _load(self) -> None:
        try:
            self.map = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            self.map = {}

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.map, ensure_ascii=False, indent=1), encoding="utf-8")

    def alias(self, entity: str) -> str:
        if entity in self.map:
            return self.map[entity]
        n = sum(1 for v in self.map.values() if v.startswith("客户")) + 1
        alias = f"客户{_cn_num(n)}"
        self.map[entity] = alias
        return alias


_CN = "零一二三四五六七八九十"


def _cn_num(n: int) -> str:
    if n <= 10:
        return _CN[n]
    if n < 20:
        return "十" + _CN[n - 10]
    return str(n)


def mask_text(text: str, mm: MaskMap) -> tuple[str, dict]:
    """对一段原文脱敏，返回 (脱敏后文本, 统计)。"""
    stats = {"company": 0, "phone": 0, "tel": 0, "id": 0, "decl": 0,
             "bank": 0, "email": 0, "person": 0}

    def _company(m: re.Match) -> str:
        stats["company"] += 1
        return mm.alias(m.group(0))

    text = _COMPANY_RE.sub(_company, text)

    def _phone(m: re.Match) -> str:
        stats["phone"] += 1
        return f"{m.group(1)}****{m.group(3)}"

    text = _PHONE_RE.sub(_phone, text)

    def _tel(m: re.Match) -> str:
        stats["tel"] += 1
        return f"{m.group(1)}-****{m.group(3)}"

    text = _TEL_RE.sub(_tel, text)

    def _decl(m: re.Match) -> str:
        stats["decl"] += 1
        v = m.group(1)
        return m.group(0).replace(v, "D" + "*" * (len(v) - 1))

    # 报关单号要在身份证/银行卡之前处理，否则 18 位报关号会被当成身份证
    text = _DECL_RE.sub(_decl, text)

    def _id(m: re.Match) -> str:
        stats["id"] += 1
        s = m.group(0)
        return s[:4] + "*" * (len(s) - 8) + s[-4:]

    text = _ID_RE.sub(_id, text)

    def _bank(m: re.Match) -> str:
        stats["bank"] += 1
        s = m.group(0)
        return s[:4] + "*" * (len(s) - 8) + s[-4:]

    text = _BANK_RE.sub(_bank, text)

    def _email(m: re.Match) -> str:
        stats["email"] += 1
        name, domain = m.group(0).split("@", 1)
        return f"{name[:2]}***@{domain}"

    text = _EMAIL_RE.sub(_email, text)

    def _name(m: re.Match) -> str:
        stats["person"] += 1
        nm = m.group(2)
        return m.group(0).replace(nm, nm[0] + "*" * (len(nm) - 1))

    text = _NAME_RE.sub(_name, text)
    return text, stats


def mask_fields(fields: dict[str, str], mm: MaskMap) -> tuple[dict[str, str], dict]:
    """对字段值脱敏。客户名走同一张映射表，保证与正文一致。"""
    total = {k: 0 for k in ("company", "phone", "tel", "id", "decl", "bank", "email", "person")}
    out: dict[str, str] = {}
    for k, v in fields.items():
        if not v:
            out[k] = v
            continue
        masked, st = mask_text(v, mm)
        for kk, vv in st.items():
            total[kk] += vv
        out[k] = masked
    return out, total


def fingerprint(text: str) -> str:
    """原文指纹：证明"这条脱敏数据来自哪份原文"，同时不泄露内容。"""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
