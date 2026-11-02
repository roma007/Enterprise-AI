"""原件存储（A4，同时为 A6 预留）。

为什么必须存：
- 现在 `/api/extract/upload` 解析完就把文件丢了
- 一旦有争议（"我没发过这个箱号"），无法回溯当时系统看到的是什么
- 审计要成立，"原文"必须可复现

存储后端：
- `local`：落 `data/uploads/`（默认，单机够用）
- `s3`：预留接口，等客户环境确定后接（A6）

安全：
- 扩展名白名单，防止有人传 .html/.svg 上来做 XSS
- 读取时校验路径，禁止目录穿越
"""
from __future__ import annotations

import os
import uuid
from datetime import date
from pathlib import Path

from .config import ROOT

BACKEND = os.getenv("STORAGE_BACKEND", "local").strip().lower()
BASE = Path(os.getenv("STORAGE_DIR", str(ROOT / "data" / "uploads")))
ALLOWED_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff",
               ".pdf", ".txt", ".csv", ".xls", ".xlsx"}


def _ext(filename: str) -> str:
    ext = Path(filename or "").suffix.lower()
    return ext if ext in ALLOWED_EXT else ".bin"


def save(data: bytes, filename: str, scope: str = "booking") -> str:
    """存原件，返回相对路径（用于写库与回读）。"""
    day = date.today().strftime("%Y%m%d")
    rel = f"{scope}/{day}/{uuid.uuid4().hex[:16]}{_ext(filename)}"
    target = BASE / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return rel


def resolve(rel: str) -> Path | None:
    """把相对路径还原成绝对路径，并确保没有跳出存储目录。"""
    if not rel:
        return None
    base = BASE.resolve()
    try:
        p = (base / rel).resolve()
    except OSError:
        return None
    if not str(p).startswith(str(base)):
        return None
    return p if p.exists() else None


def info(rel: str) -> dict:
    p = resolve(rel)
    if not p:
        return {"exists": False, "path": rel}
    st = p.stat()
    return {"exists": True, "path": rel, "size": st.st_size,
            "modified": date.fromtimestamp(st.st_mtime).isoformat()}


def usage() -> dict:
    """粗略统计占用，给运维看。"""
    if not BASE.exists():
        return {"files": 0, "bytes": 0}
    files = 0
    total = 0
    for p in BASE.rglob("*"):
        if p.is_file():
            files += 1
            total += p.stat().st_size
    return {"files": files, "bytes": total, "dir": str(BASE)}
