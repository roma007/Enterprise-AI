"""会客 demo 服务。

一件事：托书原文 → 结构化草稿 → 规则挑错 → 人工确认 → 留痕。
登录与角色见 app/auth.py；阈值见 app/thresholds.py；原件存储见 app/storage.py。
"""
from __future__ import annotations

import json
import os
import re
import secrets
import time
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, UploadFile

from fastapi.responses import (
    FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response,
)

from . import auth, db, delivery, storage
from . import metrics as prom
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import ocr, wecom_crypto
from .config import ROOT, VERSION, settings
from .csvio import decode_csv_bytes, export_csv, parse_tms_csv
from . import wecom, wecom_api
from .evalrun import SAMPLE_PATH, run_all
from .extract import extract
from .schema import BLOCKING_KEYS, FIELD_KEYS, LABELS, SPECS
from .store import (
    AlreadyConfirmed, audit, audit_csv, count_users, create_session, create_user,
    dump_feedback, find_amend_candidates, find_by_booking_no, get_user,
    get_user_by_email, init_db, ignore_item, label_item, latest_unconfirmed_run, learn_export,
    learn_filter_options, learn_item, learn_queue, learn_stats, list_users,
    metrics, queue, recent, record_inbound, report_md, revoke_session,
    revoke_user_sessions, risk_sim, save_feedback, save_run, session_valid,
    set_password, stats, touch_login, update_user,
    clear_login_failures, login_locked, record_login_failure, ops_counts,
    save_pilot_review, get_pilot_review, list_pilot_reviews, mark_pilot_review_delivery,
    list_jobs,
    confirmed_recent, revisions, undo_confirm, NotConfirmed, VersionMismatch,
    claim_wecom_msg, mark_wecom_msg, update_inbound_text,
)

MAX_UPLOAD = 10 * 1024 * 1024  # 10 MB

app = FastAPI(title="集卡托书 AI 录入 · Demo", version="0.1.0")
app.mount("/static", StaticFiles(directory=str(ROOT / "static")), name="static")


@app.on_event("startup")
def _startup() -> None:
    init_db()
    from .batchproc import start_worker as start_batch_worker
    start_batch_worker()
    delivery.start_worker()
    from .notify import start_watcher as start_notify_watcher
    start_notify_watcher()
    from .tms import start_worker as start_tms_worker
    start_tms_worker()
    if count_users() == 0:
        email = os.getenv("ADMIN_EMAIL", "admin@local").strip() or "admin@local"
        pw = os.getenv("ADMIN_PASSWORD", "").strip()
        generated = not pw
        if generated:
            pw = secrets.token_urlsafe(9)
        h, salt = auth.hash_password(pw)
        create_user(email, "系统管理员", "admin", h, salt)
        if generated:
            print("=" * 58)
            print(f"[引导] 初始管理员：{email}")
            print(f"[引导] 初始密码：{pw}")
            print("[引导] 只显示一次，请立即登录并修改")
            print("=" * 58)


class InboundReq(BaseModel):
    text: str = Field(default="", max_length=20000)
    source: str = "wecom"


class ExtractReq(BaseModel):
    text: str = Field(default="", max_length=20000)
    use_llm: bool = True


class ConfirmReq(BaseModel):
    run_id: str
    auto: dict[str, str] = {}
    final: dict[str, str] = {}
    handle_ms: int | None = Field(default=None, ge=0, le=3_600_000)


@app.exception_handler(storage.StorageError)
async def _storage_error(request: Request, exc: storage.StorageError):
    """存储后端不可用（缺 boto3 / 配置错）时给可读提示，不抛 500 堆栈。"""
    return JSONResponse({"detail": str(exc)}, status_code=503)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path
    if auth.is_public(path):
        return await call_next(request)

    token = ""
    head = request.headers.get("authorization", "")
    if head.lower().startswith("bearer "):
        token = head[7:].strip()
    if not token:
        token = request.cookies.get("sid", "")

    payload = auth.verify(token) if token else None
    user = None
    if payload and session_valid(payload.get("jti", "")):
        u = get_user(payload.get("uid", ""))
        if u and u.get("active"):
            user = u

    if not user:
        if path.startswith("/api/"):
            return JSONResponse({"detail": "未登录或会话已失效"}, status_code=401)
        return RedirectResponse("/login")

    ok, why = auth.allowed(user["role"], request.method, path)
    if not ok:
        return JSONResponse({"detail": why}, status_code=403)

    request.state.user = user
    request.state.jti = payload.get("jti", "")
    return await call_next(request)


@app.middleware("http")
async def observe_middleware(request: Request, call_next):
    """记录 Prometheus 指标 + 补安全响应头。

    放在 auth 之后注册 = 包在最外层，未登录的 401 也会被计数。
    """
    start = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        prom.observe(request.method, "unmatched", 500,
                     (time.perf_counter() - start) * 1000)
        raise

    if request.url.path != "/metrics":
        route = request.scope.get("route")
        path = getattr(route, "path", None) or request.url.path
        prom.observe(request.method, path, response.status_code,
                     (time.perf_counter() - start) * 1000)

    # 页面与导航脚本改动后浏览器要重新校验，避免客户打开到旧界面
    if response.headers.get("content-type", "").startswith("text/html") or request.url.path in {
        "/static/nav.js",
        "/static/nav.css",
    }:
        response.headers.setdefault("Cache-Control", "no-cache")

    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    if proto == "https":
        response.headers.setdefault(
            "Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return response


def _uid(request: Request) -> str:
    u = getattr(request.state, "user", None) or {}
    return u.get("id", "")


@app.get("/api/settings")
def api_settings_get():
    from . import thresholds as th
    return th.snapshot()


@app.put("/api/settings")
def api_settings_put(req: dict, request: Request):
    from . import thresholds as th
    values = req.get("values") or {}
    if not isinstance(values, dict) or not values:
        raise HTTPException(status_code=400, detail="values 不能为空")
    try:
        return th.set_many(values, actor=_uid(request),
                           reason=str(req.get("reason") or "")[:200])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/settings/reset")
def api_settings_reset(req: dict, request: Request):
    from . import thresholds as th
    keys = req.get("keys") or None
    try:
        return th.reset(keys, actor=_uid(request),
                        reason=str(req.get("reason") or "")[:200])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/settings/history")
def api_settings_history(limit: int = 50):
    from . import thresholds as th
    items = th.history(limit)
    names: dict[str, str] = {}
    for item in items:
        actor = str(item.get("actor") or "")
        if actor and actor not in names:
            user = get_user(actor) or {}
            names[actor] = user.get("name") or user.get("email") or actor
        item["actor_name"] = names.get(actor, actor or "system")
    return {"items": items}


@app.get("/api/settings/export")
def api_settings_export():
    """导出运行级配置。不含密钥：密钥在 .env，不在此接口范围内。"""
    from . import thresholds as th

    data = th.snapshot()
    values = {item["key"]: item["value"] for group in data["groups"]
              for item in group["items"] if not item.get("secret")}
    return {
        "version": 1,
        "exported_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "values": values,
    }


@app.post("/api/settings/import")
def api_settings_import(req: dict, request: Request):
    from . import thresholds as th

    values = req.get("values")
    if not isinstance(values, dict) or not values:
        raise HTTPException(status_code=400, detail="values 不能为空")
    try:
        result = th.set_many(values, actor=_uid(request),
                             reason=str(req.get("reason") or "导入配置")[:200])
        return {**result, "imported": len(values)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/settings/rollback")
def api_settings_rollback(req: dict, request: Request):
    from . import thresholds as th
    entry_id = str(req.get("id") or "").strip()
    if not entry_id:
        raise HTTPException(status_code=400, detail="id 不能为空")
    try:
        return th.rollback(entry_id, actor=_uid(request),
                           reason=str(req.get("reason") or "")[:200])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


def _mask_value(value: str, head: int = 0) -> str:
    if not value:
        return ""
    if head:
        return value[:head] + "****"
    return f"已配置（{len(value)} 位）"


@app.get("/api/config/integrations")
def api_config_integrations():
    """部署级配置只读视图：来自 .env，改完需要重启。"""
    s = settings
    return {
        "note": "这些配置来自 .env，页面只读；改完需要重启服务。",
        "groups": [
            {"name": "模型", "items": [
                {"key": "llm.provider", "label": "提供方", "value": s.provider,
                 "configured": s.provider not in {"", "rule", "off", "none"}},
                {"key": "llm.base_url", "label": "网关地址", "value": s.base_url},
                {"key": "llm.model", "label": "模型", "value": s.model},
                {"key": "llm.api_key", "label": "API Key", "value": _mask_value(s.api_key),
                 "configured": bool(s.api_key), "secret": True},
                {"key": "llm.strategy", "label": "调用策略", "value": s.llm_strategy},
                {"key": "llm.timeout", "label": "超时（秒）", "value": s.timeout},
                {"key": "llm.below_conf", "label": "补空阈值", "value": s.llm_conf_floor},
            ]},
            {"name": "企业微信", "items": [
                {"key": "wecom.corpid", "label": "CorpID",
                 "value": _mask_value(s.wecom_corpid, 4), "configured": bool(s.wecom_corpid)},
                {"key": "wecom.agentid", "label": "AgentId", "value": s.wecom_agentid,
                 "configured": bool(s.wecom_agentid)},
                {"key": "wecom.secret", "label": "Secret", "value": _mask_value(s.wecom_secret),
                 "configured": bool(s.wecom_secret), "secret": True},
                {"key": "wecom.token", "label": "Token", "value": _mask_value(s.wecom_token),
                 "configured": bool(s.wecom_token), "secret": True},
                {"key": "wecom.aes_key", "label": "EncodingAESKey",
                 "value": _mask_value(s.wecom_aes_key), "configured": bool(s.wecom_aes_key),
                 "secret": True},
                {"key": "wecom.image_max_mb", "label": "图片上限（MB）",
                 "value": s.wecom_image_max_mb},
            ]},
            {"name": "邮件（SMTP）", "items": [
                {"key": "smtp.host", "label": "SMTP 主机",
                 "value": s.smtp_host, "configured": bool(s.smtp_host)},
                {"key": "smtp.port", "label": "端口", "value": s.smtp_port},
                {"key": "smtp.user", "label": "账号",
                 "value": _mask_value(s.smtp_user, 3), "configured": bool(s.smtp_user)},
                {"key": "smtp.password", "label": "密码",
                 "value": _mask_value(s.smtp_password), "configured": bool(s.smtp_password),
                 "secret": True},
                {"key": "smtp.from", "label": "发件人", "value": s.smtp_from or "（默认同账号）"},
                {"key": "smtp.tls", "label": "SSL", "value": "开" if s.smtp_tls else "关"},
                {"key": "smtp.starttls", "label": "STARTTLS",
                 "value": "开" if s.smtp_starttls else "关"},
            ]},
            {"name": "存储", "items": [
                {"key": "storage.backend", "label": "后端", "value": storage.BACKEND},
                {"key": "storage.dir", "label": "本地目录", "value": str(storage.BASE)},
                {"key": "storage.s3_bucket", "label": "Bucket",
                 "value": storage.S3_BUCKET, "configured": bool(storage.S3_BUCKET)},
                {"key": "storage.s3_endpoint", "label": "S3 Endpoint",
                 "value": storage.S3_ENDPOINT, "configured": bool(storage.S3_ENDPOINT)},
            ]},
        ],
    }


@app.post("/api/config/test/llm")
def api_config_test_llm():
    from . import llm as llm_mod

    if not settings.llm_enabled:
        return {"ok": False, "error": "模型未启用（没有 API Key 或 provider=rule）"}
    start = time.perf_counter()
    res = llm_mod.chat_json("你是连通性测试，只输出 JSON。", '只输出 {"ok": true}')
    return {
        "ok": res.ok,
        "elapsed_ms": round((time.perf_counter() - start) * 1000),
        "model": settings.model,
        "cached": res.cached,
        "tokens": res.tokens,
        "error": (res.error or "")[:200],
    }


@app.post("/api/config/test/wecom")
def api_config_test_wecom():
    from . import wecom_api

    if not wecom_api.configured():
        return {"ok": False, "error": "缺 CorpID / Secret / AgentID"}
    start = time.perf_counter()
    try:
        token = wecom_api.get_access_token(force=True)
        return {
            "ok": bool(token),
            "elapsed_ms": round((time.perf_counter() - start) * 1000),
            "agentid": settings.wecom_agentid,
            "callback_signed": bool(settings.wecom_token and settings.wecom_aes_key),
        }
    except Exception as exc:  # noqa: BLE001 — 外部接口失败要给人话
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:200]}


@app.post("/api/config/test/email")
def api_config_test_email():
    from .notify import _send_email

    ok, error = _send_email("智单邮件测试", "收到这封邮件说明 SMTP 配置有效。")
    return {"ok": ok, "error": error}


@app.post("/api/config/test/tms")
def api_config_test_tms():
    from .tms import test_endpoint

    return test_endpoint()


@app.get("/api/tms/status")
def api_tms_status():
    from .tms import status

    return status()


@app.get("/api/tms/outbox")
def api_tms_outbox(limit: int = 20):
    from .tms import recent

    return {"items": recent(limit)}


@app.post("/api/tms/push/{run_id}")
def api_tms_push(run_id: str):
    from .tms import push

    try:
        return push(run_id)
    except (LookupError,) as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@app.post("/api/tms/flush")
def api_tms_flush():
    from .tms import flush

    return flush()


@app.post("/api/config/test/notify")
def api_config_test_notify():
    from .notify import notify as send_notify

    return send_notify("test", "智单通知测试",
                       "这是一条测试消息；收到说明 Webhook 配置有效。", force=True)


@app.get("/api/notify/recent")
def api_notify_recent(limit: int = 20):
    from .notify import recent

    return {"items": recent(limit)}


@app.post("/api/config/test/storage")
def api_config_test_storage():
    start = time.perf_counter()
    rel = ""
    try:
        rel = storage.save(b"zhidan-storage-test", "connectivity.txt", scope="_selftest")
        obj = storage.open_for_read(rel)
        ok = obj is not None
        if hasattr(obj, "read_bytes"):
            ok = obj.read_bytes() == b"zhidan-storage-test"
        return {
            "ok": ok,
            "elapsed_ms": round((time.perf_counter() - start) * 1000),
            "backend": storage.BACKEND,
            "key": rel,
        }
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:200]}
    finally:
        if rel:
            storage.delete(rel)


@app.get("/settings")
def settings_page():
    return FileResponse(ROOT / "static" / "settings.html")


@app.get("/users")
def users_page():
    return FileResponse(ROOT / "static" / "users.html")


@app.get("/login")
def login_page():
    return FileResponse(ROOT / "static" / "login.html")


class LoginReq(BaseModel):
    email: str = Field(min_length=3, max_length=120)
    password: str = Field(min_length=1, max_length=200)


@app.post("/api/auth/login")
def api_login(req: LoginReq, request: Request):
    email = req.email.strip().lower()
    ip = request.client.host if request.client else ""
    key = f"{email}|{ip}"

    def _wait_text(seconds: int) -> str:
        return f"{seconds // 60} 分钟" if seconds >= 60 else f"{max(1, seconds)} 秒"

    remain = login_locked(key)
    if remain > 0:
        raise HTTPException(
            status_code=429,
            detail=f"登录失败次数过多，请 {_wait_text(remain)}后再试",
            headers={"Retry-After": str(remain)},
        )

    u = get_user_by_email(email)
    if not u:
        # 未知账号也做一次等价开销的校验，避免按响应时间枚举
        auth.verify_password(req.password, auth.DUMMY_HASH, auth.DUMMY_SALT)
    if not u or not u.get("active") or not auth.verify_password(
            req.password, u["pw_hash"], u["pw_salt"]):
        locked = record_login_failure(
            key, settings.login_max_failures,
            settings.login_lock_seconds, settings.login_window_seconds,
        )
        if locked:
            raise HTTPException(
                status_code=429,
                detail=f"登录失败次数过多，请 {_wait_text(locked)}后再试",
                headers={"Retry-After": str(locked)},
            )
        raise HTTPException(status_code=401, detail="邮箱或密码不正确")

    clear_login_failures(key)
    payload = auth.new_payload(u["id"])
    create_session(payload["jti"], u["id"], payload["exp"],
                   request.headers.get("user-agent", ""),
                   request.client.host if request.client else "")
    touch_login(u["id"])
    resp = JSONResponse({
        "ok": True,
        "user": {"id": u["id"], "email": u["email"], "name": u["name"], "role": u["role"]},
    })
    resp.set_cookie("sid", auth.sign(payload), httponly=True, samesite="lax",
                    secure=settings.cookie_secure,
                    max_age=auth.TOKEN_TTL, path="/")
    return resp


@app.post("/api/auth/logout")
def api_logout(request: Request):
    jti = getattr(request.state, "jti", "")
    if jti:
        revoke_session(jti)
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("sid", path="/", secure=settings.cookie_secure)
    return resp


@app.get("/api/me")
def api_me(request: Request):
    u = request.state.user
    return {"id": u["id"], "email": u["email"], "name": u["name"],
            "role": u["role"], "role_label": auth.ROLE_LABEL.get(u["role"], u["role"])}


class UserReq(BaseModel):
    email: str = Field(min_length=3, max_length=120)
    name: str = ""
    role: str = "viewer"
    password: str = Field(min_length=10, max_length=200)


@app.get("/api/users")
def api_users():
    return {"items": list_users(), "roles": [
        {"key": r, "label": auth.ROLE_LABEL[r]} for r in auth.ROLES]}


@app.post("/api/users")
def api_user_create(req: UserReq):
    if req.role not in auth.ROLES:
        raise HTTPException(status_code=400, detail="角色不合法")
    ok, why = auth.password_ok(req.password)
    if not ok:
        raise HTTPException(status_code=400, detail=why)
    if get_user_by_email(req.email):
        raise HTTPException(status_code=409, detail="该邮箱已存在")
    h, salt = auth.hash_password(req.password)
    uid = create_user(req.email, req.name, req.role, h, salt)
    return {"id": uid, "email": req.email.strip().lower(), "role": req.role}


@app.patch("/api/users/{uid}")
def api_user_update(uid: str, req: dict, request: Request):
    if uid == request.state.user["id"] and req.get("role"):
        raise HTTPException(status_code=400, detail="不能修改自己的角色")
    if req.get("role") and req["role"] not in auth.ROLES:
        raise HTTPException(status_code=400, detail="角色不合法")
    update_user(uid, **{k: req.get(k) for k in ("name", "role", "active") if k in req})
    if req.get("active") is False:
        revoke_user_sessions(uid)
    return {"ok": True}


class PasswordReq(BaseModel):
    old_password: str
    new_password: str = Field(min_length=10, max_length=200)


@app.post("/api/auth/password")
def api_password(req: PasswordReq, request: Request):
    u = request.state.user
    if not auth.verify_password(req.old_password, u["pw_hash"], u["pw_salt"]):
        raise HTTPException(status_code=400, detail="原密码不正确")
    ok, why = auth.password_ok(req.new_password)
    if not ok:
        raise HTTPException(status_code=400, detail=why)
    h, salt = auth.hash_password(req.new_password)
    set_password(u["id"], h, salt)
    revoke_user_sessions(u["id"], except_jti=getattr(request.state, "jti", ""))
    return {"ok": True, "note": "其他设备已强制下线"}


@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/api/health")
def health():
    """健康检查：给负载均衡/监控用，不返回任何敏感信息。"""
    db_ok = True
    journal = ""
    try:
        from .store import _conn
        with _conn() as conn:
            if db.BACKEND == "sqlite":
                journal = conn.execute("PRAGMA journal_mode").fetchone()[0]
            conn.execute("SELECT 1").fetchone()
    except Exception:  # noqa: BLE001
        db_ok = False
    return {
        "ok": db_ok,
        "version": VERSION,
        "llm_enabled": settings.llm_enabled,
        "model": settings.model if settings.llm_enabled else "rule-based-v1",
        "ocr": ocr.available(),
        "db": {"ok": db_ok, "backend": db.BACKEND, "journal_mode": journal},
        "storage": storage.health(),
    }


@app.get("/metrics", response_class=PlainTextResponse)
def prometheus(request: Request):
    """Prometheus 抓取端点。

    - 配了 METRICS_TOKEN：必须带 Bearer 或 ?token=
    - 没配：只允许本机访问（反代在另一台机器时必须配 token）
    """
    expected = os.getenv("METRICS_TOKEN", "").strip()
    if expected:
        head = request.headers.get("authorization", "")
        got = head[7:].strip() if head.lower().startswith("bearer ") else \
            request.query_params.get("token", "")
        if not secrets.compare_digest(got, expected):
            raise HTTPException(status_code=401, detail="metrics token 不正确")
    else:
        host = request.client.host if request.client else ""
        if host not in {"127.0.0.1", "::1", "localhost"}:
            raise HTTPException(
                status_code=403,
                detail="未配置 METRICS_TOKEN 时仅允许本机抓取",
            )
    return PlainTextResponse(
        prom.render(),
        media_type="text/plain; version=0.0.4; charset=utf-8",
    )


def _draft_response(draft, run_id: str, extra: dict | None = None) -> dict:
    body = {
        "run_id": run_id,
        "engine": draft.engine,
        "elapsed_ms": draft.elapsed_ms,
        "tokens": draft.tokens,
        "blocking": draft.blocking,
        "note": draft.note,
        "review_level": draft.review_level,
        "fields": {
            k: {"value": v.value, "confidence": v.confidence, "source": v.source,
                "label": LABELS[k], "blocking": k in BLOCKING_KEYS}
            for k, v in draft.fields.items()
        },
        "checks": [c.model_dump() for c in draft.checks],
    }
    if extra:
        body.update(extra)
    return body


@app.get("/api/meta")
def meta():
    from . import thresholds as th
    return {
        "fields": [
            {"key": s.key, "label": s.label, "blocking": s.blocking, "kind": s.kind, "placeholder": s.example}
            for s in SPECS
        ],
        "blocking": list(BLOCKING_KEYS),
        "org": settings.org_name,
        "llm_enabled": settings.llm_enabled,
        "model": settings.model if settings.llm_enabled else "rule-based-v1",
        "ocr_ready": ocr.available()["ready"],
        "baseline_manual_sec": th.get("metrics.baseline_manual_sec"),
        "hourly_cost": th.get("metrics.hourly_cost"),
    }


def _resolve_amend(text: str, draft):
    """改单解析（B1 + B2 共用）。

    - 有原单号 → 直接找
    - 没原单号 / 找不到 → 按"箱号 / 客户 + 近 3 天"反查候选
    - 候选多于一个 → 不猜，交给人选
    """
    from .amend import apply_changes, base_booking_no, is_amend
    from .rules import apply_rules

    if not is_amend(text):
        return None

    no = base_booking_no(text) or (
        draft.fields["booking_no"].value if draft.fields.get("booking_no") else None
    )
    orig = find_by_booking_no(no) if no else None
    how = "原单号"

    if not orig:
        fields = {k: (v.value or "") for k, v in draft.fields.items()}
        cands = find_amend_candidates(fields)
        if len(cands) == 1:
            orig = {"run_id": cands[0]["run_id"], "fields": cands[0]["fields"]}
            how = f"反查（{cands[0]['reason']}）"
            no = cands[0]["booking_no"] or no
        elif len(cands) > 1:
            return {
                "base_run_id": None, "base_booking_no": no, "diff": [],
                "candidates": [
                    {k: c[k] for k in ("run_id", "ts", "score", "reason",
                                       "booking_no", "client", "container_no")}
                    for c in cands
                ],
                "note": f"未指定原单号，找到 {len(cands)} 张可能原单，请人工选择",
            }
        else:
            return {
                "base_run_id": None, "base_booking_no": no, "diff": [],
                "note": f"未找到原单 {no or ''}，已按新单处理",
            }

    changes = {k: (v.value or "") for k, v in draft.fields.items()}
    merged, diff = apply_changes(text, orig["fields"], changes)
    for k, v in merged.items():
        if k in draft.fields and v and v != draft.fields[k].value:
            draft.fields[k].value = v
            draft.fields[k].source = "amend"
    apply_rules(draft)
    return {
        "base_run_id": orig["run_id"],
        "base_booking_no": no,
        "matched_by": how,
        "diff": diff,
    }


@app.post("/api/extract")
def api_extract(req: ExtractReq, request: Request):
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="托书内容为空")
    draft = extract(req.text, allow_llm=req.use_llm)

    # D9 + B1：改单通知。有原单号直接找，没有就反查候选。
    extra: dict = {}
    try:
        info = _resolve_amend(req.text, draft)
        if info:
            extra["amend"] = info
    except Exception as exc:  # noqa: BLE001
        # 不吞异常：改单解析失败要能被看见，否则会静默当新单处理
        extra["amend"] = {"error": f"{type(exc).__name__}: {exc}", "diff": []}

    run_id = save_run(req.text, draft, actor=_uid(request))
    return _draft_response(draft, run_id, extra)


@app.post("/api/split")
def api_split(req: ExtractReq, request: Request):
    """D8：把一条消息里的多票拆开，逐票解析。"""
    from .splitter import split_tickets

    if not req.text.strip():
        raise HTTPException(status_code=400, detail="内容为空")
    segs = split_tickets(req.text)
    tickets = []
    for i, seg in enumerate(segs, 1):
        d = extract(seg, allow_llm=req.use_llm)
        extra = {"index": i, "segment": seg}
        # B2：拆出来的每一票，单独判断是不是改单
        try:
            info = _resolve_amend(seg, d)
            if info:
                extra["amend"] = info
        except Exception as exc:  # noqa: BLE001
            extra["amend"] = {"error": f"{type(exc).__name__}: {exc}", "diff": []}
        rid = save_run(seg, d, actor=_uid(request))
        tickets.append(_draft_response(d, rid, extra))
    return {"count": len(tickets), "tickets": tickets}


@app.post("/api/extract/upload")
async def api_upload(
    request: Request,
    file: UploadFile = File(...),
    use_llm: bool = Form(True),
    source: str = Form("h5-upload"),
):
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="文件为空")
    if len(data) > MAX_UPLOAD:
        raise HTTPException(status_code=413, detail="文件超过 10MB")

    try:
        res = ocr.extract(file.filename or "", data)
    except ocr.OcrUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"OCR 不可用：{exc}")

    if not res.text.strip():
        raise HTTPException(status_code=422, detail="未能从文件中识别出文字，请检查清晰度或改用粘贴文本")

    src = source if source in {"h5-upload", "web-upload"} else "upload"
    stored = storage.save(data, file.filename or "", "booking")
    # 上传也是入口：先落 inbound，再解析，保证「绕过率」分母不漏掉拍照/上传。
    record_inbound(res.text, source=src)
    draft = extract(res.text, allow_llm=use_llm)
    run_id = save_run(res.text, draft, actor=_uid(request), source_file=stored)
    return _draft_response(draft, run_id, {
        "ocr": {"pages": res.pages, "used_ocr": res.used_ocr, "note": res.note},
        "raw_text": res.text,
        "source_file": stored,
    })


@app.post("/api/confirm")
def api_confirm(req: ConfirmReq, request: Request):
    try:
        return save_feedback(req.run_id, req.auto, req.final, req.handle_ms, actor=_uid(request))
    except AlreadyConfirmed as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "ALREADY_CONFIRMED",
                "message": "这张单已经被确认过，且本次提交的内容不同。请刷新后再决定。",
                "run_id": exc.run_id,
                "version": exc.version,
            },
        )


class UndoReq(BaseModel):
    note: str = ""
    version: int | None = None


@app.post("/api/runs/{run_id}/undo")
def api_undo(run_id: str, req: UndoReq, request: Request):
    """撤销一次确认（B2，仅管理员）。"""
    try:
        return undo_confirm(run_id, actor=_uid(request), note=req.note,
                            expected_version=req.version)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except NotConfirmed as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except VersionMismatch as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@app.get("/api/runs/confirmed")
def api_runs_confirmed(limit: int = 100):
    from .tms import status as tms_status

    return {"items": confirmed_recent(limit), "tms": tms_status()}


@app.get("/api/runs/{run_id}/revisions")
def api_runs_revisions(run_id: str, limit: int = 100):
    return {"items": revisions(run_id, limit)}


@app.get("/history")
def history_page():
    return FileResponse(ROOT / "static" / "history.html")


@app.get("/h5")
def h5_page():
    return FileResponse(ROOT / "static" / "h5.html")


@app.get("/batch")
def batch_page():
    return FileResponse(ROOT / "static" / "batch.html")


def _require_wecom_config() -> None:
    """安全模式三件套缺一不可，缺了就别装作能收消息。"""
    missing = [k for k, v in (
        ("WECOM_TOKEN", settings.wecom_token),
        ("WECOM_ENCODING_AES_KEY", settings.wecom_aes_key),
        ("WECOM_CORPID", settings.wecom_corpid),
    ) if not v]
    if missing:
        raise HTTPException(
            status_code=503,
            detail=f"企业微信安全模式配置不完整，缺少：{', '.join(missing)}",
        )


@app.get("/api/wecom/callback", response_class=PlainTextResponse)
def wecom_verify(msg_signature: str = "", timestamp: str = "", nonce: str = "",
                 echostr: str = "", signature: str = ""):
    """企业微信回调 URL 验证。

    - 配了 WECOM_ENCODING_AES_KEY → 安全模式：验 msg_signature 后解密 echostr
    - 没配 → 明文模式：验 signature 后原样返回 echostr（仅本地调试）
    """
    if settings.wecom_aes_key:
        _require_wecom_config()
        if not wecom_crypto.verify(settings.wecom_token, msg_signature,
                                   timestamp, nonce, echostr):
            raise HTTPException(status_code=403, detail="签名校验失败")
        try:
            return wecom_crypto.decrypt_echo(
                echostr, settings.wecom_aes_key, settings.wecom_corpid)
        except wecom_crypto.WeComCryptoError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    if not wecom.verify_signature(settings.wecom_token, signature or msg_signature,
                                  timestamp, nonce):
        raise HTTPException(status_code=403, detail="签名校验失败")
    return echostr


_WECOM_DRAFTS: dict[str, dict] = {}
_WECOM_DRAFT_TTL = 30 * 60


def _draft_get(user: str) -> dict | None:
    item = _WECOM_DRAFTS.get(user)
    if not item:
        return None
    if time.time() - item["updated"] > _WECOM_DRAFT_TTL:
        _WECOM_DRAFTS.pop(user, None)
        return None
    return item


def _draft_put(user: str, text: str) -> dict:
    item = _WECOM_DRAFTS.get(user) or {"text": "", "parts": 0, "updated": time.time()}
    if item["text"]:
        item["text"] += "\n"
    item["text"] += text
    item["parts"] += 1
    item["updated"] = time.time()
    _WECOM_DRAFTS[user] = item
    return item


def _looks_complete(text: str) -> bool:
    try:
        draft = extract(text, allow_llm=False)
    except Exception:
        return False
    values = {k: (v.value or "").strip() for k, v in draft.fields.items()}
    keys = ("client", "booking_no", "bl_no", "container_no", "container_type",
            "closing_time", "pickup_addr", "delivery_addr")
    hit = sum(1 for k in keys if values.get(k))
    return hit >= 3 and bool(values.get("booking_no") or values.get("container_no") or values.get("client"))


def _handle_wecom_image(msg: dict, encrypted: bool,
                        background: BackgroundTasks) -> Response:
    """图片消息：先记 inbound，再异步下载/OCR，5 秒内先回一条确认。"""
    media_id = msg.get("media_id") or ""
    from_user = msg.get("from_user") or ""
    to_user = msg.get("to_user") or ""
    msg_id = msg.get("msg_id") or ""
    actor = f"wecom:{from_user}" if from_user else "wecom"

    def reply(text: str) -> Response:
        inner = wecom.build_text_reply(from_user, to_user, text)
        return _wecom_reply(inner, encrypted)

    # 先记分母：即使缺 MediaId / 未配置 / OCR 失败，这条图片也算一次来单。
    inbound = record_inbound(f"[图片待识别] media_id={media_id[:32] or 'missing'}",
                             source="wecom-image")

    if not media_id:
        prom.inc_wecom_image("failed")
        mark_wecom_msg(msg_id, "failed", "missing media_id")
        return reply("图片消息里没有 MediaId，请重发，或改用 H5 上传。")

    if not wecom_api.configured():
        prom.inc_wecom_image("unconfigured")
        mark_wecom_msg(msg_id, "unconfigured", "missing secret/agentid")
        return reply(
            "图片识别通道还没配置好（缺少 WECOM_SECRET / WECOM_AGENTID）。\n"
            "请先用 H5 上传或批量导入。"
        )

    if not ocr.available().get("ready"):
        prom.inc_wecom_image("unconfigured")
        mark_wecom_msg(msg_id, "unconfigured", "ocr unavailable")
        return reply("OCR 服务未安装，图片暂时不能识别。请改用文字或 H5 粘贴。")

    # 先记分母：即使后续 OCR 失败，这条图片也算一次来单。
    background.add_task(
        _process_wecom_image,
        msg_id=msg_id,
        media_id=media_id,
        from_user=from_user,
        inbound_id=inbound["id"],
        actor=actor,
    )
    prom.inc_wecom_image("received")
    return reply(wecom.image_received_text())


def _process_wecom_image(*, msg_id: str, media_id: str, from_user: str,
                         inbound_id: str, actor: str) -> None:
    """后台任务：下载临时素材 → OCR → 抽取 → 入库 → 主动推送结果。"""
    try:
        data, filename, _ctype = wecom_api.download_media(media_id)
        stored = storage.save(data, filename, "booking")
        res = ocr.extract(filename, data)
        text = (res.text or "").strip()
        if not text:
            raise RuntimeError("没有识别出文字")

        # 占位 inbound 补成真实原文，save_run 才能按 text_hash 关联。
        update_inbound_text(inbound_id, text)
        draft = extract(text)
        run_id = save_run(text, draft, actor=actor, source_file=stored)
        mark_wecom_msg(msg_id, "done", run_id)
        prom.inc_wecom_image("done")
        wecom_api.send_text(from_user, wecom.format_result(draft, run_id))
    except Exception as exc:  # noqa: BLE001
        # 后台任务必须兜底：失败也要落状态、回消息，不能静默。
        print(f"[wecom-image] 处理失败 msg={msg_id[:16]} err={exc}")
        mark_wecom_msg(msg_id, "failed", str(exc))
        prom.inc_wecom_image("failed")
        try:
            from .notify import notify

            notify("wecom_image_failed", "企微图片处理失败",
                   f"msg={msg_id[:16]} err={str(exc)[:200]}", key=msg_id)
        except Exception:  # noqa: BLE001
            pass
        try:
            wecom_api.send_text(from_user, wecom.image_failed_text(str(exc)))
        except Exception as send_exc:  # noqa: BLE001
            print(f"[wecom-image] 失败通知也没发出去 msg={msg_id[:16]} err={send_exc}")


@app.post("/api/wecom/callback", response_class=PlainTextResponse)
async def wecom_message(request: Request, background: BackgroundTasks,
                        msg_signature: str = "", timestamp: str = "",
                        nonce: str = "", signature: str = ""):
    """企业微信消息入口：先记录来单，再解析，最后被动回复。

    顺序很重要：**先 inbound 再解析**。这样即使解析失败，这条单也进了分母，
    绕过率才不会被"处理失败的单"悄悄稀释。

    安全模式下 body 是加密信封，解密后才能拿到真正的 XML。
    """
    body = (await request.body()).decode("utf-8", errors="ignore")
    encrypted = bool(settings.wecom_aes_key)

    if encrypted:
        _require_wecom_config()
        try:
            envelope = wecom_crypto.extract_encrypt(body)
        except wecom_crypto.WeComCryptoError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        if not wecom_crypto.verify(settings.wecom_token, msg_signature,
                                   timestamp, nonce, envelope):
            raise HTTPException(status_code=403, detail="签名校验失败")
        try:
            xml_text = wecom_crypto.decrypt_with_key(
                envelope, settings.wecom_aes_key, settings.wecom_corpid)
        except wecom_crypto.WeComCryptoError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    else:
        if not wecom.verify_signature(settings.wecom_token, signature or msg_signature,
                                      timestamp, nonce):
            raise HTTPException(status_code=403, detail="签名校验失败")
        xml_text = body

    msg = wecom.parse_message(xml_text)
    msg_type = msg.get("msg_type") or "text"

    # 幂等：企微 5 秒超时会重试 3 次，同一 MsgId 只处理一次。
    if not claim_wecom_msg(msg.get("msg_id", ""), msg_type):
        if msg_type == "image":
            prom.inc_wecom_image("duplicate")
        return _wecom_reply("", encrypted)

    # 关注/进入应用等事件不需要回复内容。
    if msg_type == "event":
        return _wecom_reply("", encrypted)

    if msg_type == "image":
        return _handle_wecom_image(msg, encrypted, background)

    content = msg["content"].strip()
    actor = f"wecom:{msg['from_user']}" if msg.get("from_user") else "wecom"

    if not content:
        inner = wecom.build_text_reply(msg["from_user"], msg["to_user"], wecom.format_help())
        return _wecom_reply(inner, encrypted)

    user = msg.get("from_user") or "wecom"
    draft_state = _draft_get(user)

    if content in {"确认", "确认入库", "确认并记录"}:
        pending = latest_unconfirmed_run(actor) or latest_unconfirmed_run("wecom")
        if not pending:
            reply = "没有待确认的单。请先把托书文字发给我。"
        else:
            save_feedback(
                pending["id"], pending["auto"], pending["auto"],
                actor=actor,
            )
            reply = f"已确认入库。\n单号：{pending['id']}"
        inner = wecom.build_text_reply(msg["from_user"], msg["to_user"], reply)
        return _wecom_reply(inner, encrypted)

    if content in {"取消", "清空", "不发了"}:
        _WECOM_DRAFTS.pop(user, None)
        reply = "已取消当前草稿。"
        inner = wecom.build_text_reply(msg["from_user"], msg["to_user"], reply)
        return _wecom_reply(inner, encrypted)

    if content in {"完成", "生成", "出单", "好了"}:
        state = _draft_get(user)
        if not state:
            reply = "当前没有待完成的草稿。请先发送托书内容。"
        else:
            _WECOM_DRAFTS.pop(user, None)
            record_inbound(state["text"], source="wecom")
            draft = extract(state["text"])
            run_id = save_run(state["text"], draft, actor=actor)
            reply = wecom.format_result(draft, run_id)
        inner = wecom.build_text_reply(msg["from_user"], msg["to_user"], reply)
        return _wecom_reply(inner, encrypted)

    if content in {"分条", "开始", "新建", "新建托书"}:
        _WECOM_DRAFTS[user] = {"text": "", "parts": 0, "updated": time.time()}
        reply = "已进入分条录入。请一条条发托书内容，发完回复「完成」；回复「取消」清空。"
        inner = wecom.build_text_reply(msg["from_user"], msg["to_user"], reply)
        return _wecom_reply(inner, encrypted)

    if content in {"查看草稿", "查看"} and draft_state:
        reply = f"当前草稿（{draft_state['parts']} 条，共 {len(draft_state['text'])} 字）：\n" + draft_state["text"][:800]
        inner = wecom.build_text_reply(msg["from_user"], msg["to_user"], reply)
        return _wecom_reply(inner, encrypted)

    if draft_state:
        # 已在分条模式：后续消息继续追加，直到「完成」
        state = _draft_put(user, content)
        reply = f"已收到，当前 {state['parts']} 条（{len(state['text'])} 字）。\n继续发剩余内容，发完回复「完成」；回复「取消」清空。"
        inner = wecom.build_text_reply(msg["from_user"], msg["to_user"], reply)
        return _wecom_reply(inner, encrypted)

    if not _looks_complete(content):
        state = _draft_put(user, content)
        reply = f"这条信息不完整，已先记入草稿（{state['parts']} 条）。\n继续发剩余字段，发完回复「完成」；回复「取消」清空。"
        inner = wecom.build_text_reply(msg["from_user"], msg["to_user"], reply)
        return _wecom_reply(inner, encrypted)

    record_inbound(content, source="wecom")
    draft = extract(content)
    run_id = save_run(content, draft, actor=actor)
    reply = wecom.format_result(draft, run_id)
    inner = wecom.build_text_reply(msg["from_user"], msg["to_user"], reply)
    return _wecom_reply(inner, encrypted)


def _wecom_reply(inner_xml: str, encrypted: bool) -> Response:
    """明文模式直接回；安全模式包一层加密信封。"""
    if not encrypted:
        return Response(content=inner_xml, media_type="application/xml")
    wrapped = wecom_crypto.build_encrypted_reply(
        inner_xml, settings.wecom_token,
        settings.wecom_aes_key, settings.wecom_corpid)
    return Response(content=wrapped, media_type="application/xml")


@app.post("/api/inbound")
def api_inbound(req: InboundReq):
    """入口唯一化：企微机器人 / H5 把每一条来单先记在这里。

    没有对应确认记录的就是"绕过"——这让"人挑活"从不可见变成可量化。
    """
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="来单内容为空")
    return record_inbound(req.text, req.source)


@app.get("/api/audit/{run_id}")
def api_audit(run_id: str):
    row = audit(run_id)
    if not row:
        raise HTTPException(status_code=404, detail="未找到该单据")
    return row


@app.get("/api/audit.csv", response_class=PlainTextResponse)
def api_audit_csv():
    return audit_csv()


@app.get("/api/export.csv", response_class=PlainTextResponse)
def api_export_csv(limit: int = 5000):
    """D13：把确认过的单据导成标准 CSV，客户可导进 TMS / Excel。"""
    from .store import confirmed_tickets

    return export_csv(confirmed_tickets(limit))


@app.post("/api/import/tms")
async def api_import_tms(file: UploadFile = File(...)):
    """D13：读客户 TMS 导出的 CSV，转成可配对记录。"""
    data = await file.read()
    if len(data) > MAX_UPLOAD:
        raise HTTPException(status_code=413, detail="文件超过 10MB")
    text, enc = decode_csv_bytes(data)
    result = parse_tms_csv(text)
    result["encoding"] = enc
    return result


@app.post("/api/pair")
def api_pair(req: dict):
    """D4：纸质原文（已抽取的字段）↔ TMS 记录 配对。"""
    from .pairing import pair as _pair

    papers = req.get("papers") or []
    tms = req.get("tms") or []
    if not isinstance(papers, list) or not isinstance(tms, list):
        raise HTTPException(status_code=400, detail="papers / tms 必须是数组")
    if not papers:
        raise HTTPException(status_code=400, detail="没有待配对的纸质样本")
    return _pair(papers, tms)


@app.post("/api/goldset/eval")
def api_goldset_eval(req: dict):
    """D6：用 TMS 记录当弱金标评测，并给出待抽检清单。

    入参：{"papers":[{"id","text"}], "tms":[{"id",...}], "use_llm": false}
    可选：{"audits": {"T0001": "tms_wrong", ...}} 用于校准
    """
    from .goldset import calibrate, evaluate, sample_for_audit
    from .pairing import pair as _pair

    tms = req.get("tms") or []
    papers_in = req.get("papers") or []
    if not papers_in or not tms:
        raise HTTPException(status_code=400, detail="需要 papers 与 tms")

    use_llm = bool(req.get("use_llm"))
    extracted = []
    for p in papers_in:
        pid = p.get("id") or f"P{len(extracted):03d}"
        text = p.get("text") or ""
        if not text:
            raise HTTPException(status_code=400, detail=f"{pid} 缺少 text")
        d = extract(text, allow_llm=use_llm)
        extracted.append({"id": pid, **{k: (v.value or "") for k, v in d.fields.items()}})

    pr = _pair(extracted, tms)
    tms_by_id = {t.get("id"): t for t in tms}
    result = evaluate(extracted, tms_by_id, pr["pairs"])
    result["pairing"] = {k: pr[k] for k in ("matched", "pairing_rate", "unmatched_papers")}
    result["audit_sample"] = sample_for_audit(result, float(req.get("audit_rate", 0.1)))
    if req.get("audits"):
        result["calibration"] = calibrate(result, req["audits"])
    return result


@app.get("/api/learn/stats")
def api_learn_stats(source: str = "", batch_id: str = ""):
    return learn_stats(source=source, batch_id=batch_id)


@app.get("/api/learn/filters")
def api_learn_filters():
    """标注台筛选选项：按来源（企微/H5/批量/网页）与批次。"""
    return learn_filter_options()


@app.get("/api/learn/queue")
def api_learn_queue(status: str = "pending", limit: int = 100,
                    source: str = "", batch_id: str = ""):
    return {"items": learn_queue(status, limit, source=source, batch_id=batch_id)}


@app.get("/api/learn/export.jsonl", response_class=PlainTextResponse)
def api_learn_export(limit: int = 2000):
    """导出成评测集格式，可直接追加到 samples/ 后重跑评测。"""
    return learn_export(limit)


@app.get("/api/learn/item/{run_id}")
def api_learn_item(run_id: str):
    """标注工作台：原文 + 系统抽取 + 现有金标 + 字段中文名。"""
    from .invoice import INV_LABELS
    from .schema import LABELS

    d = learn_item(run_id)
    if not d:
        raise HTTPException(status_code=404, detail="未找到该标注项")
    labels = dict(INV_LABELS) if d.get("kind") == "invoice" else dict(LABELS)
    order = list(labels)
    # 兼容历史数据里出现过的字段
    for k in d.get("fields", {}):
        if k not in labels:
            labels[k] = k
            order.append(k)
    d["labels"] = labels
    d["field_order"] = order
    return d


class LabelReq(BaseModel):
    gold: dict[str, str] = Field(default_factory=dict)
    note: str = ""


@app.post("/api/learn/label/{run_id}")
def api_learn_label(run_id: str, req: LabelReq, request: Request):
    if not req.gold:
        raise HTTPException(status_code=400, detail="金标不能为空")
    item = learn_item(run_id)
    if not item:
        raise HTTPException(status_code=404, detail="未找到该标注项")
    # 只允许该单真实存在的字段，避免导出评测集时混入脏 key
    allowed = set(item.get("fields", {}))
    bad = [k for k in req.gold if k not in allowed]
    if bad:
        raise HTTPException(status_code=400, detail=f"未知字段：{', '.join(bad[:5])}")
    try:
        return label_item(run_id, req.gold, actor=_uid(request), note=req.note)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/learn/ignore/{run_id}")
def api_learn_ignore(run_id: str, request: Request, req: dict | None = None):
    note = (req or {}).get("note", "")
    try:
        return ignore_item(run_id, actor=_uid(request), note=note)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.get("/learn")
def learn_page():
    return FileResponse(ROOT / "static" / "learn.html")


@app.post("/api/mask")
def api_mask(req: ExtractReq):
    """P0：脱敏预览。同一实体在多次调用中映射到同一代号。"""
    from .masking import MaskMap, fingerprint, mask_text

    if not req.text.strip():
        raise HTTPException(status_code=400, detail="内容为空")
    mm = MaskMap()
    masked, stats = mask_text(req.text, mm)
    mm.save()
    return {"masked": masked, "stats": stats, "fingerprint": fingerprint(req.text)}


@app.post("/api/batches")
def api_create_batch(req: dict):
    from .batchproc import new_batch

    return new_batch(req.get("name", ""), req.get("note", ""), req.get("kind", "booking"))


@app.get("/api/batches")
def api_list_batches():
    from .store import list_batches

    return {"items": list_batches()}


@app.post("/api/sampling/plan")
def api_sampling_plan(req: dict):
    """B6：按 月份 × 客户 × 格式 分层抽样。"""
    from .sampling import plan

    items = req.get("items") or []
    if not isinstance(items, list) or not items:
        raise HTTPException(status_code=400, detail="items 不能为空")
    keys = tuple(req.get("keys") or ("month", "client", "format"))
    res = plan(items, int(req.get("target", 200)), keys, int(req.get("seed", 7)))
    return res


@app.post("/api/sampling/manifest.csv", response_class=PlainTextResponse)
def api_sampling_manifest(req: dict):
    """B6：生成可打印的抽样清单（档案室照着勾）。"""
    from .sampling import manifest_csv, plan

    items = req.get("items") or []
    if not items:
        raise HTTPException(status_code=400, detail="items 不能为空")
    keys = tuple(req.get("keys") or ("month", "client", "format"))
    res = plan(items, int(req.get("target", 200)), keys, int(req.get("seed", 7)))
    return manifest_csv(res["selected"], keys)


@app.get("/api/sampling/demo")
def api_sampling_demo(target: int = 40):
    """演示：造一份档案室台账，抽样并给出覆盖情况。"""
    from .sampling import demo_inventory, plan

    inv = demo_inventory()
    res = plan(inv, target)
    return {
        "inventory": len(inv),
        "stats": res["stats"],
        "warnings": res["warnings"],
        "sample": res["selected"][:5],
    }


@app.get("/api/batches/failed")
def api_batch_failed(limit: int = 500):
    """B7：跨批次失败队列。"""
    from .store import failed_items

    items = failed_items(limit)
    return {"count": len(items), "items": items}


@app.post("/api/batches/retry-all")
def api_batch_retry_all(batch_id: str | None = None):
    """B7：一键把失败项重新排队（可只针对某个批次）。"""
    from .store import requeue_failed

    return {"requeued": requeue_failed(batch_id)}


@app.get("/api/batches/{batch_id}")
def api_batch_detail(batch_id: str):
    from .batchproc import detail

    d = detail(batch_id)
    if not d:
        raise HTTPException(status_code=404, detail="批次不存在")
    return d


@app.post("/api/batches/{batch_id}/upload")
async def api_batch_upload(batch_id: str, files: list[UploadFile] = File(...)):
    """P1：一次上传多个文件。"""
    from .batchproc import save_upload
    from .store import get_batch

    if not get_batch(batch_id):
        raise HTTPException(status_code=404, detail="批次不存在")
    if len(files) > 200:
        raise HTTPException(status_code=413, detail="单次最多 200 个文件")

    saved = []
    for f in files:
        data = await f.read()
        if len(data) > MAX_UPLOAD:
            raise HTTPException(status_code=413, detail=f"{f.filename} 超过 10MB")
        saved.append(save_upload(batch_id, f.filename or "unnamed", data))
    return {"count": len(saved), "items": saved}


@app.post("/api/batches/{batch_id}/process")
def api_batch_process(batch_id: str, request: Request, use_llm: bool = False, mask: bool = True):
    """启动后台处理；重复点击不会重复跑。"""
    from .batchproc import start_processing
    from .store import get_batch

    if not get_batch(batch_id):
        raise HTTPException(status_code=404, detail="批次不存在")
    started = start_processing(batch_id, use_llm=use_llm, do_mask=mask, actor=_uid(request))
    return {"started": started, "note": "" if started else "该批次已在处理中"}


@app.post("/api/batches/{batch_id}/retry")
def api_batch_retry(batch_id: str):
    from .batchproc import retry_failed

    return {"requeued": retry_failed(batch_id)}


@app.get("/api/batches/{batch_id}/gold.csv", response_class=PlainTextResponse)
def api_batch_gold(batch_id: str):
    """导出金标模板：gold_* 留空，pred_* 带系统值，text 带原文。"""
    from .batchgold import export_template
    from .store import get_batch

    if not get_batch(batch_id):
        raise HTTPException(status_code=404, detail="批次不存在")
    try:
        content = export_template(batch_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return PlainTextResponse(
        content,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition":
                 f'attachment; filename="batch-{batch_id}-gold.csv"'},
    )


@app.post("/api/batches/{batch_id}/gold-eval")
def api_batch_gold_eval(batch_id: str, req: dict, request: Request):
    """导入填好的金标 CSV，逐字段比对。"""
    from .batchgold import evaluate_csv
    from .store import get_batch

    if not get_batch(batch_id):
        raise HTTPException(status_code=404, detail="批次不存在")
    text = str(req.get("csv") or "")
    if not text.strip():
        raise HTTPException(status_code=400, detail="CSV 为空")
    if len(text) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="CSV 超过 10MB")
    try:
        return evaluate_csv(batch_id, text, actor=_uid(request))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@app.get("/api/invoice/meta")
def api_invoice_meta():
    from .invoice import INVOICE_SPECS

    return {
        "fields": [
            {"key": s.key, "label": s.label, "blocking": s.blocking, "placeholder": s.example}
            for s in INVOICE_SPECS
        ],
        "llm_enabled": settings.llm_enabled,
        "model": settings.model if settings.llm_enabled else "rule-based-v1",
    }


def _invoice_response(draft, run_id: str, extra: dict | None = None) -> dict:
    from .invoice import INV_LABELS

    body = {
        "run_id": run_id,
        "kind": "invoice",
        "engine": draft.engine,
        "elapsed_ms": draft.elapsed_ms,
        "tokens": draft.tokens,
        "note": draft.note,
        "review_level": draft.review_level,
        "blocking": any(c.level == "error" for c in draft.checks),
        "fields": {
            k: {"value": v.value, "confidence": v.confidence, "source": v.source,
                "label": INV_LABELS.get(k, k)}
            for k, v in draft.fields.items()
        },
        "checks": [c.model_dump() for c in draft.checks],
    }
    if extra:
        body.update(extra)
    return body


@app.post("/api/invoice/extract")
def api_invoice_extract(req: ExtractReq, request: Request):
    """04b：发票识别。复用托书底座，只换 schema 与校验。"""
    from .invoice import extract_invoice

    if not req.text.strip():
        raise HTTPException(status_code=400, detail="发票内容为空")
    draft = extract_invoice(req.text, allow_llm=req.use_llm)
    run_id = save_run(req.text, draft, kind="invoice", actor=_uid(request))
    return _invoice_response(draft, run_id)


@app.post("/api/invoice/upload")
async def api_invoice_upload(request: Request, file: UploadFile = File(...), use_llm: bool = True):
    from .invoice import extract_invoice

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="文件为空")
    if len(data) > MAX_UPLOAD:
        raise HTTPException(status_code=413, detail="文件超过 10MB")
    try:
        res = ocr.extract(file.filename or "", data)
    except ocr.OcrUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"OCR 不可用：{exc}")
    if not res.text.strip():
        raise HTTPException(status_code=422, detail="未能从文件中识别出文字")
    stored = storage.save(data, file.filename or "", "invoice")
    draft = extract_invoice(res.text, allow_llm=use_llm)
    run_id = save_run(res.text, draft, kind="invoice", actor=_uid(request), source_file=stored)
    return _invoice_response(draft, run_id, {
        "ocr": {"pages": res.pages, "used_ocr": res.used_ocr, "note": res.note},
        "raw_text": res.text,
        "source_file": stored,
    })


@app.get("/api/files/{rel:path}")
def api_file(rel: str):
    """回读原件（A4）：审计时用来看"系统当时看到的到底是什么"。

    local 后端直接交给 FileResponse（支持 Range）；S3 后端由服务端代理读取，
    不让浏览器直连对象存储，私有化部署时客户端网络往往到不了存储端点。
    """
    try:
        obj = storage.open_for_read(rel)
    except storage.StorageError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    if obj is None:
        raise HTTPException(status_code=404, detail="原件不存在")
    if isinstance(obj, Path):
        return FileResponse(obj)
    data, media_type = obj
    return Response(content=data, media_type=media_type)


@app.get("/api/storage")
def api_storage():
    try:
        return {**storage.usage(), "health": storage.health()}
    except storage.StorageError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@app.post("/api/batches/{batch_id}/cancel")
def api_batch_cancel(batch_id: str):
    from .batchproc import cancel
    from .store import get_batch

    if not get_batch(batch_id):
        raise HTTPException(status_code=404, detail="批次不存在")
    stopped = cancel(batch_id)
    return {"canceled": stopped, "note": "" if stopped else "该批次当前没有在跑"}


@app.get("/invoice")
def invoice_page():
    return FileResponse(ROOT / "static" / "invoice.html")


@app.post("/api/threeway/match")
def api_threeway(req: dict):
    """三单匹配：订单 ↔ 运单 ↔ 发票。

    入参可直接传结构化字段；也可传原文（booking_text / invoice_text），服务端先抽取。
    """
    from .invoice import extract_invoice
    from .threeway import match, verdict_text

    booking = dict(req.get("booking") or {})
    waybill = dict(req.get("waybill") or {})
    invoice = dict(req.get("invoice") or {})

    if req.get("booking_text"):
        d = extract(req["booking_text"], allow_llm=bool(req.get("use_llm", False)))
        booking = {k: (v.value or "") for k, v in d.fields.items()}
    if req.get("invoice_text"):
        d = extract_invoice(req["invoice_text"], allow_llm=bool(req.get("use_llm", False)))
        invoice = {k: (v.value or "") for k, v in d.fields.items()}
    if req.get("waybill_text"):
        d = extract(req["waybill_text"], allow_llm=bool(req.get("use_llm", False)))
        waybill = {k: (v.value or "") for k, v in d.fields.items()}

    if not booking and not waybill and not invoice:
        raise HTTPException(status_code=400, detail="至少提供一方数据")

    result = match(booking, waybill, invoice)
    result["verdict"] = verdict_text(result)
    return result


@app.get("/api/threeway/demo")
def api_threeway_demo():
    """跑三种情况：一致 / 金额不符 / 箱号不符。"""
    from .threeway import match, verdict_text

    base_booking = {"client": "宁波宏运集卡运输有限公司", "container_no": "CSQU3054383,TCLU1234568",
                    "container_qty": "2", "freight": "2600"}
    base_waybill = {"client": "宁波宏运集卡运输有限公司", "container_no": "CSQU3054383,TCLU1234568",
                    "freight": "2600", "amount": "2600"}
    base_invoice = {"buyer_name": "宁波宏运集卡运输有限公司", "total_amount": "2600.00",
                    "amount": "2300.88", "tax_amount": "299.12"}

    cases = {
        "正常一致": (base_booking, base_waybill, base_invoice),
        "金额不符": (base_booking, {**base_waybill, "freight": "2400"},
                 {**base_invoice, "total_amount": "2600.00"}),
        "箱号不符": (base_booking, {**base_waybill, "container_no": "CSQU3054383"},
                 base_invoice),
    }
    out = {}
    for name, (b, w, i) in cases.items():
        r = match(b, w, i)
        out[name] = {"overall": r["overall"], "verdict": verdict_text(r),
                     "dimensions": r["dimensions"]}
    return out


@app.get("/threeway")
def threeway_page():
    return FileResponse(ROOT / "static" / "threeway.html")




# ---------------------------------------------------------------- 试点一：对账单/结算单抽取

@app.post("/api/statement/extract")
def api_statement_extract(req: dict):
    """对账单文本/CSV/Excel 粘贴 → 标准 StatementDocument。"""
    from .statement import parse_statement_text

    text = (req.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="对账单内容为空")
    try:
        doc = parse_statement_text(
            text,
            document_id=req.get("document_id"),
            source_format=req.get("source_format"),
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {
        "ok": True,
        "data": doc,
        "warnings": doc.get("warnings", []),
        "meta": {
            "engine": doc.get("engine", "rule-text-v1"),
            "elapsed_ms": doc.get("elapsed_ms", 0),
            "document_id": doc.get("document_id"),
            "needs_review": doc.get("needs_review", False),
        },
    }


@app.post("/api/statement/extract/file")
async def api_statement_extract_file(
    file: UploadFile = File(...),
    source_format: str = "text",
    document_id: str | None = None,
):
    """对账单文件：文本直读 + PDF/图片 OCR。"""
    from .statement import norm_source_format, parse_statement_text

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="文件为空")
    if len(data) > MAX_UPLOAD:
        raise HTTPException(status_code=413, detail="文件超过 10MB")
    try:
        res = ocr.extract(file.filename or "", data)
    except ocr.OcrUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"OCR 不可用：{exc}") from exc
    if not res.text.strip():
        raise HTTPException(status_code=422, detail="未能从文件中识别出文字")
    fmt = source_format if source_format != "text" else norm_source_format(None, file.filename)
    try:
        doc = parse_statement_text(
            res.text,
            document_id=document_id or (file.filename or None),
            source_format=fmt,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {
        "ok": True,
        "data": doc,
        "warnings": doc.get("warnings", []),
        "meta": {
            "needs_review": doc.get("needs_review", False),
            "ocr": {"pages": res.pages, "used_ocr": res.used_ocr, "note": res.note},
        },
    }


@app.post("/api/settlement/extract")
def api_settlement_extract(req: dict):
    """结算单文本/CSV/Excel 粘贴 → 标准 SettlementDocument。"""
    from .settlement_extract import parse_settlement_text

    text = (req.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="结算单内容为空")
    try:
        doc = parse_settlement_text(
            text,
            document_id=req.get("document_id"),
            source_format=req.get("source_format"),
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {
        "ok": True,
        "data": doc,
        "warnings": doc.get("warnings", []),
        "meta": {
            "engine": doc.get("engine", "rule-text-v1"),
            "elapsed_ms": doc.get("elapsed_ms", 0),
            "document_id": doc.get("document_id"),
            "needs_review": doc.get("needs_review", False),
        },
    }


@app.post("/api/settlement/extract/file")
async def api_settlement_extract_file(
    file: UploadFile = File(...),
    source_format: str = "text",
    document_id: str | None = None,
):
    """结算单文件：文本直读 + PDF/图片 OCR。"""
    from .settlement_extract import norm_source_format, parse_settlement_text

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="文件为空")
    if len(data) > MAX_UPLOAD:
        raise HTTPException(status_code=413, detail="文件超过 10MB")
    try:
        res = ocr.extract(file.filename or "", data)
    except ocr.OcrUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"OCR 不可用：{exc}") from exc
    if not res.text.strip():
        raise HTTPException(status_code=422, detail="未能从文件中识别出文字")
    fmt = source_format if source_format != "text" else norm_source_format(None, file.filename)
    try:
        doc = parse_settlement_text(
            res.text,
            document_id=document_id or (file.filename or None),
            source_format=fmt,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {
        "ok": True,
        "data": doc,
        "warnings": doc.get("warnings", []),
        "meta": {
            "needs_review": doc.get("needs_review", False),
            "ocr": {"pages": res.pages, "used_ocr": res.used_ocr, "note": res.note},
        },
    }




# ---------------------------------------------------------------- 试点一：复核页

@app.get("/pilot")
def pilot_page():
    return FileResponse(ROOT / "static" / "pilot.html")


@app.get("/api/pilot/demo")
def api_pilot_demo():
    """示例：原始文本 + 运单 + 合同价，供复核页一键加载。"""
    base = ROOT.parent / "会客包" / "试点一" / "samples"
    waybills = []
    wp = base / "waybills.example.jsonl"
    if wp.exists():
        waybills = [json.loads(line) for line in wp.read_text(encoding="utf-8").splitlines() if line.strip()]
    return {
        "statement_text": (base / "statement_raw.example.txt").read_text(encoding="utf-8"),
        "settlement_text": (base / "settlement_raw.example.txt").read_text(encoding="utf-8"),
        "rates_text": (base / "contract_rates.example.txt").read_text(encoding="utf-8"),
        "waybills": waybills,
    }


@app.post("/api/pilot/review")
def api_pilot_review(req: dict):
    """抽取（或接收已抽取文档）→ 规则比对 → 差异解释。"""
    from .diff_explain import explain_differences
    from .reconcile import reconcile
    from .settlement import parse_rates, settle
    from .settlement_extract import parse_settlement_text, to_bills, to_differences as settlement_differences
    from .statement import parse_statement_text, to_differences as statement_differences, to_reconcile_rows
    from .store import confirmed_waybills

    kind = (req.get("kind") or "statement").strip()
    if kind not in {"statement", "settlement"}:
        raise HTTPException(status_code=400, detail="kind 必须是 statement 或 settlement")

    document = req.get("document")
    if document:
        doc = document
    else:
        text = (req.get("text") or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="内容为空")
        try:
            if kind == "statement":
                doc = parse_statement_text(
                    text, document_id=req.get("document_id"), source_format=req.get("source_format")
                )
            else:
                doc = parse_settlement_text(
                    text, document_id=req.get("document_id"), source_format=req.get("source_format")
                )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    if kind == "statement":
        waybills = req.get("waybills") or confirmed_waybills()
        if not waybills:
            raise HTTPException(status_code=409, detail="没有可比对的运单（请先确认托书，或传 waybills）")
        result = reconcile(to_reconcile_rows(doc), waybills)
        diffs = explain_differences(
            statement_differences(doc, result),
            context={"kind": "statement", "customer_name": doc.get("customer_name")},
        )
    else:
        rates = req.get("rates") or parse_rates((req.get("rates_text") or "").strip())
        if not rates:
            raise HTTPException(status_code=400, detail="合同价表为空或无法解析")
        result = settle(rates, to_bills(doc))
        diffs = explain_differences(
            settlement_differences(doc, result),
            context={"kind": "settlement", "carrier_name": doc.get("carrier_name")},
        )

    return {
        "ok": True,
        "kind": kind,
        "document": doc,
        "result": result,
        "differences": diffs,
        "meta": {
            "engine": doc.get("engine", "rule-text-v1"),
            "needs_review": doc.get("needs_review", False),
            "warnings": doc.get("warnings", []),
        },
    }


@app.post("/api/pilot/reviews")
def api_pilot_review_save(req: dict, request: Request):
    """保存复核结果（本地幂等）。"""
    kind = (req.get("kind") or "").strip()
    document = req.get("document")
    if kind not in {"statement", "settlement"} or not isinstance(document, dict):
        raise HTTPException(status_code=400, detail="kind/document 不合法")
    decisions = req.get("decisions") or []
    differences = req.get("differences") or []
    summary = req.get("summary") or {}
    if not isinstance(decisions, list) or not isinstance(differences, list):
        raise HTTPException(status_code=400, detail="differences/decisions 必须是数组")
    return save_pilot_review(
        kind, document, differences, decisions,
        actor=_uid(request), summary=summary,
    )


@app.get("/api/pilot/reviews")
def api_pilot_reviews(limit: int = 50):
    return {"items": list_pilot_reviews(min(max(limit, 1), 200))}


@app.get("/api/pilot/reviews/{review_id}")
def api_pilot_review_get(review_id: str):
    review = get_pilot_review(review_id)
    if not review:
        raise HTTPException(status_code=404, detail="复核记录不存在")
    return review


@app.post("/api/pilot/reviews/{review_id}/push")
def api_pilot_review_push(review_id: str, req: dict):
    """把复核结果写到交付平台的对账记录。"""
    review = get_pilot_review(review_id)
    if not review:
        raise HTTPException(status_code=404, detail="复核记录不存在")
    try:
        result = delivery.push_pilot_review(review, req.get("engagement_id"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    updated = mark_pilot_review_delivery(review_id, result.get("status", "pending"), result)
    return {"ok": result.get("ok", False), "delivery": result, "review": updated}


# ---------------------------------------------------------------- 对账

@app.post("/api/reconcile")
def api_reconcile(req: dict):
    """账单级自动对账。

    入参：
      statement       结构化对账单（可选，优先）
      statement_text  对账单原文（CSV/制表符/空格分隔均支持）
      waybills        系统运单（可选，不传则从已确认的托书里取）
      explain         是否生成差异解释（规则 + 可选大模型）
    """
    from .diff_explain import explain_differences
    from .reconcile import parse_statement, reconcile
    from .statement import parse_statement_text, to_differences, to_reconcile_rows
    from .store import confirmed_waybills

    statement_doc = req.get("statement")
    text = (req.get("statement_text") or "").strip()

    if statement_doc:
        rows = to_reconcile_rows(statement_doc)
        doc = statement_doc
        meta = {"mode": "structured", "mapping": {}, "parsed_rows": len(rows)}
    else:
        if not text:
            raise HTTPException(status_code=400, detail="对账单内容为空")
        try:
            doc = parse_statement_text(
                text,
                document_id=req.get("document_id"),
                source_format=req.get("source_format"),
            )
            rows = to_reconcile_rows(doc)
            meta = {"mode": "text-v2", "mapping": {}, "parsed_rows": len(rows)}
        except ValueError:
            parsed = parse_statement(text)
            if not parsed["rows"]:
                raise HTTPException(status_code=422, detail="未能从对账单中解析出数据行")
            rows = parsed["rows"]
            doc = {
                "document_id": req.get("document_id") or "stmt-live",
                "customer_name": req.get("customer_name") or "",
            }
            meta = {"mode": parsed["mode"], "mapping": parsed["mapping"], "parsed_rows": len(rows)}

    waybills = req.get("waybills")
    if not waybills:
        waybills = confirmed_waybills()
    if not waybills:
        raise HTTPException(status_code=409,
                            detail="系统里没有已确认的运单，无法对账（请先确认托书，或手动传 waybills）")

    result = reconcile(rows, waybills)
    result["statement_meta"] = meta
    from . import thresholds as th
    explain = req.get("explain")
    if explain is None:
        explain = th.get_bool("reconcile.explain_default")
    if explain:
        diffs = explain_differences(
            to_differences(doc, result),
            context={"kind": "statement", "customer_name": doc.get("customer_name")},
        )
        result["differences"] = diffs
        result["explanation_meta"] = {
            "count": len(diffs),
            "engines": sorted({d.get("source", "rule") for d in diffs}),
        }
    return result


@app.post("/api/reconcile/file")
async def api_reconcile_file(file: UploadFile = File(...), explain: bool = Form(False)):
    """对账单文件：文本直读 + PDF/图片 OCR，再走同一套对账。"""
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="文件为空")
    if len(data) > MAX_UPLOAD:
        raise HTTPException(status_code=413, detail="文件超过 10MB")
    try:
        res = ocr.extract(file.filename or "", data)
    except ocr.OcrUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"OCR 不可用：{exc}") from exc
    text = (res.text or "").strip()
    if not text:
        raise HTTPException(status_code=422, detail="未能从对账单中识别出文字，请检查清晰度或改用粘贴")
    result = api_reconcile({"statement_text": text, "explain": explain})
    result["ocr_text"] = text
    result["ocr_engine"] = getattr(res, "engine", "") or "ocr"
    return result


@app.post("/api/reconcile/export.csv", response_class=PlainTextResponse)
def api_reconcile_export(req: dict):
    from .reconcile import export_csv, parse_statement, reconcile
    from .statement import parse_statement_text, to_reconcile_rows
    from .store import confirmed_waybills

    if req.get("statement"):
        rows = to_reconcile_rows(req["statement"])
    else:
        text = (req.get("statement_text") or "").strip()
        try:
            doc = parse_statement_text(text, document_id=req.get("document_id"))
            rows = to_reconcile_rows(doc)
        except ValueError:
            parsed = parse_statement(text)
            rows = parsed["rows"]
    waybills = req.get("waybills") or confirmed_waybills()
    return export_csv(reconcile(rows, waybills))


@app.get("/api/reconcile/demo")
def api_reconcile_demo():
    """造一张对账单：11 条里 8 条一致、2 条金额不符、1 条系统没有；系统另有 1 条对账单没报。"""
    from .reconcile import reconcile

    waybills = []
    for i in range(10):
        waybills.append({
            "booking_no": f"HY-{1100 + i}",
            "container_no": f"CSQU30543{80 + i:02d}",
            "client": "宁波宏运集卡运输有限公司",
            "freight": f"{2400 + i * 50}",
        })
    waybills.append({"booking_no": "HY-1199", "container_no": "TCLU1234599",
                     "client": "宁波宏运集卡运输有限公司", "freight": "2600"})

    rows = [{"booking_no": w["booking_no"], "container_no": w["container_no"],
             "amount": w["freight"]} for w in waybills[:10]]
    # 两条金额对不上
    rows[2]["amount"] = str(int(rows[2]["amount"]) - 150)
    rows[7]["amount"] = str(int(rows[7]["amount"]) + 80)
    # 一条系统里没有
    rows.append({"booking_no": "HY-8888", "container_no": "MSCU9999999", "amount": "2300"})

    lines = ["运单号,箱号,金额"] + [f'{r["booking_no"]},{r["container_no"]},{r["amount"]}' for r in rows]
    r = reconcile(rows, waybills)
    return {"statement_text": "\n".join(lines), "result": r}


@app.get("/reconcile")
def reconcile_page():
    return FileResponse(ROOT / "static" / "reconcile.html")


@app.post("/api/aging")
def api_aging(req: dict):
    """账龄分析：应收台账 → 分档 + 客户风险 + 催收建议。

    statement_text 传应收台账（CSV/制表符/空格）；也可直接传 rows 数组。
    as_of 不传则用今天。
    """
    from datetime import date as _date

    from .aging import aging, parse_receivables

    rows = req.get("rows")
    if not rows:
        text = (req.get("text") or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="应收台账为空")
        rows = parse_receivables(text)
    if not rows:
        raise HTTPException(status_code=422, detail="未能解析出应收记录")

    as_of = None
    if req.get("as_of"):
        try:
            y, m, d = [int(x) for x in str(req["as_of"]).split("-")]
            as_of = _date(y, m, d)
        except ValueError:
            raise HTTPException(status_code=400, detail="as_of 格式应为 YYYY-MM-DD")

    return aging(rows, as_of)


@app.post("/api/aging/export.csv", response_class=PlainTextResponse)
def api_aging_export(req: dict):
    from .aging import aging, export_csv, parse_receivables

    rows = req.get("rows") or parse_receivables((req.get("text") or "").strip())
    return export_csv(aging(rows))


@app.get("/api/aging/demo")
def api_aging_demo():
    from .aging import aging, demo_rows

    return aging(demo_rows())


@app.post("/api/aging/draft")
def api_aging_draft(req: dict):
    """可选：把规则模板改写成更自然的催收措辞。数字由规则锁定，模型只改措辞。"""
    import math

    from .advice_ai import draft

    client = str(req.get("client") or "").strip()
    if not client:
        raise HTTPException(status_code=400, detail="缺少客户名称")
    try:
        count = int(req.get("count") or 0)
        outstanding = float(req.get("outstanding") or 0)
        overdue = float(req.get("overdue") or 0)
        days = int(req.get("days") or 0)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="金额/天数参数不合法")
    if not all(math.isfinite(x) for x in (outstanding, overdue)) or count < 0 or days < 0:
        raise HTTPException(status_code=400, detail="金额/天数参数不合法")

    return draft(client=client, count=count, outstanding=outstanding,
                 overdue=overdue, days=days)


@app.post("/api/margin")
def api_margin(req: dict):
    """成本归集 + 单车/单票毛利。费用优先按单号，其次车辆+日期。"""
    from .margin import analyze, parse_costs, parse_revenue

    revenue_text = str(req.get("revenue") or "").strip()
    cost_text = str(req.get("costs") or "").strip()
    if not revenue_text or not cost_text:
        raise HTTPException(status_code=400, detail="应收和费用都不能为空")
    revenue_rows = parse_revenue(revenue_text)
    cost_rows = parse_costs(cost_text)
    if not revenue_rows:
        raise HTTPException(status_code=422, detail="未解析出应收记录")
    if not cost_rows:
        raise HTTPException(status_code=422, detail="未解析出费用记录")
    return analyze(revenue_rows, cost_rows)


@app.get("/api/margin/demo")
def api_margin_demo():
    from .margin import demo

    return demo()


@app.post("/api/margin/export.csv", response_class=PlainTextResponse)
def api_margin_export(req: dict):
    from .margin import analyze, export_csv, parse_costs, parse_revenue

    revenue_text = str(req.get("revenue") or "").strip()
    cost_text = str(req.get("costs") or "").strip()
    if not revenue_text or not cost_text:
        raise HTTPException(status_code=400, detail="应收和费用都不能为空")
    result = analyze(parse_revenue(revenue_text), parse_costs(cost_text))
    return export_csv(result)


@app.get("/margin")
def margin_page():
    return FileResponse(ROOT / "static" / "margin.html")


@app.post("/api/insight")
def api_insight(req: dict):
    """经营洞察：规则汇总毛利、待分摊、逾期与风险订单，不调用大模型。"""
    from .insight import analyze

    revenue = str(req.get("revenue") or "").strip()
    costs = str(req.get("costs") or "").strip()
    receivables = str(req.get("receivables") or "").strip()
    if not revenue or not costs or not receivables:
        raise HTTPException(status_code=400, detail="应收、费用、应收台账都不能为空")
    try:
        return analyze(revenue, costs, receivables)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@app.post("/api/insight/brief")
def api_insight_brief(req: dict):
    """经营洞察 AI 解读：规则先算，模型只写简报、排序和动作草稿。"""
    from .insight import analyze
    from .insight_ai import explain

    revenue = str(req.get("revenue") or "").strip()
    costs = str(req.get("costs") or "").strip()
    receivables = str(req.get("receivables") or "").strip()
    if not revenue or not costs or not receivables:
        raise HTTPException(status_code=400, detail="应收、费用、应收台账都不能为空")
    try:
        result = analyze(revenue, costs, receivables)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"result": result, "ai": explain(result)}


@app.get("/api/insight/demo")
def api_insight_demo():
    from .insight import demo

    return demo()


@app.get("/insight")
def insight_page():
    return FileResponse(ROOT / "static" / "insight.html")


@app.post("/api/events")
def api_events(req: dict):
    """在途异常事件抽取：规则先抽，模型只补充有原文证据的事件。"""
    from .events import extract_events

    text = str(req.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="聊天内容为空")
    if len(text) > 20000:
        raise HTTPException(status_code=413, detail="文本超过 20000 字")
    return extract_events(text, use_llm=bool(req.get("use_llm", True)))


@app.get("/api/events/demo")
def api_events_demo():
    from .events import demo

    return demo()


@app.get("/events")
def events_page():
    return FileResponse(ROOT / "static" / "events.html")


# ---------------------------------------------------------------- 知识库

@app.get("/api/kb/docs")
def api_kb_docs():
    from .kb import list_docs

    return {"items": list_docs()}


@app.post("/api/kb/docs")
def api_kb_add(req: dict):
    from .kb import add_doc

    tags = req.get("tags") or []
    if isinstance(tags, str):
        tags = [x.strip() for x in tags.replace("，", ",").split(",") if x.strip()]
    try:
        return {"ok": True, "doc": add_doc(str(req.get("title") or ""),
                                           str(req.get("text") or ""), tags)}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@app.post("/api/kb/docs/upload")
async def api_kb_upload(file: UploadFile = File(...), title: str = Form(""),
                        tags: str = Form("")):
    from .kb import add_doc

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="文件为空")
    if len(data) > MAX_UPLOAD:
        raise HTTPException(status_code=413, detail="文件超过 10MB")
    name = file.filename or "document"
    if name.lower().endswith((".txt", ".md", ".csv")):
        text = data.decode("utf-8-sig", errors="replace")
    else:
        try:
            res = ocr.extract(name, data)
        except ocr.OcrUnavailable as exc:
            raise HTTPException(status_code=503, detail=f"OCR 不可用：{exc}") from exc
        text = res.text or ""
    if not text.strip():
        raise HTTPException(status_code=422, detail="未能识别出文字")
    tag_list = [x.strip() for x in tags.replace("，", ",").split(",") if x.strip()]
    try:
        return {"ok": True, "doc": add_doc(title or name, text, tag_list)}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@app.delete("/api/kb/docs/{doc_id}")
def api_kb_delete(doc_id: str):
    from .kb import delete_doc

    return {"ok": delete_doc(doc_id)}


@app.post("/api/kb/ask")
def api_kb_ask(req: dict):
    from .kb import ask

    try:
        return ask(str(req.get("question") or ""),
                   top_k=int(req.get("top_k") or 4),
                   use_llm=bool(req.get("use_llm", True)))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/kb/demo")
def api_kb_demo():
    from .kb import demo_questions, seed_demo

    data = seed_demo()
    data["questions"] = demo_questions()
    return data


@app.get("/kb")
def kb_page():
    return FileResponse(ROOT / "static" / "kb.html")


# ---------------------------------------------------------------- 报价

@app.post("/api/quote")
def api_quote(req: dict):
    from .quote import quote

    text = str(req.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="询价内容为空")
    try:
        return quote(text, use_llm=bool(req.get("use_llm", True)))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@app.get("/api/quote/demo")
def api_quote_demo():
    from .quote import demo

    return demo()


@app.get("/api/quote/history")
def api_quote_history():
    from .quote import history

    return {"items": history()}


@app.get("/quote")
def quote_page():
    return FileResponse(ROOT / "static" / "quote.html")


# ---------------------------------------------------------------- 单证一致性

@app.post("/api/consistency")
def api_consistency(req: dict):
    from .consistency import check

    try:
        return check(str(req.get("booking") or ""),
                     str(req.get("invoice") or ""),
                     str(req.get("statement") or ""),
                     use_llm=bool(req.get("use_llm", True)))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@app.get("/api/consistency/demo")
def api_consistency_demo():
    from .consistency import demo

    return demo()


@app.get("/consistency")
def consistency_page():
    return FileResponse(ROOT / "static" / "consistency.html")


# ---------------------------------------------------------------- 关务 HS

@app.post("/api/customs/hs")
def api_customs_hs(req: dict):
    from .customs import suggest

    try:
        return suggest(str(req.get("description") or ""),
                       use_llm=bool(req.get("use_llm", True)))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@app.get("/api/customs/dict")
def api_customs_dict():
    from .customs import list_items

    return {"items": list_items()}


@app.post("/api/customs/dict/import")
def api_customs_import(req: dict):
    from .customs import import_csv

    try:
        return import_csv(str(req.get("csv") or ""))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@app.post("/api/customs/demo")
def api_customs_demo():
    from .customs import demo

    return demo()


@app.get("/customs")
def customs_page():
    return FileResponse(ROOT / "static" / "customs.html")


# ---------------------------------------------------------------- 客户查询/调度/预测

@app.post("/api/track/query")
def api_track_query(req: dict):
    from .tracking import answer

    try:
        return answer(str(req.get("question") or ""),
                      use_llm=bool(req.get("use_llm", True)))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/track/demo")
def api_track_demo():
    from .tracking import demo

    return demo()


@app.get("/track")
def track_page():
    return FileResponse(ROOT / "static" / "track.html")


@app.get("/api/dispatch/demo")
def api_dispatch_demo():
    from .dispatch import demo

    return demo()


@app.get("/dispatch")
def dispatch_page():
    return FileResponse(ROOT / "static" / "dispatch.html")


@app.get("/api/ops/ai/llm")
def api_aiops_llm():
    from . import llm_usage

    return {"usage": llm_usage.stats(7), "budget": llm_usage.budget(),
            "snapshot": llm_usage.snapshot()}


@app.post("/api/ops/ai/llm/budget")
def api_aiops_llm_budget(req: dict):
    from . import llm_usage

    return llm_usage.set_budget(
        balance_cny=req.get("balance_cny"),
        quota_tokens=req.get("quota_tokens"),
        key_expires_at=req.get("key_expires_at"),
        model_retires_at=req.get("model_retires_at"),
        price_per_1k=req.get("price_per_1k"),
    )


@app.post("/api/ops/ai/collect")
def api_aiops_collect():
    from . import aiops

    return aiops.collect()


@app.get("/api/ops/ai/state")
def api_aiops_state():
    from . import aiops

    return {"summary": aiops.summary(), **aiops.state()}


@app.get("/api/ops/ai/summary")
def api_aiops_summary():
    from . import aiops

    return aiops.summary()


@app.get("/api/ops/ai/demo")
def api_aiops_demo(scenario: str = "mixed"):
    from . import aiops

    return aiops.demo(scenario)


@app.post("/api/ops/ai/evaluate")
def api_aiops_evaluate(req: dict):
    from . import aiops

    snapshot = req.get("snapshot")
    if not isinstance(snapshot, dict) or not snapshot:
        snapshot = aiops.demo_snapshot(str(req.get("scenario") or "mixed"))
    return aiops.evaluate(snapshot)


@app.post("/api/ops/ai/incidents/{incident_id}/diagnose")
def api_aiops_diagnose(incident_id: str, req: dict):
    from . import aiops

    try:
        return aiops.diagnose_incident(incident_id, use_llm=bool(req.get("use_llm", True)))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/api/ops/ai/incidents/{incident_id}/notify")
def api_aiops_notify(incident_id: str, req: dict):
    from . import aiops

    try:
        return aiops.notify_incident(
            incident_id, force=bool(req.get("force", False)))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/api/ops/ai/incidents/{incident_id}/ack")
def api_aiops_ack(incident_id: str, req: dict):
    from . import aiops

    try:
        return aiops.ack_incident(incident_id, by=str(req.get("by") or "on-call"))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/api/ops/ai/incidents/{incident_id}/resolve")
def api_aiops_resolve(incident_id: str, req: dict):
    from . import aiops

    try:
        return aiops.resolve_incident(
            incident_id, by=str(req.get("by") or "on-call"),
            note=str(req.get("note") or ""),
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/api/ops/ai/runbooks/{name}/plan")
def api_aiops_runbook_plan(name: str, req: dict):
    from . import aiops

    try:
        return aiops.plan_runbook(name, str(req.get("target") or ""))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/api/ops/ai/reset")
def api_aiops_reset():
    from . import aiops

    return aiops.reset()


@app.get("/ops-ai")
def ops_ai_page():
    return FileResponse(ROOT / "static" / "ops_ai.html")


@app.get("/api/ops/eval")
def api_ops_eval():
    from .ops_eval import evaluate

    return evaluate()


@app.get("/ops-eval")
def ops_eval_page():
    return FileResponse(ROOT / "static" / "ops_eval.html")


@app.get("/api/forecast/demo")
def api_forecast_demo():
    from .forecast import demo

    return demo()


@app.get("/forecast")
def forecast_page():
    return FileResponse(ROOT / "static" / "forecast.html")


@app.get("/api/fleet/demo")
def api_fleet_demo():
    """车队能源/线路决策演示：公开资料 + 合成运营数据，规则测算。"""
    from .fleet import demo

    return demo()


@app.post("/api/fleet/brief")
def api_fleet_brief():
    """车队能源/线路决策 AI 解读：规则先算，模型只写简报、排序和动作草稿。"""
    from .fleet import demo
    from .fleet_ai import explain

    result = demo()
    return {"result": result, "ai": explain(result)}


@app.get("/fleet")
def fleet_page():
    return FileResponse(ROOT / "static" / "fleet.html")


@app.get("/api/profit/demo")
def api_profit_demo():
    from .profit import demo

    return demo()


@app.get("/profit")
def profit_page():
    return FileResponse(ROOT / "static" / "profit.html")


@app.get("/aging")
def aging_page():
    return FileResponse(ROOT / "static" / "aging.html")


@app.post("/api/settlement")
def api_settlement(req: dict):
    """外协结算：合同价 × 数量 = 应付，与车队报账比对。

    入参可传结构化 settlement，也可传 bill_text；explain=true 时生成差异解释。
    """
    from .diff_explain import explain_differences
    from .settlement import parse_bills, parse_rates, settle
    from .settlement_extract import parse_settlement_text, to_bills, to_differences

    settlement_doc = req.get("settlement")
    rates = req.get("rates") or parse_rates((req.get("rate_text") or "").strip())
    if settlement_doc:
        bills = to_bills(settlement_doc)
        doc = settlement_doc
    elif req.get("bills"):
        bills = req.get("bills")
        doc = {
            "document_id": req.get("document_id") or "set-live",
            "carrier_name": req.get("carrier_name") or (bills[0].get("carrier") if bills else ""),
        }
    else:
        bill_text = (req.get("bill_text") or "").strip()
        try:
            doc = parse_settlement_text(
                bill_text,
                document_id=req.get("document_id"),
                source_format=req.get("source_format"),
            )
            bills = to_bills(doc)
        except ValueError:
            bills = parse_bills(bill_text)
            doc = {
                "document_id": req.get("document_id") or "set-live",
                "carrier_name": req.get("carrier_name") or "",
            }
    if not rates:
        raise HTTPException(status_code=400, detail="合同价表为空或无法解析")
    if not bills:
        raise HTTPException(status_code=400, detail="车队结算单为空或无法解析")

    result = settle(rates, bills)
    if req.get("explain"):
        diffs = explain_differences(
            to_differences(doc, result),
            context={"kind": "settlement", "carrier_name": doc.get("carrier_name")},
        )
        result["differences"] = diffs
        result["explanation_meta"] = {
            "count": len(diffs),
            "engines": sorted({d.get("source", "rule") for d in diffs}),
        }
    return result


@app.post("/api/settlement/export.csv", response_class=PlainTextResponse)
def api_settlement_export(req: dict):
    from .settlement import export_csv, parse_bills, parse_rates, settle
    from .settlement_extract import parse_settlement_text, to_bills

    rates = req.get("rates") or parse_rates((req.get("rate_text") or "").strip())
    if req.get("settlement"):
        bills = to_bills(req["settlement"])
    elif req.get("bills"):
        bills = req.get("bills")
    else:
        bill_text = (req.get("bill_text") or "").strip()
        try:
            doc = parse_settlement_text(bill_text, document_id=req.get("document_id"))
            bills = to_bills(doc)
        except ValueError:
            bills = parse_bills(bill_text)
    return export_csv(settle(rates, bills))


@app.get("/api/settlement/demo")
def api_settlement_demo():
    from .settlement import demo_data

    return demo_data()


@app.get("/demo")
def demo_page():
    return FileResponse(ROOT / "static" / "demo.html")


@app.get("/settlement")
def settlement_page():
    return FileResponse(ROOT / "static" / "settlement.html")


@app.get("/api/queue")
def api_queue(limit: int = 50):
    """人工兜底队列：需复核但未确认的单。"""
    return {"items": queue(limit)}


@app.get("/api/metrics")
def api_metrics():
    from . import thresholds as th
    return metrics(th.get("metrics.baseline_manual_sec"))


@app.get("/api/risk-sim")
def api_risk_sim(monthly_tickets: int = 2000, penalty: float = 8300.0,
                 threshold: float = 0.9):
    """C5：取消人工确认的后果测算。参数默认值需按客户实际情况传。"""
    from . import thresholds as th
    return risk_sim(monthly_tickets, penalty, threshold,
                    th.get("metrics.hourly_cost"), th.get("metrics.baseline_manual_sec"))


@app.get("/api/report.md", response_class=PlainTextResponse)
def api_report():
    from . import thresholds as th
    return report_md(th.get("metrics.baseline_manual_sec"), th.get("metrics.hourly_cost"))


@app.get("/report", response_class=HTMLResponse)
def report_page():
    """运行月报的可读页面；原始 Markdown 仍从 /api/report.md 下载。"""
    from . import thresholds as th
    from .report_view import render_page

    return render_page(report_md(th.get("metrics.baseline_manual_sec"),
                                 th.get("metrics.hourly_cost")))


@app.get("/api/samples")
def api_samples():
    items = []
    for line in SAMPLE_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        s = json.loads(line)
        items.append({"id": s["id"], "title": s.get("title", s["id"]), "raw": s["raw"]})
    return {"samples": items}


@app.post("/api/eval")
def api_eval():
    try:
        return run_all()
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="缺少 samples/bookings.jsonl")


class DeliveryPushReq(BaseModel):
    experiment_id: str | None = None


@app.get("/api/delivery/status")
def api_delivery_status():
    """回写配置与发件箱状态（仅管理员）。"""
    return delivery.status()


@app.post("/api/delivery/push")
def api_delivery_push(req: DeliveryPushReq | None = None):
    """跑一次评测并回写交付平台（仅管理员）。

    为什么这里重跑评测而不接受前端传来的指标：
    指标必须来自服务端的评测代码，不能让调用方自己填数。
    同一份结果有幂等键，重复点不会在平台上生成第二条。
    """
    if not delivery.enabled():
        cfg = delivery.config_status()
        raise HTTPException(
            status_code=503,
            detail="回写未配置，缺少：" + ", ".join(cfg["missing"]),
        )
    result = run_all()
    queued = delivery.enqueue(result, req.experiment_id if req else None)

    # 已经成功发过：不再重发，直接告诉调用方平台上的那条 run
    if not queued["created"] and queued["status"] == "sent":
        prev = queued.get("previous") or {}
        return {
            "ok": True, "enqueued": False, "sent": 0, "retry": 0, "failed": 0,
            "run_no": prev.get("run_no"),
            "duplicate": True,
            "error": "",
        }

    flushed = delivery.flush()
    detail = (flushed.get("details") or [{}])[0]
    return {
        "ok": True,
        "enqueued": queued["created"],
        "idempotency_key": queued["idempotency_key"],
        "outbox_id": queued["outbox_id"],
        "sent": flushed.get("sent", 0),
        "retry": flushed.get("retry", 0),
        "failed": flushed.get("failed", 0),
        "run_no": detail.get("run_no"),
        "duplicate": detail.get("duplicate", False),
        "error": detail.get("error", ""),
    }


@app.post("/api/delivery/flush")
def api_delivery_flush():
    """手动重试发件箱（仅管理员）。"""
    if not delivery.enabled():
        cfg = delivery.config_status()
        raise HTTPException(
            status_code=503,
            detail="回写未配置，缺少：" + ", ".join(cfg["missing"]),
        )
    return delivery.flush()


@app.post("/api/fees/check")
def api_fees_check(req: dict):
    """异常费用识别（B6，财务/管理员）。

    入参二选一：
      {"text": "CSV/制表符费用明细"}  或  {"rows": [{booking_no, fee_name, amount, ...}]}
    """
    from .fees import check, parse_fee_text

    rows = req.get("rows")
    if rows is None:
        text = (req.get("text") or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="请提供 text 或 rows")
        try:
            rows = parse_fee_text(text)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        if not rows:
            raise HTTPException(status_code=400, detail="没有解析到费用行")
    if not isinstance(rows, list):
        raise HTTPException(status_code=400, detail="rows 必须是数组")
    return check(rows)


@app.get("/api/fees/dict")
def api_fees_dict():
    from .fees import fee_dict

    items = sorted(fee_dict())
    return {"items": items, "count": len(items)}


@app.get("/fees")
def fees_page():
    return FileResponse(ROOT / "static" / "fees.html")


@app.get("/api/admin/jobs")
def api_admin_jobs(limit: int = 100):
    """多实例任务队列（D7），仅管理员。"""
    from .batchproc import WORKER_ID
    return {"worker_backend": db.BACKEND, "worker_id": WORKER_ID,
            "items": list_jobs(limit)}


@app.get("/api/stats")
def api_stats():
    return {"summary": stats(), "recent": recent(10)}


@app.get("/api/feedback.csv", response_class=PlainTextResponse)
def api_feedback():
    rows = json.loads(dump_feedback())
    head = "run_id,ts,field,auto_value,final_value"
    lines = [head] + [
        ",".join(
            '"%s"' % str(r[k]).replace('"', '""')
            for k in ("run_id", "ts", "field", "auto_value", "final_value")
        )
        for r in rows
    ]
    return "\n".join(lines)
