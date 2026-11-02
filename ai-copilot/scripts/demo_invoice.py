"""发票识别演示（04b）：同一底座，换 schema。

做三件事：
1. 渲染 3 张"发票照片"（干净 / 倾斜+阴影 / 带印章）
2. 走 OCR → 规则+模型抽取
3. 报字段准确率与分级结果

用法：PYTHONPATH=. .venv/bin/python scripts/demo_invoice.py
"""
from __future__ import annotations

import io
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont  # noqa: E402

from app import ocr  # noqa: E402
from app.invoice import extract_invoice  # noqa: E402

FONT_CANDIDATES = (
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
)

INVOICE = {
    "invoice_no": "12345678",
    "invoice_date": "2026-10-28",
    "buyer_name": "宁波宏运集卡运输有限公司",
    "buyer_tax_id": "9133020662M3QQRL4D",
    "seller_name": "宁波北仑中石化加油站",
    "seller_tax_id": "91330200TF3NLDC9HT",
    "amount": "1234.56",
    "tax_rate": "0.13",
    "tax_amount": "160.49",
    "total_amount": "1395.05",
}

LINES = [
    "增值税专用发票",
    "",
    "发票代码：033002100311",
    "发票号码：12345678",
    "开票日期：2026-10-28",
    "",
    "购买方名称：宁波宏运集卡运输有限公司",
    "纳税人识别号：9133020662M3QQRL4D",
    "",
    "销售方名称：宁波北仑中石化加油站",
    "纳税人识别号：91330200TF3NLDC9HT",
    "",
    "货物或应税劳务：0# 柴油",
    "金额：1234.56",
    "税率：13%",
    "税额：160.49",
    "价税合计：1395.05",
    "校验码：12345678901234567890",
]


def _font(size=22):
    for p in FONT_CANDIDATES:
        if Path(p).exists():
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                continue
    raise RuntimeError("找不到中文字体")


def render(mode: str) -> bytes:
    w, h = 820, 900
    img = Image.new("RGB", (w, h), (252, 251, 248))
    d = ImageDraw.Draw(img)
    f = _font(22)
    y = 70
    for ln in LINES:
        if ln:
            d.text((70, y), ln, fill=(30, 30, 35), font=f)
        y += 40

    if mode in ("skew", "stamp"):
        img = img.rotate(2.0, expand=True, fillcolor=(247, 246, 243))
        w, h = img.size
        mask = Image.new("L", (w, h), 0)
        md = ImageDraw.Draw(mask)
        band = int(w * 0.12)
        for x in range(band):
            md.line([(x, 0), (x, h)], fill=int(140 * (1 - x / band)))
        img = Image.composite(Image.new("RGB", (w, h), (110, 110, 115)), img, mask)

    if mode == "stamp":
        w, h = img.size
        layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        dd = ImageDraw.Draw(layer)
        cx, cy, r = int(w * 0.7), int(h * 0.18), 70
        dd.ellipse((cx - r, cy - r, cx + r, cy + r), outline=(200, 40, 40, 150), width=4)
        dd.text((cx - 36, cy - 10), "已认证", fill=(200, 40, 40, 150), font=_font(16))
        img = Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")

    if mode != "clean":
        img = ImageEnhance.Contrast(img).enhance(0.85)
        img = img.filter(ImageFilter.GaussianBlur(0.4))
        px = img.load()
        w, h = img.size
        for _ in range(w * h // 200):
            x, y = random.randrange(w), random.randrange(h)
            v = random.randint(170, 255)
            px[x, y] = (v, v, v)

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=65)
    return buf.getvalue()


def main() -> None:
    print("字段级比对（10 个关键字段）\n")
    for mode, label in (("clean", "干净扫描"), ("skew", "倾斜+阴影"), ("stamp", "带印章")):
        data = render(mode)
        res = ocr.image_to_text(data)
        draft = extract_invoice(res.text, allow_llm=False)
        ok = 0
        miss = []
        for k, exp in INVOICE.items():
            got = (draft.fields[k].value or "") if k in draft.fields else ""
            if k == "tax_rate":
                a = got.replace("%", "") or "0"
                try:
                    same = abs(float(a) - float(exp)) < 1e-6 or abs(float(a) / 100 - float(exp)) < 1e-6
                except ValueError:
                    same = False
            else:
                same = got.replace(",", "") == exp
            if same:
                ok += 1
            else:
                miss.append(f"{k}({got!r})")
        print(f"[{label}] 关键字段 {ok}/{len(INVOICE)}  等级 {draft.review_level}")
        if miss:
            print("   未命中:", ", ".join(miss))
        print("   OCR:", res.note)


if __name__ == "__main__":
    main()
