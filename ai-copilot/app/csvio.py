"""CSV 导入导出（D13）。

客户没有系统、不给接口时，CSV 是唯一能走通的通道：
- 导出：把确认后的单据导成标准列，客户自己导进 TMS / Excel
- 导入：把客户 TMS 导出的历史记录读进来，用于 D4 配对与 D6 评测

列名必须是"客户怎么叫就认什么"，不能要求客户改表头。
"""
from __future__ import annotations

import csv
import io

from .schema import FIELD_KEYS, LABELS

# 客户表头 → 标准字段。顺序即优先级（先精确匹配，再包含匹配）
HEADER_ALIASES: dict[str, tuple[str, ...]] = {
    "booking_no": ("委托单号", "托书号", "托书编号", "订单号", "单号", "booking", "booking_no", "order_no"),
    "client": ("客户名称", "客户", "货主", "货代", "委托单位", "委托方", "client", "shipper"),
    "container_no": ("箱号", "集装箱号", "柜号", "柜编码", "container", "container_no", "cntr"),
    "container_type": ("箱型", "柜型", "箱形", "柜别", "container_type", "type"),
    "container_qty": ("箱量", "箱数", "柜量", "数量", "qty", "quantity"),
    "seal_no": ("封号", "铅封号", "封条", "封条号", "seal", "seal_no"),
    "closing_time": ("截港时间", "截关时间", "截港", "截关", "cutoff", "cut_off"),
    "loading_window": ("装柜时间", "装货时间", "装柜", "loading"),
    "pickup_addr": ("提箱地", "提箱地址", "装货地", "提空箱点", "pickup"),
    "delivery_addr": ("卸货地", "送货地", "卸货地址", "送货地址", "目的地", "delivery"),
    "vessel_voyage": ("船名航次", "船名", "航次", "vessel", "voyage"),
    "cargo_desc": ("品名", "货物", "货物描述", "cargo", "commodity"),
    "gross_weight": ("毛重", "重量", "gw", "gross_weight"),
    "freight": ("运费", "报价", "价格", "freight", "rate"),
    "factory_contact": ("联系人", "工厂联系人", "contact"),
    "factory_phone": ("联系电话", "电话", "手机", "phone", "tel"),
    "remark": ("备注", "要求", "remark", "note"),
}


def _map_header(name: str) -> str | None:
    n = (name or "").strip().lower().replace(" ", "").replace("_", "")
    for key, aliases in HEADER_ALIASES.items():
        for a in aliases:
            if n == a.lower().replace(" ", "").replace("_", ""):
                return key
    for key, aliases in HEADER_ALIASES.items():
        for a in aliases:
            if a.lower().replace(" ", "").replace("_", "") in n:
                return key
    return None


def decode_csv_bytes(data: bytes) -> tuple[str, str]:
    """CSV 编码探测：必须用 strict 解码判断，不能用 errors='ignore'。

    踩过的坑：`data.decode('utf-8', errors='ignore') or data.decode('gbk')`
    这种写法在 GBK 文件上会返回一串乱码（非空），导致永远不会回退到 GBK。
    """
    for enc in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return data.decode(enc), enc
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="ignore"), "utf-8(ignore)"


def parse_tms_csv(text: str) -> dict:
    """读客户 TMS 导出的 CSV，返回可配对的记录。"""
    text = text.lstrip("\ufeff")
    # 自动嗅探分隔符（逗号 / 制表符 / 分号）
    sample = text[:2000]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",\t;")
    except csv.Error:
        dialect = csv.excel

    reader = csv.reader(io.StringIO(text), dialect)
    rows = list(reader)
    if not rows:
        return {"rows": [], "count": 0, "mapped": {}, "unmapped": []}

    header = rows[0]
    mapping: dict[int, str] = {}
    unmapped: list[str] = []
    for idx, col in enumerate(header):
        key = _map_header(col)
        if key and key not in mapping.values():
            mapping[idx] = key
        elif col.strip():
            unmapped.append(col.strip())

    out = []
    for i, r in enumerate(rows[1:]):
        if not any(c.strip() for c in r):
            continue
        rec = {"id": f"T{i:04d}"}
        for idx, key in mapping.items():
            rec[key] = r[idx].strip() if idx < len(r) else ""
        out.append(rec)

    return {
        "rows": out,
        "count": len(out),
        "mapped": {v: header[k] for k, v in mapping.items()},
        "unmapped": unmapped,
    }


def export_csv(tickets: list[dict]) -> str:
    """把确认后的单据导成标准列（表头用中文，客户能直接用）。"""
    cols = list(FIELD_KEYS)
    buf = io.StringIO()
    buf.write("\ufeff")  # Excel 打开不乱码
    w = csv.writer(buf)
    w.writerow([LABELS[c] for c in cols])
    for t in tickets:
        w.writerow([(t.get(c) or "") for c in cols])
    return buf.getvalue()
