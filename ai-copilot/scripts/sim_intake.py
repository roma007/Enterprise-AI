"""资料采集全流程模拟：从档案室到可评测的金标。

目的不是演示功能，而是量出**每一步的损耗和工时**，找出批量采集时的卡点。

流程与要测的问题：
  A. 档案室抽样   → 纸质扫描成什么质量？
  B. 扫描件识别   → 装订阴影/印章/弯曲会掉多少字段？
  C. TMS 导出     → 客户表头/编码千奇百怪，能自动映射多少？
  D. 配对          → 纸质↔TMS 配得上多少？
  E. 抽检标注      → 人工要花多少时间？
  F. 脱敏          → 有没有工具？（当前没有）

用法：PYTHONPATH=. .venv/bin/python scripts/sim_intake.py
"""
from __future__ import annotations

import io
import json
import random
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter  # noqa: E402

from app import ocr  # noqa: E402
from app.csvio import decode_csv_bytes, parse_tms_csv  # noqa: E402
from app.evalrun import load_samples  # noqa: E402
from app.extract import extract  # noqa: E402
from app.pairing import pair  # noqa: E402
from app.rules import fmt  # noqa: E402
from app.schema import FIELD_KEYS, normalize_for_compare  # noqa: E402

FONT_CANDIDATES = (
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
)
check_fields = ("client", "booking_no", "container_type", "container_no",
                "seal_no", "closing_time", "pickup_addr", "delivery_addr")

random.seed(5)


def _font(size: int = 24):
    from PIL import ImageFont
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    raise RuntimeError("找不到可用的中文字体，无法渲染测试页")


# ---------- A. 模拟"档案室扫描件" ----------

def render_page(lines: list[str], w=860, h=1120) -> Image.Image:
    """把托书文字渲染成一页 A4，模拟从档案室扫描出来的效果。"""
    img = Image.new("RGB", (w, h), (252, 251, 248))
    d = ImageDraw.Draw(img)
    font = _font(24)
    y = 90
    for ln in lines:
        d.text((90, y), ln, fill=(25, 25, 30), font=font)
        y += 42
    return img


def degrade(img: Image.Image, mode: str) -> Image.Image:
    """按真实扫描/翻拍的退化方式处理。"""
    if mode == "clean":
        return img

    if "shadow" in mode:
        # 装订阴影：左侧一条由深到浅的竖向暗带
        w, h = img.size
        band = max(1, int(w * 0.16))
        mask = Image.new("L", (w, h), 0)
        md = ImageDraw.Draw(mask)
        for x in range(band):
            md.line([(x, 0), (x, h)], fill=int(150 * (1 - x / band)))
        shade = Image.new("RGB", (w, h), (105, 105, 110))
        img = Image.composite(shade, img, mask)

    if "skew" in mode:
        img = img.rotate(2.5, expand=True, fillcolor=(248, 247, 244))

    if "stamp" in mode:
        # 红色印章压在文字上
        w, h = img.size
        layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        cx, cy, r = int(w * 0.72), int(h * 0.16), 78
        d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=(200, 40, 40, 160), width=4)
        d.text((cx - 40, cy - 10), "已核对", fill=(200, 40, 40, 160), font=_font(18))
        img = Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")

    if "fold" in mode:
        w, h = img.size
        d = ImageDraw.Draw(img)
        d.line([(0, int(h * 0.5)), (w, int(h * 0.5))], fill=(212, 210, 206), width=2)

    if "noise" in mode:
        img = ImageEnhance.Contrast(img).enhance(0.85)
        img = img.filter(ImageFilter.GaussianBlur(0.5))
        px = img.load()
        w, h = img.size
        for _ in range(w * h // 150):
            x, y = random.randrange(w), random.randrange(h)
            v = random.randint(170, 255)
            px[x, y] = (v, v, v)

    return img


def to_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=62)   # 模拟扫描仪默认压缩
    return buf.getvalue()


def text_lines(raw: str) -> list[str]:
    return [ln for ln in raw.splitlines() if ln.strip()]


# ---------- C. 模拟客户 TMS 导出 ----------

def make_tms_csv(samples: list[dict], encoding: str, style: str) -> tuple[bytes, dict]:
    """造一份"客户 TMS 导出"的 CSV，故意制造常见的不规范。"""
    if style == "standard":
        header = "委托单号,客户,箱号,箱型,箱量,封号,截港时间,提箱地,卸货地"
        colmap = {"booking_no": 0, "client": 1, "container_no": 2, "container_type": 3,
                  "container_qty": 4, "seal_no": 5, "closing_time": 6,
                  "pickup_addr": 7, "delivery_addr": 8}
    else:
        # 客户自己的叫法 + 多余列 + 顺序不同
        header = "序号,托书编号,货主,柜型,柜量,箱号,封条,截关,装货地址,送货地址,备注,操作员"
        colmap = {"booking_no": 1, "client": 2, "container_type": 3, "container_qty": 4,
                  "container_no": 5, "seal_no": 6, "closing_time": 7,
                  "pickup_addr": 8, "delivery_addr": 9}

    rows = [header]
    for i, s in enumerate(samples):
        g = s.get("gold", {})
        cells = [""] * len(header.split(","))
        if style != "standard":
            cells[0] = str(i + 1)
            cells[10] = "正常"
            cells[11] = "zhangsan"
        for key, idx in colmap.items():
            cells[idx] = g.get(key, "")
        rows.append(",".join(f'"{c}"' if "," in c else c for c in cells))

    text = "\r\n".join(rows)
    return text.encode(encoding), colmap


# ---------- 主流程 ----------

def main() -> None:
    samples = load_samples(ROOT / "samples" / "bookings.jsonl")[:10]

    print("=" * 70)
    print("A/B. 档案室抽样与扫描识别")
    print("=" * 70)

    modes = [
        ("干净扫描", "clean"),
        ("+装订阴影", "shadow"),
        ("+倾斜2.5°", "shadow,skew"),
        ("+印章遮挡", "shadow,skew,stamp"),
        ("+折痕+噪点+压缩", "shadow,skew,stamp,fold,noise"),
    ]

    results = {}
    t_all = time.time()
    for label, mode in modes:
        ok = tot = 0
        failures: dict[str, int] = {}
        cost = 0.0
        for s in samples:
            img = render_page(text_lines(s["raw"]))
            data = to_bytes(degrade(img, mode))
            t0 = time.time()
            res = ocr.image_to_text(data)
            d = extract(res.text)
            cost += time.time() - t0
            for k in check_fields:
                exp = s.get("gold", {}).get(k, "")
                if not exp:
                    continue
                got = d.fields[k].value or ""
                tot += 1
                if normalize_for_compare(k, got) == normalize_for_compare(k, exp):
                    ok += 1
                else:
                    failures[k] = failures.get(k, 0) + 1
        results[label] = (ok, tot, failures, cost / len(samples))
        top = sorted(failures.items(), key=lambda x: -x[1])[:3]
        print(f"  {label:<16} 字段准确率 {ok/tot:5.1%}   单页耗时 {cost/len(samples):4.1f}s   "
              f"主要丢分: {', '.join(f'{k}×{v}' for k, v in top) or '无'}")

    print(f"\n  → 10 页总耗时 {time.time()-t_all:.0f}s，"
          f"按 400 页推算约 {(time.time()-t_all)/len(samples)*400/60:.0f} 分钟（纯机器时间）")

    print()
    print("=" * 70)
    print("C. 客户 TMS 导出导入")
    print("=" * 70)

    for style, enc, name in [("standard", "utf-8", "标准表头 + UTF-8"),
                             ("customer", "gbk", "客户叫法 + GBK 编码 + 多余列")]:
        data, _ = make_tms_csv(samples, enc, style)
        text, used_enc = decode_csv_bytes(data)
        out = parse_tms_csv(text)
        mapped = len(out["mapped"])
        print(f"  {name:<28} 行数 {out['count']:>3}  识别编码 {used_enc:<10} "
              f"自动映射 {mapped} 列  未识别 {out['unmapped'] or '无'}")
        if out["unmapped"]:
            print(f"    ↳ 需要人工处理的列: {out['unmapped']}")

    print()
    print("=" * 70)
    print("D. 纸质 vs TMS 配对")
    print("=" * 70)

    # 用"最佳扫描质量"的结果去配 TMS
    papers = []
    for i, s in enumerate(samples):
        img = render_page(text_lines(s["raw"]))
        data = to_bytes(degrade(img, "shadow,skew,noise"))
        d = extract(ocr.image_to_text(data).text)
        papers.append({"id": f"P{i:03d}", **{k: (d.fields[k].value or "") for k in FIELD_KEYS}})

    tms_rows = []
    for i, s in enumerate(samples):
        g = {k: s.get("gold", {}).get(k, "") for k in FIELD_KEYS}
        # 模拟 20% 的历史单号不规范
        if random.random() < 0.2 and g.get("booking_no"):
            g["booking_no"] = g["booking_no"][:-1] + str(random.randint(0, 9))
        tms_rows.append({"id": f"T{i:03d}", **g})
    random.shuffle(tms_rows)

    res = pair(papers, tms_rows)
    print(f"  配对成功 {res['matched']}/{res['papers']} ({res['pairing_rate']:.1%})，"
          f"其中自动接受 {res['auto_accept']}，需人工 {res['need_review']}")
    print(f"  配不上的纸质样本: {len(res['unmatched_papers'])} 份 "
          f"→ 这些要么当年没录 TMS，要么录入不规范")
    print(f"  匹配依据: {json.dumps(res['by_reason'], ensure_ascii=False)}")

    print()
    print("=" * 70)
    print("E. 抽检标注的工时估算")
    print("=" * 70)
    per_sample_rules = 12.0     # 一条规则：看原文、判断对错、记录
    per_sample_field = 35.0     # 一条字段级：对照原文逐字段核
    n = 400
    print(f"  400 份样本，两种标注口径：")
    print(f"    单号级粗标（只看单号/箱号对不对）：  {n*per_sample_rules/60:.0f} 分钟 "
          f"≈ {n*per_sample_rules/3600:.1f} 小时")
    print(f"    字段级细标（逐字段核对金标）：        {n*per_sample_field/60:.0f} 分钟 "
          f"≈ {n*per_sample_field/3600:.1f} 小时")
    print(f"    抽检 10%（字段级）：                {n*0.1*per_sample_field/60:.0f} 分钟")

    print()
    print("=" * 70)
    print("F. 脱敏工具是否存在")
    print("=" * 70)
    print("  samples/real/README.md 规定：公司名/手机号/报关单号必须替换")
    print("  现状：**没有脱敏脚本**，全靠人工改 → 400 份不可行")


if __name__ == "__main__":
    main()
