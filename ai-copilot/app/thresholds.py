"""运行时可调的阈值（A3）。

问题：`RISK_AUTO_FLOOR=0.90`、`MATCH_TOLERANCE=0.01` 这些写死在 5 个模块里。
客户现场说"太严了，放宽到 0.85"，就得改代码、重新部署。

做法：
- 存 JSON 文件 `data/settings.json`（不进版本库），带 mtime 缓存，改了立即生效
- 每个阈值有默认值、范围、说明，非法值直接拒绝
- 只让管理员改（API 层控制角色）

为什么用文件而不是数据库表：
1. 避免 thresholds → store → rules → thresholds 的循环依赖
2. 配置文件本来就不该跟业务数据混在一起，备份和回滚更简单
3. 单进程读取，mtime 缓存足够；多进程时最坏是几秒延迟
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from . import db
from .config import ROOT
from .schema import BLOCKING_KEYS, SPEC_MAP

PATH = ROOT / "data" / "settings.json"
TPL_PLACEHOLDERS = ("client", "count", "outstanding", "overdue", "days")
HISTORY_PATH = ROOT / "data" / "settings_history.json"
HISTORY_MAX = 300
_lock = threading.Lock()
_cache: dict | None = None
_cache_mtime: float = -1.0
_cache_at: float = 0.0
_DB_TTL = 2.0  # PG 多实例：最多 2 秒看到别的实例的修改


def _env_num(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return float(default)


SPECS: list[dict] = [
    # ---- 托书解析 ----
    {"key": "booking.risk_auto_floor", "group": "托书解析", "default": 0.90,
     "min": 0.50, "max": 1.0, "step": 0.01,
     "label": "风险字段自动通过阈值",
     "hint": "箱号/箱型/箱量/截港/电话 全部 ≥ 该值才允许自动通过"},
    {"key": "booking.low_conf_floor", "group": "托书解析", "default": 0.80,
     "min": 0.30, "max": 1.0, "step": 0.01,
     "label": "双人复核下限",
     "hint": "必填或风险字段低于该值 → 转双人复核"},
    {"key": "booking.rule_floor", "group": "托书解析", "default": 0.85,
     "min": 0.50, "max": 1.0, "step": 0.01,
     "label": "规则优先阈值（floor 模式用）",
     "hint": "只在 MERGE_POLICY=floor 时生效；默认 fill_only 不受影响"},

    # ---- 发票 ----
    {"key": "invoice.risk_auto_floor", "group": "发票", "default": 0.90,
     "min": 0.50, "max": 1.0, "step": 0.01,
     "label": "自动通过阈值",
     "hint": "发票号码/购买方税号/价税合计 全部 ≥ 该值才自动通过"},
    {"key": "invoice.low_conf_floor", "group": "发票", "default": 0.80,
     "min": 0.30, "max": 1.0, "step": 0.01,
     "label": "双人复核下限",
     "hint": "关键字段低于该值 → 转双人复核"},

    # ---- 单证规则开关 ----
    {"key": "rules.required", "group": "单证规则", "type": "list",
     "default": list(BLOCKING_KEYS),
     "label": "必填字段（缺失即阻断）",
     "hint": "勾选的字段为空时整单不可提交；至少保留 1 项"},
    {"key": "rules.container_checksum", "group": "单证规则", "type": "bool",
     "default": 1.0,
     "label": "箱号校验位 + 箱量一致性",
     "hint": "关掉后不再拦截 ISO 6346 校验失败的箱号，也不再提示箱号数量与箱量不一致"},
    {"key": "rules.closing", "group": "单证规则", "type": "bool",
     "default": 1.0,
     "label": "截港时间检查",
     "hint": "关掉后不再拦截「截港已过」，也不再提示 24 小时内截港与装柜时间矛盾"},
    {"key": "rules.address", "group": "单证规则", "type": "bool",
     "default": 1.0,
     "label": "地址校验",
     "hint": "关掉后不再提示错别字、区县与城市冲突、提卸同址"},

    # ---- 文档配对 ----
    {"key": "pairing.auto_accept", "group": "纸质↔TMS 配对", "default": 0.90,
     "min": 0.50, "max": 1.0, "step": 0.01,
     "label": "自动接受分数",
     "hint": "单号一致=1.0，箱号一致=0.9"},
    {"key": "pairing.review_min", "group": "纸质↔TMS 配对", "default": 0.60,
     "min": 0.30, "max": 0.99, "step": 0.01,
     "label": "最低接受分数",
     "hint": "低于该值视为配不上"},

    # ---- 对账与结算 ----
    {"key": "reconcile.tolerance", "group": "对账 / 结算", "default": 0.01,
     "min": 0.0, "max": 100.0, "step": 0.01,
     "label": "对账金额容差（元）",
     "hint": "差额在这个范围内视为一致"},
    {"key": "settlement.tolerance", "group": "对账 / 结算", "default": 1.00,
     "min": 0.0, "max": 500.0, "step": 0.01,
     "label": "外协结算容差（元）",
     "hint": "报账与合同价的差额在这个范围内视为一致"},
    {"key": "reconcile.explain_default", "group": "对账 / 结算", "type": "bool",
     "default": 0.0,
     "label": "默认生成差异解释",
     "hint": "开：对账结果自动带可能原因与建议动作；关：调用方显式传 explain=true 才生成"},

    # ---- 账龄与催收 ----
    {"key": "aging.bucket_1", "group": "账龄与催收", "default": 30,
     "min": 1, "max": 120, "step": 1,
     "label": "第一档上限（天）",
     "hint": "未到期之后的第一档，例如 1–30 天"},
    {"key": "aging.bucket_2", "group": "账龄与催收", "default": 60,
     "min": 2, "max": 180, "step": 1,
     "label": "第二档上限（天）",
     "hint": "必须大于第一档"},
    {"key": "aging.bucket_3", "group": "账龄与催收", "default": 90,
     "min": 3, "max": 365, "step": 1,
     "label": "第三档上限（天）",
     "hint": "超过该天数进入「90 天以上」档；必须大于第二档"},
    {"key": "aging.remind_days", "group": "账龄与催收", "default": 30,
     "min": 0, "max": 120, "step": 1,
     "label": "提醒档上限（天）",
     "hint": "最长逾期 ≤ 该天数 → 提醒；再长进入催收"},
    {"key": "aging.collect_days", "group": "账龄与催收", "default": 90,
     "min": 1, "max": 365, "step": 1,
     "label": "催收档上限（天）",
     "hint": "超过该天数 → 重点催收；必须大于提醒档"},

    # ---- 催收话术模板（可用占位符：{client} {count} {outstanding} {overdue} {days}）----
    {"key": "aging.tpl_remind", "group": "账龄与催收", "type": "text", "lines": 3,
     "max_len": 500,
     "default": "{client}您好：本期对账单共 {count} 笔，未收 {outstanding} 元，"
                "其中逾期 {overdue} 元（最长 {days} 天）。请在付款到期日前安排付款，"
                "如有疑问随时联系我司对账专员。",
     "label": "提醒档话术",
     "hint": "最长逾期在提醒档内使用；{client} {count} {outstanding} {overdue} {days} 会被替换"},
    {"key": "aging.tpl_collect", "group": "账龄与催收", "type": "text", "lines": 3,
     "max_len": 500,
     "default": "{client}您好：贵司目前未收 {outstanding} 元，逾期 {overdue} 元，"
                "最长逾期 {days} 天。请于 3 个工作日内确认付款计划；"
                "如需逐单对账明细，我司可即时提供。",
     "label": "催收档话术",
     "hint": "进入催收档使用；占位符同上"},
    {"key": "aging.tpl_serious", "group": "账龄与催收", "type": "text", "lines": 3,
     "max_len": 500,
     "default": "{client}您好：贵司未收 {outstanding} 元，逾期已达 {days} 天，"
                "其中逾期未收 {overdue} 元。请于 2 个工作日内书面确认付款安排；"
                "逾期未回复将暂停接新单，并按合同条款处理。",
     "label": "重点催收档话术",
     "hint": "超过催收档上限使用；占位符同上"},
    {"key": "aging.ai_draft", "group": "账龄与催收", "type": "bool", "default": 0.0,
     "label": "AI 润色催款话术（可选）",
     "hint": "模型只改写措辞；金额、天数、客户名由规则锁定，输出不合规自动回退模板"},

    # ---- 成本与毛利 ----
    {"key": "margin.match_days", "group": "成本与毛利", "default": 1,
     "min": 0, "max": 7, "step": 1,
     "label": "车辆+日期匹配窗口（天）",
     "hint": "费用没写单号时，按车辆和日期前后 N 天找唯一订单；找不到进待分摊"},
    {"key": "margin.warn_margin", "group": "成本与毛利", "default": 0.10,
     "min": 0.0, "max": 1.0, "step": 0.01,
     "label": "低毛利预警线",
     "hint": "订单毛利率低于该值标「低毛利」，为负标「亏损」"},

    # ---- 指标与月报 ----
    {"key": "metrics.baseline_manual_sec", "group": "指标与月报",
     "default": _env_num("BASELINE_MANUAL_SEC", 180), "env_key": "BASELINE_MANUAL_SEC",
     "min": 10, "max": 3600, "step": 1,
     "label": "人工单票基线（秒）",
     "hint": "节省工时的基线；默认来自 BASELINE_MANUAL_SEC，页面值优先"},
    {"key": "metrics.hourly_cost", "group": "指标与月报",
     "default": _env_num("HOURLY_COST", 45), "env_key": "HOURLY_COST",
     "min": 0, "max": 2000, "step": 1,
     "label": "人工时薪（元）",
     "hint": "折算金额用；默认来自 HOURLY_COST，页面值优先"},
    {"key": "metrics.bypass_alert", "group": "指标与月报", "default": 0.20,
     "min": 0.0, "max": 1.0, "step": 0.01,
     "label": "绕过率告警阈值",
     "hint": "超过该比例提示「节省工时会高估」"},

    # ---- 通知与告警 ----
    {"key": "notify.enabled", "group": "通知与告警", "type": "bool", "default": 0.0,
     "label": "启用通知",
     "hint": "关闭时只记录事件，不外发；开启后按下面的事件与渠道发送"},
    {"key": "notify.channels", "group": "通知与告警", "type": "list",
     "default": ["webhook"],
     "options": [
         {"key": "webhook", "label": "企微群机器人"},
         {"key": "email", "label": "邮件（SMTP）"},
     ],
     "label": "通知渠道",
     "hint": "可多选；邮件需要 .env 配置 SMTP 主机与账号"},
    {"key": "notify.webhook", "group": "通知与告警", "type": "text", "default": "",
     "secret": True, "max_len": 500,
     "label": "企微群机器人 Webhook",
     "hint": "群机器人地址；导入导出配置时不会带出该值"},
    {"key": "notify.email_to", "group": "通知与告警", "type": "text", "default": "",
     "max_len": 500,
     "label": "邮件收件人",
     "hint": "多个地址用逗号分隔；仅在勾选「邮件」渠道时使用"},
    {"key": "notify.events", "group": "通知与告警", "type": "list",
     "default": ["batch_failed", "wecom_image_failed", "bypass_alert"],
     "options": [
         {"key": "batch_failed", "label": "批量导入失败"},
         {"key": "wecom_image_failed", "label": "企微图片处理失败"},
         {"key": "bypass_alert", "label": "绕过率超阈"},
     ],
     "label": "触发事件",
     "hint": "只发勾选的事件；至少保留 1 项"},
    {"key": "notify.quiet_hours", "group": "通知与告警", "type": "text", "default": "22:00-08:00",
     "label": "静默时段",
     "hint": "格式 HH:MM-HH:MM，可跨午夜；留空表示不静默"},
    {"key": "notify.dedup_min", "group": "通知与告警", "default": 30,
     "min": 0, "max": 1440, "step": 1,
     "label": "重复抑制（分钟）",
     "hint": "同一事件 + 同一 key 在窗口内只发一次"},

    # ---- TMS 写回（通用适配层）----
    {"key": "tms.enabled", "group": "TMS 写回", "type": "bool", "default": 0.0,
     "label": "启用 TMS 写回",
     "hint": "开启后可在确认历史里把已确认单据推送到客户 TMS；关闭时只保留发件箱记录"},
    {"key": "tms.endpoint", "group": "TMS 写回", "type": "text", "default": "",
     "max_len": 500,
     "label": "TMS 接收地址",
     "hint": "客户 TMS 或中间适配器的 HTTP 地址；发的是一份固定契约 JSON"},
    {"key": "tms.token", "group": "TMS 写回", "type": "text", "default": "",
     "secret": True, "max_len": 300,
     "label": "TMS 访问令牌",
     "hint": "以 Authorization: Bearer 发送；导出配置时不会带出"},
    {"key": "tms.timeout_sec", "group": "TMS 写回", "default": 10,
     "min": 1, "max": 60, "step": 1,
     "label": "TMS 超时（秒）",
     "hint": "超时按可重试处理；4xx 直接标记失败，不反复重试"},
]

BY_KEY = {s["key"]: s for s in SPECS}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _db_load() -> dict:
    with db.connect() as conn:
        row = conn.execute(
            "SELECT value, updated_at, updated_by FROM app_settings"
            " WHERE key='thresholds'"
        ).fetchone()
    if not row:
        return {}
    try:
        data = json.loads(row["value"])
    except (json.JSONDecodeError, TypeError):
        return {}
    if not isinstance(data, dict):
        return {}
    data["updated_at"] = row["updated_at"] or ""
    data["updated_by"] = row["updated_by"] or ""
    return data


def _load() -> dict:
    """读阈值。SQLite 走文件 + mtime；PostgreSQL 走 app_settings + 2 秒缓存。"""
    global _cache, _cache_mtime, _cache_at
    if db.BACKEND == "postgres":
        now = time.time()
        if _cache is not None and now - _cache_at < _DB_TTL:
            return _cache
        _cache = _db_load()
        _cache_at = now
        return _cache

    try:
        mtime = PATH.stat().st_mtime
    except FileNotFoundError:
        if _cache is None:
            _cache = {}
            _cache_mtime = -1.0
        return _cache or {}

    if _cache is not None and mtime == _cache_mtime:
        return _cache
    try:
        data = json.loads(PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        data = {}
    _cache = data if isinstance(data, dict) else {}
    _cache_mtime = mtime
    return _cache


def _write(payload: dict) -> None:
    global _cache, _cache_mtime, _cache_at
    if db.BACKEND == "postgres":
        with db.connect() as conn:
            conn.execute(
                "INSERT INTO app_settings (key, value, updated_at, updated_by)"
                " VALUES ('thresholds',?,?,?)"
                " ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,"
                " updated_at=EXCLUDED.updated_at,"
                " updated_by=EXCLUDED.updated_by",
                (json.dumps(payload, ensure_ascii=False),
                 payload.get("updated_at", ""), payload.get("updated_by", "")),
            )
        _cache = payload
        _cache_at = time.time()
        return

    PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, PATH)
    _cache = payload
    _cache_mtime = PATH.stat().st_mtime


def get(key: str) -> float:
    spec = BY_KEY.get(key)
    default = spec["default"] if spec else 0.0
    raw = (_load().get("values") or {}).get(key)
    try:
        return float(raw)
    except (TypeError, ValueError):
        return float(default)


def get_bool(key: str) -> bool:
    return abs(get(key)) > 1e-9


def get_text(key: str) -> str:
    spec = BY_KEY.get(key)
    default = str(spec["default"]) if spec else ""
    raw = (_load().get("values") or {}).get(key, default)
    return str(raw)


def get_list(key: str) -> list[str]:
    spec = BY_KEY.get(key)
    default = spec["default"] if spec else []
    raw = (_load().get("values") or {}).get(key, default)
    if isinstance(raw, list):
        return [str(x) for x in raw]
    return [x for x in str(raw).split(",") if x]


def _history_load() -> list:
    try:
        data = json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return data if isinstance(data, list) else []


def _history_save(items: list) -> None:
    HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = HISTORY_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(items[:HISTORY_MAX], ensure_ascii=False, indent=1),
                   encoding="utf-8")
    os.replace(tmp, HISTORY_PATH)


def _record(actor: str, changes: list[dict], reason: str) -> None:
    if not changes:
        return
    items = _history_load()
    items.insert(0, {
        "id": uuid.uuid4().hex[:12],
        "ts": _now(),
        "actor": actor or "system",
        "reason": (reason or "").strip()[:200],
        "changes": changes,
    })
    _history_save(items)


def history(limit: int = 50) -> list[dict]:
    return _history_load()[: max(1, min(int(limit or 50), 200))]


def snapshot() -> dict:
    """给 UI 用：带说明与当前值。"""
    data = _load()
    values = data.get("values") or {}
    groups: dict[str, list] = {}
    for spec in SPECS:
        item = dict(spec)
        kind = spec.get("type", "number")
        if kind == "bool":
            item["value"] = get_bool(spec["key"])
        elif kind == "list":
            item["value"] = get_list(spec["key"])
        elif kind == "text":
            if spec.get("secret"):
                # 密钥类只回显“是否已配置”，接口和页面都不返回明文。
                item["configured"] = bool(get_text(spec["key"]))
                item["value"] = ""
            else:
                item["value"] = get_text(spec["key"])
        else:
            item["value"] = get(spec["key"])
        if spec["key"] not in values:
            item["changed"] = False
        elif kind == "list":
            item["changed"] = sorted(get_list(spec["key"])) != sorted(spec["default"])
        elif kind == "text":
            item["changed"] = get_text(spec["key"]) != str(spec["default"])
        elif kind == "bool":
            item["changed"] = abs(float(values[spec["key"]]) - float(spec["default"])) > 1e-9
        else:
            item["changed"] = abs(float(values[spec["key"]]) - float(spec["default"])) > 1e-9
        if spec.get("env_key"):
            item["env_set"] = bool(os.getenv(spec["env_key"], "").strip())
        groups.setdefault(spec["group"], []).append(item)
    return {
        "groups": [{"name": k, "items": v} for k, v in groups.items()],
        "updated_at": data.get("updated_at", ""),
        "updated_by": data.get("updated_by", ""),
    }


def _check_dependencies(merged: dict) -> None:
    """阈值之间的约束：自动通过阈值不能低于双人复核下限。"""
    for prefix, label in (("booking", "托书"), ("invoice", "发票")):
        hi_key = f"{prefix}.risk_auto_floor"
        lo_key = f"{prefix}.low_conf_floor"
        hi = float(merged.get(hi_key, BY_KEY[hi_key]["default"]))
        lo = float(merged.get(lo_key, BY_KEY[lo_key]["default"]))
        if hi < lo:
            raise ValueError(
                f"{label}的「自动通过阈值」不能低于「双人复核下限」（当前 {hi} < {lo}）"
            )

    b1 = float(merged.get("aging.bucket_1", BY_KEY["aging.bucket_1"]["default"]))
    b2 = float(merged.get("aging.bucket_2", BY_KEY["aging.bucket_2"]["default"]))
    b3 = float(merged.get("aging.bucket_3", BY_KEY["aging.bucket_3"]["default"]))
    if not (b1 < b2 < b3):
        raise ValueError("账龄档位必须递增：第一档 < 第二档 < 第三档")
    remind = float(merged.get("aging.remind_days", BY_KEY["aging.remind_days"]["default"]))
    collect = float(merged.get("aging.collect_days", BY_KEY["aging.collect_days"]["default"]))
    if remind >= collect:
        raise ValueError("「提醒档上限」必须小于「催收档上限」")


def set_many(values: dict, actor: str = "", reason: str = "") -> dict:
    """批量设置。只接受 SPECS 里的 key，且必须落在范围内。"""
    unknown = [k for k in values if k not in BY_KEY]
    if unknown:
        raise ValueError(f"未知配置项：{', '.join(unknown)}")

    clean: dict[str, float] = {}
    for k, v in values.items():
        spec = BY_KEY[k]
        if spec.get("type") == "text":
            text = str(v if v is not None else "").strip()
            if len(text) > int(spec.get("max_len", 500)):
                raise ValueError(f"{spec['label']} 太长（最多 {spec.get('max_len', 500)} 字）")
            if spec["key"] == "notify.webhook" and text and not text.startswith(("http://", "https://")):
                raise ValueError("Webhook 必须以 http:// 或 https:// 开头")
            if spec["key"] == "tms.endpoint" and text and not text.startswith(("http://", "https://")):
                raise ValueError("TMS 接收地址必须以 http:// 或 https:// 开头")
            if spec["key"] == "notify.quiet_hours" and text:
                m = __import__("re").fullmatch(r"([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)", text)
                if not m:
                    raise ValueError("静默时段格式应为 HH:MM-HH:MM，例如 22:00-08:00")
            if spec["key"].startswith("aging.tpl_"):
                if not text:
                    raise ValueError(f"{spec['label']} 不能为空")
                used = set(__import__("re").findall(r"\{(\w+)\}", text))
                invalid = sorted(used - set(TPL_PLACEHOLDERS))
                if invalid:
                    raise ValueError(
                        f"{spec['label']} 含未知占位符：{'、'.join('{' + x + '}' for x in invalid)}；"
                        f"可用：{' '.join('{' + x + '}' for x in TPL_PLACEHOLDERS)}")
                if "client" not in used:
                    raise ValueError(f"{spec['label']} 至少需要 {{client}}，否则不知道发给谁")
            clean[k] = text
            continue
        if spec.get("type") == "list":
            items = v if isinstance(v, list) else [x for x in str(v).split(",") if x]
            keys = sorted({str(x).strip() for x in items if str(x).strip()})
            if not keys:
                raise ValueError(f"{spec['label']} 至少要保留 1 项")
            allowed = {str(o["key"]) for o in spec.get("options", [])} or set(SPEC_MAP)
            invalid = [x for x in keys if x not in allowed]
            if invalid:
                raise ValueError(f"{spec['label']} 含未知项：{', '.join(invalid)}")
            clean[k] = keys
            continue
        if spec.get("type") == "bool":
            if isinstance(v, str):
                normalized = v.strip().lower()
                if normalized in {"1", "true", "on", "yes"}:
                    clean[k] = 1.0
                elif normalized in {"0", "false", "off", "no", ""}:
                    clean[k] = 0.0
                else:
                    raise ValueError(f"{spec['label']} 必须是开/关")
            else:
                clean[k] = 1.0 if bool(v) else 0.0
            continue
        try:
            num = float(v)
        except (TypeError, ValueError):
            raise ValueError(f"{spec['label']} 必须是数字")
        if not (spec["min"] <= num <= spec["max"]):
            raise ValueError(f"{spec['label']} 必须在 {spec['min']}–{spec['max']} 之间")
        clean[k] = num

    with _lock:
        old = dict(_load().get("values") or {})
        merged = dict(old)
        merged.update(clean)
        _check_dependencies(merged)

        changes = []
        for k, new_value in clean.items():
            spec = BY_KEY[k]
            if spec.get("type") == "list":
                old_list = sorted(get_list(k))
                new_list = sorted(new_value)
                if old_list != new_list:
                    changes.append({"key": k, "label": spec["label"],
                                    "old": old_list, "new": new_list})
                continue
            if spec.get("type") == "text":
                old_text = get_text(k)
                if old_text != new_value:
                    secret = bool(spec.get("secret"))
                    changes.append({"key": k, "label": spec["label"],
                                    "old": ("••••" if old_text else "（未配置）") if secret else old_text,
                                    "new": "••••" if secret else new_value})
                continue
            old_value = get(k)
            if abs(float(old_value) - float(new_value)) > 1e-9:
                changes.append({
                    "key": k,
                    "label": spec["label"],
                    "old": round(float(old_value), 4),
                    "new": round(float(new_value), 4),
                })

        current = dict(merged)
        # 与默认值相同的就不落盘，保持文件干净（列表项单独比较）
        for k in list(current):
            spec = BY_KEY.get(k)
            if not spec:
                continue
            if spec.get("type") == "list":
                if sorted(str(x) for x in current[k]) == sorted(spec["default"]):
                    current.pop(k)
            elif spec.get("type") == "text":
                if str(current[k]) == str(spec["default"]):
                    current.pop(k)
            elif abs(float(current[k]) - float(spec["default"])) < 1e-9:
                current.pop(k)
        _write({"values": current, "updated_at": _now(), "updated_by": actor})
        _record(actor, changes, reason)
    public = {k: ("" if BY_KEY[k].get("secret") else v) for k, v in current.items()}
    return {"ok": True, "changed": list(clean), "values": public}


def reset(keys: list[str] | None = None, actor: str = "", reason: str = "") -> dict:
    with _lock:
        current = dict(_load().get("values") or {})
        targets = keys or list(current)
        changes = []
        for k in targets:
            if k not in BY_KEY:
                continue
            spec = BY_KEY[k]
            if spec.get("type") == "list":
                old_list = sorted(get_list(k))
                default_list = sorted(spec["default"])
                if old_list != default_list:
                    changes.append({"key": k, "label": spec["label"],
                                    "old": old_list, "new": default_list})
            elif spec.get("type") == "text":
                old_text = get_text(k)
                if old_text != str(spec["default"]):
                    secret = bool(spec.get("secret"))
                    changes.append({"key": k, "label": spec["label"],
                                    "old": ("••••" if old_text else "（未配置）") if secret else old_text,
                                    "new": "••••" if secret else str(spec["default"])})
            else:
                old_value = get(k)
                default = float(spec["default"])
                if abs(old_value - default) > 1e-9:
                    changes.append({
                        "key": k,
                        "label": spec["label"],
                        "old": round(old_value, 4),
                        "new": round(default, 4),
                    })
            current.pop(k, None)
        _write({"values": current, "updated_at": _now(), "updated_by": actor})
        _record(actor, changes, reason or "恢复默认")
    public = {k: ("" if BY_KEY[k].get("secret") else v) for k, v in current.items()}
    return {"ok": True, "values": public}


def rollback(entry_id: str, actor: str = "", reason: str = "") -> dict:
    entry = next((x for x in _history_load() if x.get("id") == entry_id), None)
    if not entry:
        raise ValueError("找不到这条变更记录")
    values = {}
    for change in entry.get("changes") or []:
        key = change.get("key")
        if key not in BY_KEY:
            continue
        old = change.get("old")
        values[key] = BY_KEY[key]["default"] if old is None else float(old)
    if not values:
        raise ValueError("这条记录没有可回滚的配置项")
    return set_many(values, actor=actor, reason=reason or f"回滚 {entry_id}")
