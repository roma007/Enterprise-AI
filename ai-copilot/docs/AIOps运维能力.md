# 运维智能（AIOps）能力说明

> 版本：0.51.0 ｜ 2026-11-09 ｜ 节点：AI-51 / AI-52
> 目标：把“灰犀牛”提前发现、把“黑天鹅”快速收敛；规则负责确定性判断，AI 负责解释与建议，不直接执行危险命令。

---

## 一、两类问题，两套打法

| | 灰犀牛（可预判） | 黑天鹅（不可预判） |
|---|---|---|
| 例子 | 磁盘将满、DB 增长、证书到期、备份变旧、队列积压 | 断电、硬件损坏、网络中断、DB 宕机、坏发布 |
| 本质 | 趋势积累 | 突然断裂 |
| 重点 | 提前 N 天看见并消除 | 1 分钟内发现、快速止损/切换/恢复 |
| AI 角色 | 解释趋势、排优先级、匹配 Runbook | 汇总证据、缩小排查范围、建议切换/回滚 |
| 自动化 | 清理、续证、重排、扩容 | 切换、降级、恢复、回滚 |
| 成功标准 | 故障发生前解决 | MTTD/MTTR、RTO/RPO 达标 |

**不承诺 AI 预测黑天鹅。** AI 只能缩短黑天鹅的发现、判断和恢复时间。

---

## 二、已实现的能力

### 1. 规则引擎

`app/aiops.py` 接收一次指标快照，输出两类结果：

- `risks[]`：灰犀牛风险，带 ETA、证据、影响、Runbook、负责人、是否可自动。
- `incidents[]`：黑天鹅事件，带级别、症状、证据、影响范围、升级对象。

已覆盖：

| 灰犀牛 | 触发 |
|---|---|
| 磁盘将满 | 使用率 ≥80%，按增速预测 ≤30 天 |
| DB 增长 | DB ≥4GB 或日增 ≥0.05GB |
| 连接池 | 使用率 ≥85% 或有等待 |
| 备份变旧 | 最后成功 >36 小时 |
| 证书到期 | 剩余 ≤30 天 |
| 队列积压 | 发件箱 >20 或任务 >30 |
| 批次失败 | 失败项 >10 |
| 内存压力 | 使用率 ≥85% |
| 错误预算 | 5xx >1% 且最近 30 分钟无发布 |
| 模型超时 | 5 分钟超时 ≥5 次 |
| 模型余额不足 | 余额 ≤30 天用量（按近 7 天日均费用） |
| 模型额度不足 | 剩余 token ≤30 天用量 |
| 模型 Key 到期 | 剩余 ≤45 天 |
| 模型下线 | 当前模型剩余 ≤45 天 |
| 消耗异常放大 | 今日费用 ≥3 倍日均 |

| 黑天鹅 | 触发 |
|---|---|
| 主机/网络不可达 | 心跳 >60 秒或 host.up=false |
| 数据库不可用 | db.up=false 或 DB 探针失败 |
| 应用不可用 | app.up=false |
| 外部探针失败 | 应用自报存活但外部不可达 |
| 发布后 5xx 飙升 | 5xx ≥5% 且 30 分钟内有发布 |
| 模型网关连续超时 | 5 分钟超时 ≥10 次 |
| 疑似勒索 | 安全标记 ransomware_suspected=true |
| 模型余额/额度耗尽 | 余额 ≤0 或剩余 token ≤0 |
| 模型 Key/模型已过期 | 到期日已过 |

### 2. AI 研判

`diagnose()` 先做规则研判，再可选调用模型补充。输出固定 JSON：

```json
{
  "summary": "一句话结论",
  "confidence": 0.72,
  "likely_causes": [{"cause": "...", "confidence": 0.6, "evidence": ["..."]}],
  "evidence": ["..."],
  "immediate_actions": ["..."],
  "needs_human": ["..."],
  "escalate_to": "...",
  "runbook": "...",
  "engine": "rule | rule+ai"
}
```

约束：

- 只引用输入事实，证据必须能在上下文中找到。
- 不输出 shell 命令。
- 模型失败/未配置自动回退规则研判。
- 高风险动作必须人工审批。

### 3. Runbook 库

默认只生成处置计划，不直接执行：

| Runbook | 风险 | 自动 | 说明 |
|---|---|---|---|
| disk_cleanup | 低 | 是 | 清日志/临时文件/旧备份 |
| backup_now | 低 | 是 | 触发备份并校验 |
| cert_renew | 低 | 是 | 续期并重载 |
| queue_drain | 低 | 是 | 重排/扩容 worker |
| batch_retry | 低 | 是 | 重试失败批次 |
| llm_fallback | 低 | 是 | 切备用/关闭模型增强 |
| db_archive | 中 | 否 | 归档/扩容评估 |
| db_pool_tune | 中 | 否 | 清空闲会话/扩池 |
| service_restart | 中 | 否 | 滚动重启 |
| rollback_release | 高 | 否 | 回滚最近发布 |
| failover_host | 高 | 否 | 主机/实例切换 |
| llm_topup | 中 | 否 | 余额/额度充值续费（资金动作，必须审批） |
| llm_throttle | 低 | 是 | 关非核心模型调用、降 max_tokens、提高缓存 |
| llm_key_renew | 中 | 否 | Key/账号续期与切换 |
| llm_model_migrate | 中 | 否 | 模型下线迁移与回归 |

生产执行器应接 K8s / Ansible / 客户运维平台，带前置条件、幂等、回滚、审计；MVP 只做计划与审批闭环。

### 4. 页面与 API

- 页面：`/ops-ai`（数据与设置 → 运维智能）
- API：
  - `GET /api/ops/ai/state`：当前风险/事件/动作
  - `GET /api/ops/ai/summary`
  - `GET /api/ops/ai/demo?scenario=gray|black|mixed`
  - `POST /api/ops/ai/evaluate`：提交指标快照
  - `POST /api/ops/ai/incidents/{id}/diagnose`
  - `POST /api/ops/ai/incidents/{id}/diagnose`
  - `POST /api/ops/ai/incidents/{id}/notify`（按现有企微/邮件配置发送）
  - `POST /api/ops/ai/incidents/{id}/ack|resolve`
  - `GET /api/ops/ai/llm`：模型用量、余额/额度、可撑天数
  - `POST /api/ops/ai/llm/budget`：更新余额/额度/到期日
  - `POST /api/ops/ai/collect`：采集本机真实指标并评估
  - `POST /api/ops/ai/runbooks/{name}/plan`
  - `POST /api/ops/ai/reset`
- 权限：管理员（`/api/ops/ai` 在 `ADMIN_ONLY_PREFIXES`）。

---

## 三、指标快照格式

```json
{
  "host": {"up": true, "heartbeat_age_sec": 8, "disk_used_pct": 86,
           "disk_growth_pct_per_day": 1.2, "mem_used_pct": 78,
           "cpu_used_pct": 46, "uptime_hours": 720},
  "db": {"up": true, "size_bytes": 4800000000, "growth_gb_per_day": 0.08,
         "pool_util": 0.92, "pool_waiting": 3, "slow_queries_1h": 27,
         "backup_age_hours": 40},
  "app": {"up": true, "http_5xx_ratio": 0.042, "p95_ms": 1800,
          "batch_failed": 18, "outbox_pending": 35, "queue_pending": 40,
          "ocr_fail_ratio": 0.12, "llm_timeout_per_5m": 12},
  "security": {"cert_days_left": 9},
  "probes": {"external_ok": false, "db_ok": true, "llm_ok": false},
  "recent_change": {"version": "v1.28", "deployed_minutes_ago": 18},
  "llm": {
    "model": "deepseek-v4.1-flash",
    "balance_cny": 260, "remaining_tokens": 180000,
    "avg_tokens_per_day": 95000, "avg_cost_per_day": 18.5,
    "today_cost": 62, "key_expires_days": 12, "model_retires_days": 20
  }
}
```

### 模型资源怎么来的

- `app/llm.py` 每次调用后写 `data/llm_usage.json`：只记 token 数、调用次数、失败/缓存次数，**不记提示词内容**。
- 日均消耗按“近 7 天（不含今天）”算，避免早上被 0 拉低。
- 余额/额度/到期日来自 `.env` 或 `data/llm_budget.json`（用 `POST /api/ops/ai/llm/budget` 更新）。
- 有余额基准日时，只扣基准日之后的消耗；没有就当作“此刻余额”。
- 没配余额/额度就不出 ETA，规则直接跳过，不猜。

采集侧建议：

- `node_exporter`：磁盘、内存、CPU、心跳。
- `postgres_exporter`：DB 大小、连接池、慢查询、备份。
- `blackbox_exporter`：外部 HTTPS/TCP 探针。
- `ai-copilot /metrics`：5xx、P95、批次、发件箱、模型超时。
- 备份/证书脚本写心跳。

当前仓库已有 `/metrics` 与 `ops/prometheus-alerts.yml`；node/DB/blackbox 抓取配置仍需按客户环境补。

---

## 四、通知与升级

当前 MVP：

- 页面事故卡：级别、症状、证据、AI 研判、通知值班、认领、解决。
- 指标：`copilot_aiops_risks_open`、`copilot_aiops_incidents_open{severity}`。
- 模型指标：`copilot_llm_tokens_today`、`copilot_llm_avg_tokens_per_day`、
  `copilot_llm_avg_cost_per_day_cny`、`copilot_llm_balance_cny`、
  `copilot_llm_remaining_tokens`、`copilot_llm_days_left{kind}`、
  `copilot_llm_key_expires_days`、`copilot_llm_model_retires_days`。
- 告警：`CopilotAiopsP0Incident`、`CopilotAiopsRiskHigh`、`CopilotLlmQuotaLow`、
  `CopilotLlmBalanceZero`、`CopilotLlmKeyExpiring`。

生产接入：

- Alertmanager → 企微/邮件/短信/电话。
- P0：5 分钟未认领升级；P1：15 分钟；P2：次日。
- 事故卡包含：已做什么、还需要谁、证据、Runbook。
- 客户侧只发摘要与 ETA，不发原始日志/拓扑。

---

## 五、自检与命令

```bash
cd ai-copilot
make aiops-test        # 42 项规则/研判/Runbook/状态/模型用量自检
make ops-eval          # 既有运营能力回归
make aiops-collect     # 采集本机指标并评估（cron 每 5 分钟跑一次）
```

自检覆盖：

- 健康快照无告警；
- 灰犀牛：磁盘/DB/证书/备份/队列；
- 黑天鹅：主机不可达 P0，且不重复报 app/db；
- AI 研判有结论/证据/动作/升级；
- Runbook 低风险自动、中高风险审批；
- 状态持久化、认领、解决；
- 模型资源：余额、额度、Key 到期、消耗放大；余额/额度耗尽升级为 P1；
- 用量账本：今日 token、近 7 天日均、失败计数、可撑天数。

---

## 六、落地边界

- 这是**规则 + AI 的研判/计划闭环**，不是“AI 直接修服务器”。
- 黑天鹅不预测；只承诺更快发现、收敛、升级。
- 真实自动执行需接客户执行器并审批；MVP 默认只出计划。
- 指标/日志质量决定 AI 研判质量；没有数据就输出“数据不足”。
- 模型余额是“账面事实”，不是预测：没配置余额/额度就不出 ETA。
- 供应商余额接口没有统一标准，先靠人工/脚本更新；不要把“猜的余额”当告警依据。
- 单租户部署；指标/告警可出客户边界，日志默认不出。

---

## 七、下一步

1. 接 node/postgres/blackbox exporter，把真实快照 POST 到 `/api/ops/ai/evaluate`。
2. 接 Alertmanager，P0 电话/短信，P1 企微。
3. 接 K8s/Ansible 执行器，先开放低风险 Runbook。
4. 加事故时间线、复盘、Runbook 成功率统计。
5. 每月做一次恢复/切换演练，按灰犀牛/黑天鹅分开复盘。
6. 模型余额：能用供应商接口就定时拉，不能就每日人工/脚本更新一次，别让它过期才发现。
