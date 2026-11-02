"""登录、角色与操作者（A1 + A2）。

为什么这两个一起做：
- 没有"谁"，权限和审计都无从谈起
- 审计日志里只写"某人改了"，等于没写

设计取舍：
- **不引入第三方依赖**：密码用 stdlib 的 scrypt，令牌用 HMAC-SHA256 自己签
- **会话可撤销**：令牌里带 jti，服务端有一张 user_sessions 表；
  这是"强制下线"和"改密码后踢掉其他设备"的基础
- **角色按前缀 + 方法**判定，而不是每个端点手写一遍
- 密钥持久化到 data/auth_secret，重启不会让所有人掉线
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path

from .config import ROOT

SECRET_PATH = ROOT / "data" / "auth_secret"
TOKEN_TTL = int(os.getenv("AUTH_TOKEN_TTL", str(12 * 3600)))  # 12 小时

# 未知邮箱也跑一次 scrypt，避免"响应快 = 账号不存在"的枚举
DUMMY_HASH = "9c8176331f34e812d76b6628dec82ad2203cc57189ed6f2504e733ccd0c4303e"
DUMMY_SALT = "468a00fff215ad7c2e0632140c9804a5"

ROLES = ("admin", "operator", "finance", "viewer")
ROLE_LABEL = {
    "admin": "管理员",
    "operator": "单证员",
    "finance": "财务",
    "viewer": "只读",
}


def _secret() -> bytes:
    env = os.getenv("AUTH_SECRET", "").strip()
    if env:
        return env.encode()
    SECRET_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not SECRET_PATH.exists():
        SECRET_PATH.write_bytes(secrets.token_bytes(32))
    return SECRET_PATH.read_bytes()


# ---------------- 密码 ----------------

def hash_password(password: str, salt: bytes | None = None) -> tuple[str, str]:
    salt = salt or secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return dk.hex(), salt.hex()


def verify_password(password: str, pw_hash: str, pw_salt: str) -> bool:
    try:
        salt = bytes.fromhex(pw_salt)
    except ValueError:
        return False
    dk = hashlib.scrypt(password.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return hmac.compare_digest(dk.hex(), pw_hash)


def password_ok(password: str) -> tuple[bool, str]:
    if len(password) < 10:
        return False, "密码至少 10 位"
    if password.isdigit() or password.isalpha():
        return False, "密码需同时包含字母和数字"
    return True, ""


# ---------------- 令牌 ----------------

def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sign(payload: dict) -> str:
    body = _b64(json.dumps(payload, separators=(",", ":")).encode())
    sig = hmac.new(_secret(), body.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{body}.{sig}"


def verify(token: str) -> dict | None:
    if not token or "." not in token:
        return None
    body, sig = token.rsplit(".", 1)
    expect = hmac.new(_secret(), body.encode(), hashlib.sha256).hexdigest()[:32]
    if not hmac.compare_digest(sig, expect):
        return None
    try:
        payload = json.loads(_unb64(body))
    except (ValueError, json.JSONDecodeError):
        return None
    if int(payload.get("exp", 0)) < int(time.time()):
        return None
    return payload


def new_payload(user_id: str) -> dict:
    return {
        "uid": user_id,
        "jti": secrets.token_hex(12),
        "exp": int(time.time()) + TOKEN_TTL,
        "iat": int(time.time()),
    }


# ---------------- 权限矩阵 ----------------

# 这些前缀下的写操作只给指定角色
FINANCE_PREFIXES = (
    "/api/invoice", "/api/threeway", "/api/reconcile",
    "/api/aging", "/api/settlement", "/api/fees",
)
OPERATOR_PREFIXES = (
    "/api/extract", "/api/split", "/api/batches",
)
ADMIN_ONLY_PREFIXES = ("/api/users", "/api/settings", "/api/delivery")

# 无需登录即可访问
PUBLIC_PATHS = {
    "/api/health",
    "/api/auth/login",
    "/api/wecom/callback",      # 用企微自己的签名校验
    "/metrics",                 # Prometheus 抓取，端点内校验 METRICS_TOKEN
    "/login",
    "/favicon.ico",
}
PUBLIC_PREFIXES = ("/static/",)


def is_public(path: str) -> bool:
    return path in PUBLIC_PATHS or any(path.startswith(p) for p in PUBLIC_PREFIXES)


def allowed(role: str, method: str, path: str) -> tuple[bool, str]:
    """返回 (是否允许, 拒绝原因)。"""
    if role not in ROLES:
        return False, "未知角色"
    if role == "admin":
        return True, ""

    for p in ADMIN_ONLY_PREFIXES:
        if path.startswith(p):
            return False, "仅管理员可操作"

    # 撤销确认会改动已确认数据与金标，只给管理员
    if method == "POST" and path.startswith("/api/runs/") and path.endswith("/undo"):
        return False, "撤销确认仅管理员可操作"

    write = method in {"POST", "PUT", "PATCH", "DELETE"}
    if not write:
        return True, ""

    if role == "viewer":
        return False, "只读账号不能修改数据"

    for p in FINANCE_PREFIXES:
        if path.startswith(p):
            return (role == "finance"), "该模块仅财务角色可操作"

    for p in OPERATOR_PREFIXES:
        if path.startswith(p):
            return (role == "operator"), "该模块仅单证员角色可操作"

    # 其余写操作：operator 与 finance 都放行（如确认、脱敏预览、入口登记）
    return (role in {"operator", "finance"}), "无权操作"
