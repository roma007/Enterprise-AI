"""运维智能：灰犀牛风险 + 黑天鹅事故的规则/ AI 研判。

两类问题分开处理：
- 灰犀牛（gray_rhino）：有趋势、可提前预测，如磁盘将满、DB 增长、证书到期。
- 黑天鹅（black_swan）：不可预测发生时间，只能快速发现、止损、恢复，如断电、断网、DB 宕机。

边界：
- 规则引擎负责确定性判断；AI 只做解释、归因、建议，不直接执行命令。
- Runbook 默认只生成处置计划；真正执行必须接客户环境执行器并审批。
- 所有判断必须带证据；没有证据就写“数据不足”，不编。
"""
from __future__ import annotations

import hashlib
import json
import threading
from datetime import datetime
from pathlib import Path

from . import llm
from .config import ROOT, settings

STATE_PATH = ROOT / "data" / "aiops" / "state.json"
_LOCK = threading.Lock()


# ------------------------------------------------------------------ Runbook 库
RUNBOOKS: dict[str, dict] = {
    "disk_cleanup": {
        "title": "清理日志与临时文件",
        "risk": "low", "auto": True,
        "steps": [
            "清理 7 天前的应用日志与压缩包",
            "清理 24 小时前的临时上传/缓存文件",
            "按保留策略清理旧备份（保留最近 14 份）",
            "复核磁盘使用率，仍高于 85% 则评估扩容",
        ],
        "rollback": "只删除可重建文件；不碰业务库、原件与最近备份",
        "owner": "运维",
    },
    "db_archive": {
        "title": "数据库归档/扩容评估",
        "risk": "medium", "auto": False,
        "steps": [
            "确认增长最快的表与索引",
            "评估历史数据归档/分区方案",
            "在维护窗口执行归档并校验",
            "复核 DB 大小与备份",
        ],
        "rollback": "归档前做全量备份；异常时按备份恢复",
        "owner": "DBA",
    },
    "db_pool_tune": {
        "title": "数据库连接池处置",
        "risk": "medium", "auto": False,
        "steps": [
            "查看连接池等待数与慢查询",
            "清理空闲/异常会话（保留业务会话）",
            "评估临时扩池或限流",
            "复核 5xx、P95 与连接池使用率",
        ],
        "rollback": "扩池参数可回退；不删业务数据",
        "owner": "DBA",
    },
    "backup_now": {
        "title": "立即备份并校验",
        "risk": "low", "auto": True,
        "steps": [
            "触发一次在线备份",
            "校验备份文件大小与可读性",
            "记录最后成功时间",
        ],
        "rollback": "不修改生产数据",
        "owner": "运维",
    },
    "cert_renew": {
        "title": "证书续期与重载",
        "risk": "low", "auto": True,
        "steps": [
            "确认证书域名与到期时间",
            "续期并部署新证书",
            "重载网关/服务",
            "外部探针验证 HTTPS",
        ],
        "rollback": "保留旧证书，可回滚",
        "owner": "运维",
    },
    "queue_drain": {
        "title": "队列/发件箱疏堵",
        "risk": "low", "auto": True,
        "steps": [
            "确认积压原因：入口、worker、下游",
            "重排失败项（限制次数）",
            "必要时临时扩容 worker",
            "复核 pending 与失败率",
        ],
        "rollback": "重排可再次暂停；不丢原始记录",
        "owner": "运维",
    },
    "batch_retry": {
        "title": "批次失败重试",
        "risk": "low", "auto": True,
        "steps": [
            "查看失败原因分布",
            "重试失败项（限制次数）",
            "仍失败则转人工/H5",
        ],
        "rollback": "原始文件保留",
        "owner": "单证",
    },
    "service_restart": {
        "title": "服务重启/内存回收",
        "risk": "medium", "auto": False,
        "steps": [
            "确认单实例故障，不影响整体",
            "滚动重启或摘流后重启",
            "观察内存、5xx、P95 30 分钟",
            "仍泄漏则抓取 profile 排期修复",
        ],
        "rollback": "重启失败自动回滚上一版本",
        "owner": "运维",
    },
    "rollback_release": {
        "title": "回滚最近发布",
        "risk": "high", "auto": False,
        "steps": [
            "确认 5xx/延迟与最近发布的因果关系",
            "暂停继续发布",
            "回滚到上一个稳定版本",
            "复核错误率与核心链路",
        ],
        "rollback": "回滚本身可再回滚；需研发确认",
        "owner": "研发负责人",
    },
    "llm_fallback": {
        "title": "模型降级/切换",
        "risk": "low", "auto": True,
        "steps": [
            "确认模型网关超时/错误率",
            "切备用模型或关闭模型增强（回退规则）",
            "观察解析成功率与耗时",
            "恢复后评估是否切回",
        ],
        "rollback": "可切回原模型",
        "owner": "运维",
    },
    "failover_host": {
        "title": "主机/实例故障切换",
        "risk": "high", "auto": False,
        "steps": [
            "确认主机/网络/电源状态（带外管理）",
            "切备用实例或备库",
            "校验数据一致性与核心接口",
            "通知客户当前状态与预计恢复时间",
        ],
        "rollback": "确认原主机恢复后再切回",
        "owner": "基础设施负责人",
    },
    "llm_topup": {
        "title": "模型额度充值/续费",
        "risk": "medium", "auto": False,
        "steps": [
            "确认当前余额/额度与近 7 天日均消耗",
            "按 30–60 天用量估算充值金额",
            "走采购/财务审批后充值或购买额度",
            "更新余额/额度配置（或调用预算更新接口）",
            "复核 /ops-ai 风险是否消失、模型调用是否正常",
        ],
        "rollback": "充值是资金动作，不可自动回滚；必须审批",
        "owner": "运维 → 采购/财务",
    },
    "llm_throttle": {
        "title": "模型用量降级",
        "risk": "low", "auto": True,
        "steps": [
            "关闭非核心模型调用（润色、解释类）",
            "下调 max_tokens 与批量模型策略",
            "提高缓存命中、规则优先",
            "观察解析成功率与人工修改率",
            "额度恢复后逐项恢复",
        ],
        "rollback": "参数可回退；不影响已确认数据",
        "owner": "运维/产品",
    },
    "llm_key_renew": {
        "title": "模型 Key/账号续期",
        "risk": "medium", "auto": False,
        "steps": [
            "确认到期时间与影响范围",
            "申请新 Key 或续期",
            "在预发验证连通性与金标回归",
            "切换配置并观察 30 分钟",
            "确认无误后再停用旧 Key",
        ],
        "rollback": "旧 Key 未删除前可切回",
        "owner": "运维 → 采购",
    },
    "llm_model_migrate": {
        "title": "模型下线迁移",
        "risk": "medium", "auto": False,
        "steps": [
            "确认下线日期与替代模型",
            "用金标样本做对比回归",
            "先灰度非核心场景",
            "评估准确率/耗时/成本后切换",
            "更新模型配置与文档",
        ],
        "rollback": "保留旧模型配置，可切回",
        "owner": "研发/运维",
    },
}


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _fingerprint(rule: str, target: str = "") -> str:
    return f"{rule}:{target}".strip(":")


def _id(prefix: str, fingerprint: str) -> str:
    h = hashlib.sha1(fingerprint.encode("utf-8")).hexdigest()[:6].upper()
    return f"{prefix}-{datetime.now().strftime('%Y%m%d')}-{h}"


def _pct(v: float) -> str:
    return f"{v * 100:.1f}%"


def _num(v) -> float | None:
    """快照里的数可能缺、可能是脏字符串；缺就返回 None，规则自动跳过。"""
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# ------------------------------------------------------------------ 规则引擎
def _risk(rule: str, severity: str, title: str, evidence: list[str], eta: str,
          impact: str, runbook: str, target: str = "") -> dict:
    fp = _fingerprint(rule, target)
    return {
        "id": _id("RSK", fp), "fingerprint": fp, "kind": "gray_rhino",
        "rule": rule, "severity": severity, "title": title, "evidence": evidence,
        "eta": eta, "impact": impact, "runbook": runbook,
        "auto": bool(RUNBOOKS.get(runbook, {}).get("auto")),
        "owner": RUNBOOKS.get(runbook, {}).get("owner", "运维"),
        "status": "open", "created_at": _now(), "updated_at": _now(),
    }


def _incident(rule: str, severity: str, title: str, symptom: str,
              evidence: list[str], blast_radius: str, runbook: str,
              escalate_to: str, target: str = "") -> dict:
    fp = _fingerprint(rule, target)
    return {
        "id": _id("INC", fp), "fingerprint": fp, "kind": "black_swan",
        "rule": rule, "severity": severity, "title": title, "symptom": symptom,
        "evidence": evidence, "blast_radius": blast_radius,
        "runbook": runbook, "escalate_to": escalate_to,
        "status": "open", "diagnosis": None,
        "created_at": _now(), "updated_at": _now(),
    }


def evaluate(snapshot: dict, persist: bool = True) -> dict:
    """输入一次指标快照，输出灰犀牛风险与黑天鹅事件。"""
    host = snapshot.get("host") or {}
    db = snapshot.get("db") or {}
    app = snapshot.get("app") or {}
    sec = snapshot.get("security") or {}
    probes = snapshot.get("probes") or {}
    change = snapshot.get("recent_change") or {}
    risks: list[dict] = []
    incidents: list[dict] = []

    # ---------- 灰犀牛：趋势/容量 ----------
    used = float(host.get("disk_used_pct") or 0)
    growth = float(host.get("disk_growth_pct_per_day") or 0)
    if used >= 80 and growth > 0:
        eta = max(0.1, round((100 - used) / growth, 1))
        if eta <= 30:
            sev = "高" if eta <= 7 else "中"
            risks.append(_risk(
                "disk_forecast", sev, f"磁盘预计 {eta:g} 天后写满",
                [f"当前使用率 {used:g}%", f"过去增速 {growth:g}%/天", f"剩余约 {(100-used):g} 个百分点"],
                f"{eta:g} 天", "写满后解析、对账、导出会失败", "disk_cleanup",
            ))

    size_gb = float(db.get("size_bytes") or 0) / 1e9
    growth_gb = float(db.get("growth_gb_per_day") or 0)
    if size_gb >= 4 or growth_gb >= 0.05:
        eta_days = round(max(1, (5 - size_gb) / growth_gb), 0) if growth_gb > 0 and size_gb < 5 else 90
        risks.append(_risk(
            "db_growth", "中" if size_gb < 5 else "高",
            f"数据库 {size_gb:.1f}GB，预计 {int(eta_days)} 天内超过 5GB",
            [f"当前 {size_gb:.1f}GB", f"日增 {growth_gb:.2f}GB", f"备份年龄 {db.get('backup_age_hours', '?')} 小时"],
            f"{int(eta_days)} 天", "超过 5GB 后备份/查询变慢，迁移成本上升", "db_archive",
        ))

    pool = float(db.get("pool_util") or 0)
    waiting = int(db.get("pool_waiting") or 0)
    if pool >= 0.85 or waiting > 0:
        risks.append(_risk(
            "db_pool", "高" if pool >= 0.95 else "中",
            f"数据库连接池使用率 {_pct(pool)}，等待 {waiting}",
            [f"连接池 {_pct(pool)}", f"等待数 {waiting}", f"慢查询 {db.get('slow_queries_1h', 0)}/小时"],
            "数小时内", "连接池饱和会直接推高 5xx 与延迟", "db_pool_tune",
        ))

    backup_age = float(db.get("backup_age_hours") or 0)
    if backup_age > 36:
        risks.append(_risk(
            "backup_stale", "高" if backup_age > 72 else "中",
            f"备份已 {backup_age:g} 小时未成功",
            [f"最后成功 {backup_age:g} 小时前", "恢复点目标 24 小时"],
            "今天", "再次故障时可能无法恢复到最近数据", "backup_now",
        ))

    cert_days = float(sec.get("cert_days_left") or 999)
    if cert_days <= 30:
        risks.append(_risk(
            "cert_expiry", "高" if cert_days <= 7 else "中",
            f"证书 {int(cert_days)} 天后到期",
            [f"剩余 {int(cert_days)} 天", "外部访问依赖 HTTPS"],
            f"{int(cert_days)} 天", "到期后登录、企微回调、外部探针全部失败", "cert_renew",
        ))

    outbox = int(app.get("outbox_pending") or 0)
    queue = int(app.get("queue_pending") or 0)
    if outbox > 20 or queue > 30:
        risks.append(_risk(
            "queue_backlog", "中" if max(outbox, queue) < 100 else "高",
            f"队列积压：发件箱 {outbox} / 任务 {queue}",
            [f"发件箱 {outbox}", f"任务队列 {queue}", f"批次失败 {app.get('batch_failed', 0)}"],
            "数小时内", "回写/批量任务延迟，可能触发客户投诉", "queue_drain",
        ))

    failed = int(app.get("batch_failed") or 0)
    if failed > 10:
        risks.append(_risk(
            "batch_failed", "中", f"批次失败项 {failed} 条",
            [f"失败 {failed}", f"OCR 失败率 {_pct(float(app.get('ocr_fail_ratio') or 0))}"],
            "今天", "失败积压增加人工处理量", "batch_retry",
        ))

    mem = float(host.get("mem_used_pct") or 0)
    if mem >= 85:
        risks.append(_risk(
            "memory_pressure", "中" if mem < 95 else "高",
            f"内存使用率 {_pct(mem)}",
            [f"内存 {_pct(mem)}", f"运行时长 {host.get('uptime_hours', '?')} 小时"],
            "数小时–数天", "可能触发 OOM 或服务重启", "service_restart",
        ))

    err = float(app.get("http_5xx_ratio") or 0)
    if err > 0.01 and float(change.get("deployed_minutes_ago") or 999) > 30:
        risks.append(_risk(
            "error_budget", "中" if err < 0.05 else "高",
            f"5xx 比例 {_pct(err)}，高于基线",
            [f"5xx {_pct(err)}", f"P95 {app.get('p95_ms', '?')}ms", "最近 30 分钟无发布"],
            "今天", "错误预算持续燃烧，影响可用性", "db_pool_tune",
        ))

    llm_timeout = int(app.get("llm_timeout_per_5m") or 0)
    if llm_timeout >= 5:
        risks.append(_risk(
            "llm_timeout", "中", f"模型网关 5 分钟超时 {llm_timeout} 次",
            [f"超时 {llm_timeout}/5m", f"模型可用 {probes.get('llm_ok', '?')}"],
            "数小时内", "解析会回退规则，准确率可能下降", "llm_fallback",
        ))

    # ---------- 灰犀牛：模型资源（余额 / 额度 / 到期） ----------
    # 这些都是“账面趋势”问题，不是黑盒预测：有多少、每天烧多少、还能撑几天。
    llm = snapshot.get("llm") or {}
    model = str(llm.get("model") or "当前模型")
    avg_cost = _num(llm.get("avg_cost_per_day")) or 0.0
    avg_tokens = _num(llm.get("avg_tokens_per_day")) or 0.0

    for days_left, rule, label, runbook, impact, expired_rule in (
        (_num(llm.get("key_expires_days")), "llm_key_expiry", "模型 Key/账号",
         "llm_key_renew", "所有模型增强停用，解析/问答回退规则", "llm_key_expired"),
        (_num(llm.get("model_retires_days")), "llm_model_retire", f"模型 {model}".strip(),
         "llm_model_migrate", "依赖该模型的解析/问答能力下降", "llm_model_retired"),
    ):
        if days_left is None or days_left > 45:
            continue
        if days_left < 0:
            incidents.append(_incident(
                expired_rule, "P1", f"{label}已过期",
                "到期日已过，模型调用可能已被供应商拒绝",
                [f"到期日已过 {abs(int(days_left))} 天", f"当前模型 {model}",
                 f"模型可用 {probes.get('llm_ok', '未知')}"],
                "模型增强不可用，解析/问答回退规则，人工修改率上升",
                runbook, "运维 → 采购/模型供应商",
            ))
            continue
        sev = "高" if days_left <= 7 else "中"
        risks.append(_risk(
            rule, sev, f"{label} {int(days_left)} 天后到期",
            [f"剩余 {int(days_left)} 天", f"当前模型 {model}",
             f"近 7 天日均 {avg_tokens:g} token"],
            f"{int(days_left)} 天", f"到期后{impact}", runbook,
        ))

    balance = _num(llm.get("balance_cny"))
    if balance is not None:
        days_balance = balance / avg_cost if avg_cost > 0 else None
        if balance <= 0:
            incidents.append(_incident(
                "llm_balance_exhausted", "P1", "模型余额已用完/欠费",
                "供应商侧余额不足，模型调用失败或即将被停",
                [f"余额 ¥{balance:g}", f"日均消耗 ¥{avg_cost:g}",
                 f"今日调用失败 {llm.get('today_errors', '?')} 次"],
                "模型增强全部停用，解析/问答降级，人工修改率上升",
                "llm_topup", "运维 → 采购/财务 → 供应商",
            ))
        elif days_balance is not None and days_balance <= 30:
            sev = "高" if days_balance <= 7 or balance <= 20 else "中"
            risks.append(_risk(
                "llm_balance_low", sev,
                f"模型余额约可支撑 {days_balance:.0f} 天（剩 ¥{balance:g}）",
                [f"余额 ¥{balance:g}", f"日均消耗 ¥{avg_cost:g}",
                 f"近 7 天日均 {avg_tokens:g} token"],
                f"{days_balance:.0f} 天",
                "余额耗尽后模型增强停用，解析/问答回退规则，人工修改率上升",
                "llm_topup",
            ))
        elif days_balance is None and balance <= 50:
            risks.append(_risk(
                "llm_balance_low", "中", f"模型余额只剩 ¥{balance:g}，暂无消耗速率",
                [f"余额 ¥{balance:g}", "近 7 天没有可用用量数据"],
                "未知", "余额耗尽后模型增强停用", "llm_topup",
            ))

    remaining_tokens = _num(llm.get("remaining_tokens"))
    if remaining_tokens is not None:
        days_tokens = remaining_tokens / avg_tokens if avg_tokens > 0 else None
        if remaining_tokens <= 0:
            incidents.append(_incident(
                "llm_quota_exhausted", "P1", "模型 token 额度已用完",
                "额度耗尽，模型调用被拒或按超额计费",
                [f"剩余 {int(remaining_tokens):,} token",
                 f"日均 {avg_tokens:g} token",
                 f"总额度 {llm.get('quota_tokens', '?')}"],
                "模型增强全部停用，解析/问答降级",
                "llm_topup", "运维 → 采购/财务",
            ))
        elif days_tokens is not None and days_tokens <= 30:
            sev = "高" if days_tokens <= 7 or remaining_tokens <= 50000 else "中"
            runbook = "llm_throttle" if days_tokens <= 7 else "llm_topup"
            risks.append(_risk(
                "llm_quota_low", sev,
                f"模型 token 额度约可支撑 {days_tokens:.0f} 天（剩 {int(remaining_tokens):,}）",
                [f"剩余 {int(remaining_tokens):,} token", f"日均 {avg_tokens:g} token",
                 f"总额度 {llm.get('quota_tokens', '?')}"],
                f"{days_tokens:.0f} 天",
                "额度耗尽后模型增强停用，解析/问答回退规则",
                runbook,
            ))
        elif days_tokens is None and remaining_tokens <= 100000:
            risks.append(_risk(
                "llm_quota_low", "中", f"模型 token 额度只剩 {int(remaining_tokens):,}，暂无消耗速率",
                [f"剩余 {int(remaining_tokens):,} token", "近 7 天没有可用用量数据"],
                "未知", "额度耗尽后模型增强停用", "llm_topup",
            ))

    today_cost = _num(llm.get("today_cost"))
    if today_cost is not None and avg_cost > 0 and today_cost >= max(avg_cost * 3, 0.5):
        risks.append(_risk(
            "llm_spend_spike", "中",
            f"今日模型消耗是日均的 {today_cost / avg_cost:.1f} 倍",
            [f"今日 ¥{today_cost:g}", f"日均 ¥{avg_cost:g}",
             f"今日 token {llm.get('today_tokens', '?')}"],
            "今天", "可能是批量重跑、提示词变长或异常调用；先查来源再限流",
            "llm_throttle",
        ))

    # ---------- 黑天鹅：突发/不可预测 ----------
    heartbeat = float(host.get("heartbeat_age_sec") or 0)
    host_down = host.get("up") is False or heartbeat > 60
    db_down = db.get("up") is False or probes.get("db_ok") is False
    app_down = app.get("up") is False
    external_bad = probes.get("external_ok") is False

    if host_down:
        incidents.append(_incident(
            "host_down", "P0", "主机/网络不可达",
            f"心跳 {heartbeat:g} 秒未上报，外部探针 {'失败' if external_bad else '未知'}",
            [f"心跳延迟 {heartbeat:g}s", f"外部探针 {'失败' if external_bad else '未知'}",
             f"最近发布 {change.get('deployed_minutes_ago', '?')} 分钟前"],
            "登录、解析、对账、导出全部不可用", "failover_host",
            "值班运维 → 基础设施 → 客户 IT",
        ))
    elif db_down:
        incidents.append(_incident(
            "db_down", "P0", "数据库不可用",
            "数据库连接失败，应用 5xx 上升",
            [f"db_up={db.get('up')}", f"5xx {_pct(err)}", f"连接池 {_pct(pool)}"],
            "所有依赖数据库的读写不可用", "failover_host",
            "DBA → 基础设施 → 研发",
        ))
    elif app_down:
        incidents.append(_incident(
            "app_down", "P0", "应用服务不可用",
            "应用健康检查失败，外部探针失败",
            [f"app_up={app.get('up')}", f"外部探针 {'失败' if external_bad else '未知'}"],
            "客户无法登录/解析/对账", "service_restart",
            "值班运维 → 研发",
        ))
    elif external_bad:
        incidents.append(_incident(
            "external_probe", "P1", "外部探针失败/网络分区",
            "应用自报存活，但外部无法访问",
            ["外部探针失败", f"应用 up={app.get('up')}", "可能是 DNS/反代/网络策略"],
            "客户侧可能完全无法访问，内部监控仍正常", "failover_host",
            "网络/运维 → 客户 IT",
        ))

    if not (host_down or db_down or app_down) and err >= 0.05 and float(change.get("deployed_minutes_ago") or 999) <= 30:
        incidents.append(_incident(
            "post_deploy_5xx", "P1", "发布后错误率飙升",
            f"5xx {_pct(err)}，最近 {change.get('deployed_minutes_ago')} 分钟内有发布",
            [f"5xx {_pct(err)}", f"版本 {change.get('version', '?')}",
             f"P95 {app.get('p95_ms', '?')}ms"],
            "核心接口错误率上升，客户可感知", "rollback_release",
            "研发负责人 → 值班运维",
        ))

    if not (host_down or db_down or app_down) and llm_timeout >= 10:
        incidents.append(_incident(
            "llm_outage", "P1", "模型网关连续超时",
            f"5 分钟超时 {llm_timeout} 次，模型探针 {probes.get('llm_ok')}",
            [f"超时 {llm_timeout}/5m", f"模型探针 {probes.get('llm_ok')}"],
            "解析/问答降级为规则，准确率下降", "llm_fallback",
            "运维 → 模型供应商",
        ))

    if snapshot.get("security", {}).get("ransomware_suspected") is True:
        incidents.append(_incident(
            "ransomware", "P0", "疑似勒索/异常加密",
            "文件异常变化，备份不可写",
            ["安全标记 ransomware_suspected=true", "立即隔离主机与备份"],
            "数据可能被加密，存在丢失风险", "failover_host",
            "安全负责人 → 客户 IT → 管理层",
        ))

    result = {
        "generated_at": _now(),
        "risks": risks,
        "incidents": incidents,
        "summary": {
            "risks": len(risks),
            "incidents": len(incidents),
            "p0": sum(1 for x in incidents if x["severity"] == "P0"),
            "p1": sum(1 for x in incidents if x["severity"] == "P1"),
            "auto_ready": sum(1 for x in risks if x["auto"]),
        },
    }
    if persist:
        _merge(result)
    return result


# ------------------------------------------------------------------ 状态存储
def _empty() -> dict:
    return {"risks": [], "incidents": [], "actions": [], "last_eval": None}


def _load() -> dict:
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            data.setdefault("risks", [])
            data.setdefault("incidents", [])
            data.setdefault("actions", [])
            data.setdefault("last_eval", None)
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return _empty()


def _save(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(STATE_PATH)


def _merge(result: dict) -> None:
    with _LOCK:
        state = _load()
        now = _now()
        for key in ("risks", "incidents"):
            old = {x.get("fingerprint"): x for x in state.get(key, [])}
            merged = []
            for item in result.get(key, []):
                prev = old.pop(item["fingerprint"], None)
                if prev:
                    item["id"] = prev.get("id", item["id"])
                    item["created_at"] = prev.get("created_at", item["created_at"])
                    # 已解决的风险/事件再次出现：重新打开，不能被历史状态吞掉
                    item["status"] = "open" if prev.get("status") == "resolved" else prev.get("status", "open")
                    if prev.get("diagnosis"):
                        item["diagnosis"] = prev["diagnosis"]
                    if prev.get("ack_by") and item["status"] != "open":
                        item["ack_by"] = prev["ack_by"]
                merged.append(item)
            # 本轮未再出现的风险自动标记 resolved；事故保留到人工解决
            for prev in old.values():
                if key == "risks" and prev.get("status") == "open":
                    prev["status"] = "resolved"
                    prev["updated_at"] = now
                    merged.append(prev)
            state[key] = merged
        state["last_eval"] = result.get("generated_at")
        _save(state)


def state() -> dict:
    with _LOCK:
        return _load()


def summary() -> dict:
    data = _load()
    risks = [x for x in data.get("risks", []) if x.get("status") != "resolved"]
    incidents = [x for x in data.get("incidents", []) if x.get("status") != "resolved"]
    return {
        "risks": len(risks),
        "incidents": len(incidents),
        "p0": sum(1 for x in incidents if x.get("severity") == "P0"),
        "p1": sum(1 for x in incidents if x.get("severity") == "P1"),
        "auto_ready": sum(1 for x in risks if x.get("auto")),
        "last_eval": data.get("last_eval"),
    }


def reset() -> dict:
    with _LOCK:
        _save(_empty())
    return summary()


def ack_incident(incident_id: str, by: str = "on-call") -> dict:
    with _LOCK:
        data = _load()
        for item in data.get("incidents", []):
            if item.get("id") == incident_id:
                item["status"] = "acknowledged"
                item["ack_by"] = by
                item["ack_at"] = _now()
                item["updated_at"] = _now()
                _save(data)
                return item
    raise KeyError("事件不存在")


def notify_incident(incident_id: str, force: bool = False) -> dict:
    """按现有通知配置（企微/邮件）发一条事故卡；未配置则只返回 skipped。"""
    data = _load()
    for item in data.get("incidents", []):
        if item.get("id") != incident_id:
            continue
        from .notify import notify
        diag = item.get("diagnosis") or {}
        title = f"[{item.get('severity')}] {item.get('title')}"
        detail = "\n".join([
            f"症状：{item.get('symptom')}",
            f"影响：{item.get('blast_radius')}",
            f"证据：{'；'.join(item.get('evidence', [])[:4])}",
            f"AI 研判：{diag.get('summary', '未研判')}",
            f"升级：{item.get('escalate_to')}",
            f"Runbook：{item.get('runbook')}",
        ])
        res = notify("aiops_incident", title, detail, key=item["id"], force=force)
        return {"incident": item, "notify": res}
    raise KeyError("事件不存在")


def resolve_incident(incident_id: str, by: str = "on-call", note: str = "") -> dict:
    with _LOCK:
        data = _load()
        for item in data.get("incidents", []):
            if item.get("id") == incident_id:
                item["status"] = "resolved"
                item["resolved_by"] = by
                item["resolved_at"] = _now()
                item["resolution_note"] = note[:300]
                item["updated_at"] = _now()
                _save(data)
                return item
    raise KeyError("事件不存在")


# ------------------------------------------------------------------ AI 研判
_DIAG_SYSTEM = """你是企业物流系统的运维事故参谋。只能根据给定的事实做研判，不得编造。
输出 JSON：
{"summary":"一句话结论","confidence":0.0,
 "likely_causes":[{"cause":"...","confidence":0.0,"evidence":["..."]}],
 "evidence":["..."],"immediate_actions":["..."],
 "needs_human":["..."],"escalate_to":"...","runbook":"..."}
要求：evidence 必须来自输入事实；没有证据就写“数据不足”；不要输出命令。"""

_RULE_DIAG = {
    "host_down": {
        "summary": "主机/网络级故障，应用本身无法自证",
        "causes": ["断电/UPS 异常", "主机硬件故障", "网络中断/路由异常"],
        "actions": ["确认 UPS/电源与带外管理", "切备用实例或备库", "恢复后校验数据一致性"],
        "human": ["基础设施确认电源/网络", "客户 IT 确认机房/线路"],
        "escalate": "值班运维 → 基础设施 → 客户 IT",
    },
    "db_down": {
        "summary": "数据库不可用，所有依赖库的读写受阻",
        "causes": ["数据库进程异常", "磁盘满/IO 故障", "连接数耗尽", "主备切换失败"],
        "actions": ["检查 DB 进程/磁盘/连接数", "必要时切备库", "恢复后校验数据"],
        "human": ["DBA 确认主备状态", "基础设施确认磁盘/网络"],
        "escalate": "DBA → 基础设施 → 研发",
    },
    "app_down": {
        "summary": "应用服务不可用，需先恢复进程/实例",
        "causes": ["进程崩溃/OOM", "端口/反代异常", "依赖初始化失败"],
        "actions": ["滚动重启/摘流重启", "检查启动日志与依赖", "外部探针验证"],
        "human": ["研发确认启动失败原因"],
        "escalate": "值班运维 → 研发",
    },
    "external_probe": {
        "summary": "外部探针失败，可能是 DNS/反代/网络策略",
        "causes": ["DNS 解析异常", "反向代理/证书问题", "网络 ACL/安全组"],
        "actions": ["从外部多地域验证 DNS/HTTPS", "检查反代与证书", "回滚最近网络变更"],
        "human": ["网络/运维确认链路", "客户 IT 确认白名单"],
        "escalate": "网络/运维 → 客户 IT",
    },
    "post_deploy_5xx": {
        "summary": "发布后错误率飙升，优先怀疑最近变更",
        "causes": ["代码缺陷", "配置/环境不一致", "数据库迁移不兼容"],
        "actions": ["暂停继续发布", "回滚上一稳定版本", "复核核心链路"],
        "human": ["研发确认变更内容与回滚方案"],
        "escalate": "研发负责人 → 值班运维",
    },
    "llm_outage": {
        "summary": "模型网关连续超时，解析/问答降级",
        "causes": ["模型供应商故障", "网关限流/网络", "密钥/配额问题"],
        "actions": ["切备用模型/关闭模型增强", "观察解析成功率", "恢复后评估切回"],
        "human": ["模型供应商/网关负责人"],
        "escalate": "运维 → 模型供应商",
    },
    "ransomware": {
        "summary": "疑似勒索/异常加密，先隔离再恢复",
        "causes": ["勒索病毒", "异常脚本/人为误操作", "备份被破坏"],
        "actions": ["隔离主机与备份", "保留现场证据", "从离线备份恢复"],
        "human": ["安全负责人", "客户 IT/管理层"],
        "escalate": "安全负责人 → 客户 IT → 管理层",
    },
    "llm_balance_exhausted": {
        "summary": "模型余额已用完，先降级再充值",
        "causes": ["未及时充值/续费", "用量突然放大", "计费口径变化或超额计费"],
        "actions": ["立即关闭非核心模型调用", "切备用 Key/网关", "按 30–60 天用量发起充值审批"],
        "human": ["财务/采购确认预算", "运维确认消耗来源"],
        "escalate": "运维 → 采购/财务 → 模型供应商",
    },
    "llm_quota_exhausted": {
        "summary": "模型 token 额度已用完，先降级再扩额",
        "causes": ["批量重跑/异常调用", "提示词变长导致单次消耗上升", "额度按周期未续"],
        "actions": ["关闭非核心模型调用并下调 max_tokens", "查今日调用来源与批次", "申请扩额或切备用账号"],
        "human": ["业务确认哪些功能可暂缓", "采购确认扩额"],
        "escalate": "运维 → 业务/采购",
    },
    "llm_key_expired": {
        "summary": "模型 Key/账号已过期，模型增强不可用",
        "causes": ["未提前续期", "账号被停用", "Key 被轮换后未更新配置"],
        "actions": ["切换备用 Key", "确认供应商账号状态", "更新配置后跑一次金标回归"],
        "human": ["采购确认续费/合同", "运维更新密钥"],
        "escalate": "运维 → 采购/模型供应商",
    },
    "llm_model_retired": {
        "summary": "当前模型已下线，需要切换替代模型",
        "causes": ["供应商下线该模型", "模型版本被强制升级", "网关不再支持该模型名"],
        "actions": ["切到已验证的替代模型", "跑金标回归对比", "观察解析成功率与耗时"],
        "human": ["研发确认替代模型", "业务确认可接受的准确率"],
        "escalate": "研发/运维",
    },
}


def _rule_diagnosis(incident: dict) -> dict:
    rule = incident.get("rule", "")
    d = _RULE_DIAG.get(rule, {
        "summary": "需要人工进一步研判",
        "causes": ["数据不足"],
        "actions": ["收集指标/日志/变更记录"],
        "human": ["值班运维"],
        "escalate": incident.get("escalate_to", "值班运维"),
    })
    return {
        "summary": d["summary"], "confidence": 0.72,
        "likely_causes": [{"cause": c, "confidence": 0.6, "evidence": incident.get("evidence", [])[:2]}
                          for c in d["causes"]],
        "evidence": incident.get("evidence", []),
        "immediate_actions": d["actions"], "needs_human": d["human"],
        "escalate_to": d["escalate"], "runbook": incident.get("runbook", ""),
        "engine": "rule",
    }


def diagnose(incident: dict, snapshot: dict | None = None, use_llm: bool = True) -> dict:
    base = _rule_diagnosis(incident)
    if not (use_llm and settings.llm_enabled):
        return base
    context = {
        "incident": {k: incident.get(k) for k in
                     ("id", "severity", "title", "symptom", "evidence", "blast_radius", "runbook")},
        "snapshot": snapshot or {},
        "runbook": RUNBOOKS.get(incident.get("runbook", ""), {}),
    }
    try:
        res = llm.chat_json(_DIAG_SYSTEM, json.dumps(context, ensure_ascii=False))
        data = llm.parse_json_loose(res.text) if res.ok else None
    except Exception:  # noqa: BLE001
        data = None
    if not isinstance(data, dict):
        return base
    summary = str(data.get("summary") or "").strip()
    causes = data.get("likely_causes")
    if not summary or not isinstance(causes, list):
        return base
    ctx_text = json.dumps(context, ensure_ascii=False)
    evidence = [str(x) for x in (data.get("evidence") or []) if isinstance(x, str)]
    evidence = [x for x in evidence if x and x[:30] in ctx_text][:8]
    merged = dict(base)
    merged.update({
        "summary": summary[:300],
        "confidence": max(0.0, min(1.0, float(data.get("confidence") or 0.7))),
        "likely_causes": [
            {"cause": str(c.get("cause", ""))[:160],
             "confidence": max(0.0, min(1.0, float(c.get("confidence") or 0.6))),
             "evidence": [str(e)[:200] for e in (c.get("evidence") or []) if isinstance(e, str)][:3]}
            for c in causes[:5] if isinstance(c, dict) and c.get("cause")
        ] or base["likely_causes"],
        "evidence": evidence or base["evidence"],
        "immediate_actions": [str(x)[:200] for x in (data.get("immediate_actions") or base["immediate_actions"])][:6],
        "needs_human": [str(x)[:200] for x in (data.get("needs_human") or base["needs_human"])][:5],
        "escalate_to": str(data.get("escalate_to") or base["escalate_to"])[:120],
        "runbook": str(data.get("runbook") or base["runbook"])[:80],
        "engine": "rule+ai",
    })
    return merged


def diagnose_incident(incident_id: str, use_llm: bool = True) -> dict:
    data = _load()
    for item in data.get("incidents", []):
        if item.get("id") == incident_id:
            diag = diagnose(item, use_llm=use_llm)
            item["diagnosis"] = diag
            item["updated_at"] = _now()
            _save(data)
            return {"incident": item, "diagnosis": diag}
    raise KeyError("事件不存在")


# ------------------------------------------------------------------ 处置计划
def plan_runbook(name: str, target: str = "") -> dict:
    rb = RUNBOOKS.get(name)
    if not rb:
        raise KeyError("Runbook 不存在")
    return {
        "runbook": name, "title": rb["title"], "target": target,
        "mode": "plan", "risk": rb["risk"],
        "requires_approval": not rb["auto"],
        "steps": rb["steps"], "rollback": rb["rollback"], "owner": rb["owner"],
        "note": "默认只生成处置计划；生产执行需接客户执行器并审批，不直接跑 shell。",
        "created_at": _now(),
    }


# ------------------------------------------------------------------ 演示快照
def demo_snapshot(scenario: str = "mixed") -> dict:
    """演示快照：gray=只有灰犀牛，black=主机/网络黑天鹅，mixed=两类都有。"""
    base = {
        "timestamp": _now(),
        "host": {"up": True, "heartbeat_age_sec": 8, "disk_used_pct": 62,
                 "disk_growth_pct_per_day": 0.2, "mem_used_pct": 58,
                 "cpu_used_pct": 35, "uptime_hours": 720},
        "db": {"up": True, "size_bytes": 2.2e9, "growth_gb_per_day": 0.01,
               "pool_util": 0.42, "pool_waiting": 0, "slow_queries_1h": 2,
               "backup_age_hours": 8},
        "app": {"up": True, "http_5xx_ratio": 0.002, "p95_ms": 280,
                "batch_failed": 0, "outbox_pending": 0, "queue_pending": 0,
                "ocr_fail_ratio": 0.01, "llm_timeout_per_5m": 0},
        "security": {"cert_days_left": 90},
        "probes": {"external_ok": True, "db_ok": True, "llm_ok": True},
        "recent_change": {"version": "v1.27", "deployed_minutes_ago": 480},
        "llm": {"model": "deepseek-v4.1-flash", "enabled": True,
                "key_expires_days": 120, "model_retires_days": 180,
                "balance_cny": 4800.0, "quota_tokens": 9000000,
                "remaining_tokens": 8000000, "avg_tokens_per_day": 60000,
                "avg_cost_per_day": 0.9, "today_cost": 1.1,
                "today_tokens": 72000, "today_errors": 0},
    }
    if scenario == "gray":
        base["host"].update({"disk_used_pct": 86, "disk_growth_pct_per_day": 1.2,
                             "mem_used_pct": 78, "uptime_hours": 720})
        base["db"].update({"size_bytes": 4.8e9, "growth_gb_per_day": 0.08,
                           "pool_util": 0.92, "pool_waiting": 3,
                           "slow_queries_1h": 27, "backup_age_hours": 40})
        base["app"].update({"http_5xx_ratio": 0.012, "p95_ms": 900,
                            "batch_failed": 18, "outbox_pending": 35,
                            "queue_pending": 40, "ocr_fail_ratio": 0.12,
                            "llm_timeout_per_5m": 6})
        base["security"]["cert_days_left"] = 9
        base["probes"].update({"external_ok": True, "llm_ok": True})
        base["recent_change"].update({"version": "v1.27", "deployed_minutes_ago": 480})
        base["llm"].update({"key_expires_days": 12, "model_retires_days": 20,
                            "balance_cny": 260.0, "quota_tokens": 5000000,
                            "remaining_tokens": 180000, "avg_tokens_per_day": 95000,
                            "avg_cost_per_day": 18.5, "today_cost": 62.0,
                            "today_tokens": 310000, "today_errors": 4})
    elif scenario == "black":
        base["host"].update({"up": False, "heartbeat_age_sec": 180,
                             "disk_used_pct": 78, "disk_growth_pct_per_day": 0.5})
        base["app"].update({"up": False, "http_5xx_ratio": 0.08, "p95_ms": 0})
        base["probes"].update({"external_ok": False, "db_ok": True, "llm_ok": True})
        base["recent_change"].update({"version": "v1.27", "deployed_minutes_ago": 480})
    else:
        base["host"].update({"disk_used_pct": 86, "disk_growth_pct_per_day": 1.2,
                             "mem_used_pct": 78, "uptime_hours": 720})
        base["db"].update({"size_bytes": 4.8e9, "growth_gb_per_day": 0.08,
                           "pool_util": 0.92, "pool_waiting": 3,
                           "slow_queries_1h": 27, "backup_age_hours": 40})
        base["app"].update({"http_5xx_ratio": 0.042, "p95_ms": 1800,
                            "batch_failed": 18, "outbox_pending": 35,
                            "queue_pending": 40, "ocr_fail_ratio": 0.12,
                            "llm_timeout_per_5m": 12})
        base["security"]["cert_days_left"] = 9
        base["probes"].update({"external_ok": False, "db_ok": True, "llm_ok": False})
        base["recent_change"].update({"version": "v1.28", "deployed_minutes_ago": 18})
    return base


def demo(scenario: str = "mixed") -> dict:
    result = evaluate(demo_snapshot(scenario))
    # 给第一个事件做一次规则研判，页面打开就能看到“AI 研判”长什么样
    for item in result.get("incidents", []):
        if item["severity"] == "P1":
            item["diagnosis"] = diagnose(item, use_llm=False)
            break
    return result


# ------------------------------------------------------------------ 真实采集
DISK_HISTORY_PATH = ROOT / "data" / "aiops_disk.json"


def _disk_usage() -> tuple[float, float]:
    """返回 (使用率, 日增速)。增速来自本地每日采样，样本不足就返回 0。"""
    import shutil
    from datetime import date

    usage = shutil.disk_usage(str(ROOT))
    used_pct = round(usage.used / usage.total * 100, 1)
    history: dict = {}
    try:
        history = json.loads(DISK_HISTORY_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        history = {}
    if not isinstance(history, dict):
        history = {}
    history[date.today().isoformat()] = used_pct
    keep = sorted(history)[-30:]
    history = {k: history[k] for k in keep}
    DISK_HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    DISK_HISTORY_PATH.write_text(json.dumps(history, ensure_ascii=False, indent=2),
                                 encoding="utf-8")
    growth = 0.0
    if len(history) >= 2:
        first, last = keep[0], keep[-1]
        try:
            span = (date.fromisoformat(last) - date.fromisoformat(first)).days
        except ValueError:
            span = 0
        if span > 0:
            growth = round((float(history[last]) - float(history[first])) / span, 2)
    return used_pct, growth


def collect_snapshot() -> dict:
    """按当前进程/主机真实数据组装快照；拿不到的项不写，规则自动跳过。

    能采到的：磁盘使用率与日增速、DB 大小、发件箱/批次积压、5xx 比例、模型用量与余额。
    采不到的：内存、连接池、备份年龄、证书、外部探针——这些由 exporter 提供，
    调用 `POST /api/ops/ai/evaluate` 时把对应字段补进来即可。
    """
    from . import llm_usage

    snap: dict = {"timestamp": _now(), "llm": llm_usage.snapshot()}

    used_pct, growth = _disk_usage()
    snap["host"] = {"up": True, "disk_used_pct": used_pct,
                    "disk_growth_pct_per_day": growth}

    try:
        from . import db
        if db.BACKEND == "postgres":
            from .store import _conn
            with _conn() as conn:
                size = conn.execute(
                    "SELECT pg_database_size(current_database()) AS n").fetchone()["n"]
            snap["db"] = {"up": True, "size_bytes": int(size)}
        else:
            base = settings.db_path
            size = sum(p.stat().st_size for p in
                       (base, Path(str(base) + "-wal"), Path(str(base) + "-shm"))
                       if p.exists())
            snap["db"] = {"up": True, "size_bytes": int(size)}
    except Exception:  # noqa: BLE001
        snap["db"] = {"up": False}

    app: dict = {"up": True}
    try:
        from .store import ops_counts
        counts = ops_counts()
        outbox = counts.get("outbox") or {}
        app["outbox_pending"] = int(outbox.get("pending", 0)) + int(outbox.get("failed", 0))
        app["batch_failed"] = int((counts.get("items") or {}).get("failed", 0))
    except Exception:  # noqa: BLE001
        pass
    try:
        from . import metrics
        health = metrics.http_health()
        app["http_5xx_ratio"] = health["http_5xx_ratio"]
        app["p95_ms"] = health["avg_ms"]
    except Exception:  # noqa: BLE001
        pass
    snap["app"] = app
    return snap


def collect() -> dict:
    """采集一次真实快照并评估；给页面按钮和定时任务共用。"""
    return evaluate(collect_snapshot())

