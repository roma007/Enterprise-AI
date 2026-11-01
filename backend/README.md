# 企业 AI 化项目管理系统 · 后端

诊断阶段（S1）的可运行后端。把文档里的领域模型、四条硬规则和 R5 十四项校验落成了 **PostgreSQL + TypeScript**。

```
Fastify 5  ←  HTTP
   │
   ├── src/repo.ts          一次取出生成报告需要的完整快照
   ├── src/rules/           四条硬规则之外的跨表判断（C1–C14、传导链、分位）
   ├── src/templates/       物流行业诊断报告模板（决定局限出现在哪一节）
   └── src/services/        生成交付物：拦截 block、写审计、存快照
          │
          └── PostgreSQL 15
                ├── 001_schema.sql    30 张表（v1 21 + v2.2 9）
                ├── 002_functions.sql 触发器 / 分位 / 连乘 / 视图
                └── 003_seed.sql      宏远国际物流样例
```

## 快速开始

```bash
cd backend
npm install
npm run db:reset     # 清空 → 迁移 → 灌样例（本地开发）
npm run db:migrate   # 只跑增量迁移（已有库升级时用）
npm run verify       # 17 项数据库规则断言（R1–R4 / P1–P4），失败即非零退出
npm run verify:report # 11 项报告结构与生成接口回归（章节编号 / 流程 / 四维 / 并发）
npm run verify:write # 30 项 S1 录入闭环回归（从空客户建项目直到生成报告）
npm run demo         # 跑 14 项校验 + 打印组合数字 + 生成 1 份报告
npm run openapi      # 生成 docs/openapi.json
npm run dev          # http://127.0.0.1:8788
```

演示登录账号（`db:reset` 后可用）：

| 邮箱 | 密码 | 角色 |
|---|---|---|
| `zhang@hengzhi.ai` | `demo1234` | consultant |
| `wang@hengzhi.ai` | `demo1234` | pm |
| `liu@hengzhi.ai` | `demo1234` | tech_lead |
| `admin@hengzhi.ai` | `demo1234` | admin |

`AUTH_REQUIRED` 默认 `false`，本地不登录也能调接口（回退到第一个组织）；设为 `true` 后，除 health/login/config/docs 外都需要 `Authorization: Bearer <token>`。单资源归属校验按 `org_id` 执行，跨组织访问统一返回 404；列表按当前组织过滤。

**角色权限（有登录态时生效）**：

| 动作 | admin / director | pm | consultant / tech_lead |
|---|---|---|---|
| 普通业务录入（痛点/机会点/方案/POC/交付/UAT/运营） | ✅ | ✅ | ✅ |
| 查看审计日志、回收站 | ✅ | ✅ | ❌ |
| 删除客户/项目/交付物、恢复回收站 | ✅ | ✅ | ❌ |
| 交付物审批、外发、撤销外发 | ✅ | ✅ | ❌ |
| 知识审批（通过/退回） | ✅ | ✅ | ❌ |
| 行业标杆、指标字典维护 | ✅ | ❌ | ❌ |

匿名开发模式不做角色校验；`AUTH_REQUIRED=true` 时必须带有效 token。越权统一返回 403 `FORBIDDEN`。

**项目级成员权限**：

- `GET/POST /api/engagements/:id/members`、`PATCH/DELETE /api/engagement-members/:id`
- 角色：`manager`（负责人）/ `member`（成员）/ `viewer`（只读）
- 项目配置成员后，非成员访问项目资源返回 403 `PROJECT_FORBIDDEN`，列表中也不再出现该项目。
- `viewer` 只读，写操作返回 403 `PROJECT_READONLY`。
- 未配置成员的项目保持组织内可见，避免历史项目被锁死。
- 管理员/总监保留组织级可见性；项目经理可管理成员；项目至少保留一名负责人。
- 成员关系随项目硬删除级联清理。

**登录安全**：连续登录失败按 `IP + 邮箱` 滑动窗口计数，默认 5 次 / 15 分钟（`LOGIN_MAX_FAILURES` / `LOGIN_WINDOW_MS`）；超限返回 429 `LOGIN_RATE_LIMITED` + `retry-after`，限流期间即使密码正确也会被拦截。登录成功清空计数；进程内存实现。

**密码策略**：新建用户、管理员重置、自助改密统一校验：≥10 位、大小写/数字/符号至少 3 类、不能是常见弱口令或包含邮箱前缀；新密码不能与最近 5 次相同（`password_history`）。违反返回 422 `WEAK_PASSWORD` / `PASSWORD_REUSED`。

**用户管理**（仅管理员/总监）：`GET/POST /api/admin/users`、`PATCH /api/admin/users/:id`、`POST /api/admin/users/:id/reset-password`；支持创建账号、调整组织角色、禁用/启用、重置密码；禁用与重置会撤销该用户全部会话，组织至少保留一名启用管理员。

**会话撤销**：登录 token 携带 `jti`，`user_sessions` 记录会话；每个带 token 的请求校验会话未撤销未过期。接口：
- `POST /api/auth/change-password`：当前用户校验旧密码后改密，保留当前会话、撤销其他会话；连续错误同样受 `LOGIN_MAX_FAILURES` 限制
- `GET /api/auth/sessions`、`DELETE /api/auth/sessions/:id`、`POST /api/auth/logout`、`POST /api/auth/logout-all`
- `GET /api/users/:id/sessions`、`POST /api/users/:id/revoke-sessions`（仅管理员/总监）
- 前端「登录会话」页可查看设备/IP/时间，撤销单个会话或全部退出。
- 会话清理：`POST /api/user-sessions/cleanup`（执行需 `confirm=CLEANUP`，仅管理员/总监，按当前组织）或 CLI `npm run sessions:cleanup -- --days=30 --dry-run`；只删除已过期/已撤销且超过保留期的会话，`USER_SESSION_RETENTION_DAYS` 默认 30 天。

**可观测性**：

- 每个响应带 `x-request-id`；上游传入合法 `x-request-id` 时原样透传，否则生成 UUID。
- 错误响应体包含 `requestId`，前端错误框直接展示，便于按 ID 查日志。
- 访问日志为结构化 JSON：`event=request_completed`、`requestId`、`method`、`route`、`statusCode`、`durationMs`、`orgId`、`userId`。
- 日志自动脱敏 `authorization` / `cookie` / `set-cookie`。
- `audit_logs.request_id` 与访问日志同源，审计页可直接看到请求 ID。
- 公开分享访问：默认每 IP + token 60 次/分钟（`PUBLIC_SHARE_RATE_LIMIT` / `PUBLIC_SHARE_RATE_WINDOW_MS`），超限返回 429 + `retry-after`；记录 browser/Word/PDF 访问明细与 IP/UA/Referer（`TRUST_PROXY=true` 时使用代理转发 IP）。

分享访问归档：`POST /api/share-views/archive`（执行需 `confirm=CLEANUP`，仅管理员/总监，按当前组织）或 CLI `npm run share:archive -- --days=180 --dry-run`；`SHARE_VIEW_RETENTION_DAYS` 默认 180 天。热表移入 `share_views_archive`，不物理删除。

分享归档查询/导出：`GET /api/share-views/archive` 支持 `share_id/token/kind/from/to` + 分页；`GET /api/share-views/archive/export.csv` 最多 5 万行。归档表带 `org_id`，分享链接删除后仍可按组织检索。
- 慢请求：`durationMs` 超过 `SLOW_REQUEST_MS`（默认 500ms）时额外输出 `event=slow_request` 警告日志。
- 指标端点 `GET /metrics`（Prometheus 文本格式，进程内计数，重启归零）：
  - `http_requests_total{method,route,status}`
  - `http_request_duration_ms` 直方图（50/100/200/500/1000/2000/5000ms）
  - `slow_requests_total`
  - `process_uptime_seconds`
  - `db_up`（`SELECT 1` 探活）
  - 设置 `METRICS_TOKEN` 后需 `Authorization: Bearer <token>` 或 `?token=`；`/metrics` 抓取本身不计入指标。

**审计归档**：

- 热表 `audit_logs` + 归档表 `audit_logs_archive`（同构，多 `archived_at`）。
- `POST /api/audit-logs/archive`：`{ before, dry_run, confirm }`；默认 dry-run，执行需 `confirm=ARCHIVE`。
- `GET /api/audit-logs/archive`：分页查询归档记录。
- 归档只移动、不删除；管理员/总监可操作，其他角色 403。
- CLI：`npm run audit:archive -- --days=180 --dry-run`，去掉 `--dry-run` 执行；支持 `--batch=1000`。
- 建议 cron 每日执行，保留 180 天热数据（`AUDIT_RETENTION_DAYS` 可覆盖）。

**分页**：项目、客户、痛点、盘点、机会点、交付物、知识库、审计日志统一支持 `limit` / `offset`，默认 200、上限 500，返回 `{ items, total, limit, offset }`；超过上限返回 400。

**搜索**：上述列表均支持 `q`（服务端 ILIKE），项目/客户按名称与行业，痛点/机会点/盘点按编号、标题、描述、来源，交付物按标题/类型，审计按 action/对象/IP/操作人；与分页组合使用，`total` 为过滤后的总数。

数据库连接默认 `postgres://127.0.0.1:5432/ai_delivery`，可用 `DATABASE_URL` 覆盖；复制 `.env.example` 为 `.env` 即自动加载。

**服务端 PDF**：`GET /api/deliverables/:id/export.pdf` 用无头 Chromium 把打印版 HTML 渲染成 PDF。按顺序查找：`PDF_CHROME_PATH` → 系统 Chrome/Chromium → Playwright 浏览器缓存。找不到浏览器时返回 503 `PDF_ENGINE_UNAVAILABLE`，不影响 Word/HTML 导出。Docker 镜像已安装 Debian `chromium` 与 `fonts-noto-cjk`。

PDF 缓存：按交付物 id / 版本 / 标题 / 客户 / 内容生成 SHA-256 key，默认写入 `backend/.pdf-cache`；命中时返回 `x-pdf-cache: HIT`，`?refresh=1` 强制重渲染并覆盖。`PDF_CACHE_DIR` 可改目录，`PDF_CACHE_TTL_DAYS` 默认 30 天，过期文件异步清理。

PDF 异步任务：`pdf_jobs` 表记录 queued/running/done/failed，进程内单并发队列执行；启动时把中断的 running 标 failed，queued 重新入队。前端点 PDF 后创建任务并轮询，完成后下载；同步导出接口仍保留。

PDF 任务清理：`POST /api/pdf-jobs/cleanup`（`{ before, dry_run, confirm }`，执行需 `confirm=CLEANUP`，仅管理员/总监）或 CLI `npm run pdf:cleanup -- --days=30 --dry-run`；只删除任务行，不删除 PDF 文件缓存。`PDF_JOB_RETENTION_DAYS` 默认 30 天。

AI 助手默认走本地规则草稿（`rule-based-v1`），不发起外部请求。配置 `AI_BASE_URL` + `AI_API_KEY`（OpenAI 兼容 `/chat/completions`）后会在规则草稿基础上润色，模型名由 `AI_MODEL` 指定；调用失败自动回退 `fallback-rule-based-v1`，不会阻塞草稿生成。`GET /api/ai/config` 只返回是否配置与模型名，不返回密钥。
`db:reset` 会 `DROP SCHEMA public CASCADE`，**只用于本地开发库**。

## 已实现的规则（不是文档，是代码）

| 规则 | 落点 | 行为 |
|---|---|---|
| **R1** 无来源痛点不能关联机会点 | 触发器 `trg_opp_pain_source` | 抛异常；已归并痛点、跨项目关联同样拦截 |
| **R2** 无基线则 ROI 置信度锁 `low` | 触发器 `trg_roi_baseline_lock` | 静默降级，不报错 |
| **R3** 有技术阻断禁止进入 `designed` | 触发器 `trg_opportunity_rules` | 未指定 `blocker_owner` 时抛异常 |
| **R4** 终止必须写原因 | CHECK `kill_requires_reason` | `stage='killed'` 且原因为空直接拒绝 |
| **P1** 收益形态全有或全无 | CHECK `realization_all_or_nothing` | 形态、系数、署名、≥10 字理由必须同时存在 |
| **P2** 分位边界 | `benchmark_position()` / `positionOf()` | 落后那条边界归落后，其余归优（含 p50） |
| **P3** 门禁缺口分级 | `ratio_level()` / `ratioLevel()` | ≥1.0 pass，0.5–1.0 warn，<0.5 block |
| **P4** 传导链 | `chain_product()` / `chainProduct()` | 逐段连乘；派生变量（stage≥90）不参与 |
| **P5** 局限分流 | `limitations.impact_class` + 模板 | amount 紧跟 ROI、scope 紧跟痛点、method 附录、internal 丢弃 |

数据库层和 TypeScript 层各实现了一遍分位与连乘：**SQL 供查询，TS 供渲染，C12 校验两者相等**。

## 14 项一致性校验（R5）

`src/rules/consistency.ts` → `runChecks(bundle)`。

| 编号 | 检查 | 级别 | 样例结果 |
|---|---|---|---|
| C1 | 进入方案设计的机会点有基线 | block | ✅ 4/4 |
| C2 | 汇总数 = 明细之和（容差 0） | block | ✅ 72.4 = 72.4 |
| C3 | 门禁状态与 checklist 一致 | block | ✅ |
| C4 | 痛点数达到门禁要求 | 动态 | ⚠️ 8/10 = 0.80 |
| C5 | killed/parked 不进推荐路线 | block | ✅ |
| C6 | low 置信度基线进入局限 | block | ✅ 1 条 |
| C7 | benchmark 存在且未过期 | warn | ⚠️ 未校准 |
| C8 | requires 依赖无环 | block | ✅ |
| C9 | template_id 存在 | block | ✅ v2.2.0 |
| C10 | 收益形态已选定并署名 | block | ✅ 4/4 |
| C11 | 门禁量化项缺口分级 | 动态 | ⚠️ 2 项 warn |
| C12 | 链条乘积 = realization_factor | block | ✅ 0.5985 = 0.5985 |
| C13 | internal 局限不进客户文档 | block | ✅ 3 条剔除 |
| C14 | amount 局限紧跟对应 ROI | block | ✅ 2 条 |

样例期望：**11 pass / 3 warn / 0 block** → 允许生成。
把 G1 状态改成 `passed` 而 checklist 仍有失败项，C3 会立刻变 block，生成接口返回 **422**，不写 `deliverables`。

## 报告结构（章节号动态生成）

模板不再写死章节号，而是按「本次实际出现的章节」连续编号，避免数据缺失时出现 `0 → 1 → 5` 这类断号。

| 章节 | 数据来源 | 说明 |
|---|---|---|
| 0 结论摘要 | 组合测算 | 核心组合、全部实施、回本口径 |
| 1 诊断范围与方法 | 访谈 / 盘点 / 基线 / 流程 / 基准 | 场次、抽样数、方法边界 |
| 2 行业定位 | `benchmarks` + 客户值 | 分位边界与「怎么读」 |
| 3 业务现状 | `process_nodes` / `process_edges` | 业务链条（树状）、关键环节量化、隐性环节 |
| 4 四维诊断 | `inventory_items` | 业务 / 数据 / 系统 / 组织，逐项完整度与核实状态 |
| 5 痛点清单 | `pain_points` | 范围类局限紧跟其后 |
| 6 机会地图 | `opportunities` | V × F × U、阻断、路线 |
| 7 ROI 测算 | `roi_models` / `roi_sensitivity` | 汇总、组合、每张卡独立编号（7.3、7.4…），金额类局限各自编号 |
| 8 依赖与路线 | `opportunity_dependencies` | Mermaid 依赖图 + 依赖明细 + 推荐路线 |
| 9 风险与阻断 | `risks` + 机会点字段 | 显式风险带概率/影响；技术阻断、数据不可得、低置信度基线自动识别 |
| 10 方法与口径 | `limitations(impact_class=method)` | 附录性质 |

`one_pager` 是独立的一页纸模板（结论、建议先做、待拍板、不确定性、下一步），不会再把完整诊断报告原样返回。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 连通性 + 表数量 |
| GET | `/api/engagements` | 项目列表（含机会点/痛点/交付物计数） |
| GET | `/api/engagements/:id` | 项目详情：机会点 + ROI 摘要 + 门禁 + 局限分类 |
| GET | `/api/engagements/:id/consistency-checks` | 跑 14 项校验，返回 pass/warn/block |
| GET | `/api/engagements/:id/preview` | 渲染报告；`?format=markdown`（默认，`text/markdown`）或 `json` |
| POST | `/api/deliverables/generate` | 生成交付物；支持 `diagnosis_report` / `one_pager`，其余类型 → **400**；有 block → **422**，成功 → **201** |
| GET | `/api/deliverables/:id` | 交付物内容 + 生成快照 + 外发记录 |
| GET | `/api/deliverables/:id/markdown` | 直接取 Markdown 正文 |
| GET | `/api/deliverables/:id/checks` | 该次生成留下的 14 条审计记录 |
| GET | `/api/opportunities/:id/roi` | ROI 卡 + 传导链 + 单段恶化 + 阈值警告 |
| GET | `/api/benchmarks/position?metric=&value=` | 单指标分位定位（含边界规则） |
| GET | `/api/benchmarks` | 物流行业 20 项基准 |
| GET | `/api/openapi.json` | OpenAPI 规范（当前按路径/标签生成，请求体 Schema 逐步补） |
| GET | `/docs` | Swagger UI |
| POST | `/api/auth/login` | 邮箱 + 密码登录，返回 8 小时 token |
| GET | `/api/me` | 当前用户 / 组织 / 角色 |

### curl 示例

```bash
EID=$(psql -h 127.0.0.1 -d ai_delivery -tAc "select id from engagements limit 1")

curl -s http://127.0.0.1:8788/api/engagements/$EID/consistency-checks | jq '.summary'
# { "pass": 11, "warn": 3, "block": 0 }

curl -s http://127.0.0.1:8788/api/engagements/$EID/preview | head

curl -s -X POST http://127.0.0.1:8788/api/deliverables/generate \
  -H 'content-type: application/json' \
  -d "{\"engagementId\":\"$EID\",\"type\":\"diagnosis_report\"}"
```

## S1 写接口（录入闭环）

所有写接口使用 JSON，字段名与数据库列保持一致（snake_case）。错误语义已统一：

| HTTP | error | 场景 |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Zod 校验失败，`issues[]` 给出字段路径 |
| 400 | `INVALID_INPUT` / `MISSING_FIELD` | UUID/日期格式错误、必填列缺失 |
| 409 | `CONFLICT` | 编号、依赖、财务快照等唯一键冲突 |
| 422 | `RULE_VIOLATION` | R1/R3、P1、门禁 passed 但 checklist 未全通过等规则违反 |
| 422 | `REFERENCE_NOT_FOUND` | 外键指向不存在的记录 |

| 实体 | 接口 |
|---|---|
| 客户 | `GET/POST /api/clients`、`PATCH /api/clients/:id`、`GET/POST /api/clients/:id/financials` |
| 项目 | `POST /api/engagements`、`PATCH /api/engagements/:id`；新建时自动初始化 G0–G5 与 G1 标准清单 |
| 门禁 | `GET /api/engagements/:id/gates`、`PUT .../gates/:code`、`POST .../gates/refresh` |
| 干系人 | `GET/POST /api/engagements/:id/stakeholders`、`PATCH /api/stakeholders/:id` |
| 访谈 | `GET/POST /api/engagements/:id/interviews`、`PATCH /api/interviews/:id` |
| 痛点 | `GET/POST /api/engagements/:id/pain-points`、`PATCH /api/pain-points/:id`；编号自动 `P-001` |
| 盘点 | `GET/POST /api/engagements/:id/inventory`、`POST .../inventory/bulk`、`PATCH /api/inventory/:id` |
| 流程 | `GET/PUT /api/engagements/:id/process-model`；节点按 `key` 或下标连线 |
| 机会点 | `GET/POST /api/engagements/:id/opportunities`、`GET/PATCH /api/opportunities/:id`、`PUT .../pain-points`；编号自动 `OP-01` |
| 基线 | `POST /api/opportunities/:id/baselines`、`PATCH/DELETE /api/baselines/:id` |
| ROI | `PUT /api/opportunities/:id/roi`、`PUT .../chain`、`POST .../roi/confirm` |
| 局限 | `GET/POST /api/engagements/:id/limitations`、`PATCH/DELETE /api/limitations/:id` |
| 依赖 | `GET/POST /api/engagements/:id/dependencies`、`DELETE /api/dependencies/:id` |
| 风险 | `GET/POST /api/engagements/:id/risks`、`PATCH/DELETE /api/risks/:id` |
| 交付物 | `GET /api/engagements/:id/deliverables`、`PATCH /api/deliverables/:id/status`、`GET /api/engagements/:id/shares` |
| 导出 | `GET /api/deliverables/:id/export.docx`、`GET /api/deliverables/:id/export.pdf`、`GET /api/deliverables/:id/export.html?print=1` |
| PDF 任务 | `POST /api/deliverables/:id/pdf-jobs`、`GET /api/deliverables/:id/pdf-jobs`、`GET /api/pdf-jobs/:id`、`GET /api/pdf-jobs/:id/file` |
| 导入 | `POST /api/engagements/:id/import?kind=pains`（也支持 `inventory`、`opportunities`，multipart `file`）、`GET /api/import/schema/:kind`、`GET /api/import/templates/:kind.csv` |
| 外发 | `POST /api/deliverables/:id/shares`、`DELETE /api/shares/:id`、`POST /api/shares/:id/rotate`、`POST /api/shares/:id/revoke`；外发前必须 `approved`，成功后状态变 `shared` |
| 只读分享 | `GET /api/public/shares/:token`、`GET .../export.docx`、`GET .../export.pdf`；token 访问、有效期、访问计数、撤销/轮换 |
| 分享访问 | `GET /api/shares/:id/views`；记录浏览/Word/PDF、IP、User-Agent、Referer；`POST /api/share-views/archive` 按组织+保留期归档 |
| 分享归档 | `GET /api/share-views/archive`（分页/过滤）、`GET /api/share-views/archive/export.csv`；仅管理员/总监 |
| 客户确认 | `GET/POST /api/engagements/:id/confirmations`、`DELETE /api/confirmations/:id`；对象/确认人必须属于该项目 |
| S2 方案 | `GET/POST /api/opportunities/:id/solutions`、`GET/PATCH/DELETE /api/solutions/:id`；组件/集成/工作量/验收/评审 |
| S2 报价 | `GET/POST /api/engagements/:id/quotes`、`GET/PATCH/DELETE /api/quotes/:id`、报价行 CRUD |
| S2 文档 | `POST /api/solutions/:id/documents`、`GET /api/solutions/:id/document(.docx)`、`POST /api/quotes/:id/documents`、`GET /api/quotes/:id/document.docx` |
| G2 门禁 | `GET /api/engagements/:id/g2-checks`（9 项：覆盖 / 范围 / 组件 / 验收 / 工作量 / 报价 / 关联 / 阻断 / 评审） |
| S3 POC | `GET/POST /api/opportunities/:id/poc-experiments`、实验详情/样本/运行/复核/结论 CRUD |
| S3 报告 | `POST /api/poc-experiments/:id/documents`、`GET .../document`、`GET .../document.docx` |
| G3 门禁 | `GET /api/engagements/:id/g3-checks`（8 项：覆盖 / 设计 / 样本 / 运行 / 复核 / 结论 / 决策 / 后续条件） |
| S4 交付 | `GET /api/engagements/:id/delivery-overview`、实施计划/任务、UAT、上线检查、培训、问题/变更 CRUD |
| G4 门禁 | `GET /api/engagements/:id/g4-checks`（11 项：计划 / 任务 / 里程碑 / UAT 覆盖 / UAT 通过 / 上线检查 / 培训 / P0P1 / 变更 / 逾期 / 客户签收） |
| S4 文档 | `POST /api/engagements/:id/delivery-documents`、`GET .../delivery-document(.docx)?type=plan\|uat\|go_live\|training` |
| S5 运营 | `GET /api/engagements/:id/value-overview`、指标目标/快照、价值记录、使用数据、续约风险 CRUD |
| G5 门禁 | `GET /api/engagements/:id/g5-checks`（9 项：目标 / 完整性 / 快照 / 来源 / 价值覆盖 / 证据 / 差异 / 使用 / 续约） |
| 指标字典 | `GET/POST /api/metric-definitions`、`PATCH/DELETE /api/metric-definitions/:id` |
| 分享页 | 客户无需登录，通过 token 只读查看/下载已批准交付物；默认 30 天有效，可撤销/轮换 |
| S5 文档 | `POST /api/engagements/:id/value-documents`、`GET .../value-document(.docx)?type=value\|renewal` |
| R6 知识库 | `GET/POST /api/knowledge`（q/industry/category/tag/status/expiring/expired）、`GET/PATCH/DELETE /api/knowledge/:id`、`POST /api/knowledge/:id/review`、`GET /api/engagements/:id/similar-knowledge` |
| R6 AI 草稿 | `GET/POST /api/engagements/:id/ai-drafts`、`PATCH/DELETE /api/ai-drafts/:id`、`POST .../confirm`、`POST .../reject`、`GET /api/ai/config`；默认 `rule-based-v1`，配置后可选大模型，必须人工确认 |
| 标杆维护 | `GET /api/benchmarks?all=1`、`POST /api/benchmarks`、`PATCH/DELETE /api/benchmarks/:id`；p25 ≤ p50 ≤ p75 |
| 回收站 | `GET /api/trash`、`POST /api/trash/:batch/restore`；客户/项目/交付物按批次恢复 |
| 审计 | `GET /api/audit-logs?limit=200&action=&object_type=`；所有写操作自动留痕 |
| 字典 | `GET /api/users` |

几个关键行为：

- **收益形态确认不接受手填系数**：`POST /roi/confirm` 会先算 `chain_product()`，再连同形态、理由、署名一起写入；链条段号不连续直接 422。
- **门禁量化项自动刷新**：录入痛点、盘点、访谈、基线、流程、一页纸后，G1 的 `actual` 由数据重算，不靠顾问手抄。
- **删除客户可级联清理**：修正了 `process_models.confirmed_by`、`deliverable_shares.shared_to` 等外键的 `ON DELETE` 行为，删客户不会再被历史确认记录挡住。

一条最小的录入顺序：

```bash
# 1 客户 → 2 项目（自动建门禁）
curl -s -X POST localhost:8788/api/clients -H 'content-type: application/json' \
  -d '{"name":"示例客户","annual_revenue":1000}'
curl -s -X POST localhost:8788/api/engagements -H 'content-type: application/json' \
  -d '{"client_id":"<CLIENT_ID>","name":"示例诊断"}'

# 3 痛点 / 盘点 / 流程 / 机会点 / 基线 / ROI / 传导链 / 确认
#    最后生成报告
curl -s -X POST localhost:8788/api/deliverables/generate -H 'content-type: application/json' \
  -d '{"engagementId":"<ENGAGEMENT_ID>","type":"diagnosis_report"}'
```

`npm run verify:write` 会把上面这条链路完整走一遍（含 R1/R3、门禁 422、并发生成），跑完删除测试客户。

## 数据模型

- `db/migrations/0001_s1_schema.sql`：30 张表。v1 的 21 张（含补齐的 `industry_templates`、`opportunity_pain_points`）+ v2.2 的 9 张（`benchmarks`、`client_financials`、`opportunity_dependencies`、`roi_sensitivity`、`process_models`、`process_nodes`、`process_edges`、`limitations`、`consistency_checks`）。
- `db/migrations/0002_s1_functions.sql`：分位、连乘、R1–R4 触发器、视图。
- `db/migrations/0003_r1_auth.sql`：登录字段与索引。
- `db/migrations/0004_r1_trash_audit.sql`：软删除字段、回收站批次、`audit_logs`。
- `db/migrations/0005_s2_solutions.sql`：S2 方案、组件、集成、工作量、验收、评审、报价 8 张表。
- `db/migrations/0006_s2_deliverable_types.sql`：交付物类型新增 `quote` / `acceptance`。
- `db/migrations/0007_s3_poc.sql`：POC 实验、样本、运行、复核、结论 5 张表。
- `db/migrations/0008_s4_delivery.sql`：实施计划、任务、UAT、上线检查、培训、问题/变更 6 张表。
- `db/migrations/0009_s4_deliverable_types.sql`：交付物类型新增 `delivery_plan` / `go_live_checklist` / `training_materials`。
- `db/migrations/0010_s5_value.sql`：指标字典、目标、快照、价值记录、使用数据、续约风险 6 张表。
- `db/migrations/0011_s5_deliverable_types.sql`：交付物类型新增 `renewal_recommendation`。
- `db/migrations/0012_r6_knowledge_ai.sql`：知识条目、AI 草稿 2 张表。
- `db/migrations/0013_r6_knowledge_review.sql`：知识有效期、审批人/时间/意见。
- `db/migrations/0014_request_id.sql`：审计日志新增 `request_id` 与索引。
- `db/migrations/0015_perf_indexes.sql`：项目列表、痛点、机会点、交付物、访谈、知识库常用查询索引。
- `db/migrations/0016_engagement_members.sql`：项目成员与角色（manager/member/viewer）。
- `db/migrations/0017_audit_archive.sql`：审计归档表 `audit_logs_archive` 与索引。
- `db/migrations/0018_pdf_jobs.sql`：PDF 异步任务表 `pdf_jobs`。
- `db/migrations/0019_share_tokens.sql`：外发记录新增分享 token、有效期、撤销与访问计数。
- `db/migrations/0020_share_views.sql`：分享访问明细 `share_views`。
- `db/migrations/0021_share_views_archive.sql`：分享访问归档表 `share_views_archive`。
- `db/migrations/0022_share_views_archive_org.sql`：归档表补充 `org_id` 并回填。
- `db/migrations/0023_user_sessions.sql`：可撤销登录会话 `user_sessions`。
- `db/migrations/0024_password_history.sql`：最近 5 次密码历史 `password_history`。
- 容器化与备份恢复见根目录 [DEPLOY.md](../DEPLOY.md)。
- `db/003_seed.sql`：宏远样例（仅在 `db:seed` / `db:reset` 时执行）。
- `db/legacy/`：迁移体系引入前的原始 SQL，仅作对照。
- `schema_migrations` 记录已执行迁移与 checksum；历史迁移不允许修改，变更走新文件。
- 金额单位统一 **万元**；`realized_value` 保留 1 位小数（1 千元精度），与报告口径一致。
- 回本用生成列计算，两种口径并存：`payback_months`（不含运维）、`payback_months_with_ops`（含运维）。
- 生成列不能引用生成列，所以 `realized_value` 内联了 `neutral_value × realization_factor` 的表达式，而不是引用另一个生成列。

## 样例数据口径

| 组合 | 可实现收益 | 投入 | 年运维 | 回本 | 含运维 |
|---|---|---|---|---|---|
| 只做 OP-01 | 17.4 万 | 40 万 | 6 万 | 27.6 个月 | 42.1 个月 |
| 一期 OP-01+03 | 26.4 万 | 52 万 | 8 万 | 23.6 个月 | 33.9 个月 |
| **核心 OP-01+02+03** | **62.4 万** | **77 万** | **13 万** | **14.8 个月** | **18.7 个月** |
| 全部一期+二期 | 72.4 万 | 92 万 | 16 万 | 15.2 个月 | 19.6 个月 |

OP-01 传导链：`1.00 × 0.95 × 0.70 × 0.90 = 0.5985`，`29 × 0.5985 = 17.36 → 17.4 万`。
单段恶化：渠道 −7.0 万、采用率 −7.0 万、准确率 −1.9 万、价值转化 −5.8 万。
准确率是**阈值型变量**：跌到 90% 以下全量复核、收益归零——单段恶化表里的 1.9 万只是线性近似。

## 已知边界

- 只覆盖 S1 诊断阶段；S2 之后的状态机字段已建表，但没有对应接口。
- 交付物目前只实现 `diagnosis_report` 与 `one_pager` 两个渲染器；`roadmap`、`roi_sheet`、`prd` 等类型虽然数据库允许，接口会明确返回 400，避免返回类型对不上的文档。
- 行业对标的 20 项 p25/p50/p75 是示意值（`calibrated=false`），正式使用前需 ≥20 个真实项目校准。
- 登录与组织隔离已生效（`org_id` 单资源归属 + 列表过滤）；客户侧只读视图、更细的角色权限仍待补。默认 `AUTH_REQUIRED=false` 便于本地开发。
- 组织隔离目前在应用层实现，数据库层未启用 RLS；直接连库仍可跨组织读取。生产多租户建议补 RLS 或独立 schema。
- `zod` 已升级到 4.6；`npm audit` 仍有 11 个 moderate（exceljs → uuid、swagger-ui → glob），当前无非破坏性修复，已评估为低风险。
- OpenAPI 目前提供路径、方法、标签导航，请求/响应体 JSON Schema 尚未覆盖全部路由。
- 客户/项目/交付物为软删除，可在回收站按批次恢复；痛点、盘点、机会点等子资源仍是物理删除，但所有写操作都会进 `audit_logs`。
- 访谈纪要为手打文本，不做录音转写（已确认的产品边界）。
- 报告 §3 的业务链条由 `process_nodes/process_edges` 自动排版；节点颗粒度仍是人工决定（与样例 §3 的判断边界一致）。
