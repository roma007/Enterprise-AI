"""会客 demo 服务。

一件事：托书原文 → 结构化草稿 → 规则挑错 → 人工确认 → 留痕。
登录与角色见 app/auth.py；阈值见 app/thresholds.py；原件存储见 app/storage.py。
"""
from __future__ import annotations

import json
import os
import secrets
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile

from fastapi.responses import (
    FileResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response,
)

from . import auth, storage
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import ocr, wecom_crypto
from .config import ROOT, settings
from .csvio import decode_csv_bytes, export_csv, parse_tms_csv
from . import wecom
from .evalrun import SAMPLE_PATH, run_all
from .extract import extract
from .schema import BLOCKING_KEYS, FIELD_KEYS, LABELS, SPECS
from .store import (
    AlreadyConfirmed, audit, audit_csv, count_users, create_session, create_user,
    dump_feedback, find_amend_candidates, find_by_booking_no, get_user,
    get_user_by_email, init_db, ignore_item, label_item, learn_export,
    learn_item, learn_queue, learn_stats, list_users,
    metrics, queue, recent, record_inbound, report_md, revoke_session,
    revoke_user_sessions, risk_sim, save_feedback, save_run, session_valid,
    set_password, stats, touch_login, update_user,
    confirmed_recent, revisions, undo_confirm, NotConfirmed, VersionMismatch,
)

MAX_UPLOAD = 10 * 1024 * 1024  # 10 MB

app = FastAPI(title="集卡托书 AI 录入 · Demo", version="0.1.0")
app.mount("/static", StaticFiles(directory=str(ROOT / "static")), name="static")


@app.on_event("startup")
def _startup() -> None:
    init_db()
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
        return th.set_many(values, actor=_uid(request))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/settings/reset")
def api_settings_reset(req: dict, request: Request):
    from . import thresholds as th
    keys = req.get("keys") or None
    return th.reset(keys, actor=_uid(request))


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
    u = get_user_by_email(req.email)
    if not u or not u.get("active") or not auth.verify_password(
            req.password, u["pw_hash"], u["pw_salt"]):
        raise HTTPException(status_code=401, detail="邮箱或密码不正确")

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
                    max_age=auth.TOKEN_TTL, path="/")
    return resp


@app.post("/api/auth/logout")
def api_logout(request: Request):
    jti = getattr(request.state, "jti", "")
    if jti:
        revoke_session(jti)
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("sid", path="/")
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
    return {
        "ok": True,
        "llm_enabled": settings.llm_enabled,
        "model": settings.model if settings.llm_enabled else "rule-based-v1",
        "ocr": ocr.available(),
    }


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
        "baseline_manual_sec": settings.baseline_manual_sec,
        "hourly_cost": settings.hourly_cost,
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
async def api_upload(request: Request, file: UploadFile = File(...), use_llm: bool = True):
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

    stored = storage.save(data, file.filename or "", "booking")
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
    return {"items": confirmed_recent(limit)}


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


@app.post("/api/wecom/callback", response_class=PlainTextResponse)
async def wecom_message(request: Request, msg_signature: str = "", timestamp: str = "",
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
    content = msg["content"].strip()

    if not content:
        inner = wecom.build_text_reply(msg["from_user"], msg["to_user"], wecom.format_help())
        return _wecom_reply(inner, encrypted)

    record_inbound(content, source="wecom")
    draft = extract(content)
    run_id = save_run(content, draft, actor="wecom")
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
def api_learn_stats():
    return learn_stats()


@app.get("/api/learn/queue")
def api_learn_queue(status: str = "pending", limit: int = 100):
    return {"items": learn_queue(status, limit)}


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


@app.post("/api/reconcile")
def api_reconcile(req: dict):
    """账单级自动对账。

    入参：
      statement_text  对账单原文（CSV/制表符/空格分隔均支持）
      waybills        系统运单（可选，不传则从已确认的托书里取）
    """
    from .reconcile import parse_statement, reconcile
    from .store import confirmed_waybills

    text = (req.get("statement_text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="对账单内容为空")

    parsed = parse_statement(text)
    if not parsed["rows"]:
        raise HTTPException(status_code=422, detail="未能从对账单中解析出数据行")

    waybills = req.get("waybills")
    if not waybills:
        waybills = confirmed_waybills()
    if not waybills:
        raise HTTPException(status_code=409,
                            detail="系统里没有已确认的运单，无法对账（请先确认托书，或手动传 waybills）")

    result = reconcile(parsed["rows"], waybills)
    result["statement_meta"] = {"mode": parsed["mode"], "mapping": parsed["mapping"],
                                "parsed_rows": len(parsed["rows"])}
    return result


@app.post("/api/reconcile/export.csv", response_class=PlainTextResponse)
def api_reconcile_export(req: dict):
    from .reconcile import export_csv
    from .store import confirmed_waybills
    from .reconcile import parse_statement, reconcile

    parsed = parse_statement((req.get("statement_text") or "").strip())
    waybills = req.get("waybills") or confirmed_waybills()
    return export_csv(reconcile(parsed["rows"], waybills))


@app.get("/api/reconcile/demo")
def api_reconcile_demo():
    """造一张对账单：10 条正常、2 条金额错、1 条系统没有；系统另有 1 条对账单没报。"""
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


@app.get("/aging")
def aging_page():
    return FileResponse(ROOT / "static" / "aging.html")


@app.post("/api/settlement")
def api_settlement(req: dict):
    """外协结算：合同价 × 数量 = 应付，与车队报账比对。"""
    from .settlement import parse_bills, parse_rates, settle

    rates = req.get("rates") or parse_rates((req.get("rate_text") or "").strip())
    bills = req.get("bills") or parse_bills((req.get("bill_text") or "").strip())
    if not rates:
        raise HTTPException(status_code=400, detail="合同价表为空或无法解析")
    if not bills:
        raise HTTPException(status_code=400, detail="车队结算单为空或无法解析")
    return settle(rates, bills)


@app.post("/api/settlement/export.csv", response_class=PlainTextResponse)
def api_settlement_export(req: dict):
    from .settlement import export_csv, parse_bills, parse_rates, settle

    rates = req.get("rates") or parse_rates((req.get("rate_text") or "").strip())
    bills = req.get("bills") or parse_bills((req.get("bill_text") or "").strip())
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
    return metrics(settings.baseline_manual_sec)


@app.get("/api/risk-sim")
def api_risk_sim(monthly_tickets: int = 2000, penalty: float = 8300.0,
                 threshold: float = 0.9):
    """C5：取消人工确认的后果测算。参数默认值需按客户实际情况传。"""
    return risk_sim(monthly_tickets, penalty, threshold,
                    settings.hourly_cost, settings.baseline_manual_sec)


@app.get("/api/report.md", response_class=PlainTextResponse)
def api_report():
    return report_md(settings.baseline_manual_sec, settings.hourly_cost)


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
