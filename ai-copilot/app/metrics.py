"""Prometheus 指标（D4）。

为什么不用 prometheus_client：
- 只暴露几个计数，自己拼文本比多一个依赖划算
- 格式必须严格：`# HELP` / `# TYPE` / `name{label="v"} value`

指标分两类：
1. 业务面：解析量、分级分布、批次、学习队列、发件箱
2. 运行面：HTTP 请求数/耗时、数据库大小、进程启动时间、依赖可用性

注意：HTTP 计数是**进程内**的。多实例部署时每个副本各算各的，
Prometheus 汇总没问题；但如果要全局精确值，应改为写共享存储（与 D7 一起做）。
"""
from __future__ import annotations

import re
import threading
import time
from pathlib import Path

from . import db
from .config import VERSION, settings

_started = time.time()
_lock = threading.Lock()
_http: dict[tuple[str, str, int], int] = {}
_dur: dict[tuple[str, str], list[float]] = {}
_wecom_image: dict[str, int] = {}


def normalize_route(route: str) -> str:
    """把未匹配到路由的路径收敛，避免标签基数爆炸。"""
    if not route:
        return "unmatched"
    path = route.split("?")[0]
    if path.startswith("/static/"):
        return "/static"
    path = re.sub(r"/[0-9a-fA-F]{8,}(?=/|$)", "/:id", path)
    return path


def observe(method: str, route: str, status: int, duration_ms: float) -> None:
    route = normalize_route(route)
    key = (method.upper(), route, int(status))
    dkey = (method.upper(), route)
    with _lock:
        _http[key] = _http.get(key, 0) + 1
        bucket = _dur.setdefault(dkey, [0.0, 0.0])
        bucket[0] += duration_ms
        bucket[1] += 1


def inc_wecom_image(result: str) -> None:
    """企微图片链路计数：received / done / failed / duplicate / unconfigured。"""
    with _lock:
        _wecom_image[result] = _wecom_image.get(result, 0) + 1


def _esc(v: str) -> str:
    return str(v).replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")


def _family(name: str, samples: list[tuple[dict | None, object]], *,
            kind: str = "counter", help_text: str = "") -> list[str]:
    """一个指标名只输出一组 HELP/TYPE，避免重复 TYPE 报错。"""
    out = [f"# HELP {name} {help_text}", f"# TYPE {name} {kind}"]
    for labels, value in samples:
        if labels:
            lbl = ",".join(f'{k}="{_esc(v)}"' for k, v in labels.items())
            out.append(f"{name}{{{lbl}}} {value}")
        else:
            out.append(f"{name} {value}")
    return out


def _size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def render() -> str:
    from . import ocr
    from .store import ops_counts

    counts = ops_counts()
    lines: list[str] = []

    lines += _family("copilot_up", [(None, 1)], kind="gauge",
                     help_text="服务是否存活")
    lines += _family("copilot_info", [({
        "version": VERSION,
        "model": settings.model if settings.llm_enabled else "rule-based",
    }, 1)], kind="gauge", help_text="版本与模型信息")
    lines += _family("copilot_start_time_seconds", [(None, f"{_started:.0f}")],
                     kind="gauge", help_text="进程启动时间（Unix 秒）")
    lines += _family("copilot_uptime_seconds", [(None, f"{time.time() - _started:.0f}")],
                     kind="gauge", help_text="运行时长")
    lines += _family("copilot_llm_enabled", [(None, int(settings.llm_enabled))],
                     kind="gauge", help_text="是否配置了模型")
    try:
        ocr_ready = 1 if ocr.available().get("ready") else 0
    except Exception:  # noqa: BLE001
        ocr_ready = 0
    lines += _family("copilot_ocr_ready", [(None, ocr_ready)], kind="gauge",
                     help_text="OCR 依赖是否可用")

    if db.BACKEND == "postgres":
        from .store import _conn
        with _conn() as conn:
            size = conn.execute(
                "SELECT pg_database_size(current_database()) AS n"
            ).fetchone()["n"]
        lines += _family("copilot_db_size_bytes", [({"kind": "postgres"}, size)],
                         kind="gauge", help_text="数据库大小")
    else:
        path = settings.db_path
        lines += _family("copilot_db_size_bytes", [
            ({"kind": "main"}, _size(path)),
            ({"kind": "wal"}, _size(Path(str(path) + "-wal"))),
            ({"kind": "shm"}, _size(Path(str(path) + "-shm"))),
        ], kind="gauge", help_text="数据库文件大小")

    lines += _family("copilot_runs_total", [(None, counts["runs"])],
                     help_text="解析记录总数")
    lines += _family("copilot_runs_confirmed_total", [(None, counts["runs_confirmed"])],
                     help_text="已确认单据数")
    lines += _family("copilot_feedback_changed_total", [(None, counts["feedback_changed"])],
                     help_text="人工修改的字段数")
    lines += _family("copilot_review_level_total", [
        ({"level": lv}, counts["review"].get(lv, 0))
        for lv in ("auto", "single", "double", "blocked", "unknown")
    ], help_text="按复核级别分布")
    lines += _family("copilot_batches_total",
                     [(None, counts["batch"].get("total", 0))], help_text="批次数")
    lines += _family("copilot_batch_items_total", [
        ({"status": st}, counts["items"].get(st, 0))
        for st in ("pending", "extracted", "failed")
    ], help_text="批次明细状态")
    lines += _family("copilot_learn_queue_total", [
        ({"status": st}, counts["learn"].get(st, 0))
        for st in ("pending", "labeled", "ignored")
    ], help_text="学习队列状态")
    lines += _family("copilot_outbox_total", [
        ({"status": st}, counts["outbox"].get(st, 0))
        for st in ("pending", "sent", "failed")
    ], help_text="回写发件箱状态")
    lines += _family("copilot_users_active", [(None, counts["users_active"])],
                     kind="gauge", help_text="启用用户数")
    lines += _family("copilot_sessions_active", [(None, counts["sessions_active"])],
                     kind="gauge", help_text="有效会话数")

    with _lock:
        wecom_image = dict(_wecom_image)
    if wecom_image:
        lines += _family(
            "copilot_wecom_image_total",
            [({"result": k}, v) for k, v in sorted(wecom_image.items())],
            help_text="企业微信图片消息处理结果",
        )

    with _lock:
        http = dict(_http)
        dur = {k: list(v) for k, v in _dur.items()}
    if http:
        lines += _family(
            "copilot_http_requests_total",
            [({"method": m, "route": r, "status": st}, n)
             for (m, r, st), n in sorted(http.items())],
            help_text="HTTP 请求数",
        )
    if dur:
        lines += ["# HELP copilot_http_request_duration_seconds HTTP 请求耗时",
                  "# TYPE copilot_http_request_duration_seconds summary"]
        for (method, route), (total_ms, n) in sorted(dur.items()):
            lines.append(
                f'copilot_http_request_duration_seconds_sum{{method="{_esc(method)}",'
                f'route="{_esc(route)}"}} {total_ms / 1000:.6f}'
            )
            lines.append(
                f'copilot_http_request_duration_seconds_count{{method="{_esc(method)}",'
                f'route="{_esc(route)}"}} {int(n)}'
            )

    try:
        from . import aiops
        s = aiops.summary()
        lines += _family("copilot_aiops_risks_open", [(None, s["risks"])],
                         kind="gauge", help_text="未关闭的灰犀牛风险数")
        lines += _family("copilot_aiops_incidents_open", [
            ({"severity": "P0"}, s["p0"]),
            ({"severity": "P1"}, s["p1"]),
            ({"severity": "all"}, s["incidents"]),
        ], kind="gauge", help_text="未关闭的黑天鹅事件数")
    except Exception:  # noqa: BLE001
        pass

    return "\n".join(lines) + "\n"
