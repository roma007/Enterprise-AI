"""图像增强对比演示（D2）。

做法：拿一张干净的托书截图，人为弄"脏"（旋转 + 压对比度 + 加噪点），
再比较"关掉增强"和"开启增强"的识别效果。差异会直接体现在字段准确率上。

用法：PYTHONPATH=. .venv/bin/python scripts/demo_enhance.py
"""
from __future__ import annotations

import io
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from PIL import Image, ImageEnhance, ImageFilter  # noqa: E402

from app import ocr  # noqa: E402
from app.config import settings  # noqa: E402
from app.extract import extract  # noqa: E402

SRC = ROOT / "samples" / "fixtures" / "booking_sample.png"
random.seed(3)

EXPECT = {
    "client": "宏远国际货代",
    "booking_no": "HY2026110501",
    "container_no": "CSQU3054383",
    "seal_no": "SL8823101",
    "closing_time": "2026-11-07 18:00",
}


def degrade(data: bytes) -> bytes:
    img = Image.open(io.BytesIO(data)).convert("RGB")

    # 1) 整体缩小，模拟微信压缩
    img = img.resize((int(img.width * 0.55), int(img.height * 0.55)), Image.LANCZOS)
    # 2) 旋转 8 度（手抖/斜拍）
    img = img.rotate(8.0, expand=True, fillcolor=(230, 230, 230))
    # 3) 压对比度 + 压暗（逆光）
    img = ImageEnhance.Contrast(img).enhance(0.35)
    img = ImageEnhance.Brightness(img).enhance(0.75)
    # 4) 模糊
    img = img.filter(ImageFilter.GaussianBlur(1.2))

    # 5) 撒噪点，模拟手机拍照的传感器噪声
    px = img.load()
    w, h = img.size
    for _ in range(w * h // 25):
        x, y = random.randrange(w), random.randrange(h)
        v = random.randint(0, 255)
        px[x, y] = (v, v, v)

    # 6) 低质量 JPEG 再存一次，压出块效应
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=35)
    return buf.getvalue()


def run(data: bytes, enhance: bool) -> tuple[dict, str]:
    settings.ocr_enhance = enhance
    res = ocr.image_to_text(data)
    draft = extract(res.text)
    got = {k: (draft.fields[k].value or "") for k in EXPECT}
    return got, res.note


def main() -> None:
    raw = SRC.read_bytes()
    dirty = degrade(raw)
    (ROOT / "samples" / "fixtures" / "booking_degraded.png").write_bytes(dirty)

    print("对照：同一张被弄脏的托书（旋转 4°、对比度 0.55、模糊 + 噪点）\n")
    for enhance, label in ((False, "关闭增强"), (True, "开启增强")):
        got, note = run(dirty, enhance)
        ok = sum(1 for k, v in EXPECT.items() if got[k] == v)
        print(f"[{label}] {note}")
        for k, v in EXPECT.items():
            mark = "✓" if got[k] == v else "✗"
            print(f"   {mark} {k:<14} 期望 {v!r}  实得 {got[k]!r}")
        print(f"   → 关键字段 {ok}/{len(EXPECT)}\n")

    settings.ocr_enhance = True


if __name__ == "__main__":
    main()
