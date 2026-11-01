"""图像增强（D2）。

现实里的托书照片：歪的、暗的、有阴影、有噪点、被压过。
直接丢给 OCR，掉字很厉害。

这里做三件事，都是无模型、纯图像的，跑在本地、不花钱：
1. 纠偏（deskew）——按"文字行投影方差最大"找最佳角度
2. 对比度增强 + 自适应二值化
3. 多版本 OCR —— 原图 / 增强图 / 二值图 各跑一遍，取最好的

不做的事（写明，别假装）：
- 不做透视矫正（需要四点定位，属于文档检测范畴）
- 不做去水印
- 不做超分辨率
"""
from __future__ import annotations

import io

MAX_SIDE = 2000  # 太大的图先缩，OCR 会快很多


def _pil(data: bytes):
    from PIL import Image
    img = Image.open(io.BytesIO(data))
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    if max(img.size) > MAX_SIDE:
        ratio = MAX_SIDE / max(img.size)
        img = img.resize((int(img.width * ratio), int(img.height * ratio)))
    return img


def deskew(img, max_angle: int = 6):
    """按文字行投影方差找倾斜角并纠正。无需 OpenCV。"""
    try:
        import numpy as np
    except ImportError:
        return img

    best_angle, best_score = 0.0, -1.0
    for angle in range(-max_angle, max_angle + 1):
        rotated = img.rotate(angle, expand=True, fillcolor=255).convert("L")
        arr = np.asarray(rotated)
        row_dark = (arr < 128).sum(axis=1).astype(float)
        score = float(row_dark.var())
        if score > best_score:
            best_angle, best_score = float(angle), score
    if best_angle == 0:
        return img
    return img.rotate(best_angle, expand=True, fillcolor=255)


def enhance(img):
    """去噪 → 自动对比 → 轻度锐化。

    注意：不要一上来就拉对比度。噪点会被一起放大，
    所以先中值滤波去椒盐噪声，再提对比。
    """
    from PIL import ImageEnhance, ImageFilter, ImageOps

    g = ImageOps.grayscale(img)
    g = g.filter(ImageFilter.MedianFilter(size=3))   # 先去噪
    g = ImageOps.autocontrast(g, cutoff=2)
    g = ImageEnhance.Contrast(g).enhance(1.25)       # 温和提对比
    return g.filter(ImageFilter.UnsharpMask(radius=1, percent=120, threshold=3))


def _otsu_threshold(arr) -> float:
    """Otsu 阈值：比"均值-k*标准差"稳，不会被大片背景带偏。"""
    import numpy as np
    hist, _ = np.histogram(arr, bins=256, range=(0, 256))
    total = arr.size
    sum_all = float((np.arange(256) * hist).sum())
    sum_b = 0.0
    w_b = 0.0
    best_t, best_var = 128.0, -1.0
    for t in range(256):
        w_b += hist[t]
        if w_b == 0:
            continue
        w_f = total - w_b
        if w_f == 0:
            break
        sum_b += t * hist[t]
        m_b = sum_b / w_b
        m_f = (sum_all - sum_b) / w_f
        var = w_b * w_f * (m_b - m_f) ** 2
        if var > best_var:
            best_var, best_t = var, float(t)
    return best_t


def binarize(img, k: float = 0.0):
    """Otsu 二值化。作为候选之一，不强制使用。"""
    try:
        import numpy as np
        from PIL import Image
    except ImportError:
        return img
    arr = np.asarray(img.convert("L"))
    thr = _otsu_threshold(arr) + k
    out = np.where(arr < thr, 0, 255).astype("uint8")
    return Image.fromarray(out)


def variants(data: bytes) -> list[tuple[str, bytes]]:
    """产出若干候选图，供多版本 OCR 投票。"""
    out: list[tuple[str, bytes]] = [("原图", data)]
    try:
        img = _pil(data)
    except Exception:
        return out

    try:
        fixed = deskew(img)
        out.append(("纠偏", _to_png(fixed)))
        enhanced = enhance(fixed)
        out.append(("增强", _to_png(enhanced)))
        out.append(("二值", _to_png(binarize(enhanced))))
    except Exception:
        pass
    return out


def _to_png(img) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
