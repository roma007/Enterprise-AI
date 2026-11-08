"""站内记录 + 企微群机器人 + 邮件通知。

设计边界：
- 通知是「告知」，不是「审批」；发不出去不能阻断业务主流程。
- 事件、渠道、静默时段、重复抑制都可配；关闭时只记录不发送。
- Webhook 与 SMTP 密码属于密钥，导出配置时不带出。
- 邮件主机/账号是部署级配置（.env）；收件人是运行级配置。
"""
from __future__ import annotations

import json
import threading
import time
from datetime import datetime
from pathlib import Path

from . import thresholds as th
from .config import ROOT

LOG_PATH = ROOT / "data" / "notifications.jsonl"
DEDUP_PATH = ROOT / "data" / "notify_dedup.json"
_LOCK = threading.Lock()

LABELS = {
    "batch_failed": "批量导入失败",
    "wecom_image_failed": "企微图片处理失败",
    "bypass_alert": "绕过率超阈值",
    "aiops_incident": "运维智能事件",
    "test": "测试消息",
}


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _parse_quiet(text: str) -> tuple[int, int] | None:
    try:
        start, end = text.split("-", 1)
        sh, sm = (int(x) for x in start.split(":"))
        eh, em = (int(x) for x in end.split(":"))
        return sh * 60 + sm, eh * 60 + em
    except (ValueError, AttributeError):
        return None


def in_quiet(now: datetime | None = None) -> bool:
    window = _parse_quiet(th.get_text("notify.quiet_hours"))
    if not window:
        return False
    start, end = window
    if start == end:
        return False
    cur = now or datetime.now()
    minute = cur.hour * 60 + cur.minute
    if start < end:
        return start <= minute < end
    return minute >= start or minute < end


def _dedup_ok(key: str, minutes: int) -> bool:
    if minutes <= 0 or not key:
        return True
    now = time.time()
    data: dict[str, float] = {}
    try:
        raw = json.loads(DEDUP_PATH.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            data = {str(k): float(v) for k, v in raw.items() if isinstance(v, (int, float))}
    except (OSError, json.JSONDecodeError):
        data = {}
    if now - data.get(key, 0) < minutes * 60:
        return False
    data[key] = now
    data = {k: v for k, v in data.items() if now - v < 7 * 86400}
    try:
        DEDUP_PATH.parent.mkdir(parents=True, exist_ok=True)
        DEDUP_PATH.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass
    return True


def _log(entry: dict) -> None:
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
        if LOG_PATH.stat().st_size > 512 * 1024:
            lines = LOG_PATH.read_text(encoding="utf-8").splitlines()[-300:]
            LOG_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except OSError:
        pass


def recent(limit: int = 20) -> list[dict]:
    try:
        lines = LOG_PATH.read_text(encoding="utf-8").splitlines()[-max(1, limit):]
    except OSError:
        return []
    out = []
    for line in reversed(lines):
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def _send_email(title: str, detail: str) -> tuple[bool, str]:
    from .config import settings

    if not settings.smtp_host:
        return False, "未配置 SMTP_HOST"
    recipients = [x.strip() for x in th.get_text("notify.email_to").replace("，", ",").split(",")
                  if x.strip()]
    if not recipients:
        return False, "未配置邮件收件人"
    from_addr = settings.smtp_from or settings.smtp_user or "noreply@zhidan.local"
    try:
        import smtplib
        from email.message import EmailMessage

        msg = EmailMessage()
        msg["Subject"] = f"[智单] {title}"
        msg["From"] = from_addr
        msg["To"] = ", ".join(recipients)
        msg.set_content(detail or title)
        if settings.smtp_tls:
            server = smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port,
                                      timeout=settings.smtp_timeout)
        else:
            server = smtplib.SMTP(settings.smtp_host, settings.smtp_port,
                                  timeout=settings.smtp_timeout)
            if settings.smtp_starttls:
                server.starttls()
        try:
            if settings.smtp_user:
                server.login(settings.smtp_user, settings.smtp_password)
            server.send_message(msg)
        finally:
            server.quit()
        return True, ""
    except Exception as exc:  # noqa: BLE001 — 通知失败不能影响主流程
        return False, f"{type(exc).__name__}: {exc}"[:200]


def _send_webhook(url: str, title: str, detail: str) -> tuple[bool, str]:
    try:
        import httpx

        content = f"**{title}**\n{detail}"[:1800]
        with httpx.Client(timeout=5) as client:
            resp = client.post(url, json={"msgtype": "markdown",
                                          "markdown": {"content": content}})
            resp.raise_for_status()
            body = resp.json()
        if isinstance(body, dict) and body.get("errcode") not in (None, 0):
            return False, f"errcode={body.get('errcode')} {body.get('errmsg', '')}"[:200]
        return True, ""
    except Exception as exc:  # noqa: BLE001 — 通知失败不能影响主流程
        return False, f"{type(exc).__name__}: {exc}"[:200]


def notify(event: str, title: str, detail: str = "", key: str = "",
           force: bool = False) -> dict:
    """发送一条通知。force=True 用于「测试发送」，忽略开关与事件订阅。"""
    if not force:
        if not th.get_bool("notify.enabled"):
            return {"ok": True, "sent": False, "skipped": "disabled"}
        if event not in th.get_list("notify.events"):
            return {"ok": True, "sent": False, "skipped": "not_subscribed"}

    dedup_key = f"{event}:{key}" if key else ""
    if not force and not _dedup_ok(dedup_key, int(th.get("notify.dedup_min"))):
        return {"ok": True, "sent": False, "skipped": "dedup"}

    channels = th.get_list("notify.channels")
    quiet = in_quiet() and not force
    results: dict[str, dict] = {}
    if quiet:
        pass
    elif not channels:
        results["_"] = {"ok": False, "error": "未选择通知渠道"}
    else:
        for channel in channels:
            if channel == "webhook":
                url = th.get_text("notify.webhook").strip()
                if not url:
                    results[channel] = {"ok": False, "error": "未配置 webhook"}
                else:
                    ok, err = _send_webhook(url, title, detail)
                    results[channel] = {"ok": ok, "error": err}
            elif channel == "email":
                ok, err = _send_email(title, detail)
                results[channel] = {"ok": ok, "error": err}
            else:
                results[channel] = {"ok": False, "error": "未知渠道"}

    sent = any(v.get("ok") for v in results.values())
    errors = [f"{k}: {v.get('error')}" for k, v in results.items() if v.get("error")]
    error = "; ".join(errors)[:300]

    entry = {
        "ts": _now(),
        "event": event,
        "label": LABELS.get(event, event),
        "title": title,
        "detail": detail[:500],
        "key": key,
        "quiet": quiet,
        "sent": sent,
        "error": error,
        "channels": results,
    }
    with _LOCK:
        _log(entry)
    return {"ok": sent, "sent": sent, "quiet": quiet,
            "skipped": "quiet" if quiet else "", "error": error,
            "channels": results}


def _bypass_loop() -> None:
    time.sleep(300)
    while True:
        try:
            if th.get_bool("notify.enabled") and th.get_list("notify.channels"):
                from .store import metrics

                data = metrics(th.get("metrics.baseline_manual_sec"))
                if data.get("bypass_alert"):
                    notify(
                        "bypass_alert",
                        "绕过率超过阈值",
                        f"当前绕过率 {data.get('bypass_rate', 0):.1%}，"
                        f"阈值 {th.get('metrics.bypass_alert'):.0%}。"
                        "此时「节省工时」可能被高估。",
                        key=datetime.now().strftime("%Y-%m-%d"),
                    )
        except Exception:  # noqa: BLE001 — 后台巡检不允许影响服务
            pass
        time.sleep(1800)


def start_watcher() -> None:
    threading.Thread(target=_bypass_loop, name="notify-watcher", daemon=True).start()
