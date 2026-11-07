"""企业微信服务端 API：access_token 缓存、临时素材下载、应用消息推送。

为什么单独一个模块：
- token 有 7200 秒有效期，必须缓存；每张图都重新取 token 会撞频率限制
- 下载临时素材要跟随 302、识别 JSON 错误、限制大小
- 主动推送结果（异步 OCR 完成后）需要 AgentID + Secret

所有函数都允许传入 httpx.Client，测试用 MockTransport 注入，
不需要真实企业微信账号。
"""
from __future__ import annotations

import re
import threading
import time
from urllib.parse import unquote

import httpx

from .config import settings
from .wecom import clip_text


class WeComAPIError(RuntimeError):
    def __init__(self, message: str, code: int | None = None):
        super().__init__(message)
        self.code = code


_lock = threading.Lock()
_token: dict[str, object] = {"value": "", "expires_at": 0.0}

# token 失效类错误：强制刷新后重试一次
_TOKEN_ERRORS = {40014, 42001, 41001}


def configured() -> bool:
    """图片通道是否具备下载与主动推送条件。"""
    return bool(settings.wecom_corpid and settings.wecom_secret
                and settings.wecom_agentid)


def reset_cache() -> None:
    with _lock:
        _token["value"] = ""
        _token["expires_at"] = 0.0


def _request(client: httpx.Client | None, method: str, path: str, **kwargs):
    own = client is None
    c = client or httpx.Client(
        base_url=settings.wecom_api_base, timeout=30, follow_redirects=True
    )
    try:
        return c.request(method, path, **kwargs)
    finally:
        if own:
            c.close()


def _json(resp: httpx.Response) -> dict:
    try:
        payload = resp.json()
    except ValueError as exc:
        raise WeComAPIError(f"企业微信返回非 JSON（HTTP {resp.status_code}）") from exc
    if not isinstance(payload, dict):
        raise WeComAPIError("企业微信返回格式异常")
    code = int(payload.get("errcode", 0) or 0)
    if code != 0:
        raise WeComAPIError(
            str(payload.get("errmsg") or f"errcode={code}"), code=code
        )
    return payload


def get_access_token(client: httpx.Client | None = None, force: bool = False) -> str:
    if not settings.wecom_corpid or not settings.wecom_secret:
        raise WeComAPIError("未配置 WECOM_CORPID / WECOM_SECRET")
    now = time.time()
    with _lock:
        if not force and _token["value"] and now < float(_token["expires_at"]):
            return str(_token["value"])
        resp = _request(client, "GET", "/cgi-bin/gettoken", params={
            "corpid": settings.wecom_corpid,
            "corpsecret": settings.wecom_secret,
        })
        payload = _json(resp)
        token = str(payload.get("access_token") or "")
        if not token:
            raise WeComAPIError("企业微信未返回 access_token")
        expires_in = int(payload.get("expires_in", 7200) or 7200)
        # 提前 5 分钟刷新，避免边界过期
        _token["value"] = token
        _token["expires_at"] = now + max(60, expires_in - 300)
        return token


def _with_token(fn, client: httpx.Client | None):
    try:
        return fn(get_access_token(client))
    except WeComAPIError as exc:
        if exc.code in _TOKEN_ERRORS:
            return fn(get_access_token(client, force=True))
        raise


_EXT_BY_TYPE = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/bmp": ".bmp",
    "image/webp": ".webp",
}


def _filename(resp: httpx.Response, media_id: str) -> str:
    disp = resp.headers.get("content-disposition", "")
    # RFC 5987：filename*=UTF-8''%E6%89%98...
    m = re.search(r"filename\*\s*=\s*UTF-8''([^;]+)", disp, flags=re.IGNORECASE)
    if m:
        return unquote(m.group(1).strip().strip('"'))
    m = re.search(r'filename="?([^";]+)"?', disp)
    if m:
        return m.group(1)
    ctype = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
    return media_id + _EXT_BY_TYPE.get(ctype, ".jpg")


def download_media(media_id: str, client: httpx.Client | None = None
                   ) -> tuple[bytes, str, str]:
    """下载临时素材，返回 (bytes, filename, content_type)。"""
    if not media_id:
        raise WeComAPIError("缺少 MediaId")
    if not settings.wecom_corpid or not settings.wecom_secret:
        raise WeComAPIError("未配置 WECOM_CORPID / WECOM_SECRET")

    def call(token: str) -> httpx.Response:
        resp = _request(client, "GET", "/cgi-bin/media/get", params={
            "access_token": token, "media_id": media_id,
        })
        if resp.status_code != 200:
            raise WeComAPIError(f"素材下载失败（HTTP {resp.status_code}）")
        ctype = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
        if "application/json" in ctype or "text/" in ctype:
            # 企业微信把错误也用 200 返回；_json 会带 errcode 抛错，token 失效时触发重试
            _json(resp)
        return resp

    resp = _with_token(call, client)
    ctype = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
    data = resp.content
    if not data:
        raise WeComAPIError("素材内容为空")
    limit = max(1, settings.wecom_image_max_mb) * 1024 * 1024
    if len(data) > limit:
        raise WeComAPIError(
            f"图片超过 {settings.wecom_image_max_mb}MB，请走 H5 上传"
        )
    return data, _filename(resp, media_id), ctype or "application/octet-stream"


def send_text(touser: str, content: str, client: httpx.Client | None = None) -> None:
    """异步处理完成后，主动给员工发结果。"""
    if not configured():
        raise WeComAPIError("未配置 WECOM_CORPID / WECOM_SECRET / WECOM_AGENTID")
    if not touser:
        raise WeComAPIError("缺少 touser")

    payload = {
        "touser": touser,
        "msgtype": "text",
        "agentid": int(settings.wecom_agentid)
        if settings.wecom_agentid.isdigit() else settings.wecom_agentid,
        "text": {"content": clip_text(content)},
    }

    def call(token: str) -> httpx.Response:
        resp = _request(client, "POST", "/cgi-bin/message/send", params={
            "access_token": token,
        }, json=payload)
        _json(resp)
        return resp

    _with_token(call, client)
