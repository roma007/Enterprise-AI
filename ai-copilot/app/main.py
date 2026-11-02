"""会客 demo 服务。

刻意只做一件事：托书原文 → 结构化草稿 → 规则挑错 → 人工确认 → 留痕。
没有登录、没有权限、没有多租户 —— 演示阶段加这些只会拖慢交付。
"""
from __future__ import annotations

import json

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import ocr
from .config import ROOT, settings
from .csvio import decode_csv_bytes, export_csv, parse_tms_csv
from . import wecom
from .evalrun import SAMPLE_PATH, run_all
from .extract import extract
from .schema import BLOCKING_KEYS, FIELD_KEYS, LABELS, SPECS
from .store import (
    AlreadyConfirmed, audit, audit_csv, dump_feedback, find_amend_candidates,
    find_by_booking_no, init_db, learn_export, learn_queue, learn_stats, metrics,
    queue, recent, record_inbound, report_md, risk_sim, save_feedback, save_run, stats,
)

MAX_UPLOAD = 10 * 1024 * 1024  # 10 MB

app = FastAPI(title="集卡托书 AI 录入 · Demo", version="0.1.0")
app.mount("/static", StaticFiles(directory=str(ROOT / "static")), name="static")


@app.on_event("startup")
def _startup() -> None:
    init_db()


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
def api_extract(req: ExtractReq):
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

    run_id = save_run(req.text, draft)
    return _draft_response(draft, run_id, extra)


@app.post("/api/split")
def api_split(req: ExtractReq):
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
        rid = save_run(seg, d)
        tickets.append(_draft_response(d, rid, extra))
    return {"count": len(tickets), "tickets": tickets}


@app.post("/api/extract/upload")
async def api_upload(file: UploadFile = File(...), use_llm: bool = True):
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

    draft = extract(res.text, allow_llm=use_llm)
    run_id = save_run(res.text, draft)
    return _draft_response(draft, run_id, {
        "ocr": {"pages": res.pages, "used_ocr": res.used_ocr, "note": res.note},
        "raw_text": res.text,
    })


@app.post("/api/confirm")
def api_confirm(req: ConfirmReq):
    try:
        return save_feedback(req.run_id, req.auto, req.final, req.handle_ms)
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


@app.get("/h5")
def h5_page():
    return FileResponse(ROOT / "static" / "h5.html")


@app.get("/batch")
def batch_page():
    return FileResponse(ROOT / "static" / "batch.html")


@app.get("/api/wecom/callback", response_class=PlainTextResponse)
def wecom_verify(msg_signature: str = "", timestamp: str = "", nonce: str = "",
                 echostr: str = ""):
    """企业微信回调 URL 验证。"""
    if not wecom.verify_signature(settings.wecom_token, msg_signature, timestamp, nonce):
        raise HTTPException(status_code=403, detail="签名校验失败")
    return echostr


@app.post("/api/wecom/callback", response_class=PlainTextResponse)
async def wecom_message(request: Request, msg_signature: str = "", timestamp: str = "",
                        nonce: str = ""):
    """企业微信消息入口：先记录来单，再解析，最后被动回复。

    顺序很重要：**先 inbound 再解析**。这样即使解析失败，这条单也进了分母，
    绕过率才不会被"处理失败的单"悄悄稀释。
    """
    if not wecom.verify_signature(settings.wecom_token, msg_signature, timestamp, nonce):
        raise HTTPException(status_code=403, detail="签名校验失败")

    body = (await request.body()).decode("utf-8", errors="ignore")
    msg = wecom.parse_message(body)
    content = msg["content"].strip()

    if not content:
        return Response(
            content=wecom.build_text_reply(msg["from_user"], msg["to_user"], wecom.format_help()),
            media_type="application/xml",
        )

    record_inbound(content, source="wecom")
    draft = extract(content)
    run_id = save_run(content, draft)
    reply = wecom.format_result(draft, run_id)
    return Response(
        content=wecom.build_text_reply(msg["from_user"], msg["to_user"], reply),
        media_type="application/xml",
    )


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

    return new_batch(req.get("name", ""), req.get("note", ""))


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
def api_batch_process(batch_id: str, use_llm: bool = False, mask: bool = True):
    """启动后台处理；重复点击不会重复跑。"""
    from .batchproc import start_processing
    from .store import get_batch

    if not get_batch(batch_id):
        raise HTTPException(status_code=404, detail="批次不存在")
    started = start_processing(batch_id, use_llm=use_llm, do_mask=mask)
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
def api_invoice_extract(req: ExtractReq):
    """04b：发票识别。复用托书底座，只换 schema 与校验。"""
    from .invoice import extract_invoice

    if not req.text.strip():
        raise HTTPException(status_code=400, detail="发票内容为空")
    draft = extract_invoice(req.text, allow_llm=req.use_llm)
    run_id = save_run(req.text, draft, kind="invoice")
    return _invoice_response(draft, run_id)


@app.post("/api/invoice/upload")
async def api_invoice_upload(file: UploadFile = File(...), use_llm: bool = True):
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
    draft = extract_invoice(res.text, allow_llm=use_llm)
    run_id = save_run(res.text, draft, kind="invoice")
    return _invoice_response(draft, run_id, {
        "ocr": {"pages": res.pages, "used_ocr": res.used_ocr, "note": res.note},
        "raw_text": res.text,
    })


@app.get("/invoice")
def invoice_page():
    return FileResponse(ROOT / "static" / "invoice.html")


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
