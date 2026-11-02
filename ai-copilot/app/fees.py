"""异常费用识别（B6）。

为什么先做"结构异常"而不是"和市场价比"：
- 客户的历史费率、合同价往往拿不到，硬比会编数字
- 但重复收费、金额算错、同一批里明显离群，**不需要任何外部数据**就能查

检测项：
1. 重复收费：同单号 + 同费用名 + 同金额出现多次 → error
2. 金额非法：≤0 或无法解析 → error
3. 算术不符：数量 × 单价 ≠ 金额（容差 0.01） → error
4. 未知费用名：不在费用字典里 → warn（可能是新增附加费，也可能写错）
5. 同批离群：同类费用 ≥5 条时，金额高于中位数 3 倍（或低于 1/3）→ warn

不做的事（明确写出来，避免被当成"全能"）：
- 不与合同价比（没有费率表）
- 不判断某项费用该不该收（业务判断）
- 不跨月比较（需要历史基线）

费用字典可以在 `data/fee_dict.txt` 里一行一个补充，不用改代码。
"""
from __future__ import annotations

import csv
import io
import re
import statistics
from decimal import Decimal, InvalidOperation
from pathlib import Path

from .config import ROOT

DICT_PATH = Path(ROOT / "data" / "fee_dict.txt")

# 内置的常见费用名（子集，不是行业全集）
BUILTIN_FEES = {
    "运费", "拖车费", "运输费", "包干费", "提箱费", "落箱费", "装卸费",
    "掏箱费", "装箱费", "报关费", "报检费", "文件费", "单证费", "订舱费",
    "电放费", "thc", "码头操作费", "燃油附加费", "低硫燃油附加费",
    "压夜费", "等候费", "待时费", "改单费", "退关费", "冲港费", "进港费",
    "过磅费", "路桥费", "停车费", "司机补贴", "代垫费", "箱使费",
    "滞箱费", "修箱费", "洗箱费", "熏蒸费", "保险费", "仓储费", "理货费",
    "查验费", "铅封费", "打单费", "设备交接单费", "edi费", "港口费",
}

_HINTS = {
    "booking_no": ("运单号", "委托单号", "单号", "托书号", "提单号", "订单号", "趟次号"),
    "fee_name": ("费用名称", "费用", "费目", "项目", "科目", "收费项目"),
    "amount": ("金额", "费用金额", "应付", "报账金额", "结算金额", "合计"),
    "qty": ("数量", "趟数", "吨位", "重量", "车数"),
    "unit_price": ("单价", "价格", "运价", "费率"),
    "vendor": ("车队", "供应商", "承运商", "外协"),
    "date": ("日期", "发生日期", "费用日期"),
}


def _dec(v) -> Decimal | None:
    if v is None or v == "":
        return None
    s = re.sub(r"[^\d.\-]", "", str(v))
    if not s or s in {"-", "."}:
        return None
    try:
        return Decimal(s).quantize(Decimal("0.01"))
    except InvalidOperation:
        return None


def _norm_fee(name: str) -> str:
    s = re.sub(r"\s+", "", str(name or "")).lower()
    return s.replace("（", "(").replace("）", ")")


def fee_dict() -> set[str]:
    """内置 + 现场补充。文件改了立即生效（每次读，量很小）。"""
    out = set(BUILTIN_FEES)
    if DICT_PATH.exists():
        try:
            for line in DICT_PATH.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith("#"):
                    out.add(_norm_fee(line))
        except OSError:
            pass
    return out


def _map_header(cols: list[str]) -> dict[int, str]:
    mapping: dict[int, str] = {}
    for i, c in enumerate(cols):
        name = (c or "").strip().lower().replace(" ", "")
        for key, hints in _HINTS.items():
            if key in mapping.values():
                continue
            if any(h.lower() in name for h in hints):
                mapping[i] = key
                break
    return mapping


def parse_fee_text(text: str) -> list[dict]:
    """解析费用明细：CSV / 制表符均可，需有表头。"""
    text = (text or "").lstrip("\ufeff")
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if not lines:
        return []
    header = -1
    for i, ln in enumerate(lines[:5]):
        if any(h in ln for hs in _HINTS.values() for h in hs):
            header = i
            break
    if header < 0:
        raise ValueError("没有找到表头（至少要有「单号 / 费用名称 / 金额」之一）")

    sample = "\n".join(lines[header:header + 5])
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",\t;|")
    except csv.Error:
        dialect = csv.excel
    rows = list(csv.reader(io.StringIO("\n".join(lines[header:])), dialect))
    mapping = _map_header(rows[0])
    if "amount" not in mapping.values():
        raise ValueError("表头缺少「金额」列")

    out = []
    for r in rows[1:]:
        if not any((c or "").strip() for c in r):
            continue
        rec = {}
        for idx, key in mapping.items():
            rec[key] = (r[idx].strip() if idx < len(r) else "")
        if not rec.get("fee_name") and not rec.get("amount"):
            continue
        out.append(rec)
    return out


def _row_label(i: int, row: dict) -> str:
    parts = []
    if row.get("booking_no"):
        parts.append(f"单号 {row['booking_no']}")
    if row.get("fee_name"):
        parts.append(str(row["fee_name"]))
    return f"第 {i + 1} 行" + ("（" + " / ".join(parts) + "）" if parts else "")


def check(rows: list[dict]) -> dict:
    """逐行检查 + 同批离群。不修改入参。"""
    issues: list[dict] = []
    parsed: list[dict] = []
    known = fee_dict()

    for i, raw in enumerate(rows or []):
        row = {k: (str(v).strip() if v is not None else "") for k, v in raw.items()}
        amount = _dec(row.get("amount"))
        qty = _dec(row.get("qty"))
        unit = _dec(row.get("unit_price"))
        label = _row_label(i, row)
        parsed.append({"i": i, "row": row, "amount": amount,
                       "qty": qty, "unit": unit, "label": label})

        # 1. 金额非法
        if amount is None:
            issues.append(_issue("error", "E_FEE_AMOUNT", i, row, label,
                                 f"{label} 金额「{row.get('amount', '')}」无法识别"))
        elif amount <= 0:
            issues.append(_issue("error", "E_FEE_AMOUNT", i, row, label,
                                 f"{label} 金额 {amount} 不大于 0"))

        # 2. 算术不符
        if amount is not None and qty is not None and unit is not None:
            expect = (qty * unit).quantize(Decimal("0.01"))
            if abs(expect - amount) > Decimal("0.01"):
                issues.append(_issue(
                    "error", "E_FEE_ARITHMETIC", i, row, label,
                    f"{label} 数量 {qty} × 单价 {unit} = {expect}，"
                    f"与金额 {amount} 不符",
                ))

        # 3. 未知费用名
        fee = _norm_fee(row.get("fee_name", ""))
        if fee and fee not in known:
            issues.append(_issue(
                "warn", "W_FEE_UNKNOWN", i, row, label,
                f"{label} 费用名「{row['fee_name']}」不在字典内，"
                f"确认是新增附加费还是写错（可在 data/fee_dict.txt 补充）",
            ))

    # 4. 重复收费：同单号 + 同费用名 + 同金额
    seen: dict[tuple, int] = {}
    for item in parsed:
        row, amount = item["row"], item["amount"]
        if amount is None or not row.get("booking_no") or not row.get("fee_name"):
            continue
        key = (row["booking_no"].upper(), _norm_fee(row["fee_name"]), str(amount))
        if key in seen:
            first = seen[key]
            issues.append(_issue(
                "error", "E_FEE_DUPLICATE", item["i"], row, item["label"],
                f"{item['label']} 与第 {first + 1} 行重复："
                f"同单号、同费用、同金额 {amount}",
            ))
        else:
            seen[key] = item["i"]

    # 5. 同批离群（同类 ≥5 条才判断，避免小样本误报）
    groups: dict[str, list[dict]] = {}
    for item in parsed:
        if item["amount"] is None or item["amount"] <= 0:
            continue
        fee = _norm_fee(item["row"].get("fee_name", ""))
        if fee:
            groups.setdefault(fee, []).append(item)

    for fee, items in groups.items():
        if len(items) < 5:
            continue
        values = [float(x["amount"]) for x in items]
        median = statistics.median(values)
        if median <= 0:
            continue
        for item in items:
            amt = float(item["amount"])
            if amt > median * 3 and amt - median >= 100:
                issues.append(_issue(
                    "warn", "W_FEE_OUTLIER", item["i"], item["row"], item["label"],
                    f"{item['label']} 金额 {item['amount']} 明显高于同类中位数 "
                    f"{median:.2f}（{len(items)} 条），请核对",
                ))
            elif amt < median / 3 and median - amt >= 100:
                issues.append(_issue(
                    "warn", "W_FEE_OUTLIER", item["i"], item["row"], item["label"],
                    f"{item['label']} 金额 {item['amount']} 明显低于同类中位数 "
                    f"{median:.2f}（{len(items)} 条），请核对是否少收",
                ))

    total = sum((x["amount"] for x in parsed if x["amount"] is not None),
                Decimal("0.00"))
    by_code: dict[str, int] = {}
    for x in issues:
        by_code[x["code"]] = by_code.get(x["code"], 0) + 1

    return {
        "rows": len(parsed),
        "total_amount": str(total),
        "issues": issues,
        "by_code": by_code,
        "clean": not issues,
        "note": "只做结构异常与同批离群；不替代与合同价的逐项核对。",
    }


def _issue(level: str, code: str, row_index: int, row: dict,
           label: str, message: str) -> dict:
    return {
        "level": level, "code": code, "row": row_index,
        "booking_no": row.get("booking_no", ""),
        "fee_name": row.get("fee_name", ""),
        "amount": row.get("amount", ""),
        "message": message,
    }
