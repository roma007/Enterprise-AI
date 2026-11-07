"""原件存储（A4 留存 + A6 对象存储抽象）。

为什么必须存：
- 上传解析完就把文件丢了，一旦有争议（"我没发过这个箱号"），
  无法回溯当时系统看到的是什么
- 审计要成立，"原文"必须可复现

两种后端，同一套接口：
- `local`（默认）：落 `data/uploads/`，单机部署够用
- `s3`：AWS S3 / MinIO / 阿里云 OSS / 腾讯云 COS 等 S3 兼容存储，
  多实例、扩缩容、集中备份时用

为什么 S3 用可选依赖：
- boto3 约 10MB，单机客户用不上，不该强制安装
- `STORAGE_BACKEND=s3` 但没装 boto3 时，报明确的错并告诉怎么装，
  而不是启动成功、上传时才 500

安全：
- 扩展名白名单，防止有人传 .html/.svg 上来做 XSS
- local 读取校验路径前缀，禁止目录穿越
- S3 的 key 由服务端生成（scope/日期/随机名），不接受用户传入
"""
from __future__ import annotations

import mimetypes
import os
import uuid
from datetime import date
from pathlib import Path

from .config import ROOT

BACKEND = os.getenv("STORAGE_BACKEND", "local").strip().lower()
BASE = Path(os.getenv("STORAGE_DIR", str(ROOT / "data" / "uploads")))
ALLOWED_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff",
               ".pdf", ".txt", ".csv", ".xls", ".xlsx"}

# S3 配置（仅在 BACKEND=s3 时使用）
S3_BUCKET = os.getenv("S3_BUCKET", "").strip()
S3_PREFIX = os.getenv("S3_PREFIX", "uploads/").strip().lstrip("/")
S3_ENDPOINT = os.getenv("S3_ENDPOINT_URL", "").strip()
S3_REGION = os.getenv("S3_REGION", "us-east-1").strip()
S3_PRESIGN = int(os.getenv("S3_PRESIGN_SECONDS", "300"))


class StorageError(RuntimeError):
    """存储后端不可用（配置错/缺依赖），由 API 层转成明确提示。"""


def _ext(filename: str) -> str:
    ext = Path(filename or "").suffix.lower()
    return ext if ext in ALLOWED_EXT else ".bin"


def _key(rel: str) -> str:
    return f"{S3_PREFIX}{rel}" if S3_PREFIX else rel


def _rel_from_key(key: str) -> str:
    return key[len(S3_PREFIX):] if S3_PREFIX and key.startswith(S3_PREFIX) else key


def _media_type(rel: str, fallback: str = "application/octet-stream") -> str:
    return mimetypes.guess_type(rel)[0] or fallback


# ---------------- local ----------------

def _local_save(data: bytes, rel: str) -> None:
    target = BASE / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)


def _local_path(rel: str) -> Path | None:
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


# ---------------- s3 ----------------

_s3_client = None


def _s3():
    """惰性创建客户端。缺 boto3 或配置时抛 StorageError，附修复方法。"""
    global _s3_client
    if _s3_client is not None:
        return _s3_client
    if not S3_BUCKET:
        raise StorageError("STORAGE_BACKEND=s3 但未配置 S3_BUCKET")
    try:
        import boto3  # noqa: PLC0415
    except ImportError as exc:
        raise StorageError(
            "使用 S3 存储需先安装 boto3：pip install boto3"
        ) from exc
    kwargs = {"region_name": S3_REGION}
    if S3_ENDPOINT:
        kwargs["endpoint_url"] = S3_ENDPOINT
    _s3_client = boto3.client("s3", **kwargs)
    return _s3_client


def _s3_save(data: bytes, rel: str) -> None:
    _s3().put_object(
        Bucket=S3_BUCKET,
        Key=_key(rel),
        Body=data,
        ContentType=_media_type(rel),
    )


# ---------------- 对外接口 ----------------

def save(data: bytes, filename: str, scope: str = "booking") -> str:
    """存原件，返回相对路径（写库与回读都用它，换后端不用改数据）。"""
    day = date.today().strftime("%Y%m%d")
    rel = f"{scope}/{day}/{uuid.uuid4().hex[:16]}{_ext(filename)}"
    if BACKEND == "s3":
        _s3_save(data, rel)
    else:
        _local_save(data, rel)
    return rel


def resolve(rel: str) -> Path | None:
    """local 后端的绝对路径；s3 后端永远返回 None。

    保留这个函数是为了兼容既有调用，新代码请用 `open_for_read()`。
    """
    if BACKEND == "s3":
        return None
    return _local_path(rel)


def open_for_read(rel: str):
    """回读原件。

    - local：返回 Path，交给 FileResponse（支持 Range / 断点续传）
    - s3：返回 (bytes, media_type)，由 API 层直接返回
    - 不存在：返回 None
    """
    if not rel or ".." in rel.split("/"):
        return None
    if BACKEND == "s3":
        try:
            obj = _s3().get_object(Bucket=S3_BUCKET, Key=_key(rel))
            return obj["Body"].read(), _media_type(rel)
        except StorageError:
            raise
        except Exception:  # noqa: BLE001 — 不存在/无权限都当 404，不向调用方泄露细节
            return None
    p = _local_path(rel)
    return p


def delete(rel: str) -> bool:
    """删除原件（本地或 S3）。不存在也算成功，方便清理任务幂等。"""
    if not rel or ".." in rel.split("/"):
        return False
    if BACKEND == "s3":
        try:
            _s3().delete_object(Bucket=S3_BUCKET, Key=_key(rel))
            return True
        except Exception:  # noqa: BLE001 — 删除失败不阻断调用方
            return False
    path = _local_path(rel)
    if path and path.exists():
        path.unlink()
    return True


def info(rel: str) -> dict:
    if not rel:
        return {"exists": False, "path": rel}
    if BACKEND == "s3":
        try:
            head = _s3().head_object(Bucket=S3_BUCKET, Key=_key(rel))
            return {"exists": True, "path": rel, "size": head.get("ContentLength", 0),
                    "modified": str(head.get("LastModified", ""))}
        except StorageError:
            raise
        except Exception:  # noqa: BLE001
            return {"exists": False, "path": rel}
    p = _local_path(rel)
    if not p:
        return {"exists": False, "path": rel}
    st = p.stat()
    return {"exists": True, "path": rel, "size": st.st_size,
            "modified": date.fromtimestamp(st.st_mtime).isoformat()}


def usage() -> dict:
    """粗略统计占用，给运维看。S3 只统计当前前缀下的对象。"""
    if BACKEND == "s3":
        client = _s3()
        files = 0
        total = 0
        token = None
        while True:
            kwargs = {"Bucket": S3_BUCKET, "Prefix": S3_PREFIX or "", "MaxKeys": 1000}
            if token:
                kwargs["ContinuationToken"] = token
            res = client.list_objects_v2(**kwargs)
            for obj in res.get("Contents", []):
                files += 1
                total += int(obj.get("Size", 0))
            if not res.get("IsTruncated"):
                break
            token = res.get("NextContinuationToken")
        return {"backend": "s3", "files": files, "bytes": total,
                "bucket": S3_BUCKET, "prefix": S3_PREFIX}

    if not BASE.exists():
        return {"backend": "local", "files": 0, "bytes": 0, "dir": str(BASE)}
    files = 0
    total = 0
    for p in BASE.rglob("*"):
        if p.is_file():
            files += 1
            total += p.stat().st_size
    return {"backend": "local", "files": files, "bytes": total, "dir": str(BASE)}


def health() -> dict:
    """给运维页/启动自检用：当前后端是否真的可用。"""
    if BACKEND == "s3":
        try:
            _s3().head_bucket(Bucket=S3_BUCKET)
            return {"backend": "s3", "ok": True, "bucket": S3_BUCKET}
        except Exception as exc:  # noqa: BLE001
            return {"backend": "s3", "ok": False, "bucket": S3_BUCKET, "error": str(exc)}
    return {"backend": "local", "ok": True, "dir": str(BASE),
            "exists": BASE.exists()}
