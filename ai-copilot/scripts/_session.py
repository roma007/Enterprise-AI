"""脚本用的小工具：登录并返回带 cookie 的 opener。

所有需要调 API 的脚本都通过这里登录，凭据取环境变量：
    ADMIN_EMAIL / ADMIN_PASSWORD（与 .env 一致）

这样脚本和浏览器走同一套鉴权，不需要在服务端开后门。
"""
from __future__ import annotations

import http.cookiejar
import json
import os
import urllib.request
from pathlib import Path


def _load_env() -> None:
    """很多脚本不 import app 模块，.env 不会被自动加载，这里补一次。"""
    env = Path(__file__).resolve().parent.parent / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env()


class NotLoggedIn(RuntimeError):
    pass


def opener_for(base: str, email: str | None = None, password: str | None = None):
    """返回一个已登录的 opener；未配置密码时返回未登录的 opener（仅能调公开接口）。"""
    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    email = email or os.getenv("ADMIN_EMAIL", "admin@local")
    password = password or os.getenv("ADMIN_PASSWORD", "")
    if not password:
        return op
    req = urllib.request.Request(
        base + "/api/auth/login",
        data=json.dumps({"email": email, "password": password}).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        op.open(req, timeout=30)
    except Exception as exc:  # noqa: BLE001
        raise NotLoggedIn(f"登录失败（{email}）：{exc}") from exc
    return op


def get_json(op, url: str, timeout: int = 60):
    return json.load(op.open(url, timeout=timeout))


def post_json(op, url: str, body: dict, timeout: int = 120):
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}
    )
    return json.load(op.open(req, timeout=timeout))
