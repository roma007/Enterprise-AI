#!/usr/bin/env python3
"""生成试点一的 OCR 测试图片/PDF（从原始文本样本渲染）。

用法（仓库根目录，使用 ai-copilot 的虚拟环境）：
  ai-copilot/.venv/bin/python ai-copilot/scripts/make_pilot_ocr_fixtures.py

输出：
  会客包/试点一/samples/statement_ocr.png
  会客包/试点一/samples/settlement_ocr.png
  会客包/试点一/samples/statement_ocr.pdf

依赖：Pillow。需要系统里有中文字体；脚本会尝试常见路径。
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
SAMPLES = ROOT / "会客包" / "试点一" / "samples"

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
]


def pick_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    raise SystemExit(
        "未找到中文字体；请安装 Noto Sans CJK 或在 FONT_CANDIDATES 中补充路径"
    )


def render(text_path: Path, out_png: Path, column_spaces: int, size: int = 24) -> Image.Image:
    lines = text_path.read_text(encoding="utf-8").splitlines()
    rendered = [line.replace("\t", " " * column_spaces) for line in lines]
    font = pick_font(size)
    probe = Image.new("RGB", (10, 10), "white")
    draw = ImageDraw.Draw(probe)
    width = max(draw.textbbox((0, 0), line, font=font)[2] for line in rendered if line.strip()) + 100
    height = max(220, (len(rendered) + 2) * (size + 20))
    img = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(img)
    y = 30
    for line in rendered:
        draw.text((40, y), line, fill="black", font=font)
        y += size + 20
    img.save(out_png)
    return img


def main() -> int:
    SAMPLES.mkdir(parents=True, exist_ok=True)
    statement_png = SAMPLES / "statement_ocr.png"
    settlement_png = SAMPLES / "settlement_ocr.png"

    statement = render(SAMPLES / "statement_raw.example.txt", statement_png, column_spaces=4)
    render(SAMPLES / "settlement_raw.example.txt", settlement_png, column_spaces=8)
    statement.save(SAMPLES / "statement_ocr.pdf", "PDF", resolution=150)

    print(f"已生成：{statement_png}")
    print(f"已生成：{settlement_png}")
    print(f"已生成：{SAMPLES / 'statement_ocr.pdf'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
