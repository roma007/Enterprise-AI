"""生成一张"托书截图"测试图，用于验证 OCR 全链路。

用途：在拿不到真实客户截图前，先用可控图片验证
     读图 → OCR → 抽取 → 规则校验 这条路是通的。
注意：合成图不能代表真实照片（光照、倾斜、水印、压缩都不同），
     OCR 准确率必须用真实截图重测。

用法：PYTHONPATH=. .venv/bin/python scripts/make_test_image.py
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "samples" / "fixtures"
FONT_CANDIDATES = (
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
)

LINES = [
    "拖车委托单",
    "",
    "客户：宏远国际货代",
    "委托单号：HY2026110501",
    "箱型：40HQ    箱量：1",
    "箱号：CSQU3054383",
    "封号：SL8823101",
    "提箱地：北仑港区二期堆场",
    "卸货地：宁波北仑春晓工业园3号仓",
    "联系人：王主管   电话：13800001234",
    "装柜时间：2026-11-06 08:00",
    "截港时间：2026-11-07 18:00",
    "船名航次：COSCO SHIPPING ARIES / 042E",
    "品名：家用电器    毛重：18600",
    "运费：2600",
    "备注：需报关，周五前必须进港",
]


def _font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    font = _font(26)
    line_h = 44
    width, height = 900, 60 + line_h * len(LINES)
    img = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(img)

    y = 30
    for line in LINES:
        if line:
            draw.text((50, y), line, fill=(20, 20, 20), font=font)
        y += line_h

    path = OUT / "booking_sample.png"
    img.save(path)
    print(f"saved {path}  {width}x{height}")


if __name__ == "__main__":
    main()
