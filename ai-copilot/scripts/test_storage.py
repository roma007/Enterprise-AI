"""A6 存储后端自检：local / s3 两条路径都要能跑通。

用法：
    PYTHONPATH=. .venv/bin/python scripts/test_storage.py

S3 部分不连真实对象存储，用一个内存假客户端替换 boto3，
验证的是**我们的调用方式**（key 前缀、ContentType、读回、分页统计），
真实连通性等客户环境确定后用 `GET /api/storage` 的 health 字段确认。
"""
from __future__ import annotations

import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import storage  # noqa: E402

ok = True


def chk(name: str, cond: bool, extra: str = "") -> None:
    global ok
    print(f"  {'✓' if cond else '✗'} {name}{('  ' + extra) if extra else ''}")
    ok = ok and cond


# ---------------- local ----------------
print("local 后端")
rel = storage.save(b"hello-booking", "托书.PNG", "booking")
chk("扩展名归一（大写 PNG → 小写）", rel.endswith(".png"), rel)
chk("路径含 scope/日期", rel.startswith("booking/"), rel)
p = storage.open_for_read(rel)
chk("回读返回 Path", isinstance(p, Path) and p.exists())
chk("内容一致", isinstance(p, Path) and p.read_bytes() == b"hello-booking")
chk("未知扩展名降级 .bin", storage.save(b"x", "a.exe", "booking").endswith(".bin"))
chk("目录穿越被拦", storage.open_for_read("../.env") is None)
chk("不存在返回 None", storage.open_for_read("booking/19700101/none.png") is None)
i = storage.info(rel)
chk("info 有大小", i["exists"] and i["size"] == len(b"hello-booking"), str(i))
u = storage.usage()
chk("usage 记账", u["backend"] == "local" and u["files"] >= 1, str(u))
chk("health 可用", storage.health()["ok"] is True)


# ---------------- s3（假客户端）----------------
class FakeS3:
    def __init__(self):
        self.store: dict[str, bytes] = {}
        self.meta: dict[str, str] = {}
        self.calls: list[str] = []

    def put_object(self, Bucket, Key, Body, ContentType):
        self.calls.append(f"put:{Bucket}/{Key}")
        self.store[Key] = Body
        self.meta[Key] = ContentType

    def get_object(self, Bucket, Key):
        self.calls.append(f"get:{Bucket}/{Key}")
        if Key not in self.store:
            raise KeyError(Key)
        import io
        return {"Body": io.BytesIO(self.store[Key])}

    def head_object(self, Bucket, Key):
        self.calls.append(f"head:{Bucket}/{Key}")
        if Key not in self.store:
            raise KeyError(Key)
        return {"ContentLength": len(self.store[Key]), "LastModified": "2026-11-02"}

    def list_objects_v2(self, Bucket, Prefix="", MaxKeys=1000, ContinuationToken=None):
        self.calls.append(f"list:{Bucket}/{Prefix}")
        keys = [k for k in self.store if k.startswith(Prefix)]
        # 故意每页 2 条，验证分页循环
        page = keys[:2]
        rest = keys[2:]
        out = {"Contents": [{"Key": k, "Size": len(self.store[k])} for k in page],
               "IsTruncated": bool(rest)}
        if rest:
            out["NextContinuationToken"] = "t1"
        return out

    def head_bucket(self, Bucket):
        self.calls.append(f"head_bucket:{Bucket}")
        return {}


print("s3 后端（假客户端）")
fake = FakeS3()
storage.BACKEND = "s3"
storage.S3_BUCKET = "copilot-test"
storage.S3_PREFIX = "uploads/"
storage._s3_client = fake

rel = storage.save(b"pdf-bytes", "invoice.pdf", "invoice")
chk("key 带前缀", rel in [k[len("uploads/"):] for k in fake.store], rel)
chk("ContentType 正确", fake.meta.get(f"uploads/{rel}") == "application/pdf",
    str(fake.meta.get(f"uploads/{rel}")))
got = storage.open_for_read(rel)
chk("回读返回 (bytes, media)", isinstance(got, tuple) and got[0] == b"pdf-bytes")
chk("媒体类型", isinstance(got, tuple) and got[1] == "application/pdf")
chk("resolve 在 s3 下返回 None", storage.resolve(rel) is None)
i = storage.info(rel)
chk("info 走 head_object", i["exists"] and i["size"] == 9, str(i))
chk("不存在返回 None", storage.open_for_read("invoice/19700101/none.pdf") is None)

u = storage.usage()
chk("usage 统计 s3", u["backend"] == "s3" and u["files"] == 1 and u["bytes"] == 9, str(u))
chk("health 走 head_bucket", storage.health()["ok"] is True)

print()
print("全部通过" if ok else "有失败项")
sys.exit(0 if ok else 1)
