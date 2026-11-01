"""图片 / PDF 托书识别。

为什么独立成模块：
1. OCR 依赖较重（onnxruntime + 模型），必须**可选**——没装也要能跑文本演示
2. PDF 有两条路：能取文本层就取文本层（快且准），取不到才走 OCR
3. 识别结果要与手打文本走完全相同的抽取管线，不搞第二套逻辑

依赖：pillow、pymupdf、rapidocr-onnxruntime（三者都缺失时自动降级为不可用）
"""
from __future__ import annotations

import io
import re
from dataclasses import dataclass

from .config import settings


class OcrUnavailable(RuntimeError):
    """OCR 依赖未安装。上层应提示用户改用粘贴文本。"""


@dataclass
class OcrResult:
    text: str
    pages: int = 1
    used_ocr: bool = False
    note: str = ""


_engine = None


def available() -> dict:
    """探测依赖是否齐备，供 /api/health 与 UI 使用。"""
    status = {"pil": False, "pymupdf": False, "rapidocr": False}
    try:
        import PIL  # noqa: F401
        status["pil"] = True
    except ImportError:
        pass
    try:
        import pymupdf  # noqa: F401  (PyMuPDF >= 2.0)
        status["pymupdf"] = True
    except ImportError:
        try:
            import fitz  # noqa: F401  (旧版别名)
            status["pymupdf"] = True
        except ImportError:
            pass
    try:
        import rapidocr_onnxruntime  # noqa: F401
        status["rapidocr"] = True
    except ImportError:
        pass
    status["ready"] = all(status.values())
    return status


def _get_engine():
    global _engine
    if _engine is None:
        try:
            from rapidocr_onnxruntime import RapidOCR
        except ImportError as exc:  # pragma: no cover - 环境相关
            raise OcrUnavailable("未安装 rapidocr-onnxruntime") from exc
        _engine = RapidOCR()
    return _engine


def _rule_score(text: str) -> tuple[int, int]:
    """用领域规则给一段 OCR 文本打分，作为多版本裁决依据。

    为什么要用规则而不是"字数多少"：
    字数多不等于对。一段把"截港"认成"藏港"的文本可能更长，但一个字段都抽不出来。
    规则能直接判断"有没有抓到合法箱号、能不能解析出时间"，这才是我们要的东西。
    """
    try:
        from .extract import extract_by_rules
        from .rules import container_is_valid, parse_datetime
    except Exception:
        return 0, len(text)

    f = extract_by_rules(text)
    score = sum(1 for v in f.values() if v.value)

    c = f.get("container_no")
    if c and c.value:
        items = [x for x in re.split(r"[,，、;；\s]+", c.value) if x]
        if items and all(container_is_valid(x) for x in items):
            score += 3          # 箱号全过校验位，强证据

    t = f.get("closing_time")
    if t and t.value and parse_datetime(t.value):
        score += 2

    if f.get("factory_phone") and f["factory_phone"].value:
        score += 1

    return score, len(text)


def _layout(items: list, y_tol: float = 14.0) -> str:
    """把 OCR 的散乱文本框还原成阅读顺序。

    托书里"客户"和"宏远国际货代"经常是两个框，按 y 聚行、行内按 x 排序，
    才能还原成 "客户 宏远国际货代"，否则键值对全部错位。
    """
    boxes = []
    for item in items:
        box, text = item[0], item[1]
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        boxes.append({
            "x": min(xs), "y": sum(ys) / len(ys),
            "h": max(ys) - min(ys), "text": text,
        })
    if not boxes:
        return ""

    boxes.sort(key=lambda b: b["y"])
    lines: list[list[dict]] = [[boxes[0]]]
    for b in boxes[1:]:
        cur = lines[-1]
        center = sum(x["y"] for x in cur) / len(cur)
        if abs(b["y"] - center) <= max(y_tol, b["h"] * 0.6):
            cur.append(b)
        else:
            lines.append([b])

    out = []
    for line in lines:
        line.sort(key=lambda b: b["x"])
        out.append("  ".join(b["text"].strip() for b in line if b["text"].strip()))
    return "\n".join(out)


def image_to_text(data: bytes) -> OcrResult:
    try:
        import numpy as np
        from PIL import Image
    except ImportError as exc:
        raise OcrUnavailable("未安装 pillow / numpy") from exc

    engine = _get_engine()

    # D2：多版本 OCR。歪的、暗的、糊的图，单跑一遍掉字很厉害。
    # 各版本各跑一遍，按（识别字数, 平均置信度）挑最好的。
    best_text, best_score, best_tag, boxes = "", -1.0, "原图", 0
    base_score: float | None = None
    candidates = [("原图", data)]
    if settings.ocr_enhance:
        try:
            from .enhance import variants
            candidates = variants(data)
        except Exception:
            pass

    for tag, payload in candidates:
        try:
            img = Image.open(io.BytesIO(payload)).convert("RGB")
            result, _ = engine(np.array(img))
        except Exception:
            continue
        text = _layout(result or [])
        # 用领域规则裁决，而不是"谁字数多"
        rule_score, length = _rule_score(text)
        score = rule_score * 1000 + length
        if tag == "原图":
            base_score = score
        if score > best_score:
            best_text, best_score, best_tag, boxes = text, score, tag, len(result or [])

    # 保守策略：除非增强版本有**明显更好**的规则得分（+2 及以上），否则用原图。
    # 这条保证"多版本永远不会比单跑原图更差"——现场最怕的是越处理越糟。
    if (best_tag != "原图" and base_score is not None and best_score < base_score + 2000):
        for tag, payload in candidates:
            if tag != "原图":
                continue
            try:
                img = Image.open(io.BytesIO(payload)).convert("RGB")
                result, _ = engine(np.array(img))
                best_text = _layout(result or [])
                best_tag, boxes = "原图", len(result or [])
            except Exception:
                pass
            break

    return OcrResult(text=best_text, used_ocr=True,
                     note=f"OCR {boxes} 框 · 采用{best_tag}")


def pdf_to_text(data: bytes, max_pages: int = 5) -> OcrResult:
    try:
        import pymupdf as fitz
    except ImportError:
        try:
            import fitz  # 旧版 PyMuPDF
        except ImportError as exc:
            raise OcrUnavailable("未安装 pymupdf") from exc

    doc = fitz.open(stream=data, filetype="pdf")
    pages = min(len(doc), max_pages)
    chunks: list[str] = []
    used_ocr = False

    for i in range(pages):
        page = doc[i]
        text = page.get_text("text").strip()
        if len(text) >= 20:          # 有文本层，直接用（更快更准）
            chunks.append(text)
            continue
        used_ocr = True
        pix = page.get_pixmap(dpi=200)
        chunks.append(image_to_text(pix.tobytes("png")).text)

    doc.close()
    note = f"PDF {pages} 页，{'含 OCR' if used_ocr else '文本层直读'}"
    return OcrResult(text="\n".join(c for c in chunks if c), pages=pages,
                     used_ocr=used_ocr, note=note)


TEXT_EXT = {".txt", ".md", ".csv", ".json", ".eml"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}


def extract(filename: str, data: bytes) -> OcrResult:
    """按文件类型选择解析方式。"""
    name = (filename or "").lower()
    ext = "." + name.rsplit(".", 1)[-1] if "." in name else ""

    if ext in TEXT_EXT:
        return OcrResult(text=data.decode("utf-8", errors="ignore"), note="文本直读")
    if ext in IMAGE_EXT:
        return image_to_text(data)
    if ext == ".pdf":
        return pdf_to_text(data)
    # 未知类型：先当图片试，再当文本试
    try:
        return image_to_text(data)
    except Exception:
        return OcrResult(text=data.decode("utf-8", errors="ignore"), note="按文本兜底解析")
