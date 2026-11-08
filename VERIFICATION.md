# 全项目核验报告

> 核验日期：2026-11-08
> 基线提交：`bab683b` + 客户现场实施图重构
> 范围：`backend`、`frontend`、`ai-copilot`、数据库迁移、API/OpenAPI、文档与全部 Mermaid 流程图、运维/安全配置。
> 口径：**自动化通过 = 代码侧通过；真实客户/外部环境未验证的，明确写未验证，不用样例冒充。**

---

## 0. 结论

| 维度 | 结论 |
|---|---|
| 代码与回归 | **通过**：后端 79 项、前端 13 项单测 + 25 条 e2e 全部通过 |
| 数据库 | **通过**：59 个迁移全部应用；85 张表；81 张业务表启用 RLS；82 条策略 |
| API | **通过**：源码声明 336 个操作，OpenAPI 336 个，无缺失/多余 |
| 文档与流程图 | **通过（语法/口径）**：8 个 Mermaid 图全部可解析；51 个相对链接无断链 |
| ai-copilot | **通过（内部样例）**：8 个专项测试 + 16 项 smoke 通过；规则评测通过 |
| CI | **通过**：GitHub Actions 4 个 job 全部通过（`bab683b`，run #179） |
| 生产/试点就绪 | **未通过（配置）**：本地缺 `AUTH_REQUIRED` / `AUTH_SECRET` / `METRICS_TOKEN` |
| 真实外部联调 | **未验证**：真实客户、K8s、支付、模型、Alertmanager、真实 S3 仍阻塞 |
| 计划状态 | **65 项已完成 / 7 项未完成**；未完成项全部是真实客户/外部环境 |

**总评：代码侧可交付性通过；真实试点/生产放行仍需外部资源与配置。**

---

## 1. 自动化核验结果

### 1.1 后端

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run verify` | **17/17 通过** |
| `npm run verify:report` | **11/11 通过** |
| `npm run verify:write` | **51/51 通过** |
| `npm run openapi` | 生成 `docs/openapi.json` |
| `npm run readiness:check -- --report-only` | PASS 13 / WARN 5 / FAIL 3 |

### 1.2 前端

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run test:unit` | **13/13 通过**（3 个测试文件） |
| `npm run build` | 成功 |
| `PW_CHANNEL=msedge npx playwright test` | **25/25 通过** |

e2e 覆盖：登录/注册、项目列表与搜索、项目页签、页签记忆、知识库、PDF、客户分享、会话、用户、平台租户/就绪看板、组织套餐、审计/导出/筛选视图、协作审计、通知、POC、报价版本对比、审计边界。

### 1.3 ai-copilot

| 检查 | 结果 |
|---|---|
| `test_address` / `test_fees` / `test_metrics` / `test_delivery` / `test_hardening` / `test_wecom_crypto` / `test_storage` | 全部通过 |
| `make smoke` | **16/16 通过** |
| H5 拍照/上传（本机实测） | **通过**：上传 `samples/fixtures/booking_sample.png`，OCR + 规则抽出 17 个字段，`review_level=single`，带逐字段置信度与截港预警 |
| 网站粘贴（本机实测） | **通过**：粘贴 8 行托书，抽出 8 个字段、`review_level=single`；生成 `source=web` 的 inbound 并关联 run；点内置样例不计入 inbound |
| 批量导入（本机实测） | **通过**：2 个文件（PNG + PDF）100% 识别，各生成 `source=batch-booking` 的 inbound 并关联 run；默认规则 + 脱敏 |
| 规则评测（tuned，20 样本） | 字段 100%，整单 100%，阻断 100% |
| 规则评测（holdout，8 样本） | 字段 98.7%，整单 87.5%，阻断 96.88% |

> 未运行真实模型评测（会调用外部模型并产生费用）；未使用真实客户托书。以上均为合成样本/规则引擎结果，不能对外当作真实准确率。

### 1.4 数据库

| 项 | 实测 |
|---|---|
| 迁移文件 / 已应用 | 59 / 59 |
| 表 | 85 |
| 启用 RLS 的表 | 81 |
| RLS 策略 | 82 |
| 外键 | 158 |
| 索引 | 232 |
| 当前业务数据 | 1 组织、4 用户、1 客户、1 项目；另有带 `【合成演示】` 标记的 S2–S5 演示数据 |

未启用 RLS 的 4 张表为全局表：`benchmarks`、`industry_templates`、`metric_definitions`、`schema_migrations`，已在就绪检查中作为白名单。

### 1.5 API / OpenAPI

- 源码路由声明：**336**
- OpenAPI 操作：**336**
- 源码缺失于 OpenAPI：**0**
- OpenAPI 多余操作：**0**

覆盖：S1 录入/报告、S2 方案/报价、S3 POC、S4 交付、S5 运营、R6 知识库/AI、租户/平台/账单、审计/通知/协作审计、PDF/分享、系统/指标。

---

## 2. 功能矩阵

| 模块 | 核验方式 | 结论 |
|---|---|---|
| S1 诊断、14 项一致性校验、报告 Word/PDF | `verify`、`verify:report`、e2e | 通过（内部样例） |
| S2 方案、组件、集成、工作量、验收、评审、G2 | `verify:write`、e2e | 通过 |
| S2 方案版本对比 + 客户版脱敏 | `verify:write`、单测、e2e | 通过 |
| S2 报价、报价行、报价版本对比 | `verify:write`、单测、e2e | 通过 |
| S2 G2-10/11/12 联动检查 | `verify:write` | 通过（G2-12 为 warn 提示） |
| S3 POC 实验/样本/运行/复核/结论/G3 | `verify:write`、e2e POC 页签 | 通过 |
| S4 计划/UAT/上线检查/培训/问题变更/G4 | `verify:write`、e2e 页签 | 通过 |
| S5 指标/快照/价值/使用/续约/G5 | `verify:write`、e2e 页签 | 通过 |
| S5 经营洞察：结论/指标差距/建议动作 | `verify:write`、e2e、Markdown/Word | 通过（规则引擎，可追溯） |
| R6 知识库/AI 草稿/人工确认 | `verify:write`、e2e | 通过（规则回退可跑） |
| 多租户注册、登录、角色、RLS、平台租户 | `verify:write`、DB 核验、e2e | 通过 |
| 试用/配额/账单/模拟支付/回调/续费 | `verify:write` | 通过（真实支付未接） |
| PDF 队列、缓存、对象存储、分享页 | e2e、`verify:write` | 通过（真实 S3 未联调） |
| 审计日志、导出任务、筛选视图、协作审计、通知 | e2e 8 条 + `verify:write` | 通过 |
| 运维/安全/就绪检查 | readiness、npm audit、文档链接 | 通过（配置 FAIL 3 项） |

---

## 3. 流程图核验

共发现 **8 个 Mermaid 流程图**，全部位于 `会客包/`：

| 文件 | 图 | 结果 |
|---|---|---|
| `会客包/02_机会地图.md` | 完整机会依赖图 | 解析通过；分期/依赖关系与路线图一致 |
| `会客包/10_业务与财务流程图.md` | 业务主线、财务对账、成本归集、数据流 | 4 图全部解析通过；边界与 ai-copilot 能力一致 |
| `会客包/12_系统边界与落地清单.md` | 交付平台/ai-copilot/客户边界 | 解析通过；三方边界与部署定位一致 |
| `会客包/13_AI能力路线图.md` | 五层能力、数据飞轮 | 2 图解析通过；未把规则/系统能力包装成 AI |

核验方法：使用前端已安装的 `mermaid@12.2.0` 在 Node + jsdom 中逐图 `parse()`，**8/8 通过**。

语义核验：
- 业务主图中 `A1 客户下单` 原先被标成绿色“已实现”，已改为灰色“输入源/非 AI 节点”；`A3 托书解析` 保留绿色。
- `P4 发票识别+校验`、`R2 客户对账单`、`R5 账龄与催收` 与 ai-copilot 实际能力一致。
- `S1/S2 成本归集/单车毛利` 标红为“被前置条件阻塞”，与未实现清单 C1 一致。
- 系统边界图明确“客户只装 ai-copilot，不装交付平台”，与实际定位一致。

> 未做逐图像素级视觉回归；Mermaid 语法与页面渲染组件已覆盖，报告内动态 Mermaid 由 `verify:report` 检查存在性与 `MarkdownView` 按需渲染。

---

## 4. 文档与链接

- Markdown 文件：74 个（不含依赖目录）。
- 相对链接检查：**51 个，0 断链**。
- 修复 `OPERATIONS.md` 中 4 个错误的 `../ops/...` 链接。
- 同步过时数字：
  - e2e：24 → **25**
  - 前端单测：10 → **13**
  - 迁移：58 → **59**
  - 表：86 → **85**
  - ai-copilot smoke：13 → **15**
  - ai-copilot 端点：62 → **91**
- `frontend/README.md` 修正了“RLS 待补”“没有组件级单测”“16 条 e2e”等过时描述。

---

## 5. 本轮发现并修复的问题

### 5.1 e2e 自助注册泄漏租户（已修复）

- 现象：数据库中存在 16 个 `E2E供应商*` 组织（历史 e2e 运行残留），导致平台租户列表被测试数据污染。
- 原因：`供应商可自助注册并进入独立工作台` 用例只创建、不清理。
- 修复：用例增加 `finally` 清理，通过平台管理员 API 按 `slug` 删除刚创建的租户；已清理历史残留。
- 复验：全量 e2e 25/25 通过；数据库回到 **1 组织 / 4 用户**。

### 5.2 文档过时与断链（已修复）

- 4 个运维文档链接指向不存在的 `../ops/...`。
- 多处测试/迁移/表数量未随最近功能更新。
- 已统一到当前实测值。

### 5.3 流程图语义（已修复）

- 业务主图 `A1 客户下单` 被误标为“已实现”绿色；已改为灰色输入源，图例与实际能力一致。

### 5.4 GitHub Actions 持续失败（已修复）

- 现象：`CI` 工作流连续 114 次失败，`docker · compose smoke` 与 `e2e · playwright smoke` 两个 job 长期红。
- 原因一：docker job 从宿主 `127.0.0.1:8788` 等后端，但 compose 按设计不把 8788 暴露到宿主；已改为经 nginx `8080/api/health` 检查。
- 原因二：e2e 在全新 seed 库上跑时，平台就绪看板出现两条同名 `AUTH_REQUIRED`（服务端重复检查），触发 Playwright strict mode；已合并为一条。
- 原因三：`POC 页签可打开对账复核并查看差异` 依赖本地历史数据；已在 `003_seed.sql` 增加一条带 `【合成演示】` 标记的对账复核样例，保证全新环境也有数据可看。
- 复验：在本机新建空库 → `db:reset` → 后端连该库 → e2e **25/25 通过**；`verify` 17/17、`verify:write` 51/51 通过。
- 真实 CI：推送后 run #115（`a88e58e`）**4 个 job 全部通过**（backend 1m08s、frontend 30s、e2e 10m18s、docker 1m27s）。本机无 Docker，docker job 未本地实跑，以 Actions 结果为准。
- Actions 运行时升级：`checkout@v4→v7`（4 处）、`setup-node@v4→v7`（3 处）、`upload-artifact@v4→v7`（2 处）。v7 均使用 `node24`，输入与本项目用法兼容。
- 升级后复验：run #117（`d6351db`）**4 个 job 全部通过**（backend 1m27s、frontend 23s、e2e 1m35s、docker 1m21s）；Node.js 20 弃用 annotation 已消失，仅剩 runner 镜像 `ubuntu-latest → Ubuntu 26` 的提示。
- 注意：e2e 在 CI 使用 `CI=true`，失败会重试 1 次；本地复验未开重试，结果更严格。

### 5.5 四种入口的 inbound 统计补齐（已修复）

- 现象一：H5 `/api/extract/upload` 只写 `runs`，不写 `inbound`，导致拍照/上传不在「绕过率」分母里。
- 现象二：网页「粘贴 + 解析」只调 `/api/extract`，没有写 `inbound`，网站粘贴也没进分母。
- 现象三：批量处理把 `record_inbound` 放在 `save_run` 之后，inbound 行无法回填 `run_id`。
- 现象四：`/api/extract/upload` 的 `use_llm` 被声明成查询参数，前端用表单发的值被忽略，实际一直允许模型。
- 修复：
  - 上传接口先 `record_inbound` 再解析，并按表单 `source` 区分 `h5-upload` / `web-upload`（白名单，其他值记为 `upload`）。
  - 网页粘贴在 `/api/extract` 前写 `source=web`；内置样例和同一段文字重复解析不重复计数。
  - 批量处理改为先 `record_inbound(..., source=batch-{kind})` 再 `save_run`，保证 `run_id` 回填。
  - `use_llm` / `source` 改为表单参数（`Form`）。
- 复验：
  - H5 上传 `booking_sample.png` → `h5-upload` inbound 关联 run。
  - 网页粘贴 8 行托书 → `web` inbound 关联 run；点样例后 inbound 数量不变。
  - 批量 2 个文件（PNG + PDF）→ 2 条 `batch-booking` inbound，均关联 run。
  - 访问 `/api/audit/<run_id>` 可查批量字段；ai-copilot smoke **15/15 通过**。

### 5.6 学习队列按来源/批次筛选（新增）

- 背景：`/learn` 只按状态（待标注/已标注/已跳过）分页，测试单与正式单据混在一起；标注员无法只处理某次批量导入或某个入口的样本。
- 改动：
  - 后端新增 `_learn_filter_sql`，`learn_queue` / `learn_stats` 支持 `source`、`batch_id`；来源按 `inbound.source` 关联，批次按 `batch_items.run_id` 关联。
  - 新增 `GET /api/learn/filters`，返回当前队列里出现过的来源与批次及条数；无来源用 `__none__` 表示。
  - `learn_queue` 每行附带 `source`、`batch_id`、`batch_name`；`learn_item` 也附来源与批次。
  - `/learn` 增加来源/批次下拉、「清除筛选」；统计卡随筛选同步变化，列表与编辑区显示来源和批次名。
  - 页面底部失效的 `scripts/run_eval.py` 提示改为 `make eval`；`docs/运维手册.md` 同步。
- 复验（本机 SQLite + 实测批次 `f1301151a584`「筛选验证-20261107」）：
  - `filters` 返回：无来源 74、`wecom` 3、`h5-upload` 1、`batch-booking` 1；批次 1 个。
  - `stats?source=wecom` → 待标注 2、已标注 1；`stats?batch_id=...` → 待标注 1。
  - `queue?status=pending&batch_id=...` 精确返回该批次的 `27c7921880ac`（`blocked / batch-booking`）。
  - 页面切换「来源=企业微信」后列表变为 2 条、统计卡同步为 2/1/0/0；切换批次后变为 1 条。
  - ai-copilot smoke **15/15 通过**。

### 5.7 实施全景图与“每次改动复核”铁律（新增）

- 新增 `实施全景图.md`：脑图 + 阶段主线 + 角色泳道 + 发布闭环 + AI 托书流程 + 多租户/HA + 客户试点 + 逐项检查表 + RACI + 变更影响矩阵。
- 新增 `AGENTS.md`：把“图先于改、同一提交更新、完成只认证据、外部项不冒充、验证串行、不包装 AI”写成项目铁律。
- `AUTOPILOT.md` 顶部、`TODO.md` 顶部同步指向该图；新增 `make impl-map` 从 Markdown 生成 HTML。
- 新增 `scripts/build_impl_map.py`：解析检查表统计完成度，生成可离线打开的 `实施全景图.html`；表格 `[x]/[ ]` 自动渲染为复选框，支持“只看未完成 / 只看已完成”。
- CI 前端 job 新增“实施全景图 HTML 与 MD 同步”步骤：`python3 scripts/build_impl_map.py` + `git diff --exit-code -- 实施全景图.html`，防止手改或漂移。
- 复验：
  - GitHub Actions run #126（`e87e65d`）**4 个 job 全部通过**（backend 78s、frontend 36s、e2e 119s、docker 75s）；CI-11 同步校验通过。
  - 生成结果：完成 78 / 109（71.6%），未完成 31；8 个 Mermaid 图全部渲染，0 个语法错误，浏览器控制台 0 error。
  - 筛选：点“只看未完成”后可见 31 行，点“只看已完成”后可见 78 行。
  - `python3 -m py_compile scripts/build_impl_map.py` 通过；连续生成两次 HTML 哈希一致。

### 5.8 铁律可执行化：preflight + Git hooks + CI

- 规则权威归位 `AGENTS.md`（OpenCode 每次会话自动加载），新增“开工前 30 秒 / 提交前 30 秒”可执行清单；`实施全景图.md` §0 只保留摘要并指向 `AGENTS.md`，避免两处漂移。
- 新增 `scripts/preflight.py`：
  - 改了 `实施全景图.md` 但 HTML 未重新生成 → 失败。
  - 改了代码/脚本/CI/运维配置，提交说明无 `[节点ID]` 且无 `图无影响：<原因>` → 失败。
  - 带节点 ID 但没同提交更新本图 → 失败。
- 新增 `.githooks/pre-commit`、`.githooks/commit-msg`、`scripts/install-git-hooks.sh` 与 `make install-hooks`；本地提交即拦截。
- CI frontend job 新增 `python3 scripts/preflight.py --commit HEAD`，与本地共用同一脚本；合并提交自动跳过。
- 复验：
  - `python3 -m py_compile scripts/preflight.py` 通过。
  - 正向：`--commit 202549f`（纯文档提交）通过。
  - 反向：构造“代码改动 + 无节点 ID”与“节点 ID + 未更新图”两种场景，均按预期失败。
  - 生成结果：完成 79 / 110（71.8%），未完成 31；8 个 Mermaid 图渲染正常。
  - GitHub Actions run #128（`db566f3`）**4 个 job 全部通过**（backend 69s、frontend 30s、e2e 116s、docker 74s）；新增的 preflight 步骤通过。

### 5.9 企业微信图片消息（异步 OCR）

- 新增 `app/wecom_api.py`：access_token 缓存（提前 5 分钟刷新）、临时素材下载（跟随 302、RFC 5987 文件名、JSON 错误、10MB 上限）、应用消息主动推送、token 失效自动重试一次。
- `app/wecom.py`：解析 `MsgType=image` 的 `MediaId/PicUrl/MsgId`；文本按 2048 字节安全截断；图片帮助文案更新。
- `app/main.py`：图片回调 5 秒内先回“已收到”，用 FastAPI `BackgroundTasks` 异步下载 → OCR → 抽取 → 入库 → 主动推送；`MsgId` 幂等（企微重试不重复 OCR）；所有图片先写 `inbound`（`source=wecom-image`），OCR 后回填原文并关联 `run_id`；失败落 `wecom_msgs.status=failed` 并通知用户。
- `app/store.py`：新增 `wecom_msgs` 幂等表、`claim_wecom_msg`、`mark_wecom_msg`、`update_inbound_text`。
- `app/metrics.py`：新增 `copilot_wecom_image_total{result=received|done|failed|duplicate|unconfigured}`。
- `scripts/test_wecom_image.py`：MockTransport + 临时库覆盖解析、幂等、inbound 回填、token 缓存、token 过期重试、素材下载、文件名、主动推送、非法 media_id、未配置提示、后台成功/失败兜底。
- 复验：
  - `PYTHONPATH=. .venv/bin/python scripts/test_wecom_image.py` **全部通过**（26 项）。
  - `ai-copilot/scripts/smoke.sh` **16/16 通过**（新增“企微图片自检”）。
  - `python -m py_compile` 通过（config/store/wecom/wecom_api/main/metrics/测试）。
  - GitHub Actions run #130（`5b09237`）**4 个 job 全部通过**（backend 84s、frontend 27s、e2e 131s、docker 76s）；preflight 通过。
  - 当时未验证：真实企业微信账号、真实图片素材、真实主动推送、可信 IP、固定回调域名；因此 AI-07 保持 🟡，AI-07E 保持 `[ ]`。（2026-11-07 已在测试租户完成真实联调，见 5.18）

### 5.10 实施全景图重构为客户现场实施（v2.0）

- 背景：原图混合了产品开发、CI、发布、架构与客户现场实施，且没有讲清系统边界；容易误读成“诊断平台也要部署到客户”。
- 边界修正：诊断平台（`backend/` + `frontend/`）是**供应商内部工具，不部署客户、客户不登录**；客户现场只部署和使用 `ai-copilot`。供应商在现场用诊断平台完成 S1 诊断、S2 方案、S5 价值核算。
- 拆分：
  - `实施全景图.md` v2.0：只保留客户现场实施阶段（进场前 → 现场诊断 → 方案与范围 → 环境部署 → 数据与样本 → 试运行 → 培训上线 → 验收价值 → 移交运维），新增系统边界图、现场诊断流程、ai-copilot 部署流程、常见实施错误。
  - `内部开发与发布.md` v1.0：承接原图的开发阶段、CI、发布闭环、架构、多租户/HA、开发检查表与变更影响矩阵；明确“不发给客户”。
- 规则同步：`AGENTS.md` §0 改为两份事实源；`scripts/preflight.py` 支持 `实施全景图.md` 或 `内部开发与发布.md` 任一更新；HTML 仍只由 `实施全景图.md` 生成。
- 复验：
  - `python3 -m py_compile scripts/preflight.py` 通过。
  - `python3 scripts/build_impl_map.py` 生成成功：完成 8 / 94（8.5%）；8 个 Mermaid 图渲染正常，0 语法错误。
  - GitHub Actions run #132（`d983fa5`）**4 个 job 全部通过**（backend 76s、frontend 30s、e2e 119s、docker 72s）；preflight 通过。
  - 说明：完成度低是**真实口径**——现场实施尚未开始，只有准备模板/边界规则有证据；未把内部开发完成度混入现场实施。
  - 未验证：真实客户现场实施（授权、诊断、部署、样本、试运行、验收）全部仍为 `[ ]`；企微图片真机联调见 EXT-13。

### 5.11 客户侧“经营洞察”与 TMS 对接的边界澄清（v2.1）

- 触发：复核过程中发现三处容易被误读，必须在事实源里写清，避免对外把“供应商诊断能力”当成“客户上线后的能力”。
- 结论（均为**未实现**，不是已完成）：
  - **S5 经营洞察**位于诊断平台，是供应商在诊断/交付阶段对客户项目的判断（指标达标、续约风险、机会点前置条件）；**客户不登录、不使用**。
  - **客户侧经营洞察**（上线后客户长期使用：营收、成本、毛利、回款、异常、AI 贡献）**当前不存在**。客户侧现有的 `/api/metrics`、`/api/report.md`、`/api/risk-sim` 只是运营指标，不含营收、成本、毛利、单车盈利。路线图定位为 P2，前置是成本归集 + TMS/财务数据。
  - **TMS 写回（C2）未实现**：`ai-copilot` 当前只能 CSV 导出、人工回填；结果表现在 `ai-copilot` 自己的页面，不在客户 TMS 里。
- 附带发现：`会客包/reports/make_capability_ppt.py` 第 6 页「怎样表现③：经营洞察」使用 `ppt_assets/ui-platform-insights.png`，即**诊断平台 S5 截图**（侧边栏含「平台租户 / 协作审计 / 审计日志」，正文含报价 247.2 万与续约风险），与“客户不登录诊断平台”的边界冲突，且会把内部信息带给客户。已记入 `TODO.md` 待替换，**本轮未改 PPT**。
- 本轮变更范围：仅文档（`实施全景图.md` v2.1、`内部开发与发布.md` v1.1、`TODO.md`、本文件），未改代码、未跑测试；`python3 scripts/build_impl_map.py` 重新生成 HTML。
- GitHub Actions run #134（`5c91604`）**4 个 job 全部通过**（backend 111s、frontend 21s、e2e 124s、docker 79s）；preflight 通过。
- 说明：本节不把上述任何一项写成 ✅；客户侧经营洞察与 TMS 写回继续保持 ⛔/`[ ]`。

### 5.12 客户老板版 PPT 删除「经营洞察」页（v2.2）

- 原因：原第 6 页「怎样表现③：从数据到结论」使用 `ppt_assets/ui-platform-insights.png`，即诊断平台 S5 截图。该页客户不登录、截图含「平台租户 / 协作审计 / 审计日志 / 报价 247.2 万 / 续约风险」，与系统边界冲突。
- 改动：
  - `会客包/reports/make_capability_ppt.py`：删除原第 6 页整块；`add_footer(total=14)` → `total=13`；第 6 页「大模型介入点」的“经营洞察由规则引擎生成”改为“经营指标由规则引擎计算”；第 7 页四步路径的“洞察”改为“月报”，底部说明同步。
  - `会客包/reports/客户老板版_讲稿.md`：14 页 → 13 页；删除原第 6 页；原第 7–14 页顺延为第 6–13 页；同步“洞察 → 指标/月报”。
  - `会客包/reports/README.md`：页数 14 → 13；截图说明改为第 4–5 页 2 张；记录本次修订。
- 复验（结构检查，本机无 LibreOffice，未做逐页像素级渲染）：
  - 重新生成 `客户老板版_系统能力介绍_2026-11-05.pptx`：**13 slides**。
  - 全文件文本与备注扫描：**0 处“洞察”**。
  - 图片哈希比对：第 4、5 页各 1 张截图；**不再包含 `ui-platform-insights.png`**。
  - 页脚抽样：`05 / 13`、`06 / 13` 正确。
- 说明：`ui-platform-insights.png` 资产保留（未删除），仅从客户版 PPT 移除引用。
- GitHub Actions run #136（`4f79afd`）**4 个 job 全部通过**（backend 80s、frontend 26s、e2e 128s、docker 77s）；preflight 通过。

### 5.13 客户老板版 PPT 第 5 页对账文案校正（v2.3）

- 原因：原文案有两处超出系统实际能力，客户现场容易被追问：
  - 「把差异分到**动作**」隐含自动派单；实际是系统给建议动作，人工做处理决定。
  - 「每条差异有**负责人**」不成立：系统没有逐条负责人字段，只有复核记录的 `actor`（谁保存）。
  - 演示数据写「2 条金额不符、9 条系统无此单」，与 `/api/reconcile/demo` 实际结果不符。
- 改动：
  - 第 5 页标题：`…把差异分到动作` → `…把差异分到处理决定`。
  - 第 5 页副标题：`每条差异有原因、有负责人` → `每条差异有原因、有处理记录`。
  - 第 5 页数据说明：改为 `8 条一致、2 条金额不符、1 条系统无此单、1 条客户漏单`，与系统演示一致。
  - 讲稿第 5 页同步；新增“系统给建议动作，不是自动派单；最终处理决定由人做”，并补充处理选项「采纳 / 修改后采纳 / 忽略 + 备注」。
  - `reports/README.md` 记录本次文案校正。
- 口径确认（写入本文件，避免再把规则说成 AI）：
  - 对账单解析、单号/箱号匹配、金额容差、四类差异 = **规则**。
  - `explain=true` 时模型只写 `possible_causes` / `suggested_action`，失败回退规则；金额与差异类型不改。
- 复验（结构检查）：
  - 重新生成：**13 slides**；第 5 页文本与备注已更新，扫描 **0 处**「负责人 / 分到动作」。
  - 未做逐页像素级渲染（本机无 LibreOffice）。
- 说明：本轮**未改 `ai-copilot` 代码**，只改对外材料口径；系统行为不变。
- GitHub Actions run #138（`515b80d`）**4 个 job 全部通过**（backend 80s、frontend 33s、e2e 143s、docker 81s）；preflight 通过。

### 5.14 客户老板版 PPT 第 2 页口径校正（v2.4）

- 原因：两处口径对外不成立或属内部信息。
  - 「续约风险」指我方与客户的续约，属供应商内部口径，客户现场会误读。
  - 「能追到单据、客户、责任人」：`ai-copilot` 无逐条负责人/催收人字段；`app/aging.py` 输出为 `client` / `invoice_no` / `due_date` / `overdue_days` / `bucket`。
- 改动：
  - `make_capability_ppt.py` 第 2 页第 3 张卡片：`对账差异、账龄、续约风险 / 能追到单据、客户、责任人` → `对账差异、账龄、回款风险 / 能追到单据、客户、账期`。
  - `客户老板版_讲稿.md` 第 2 页同步。
  - `reports/README.md` 记录本次校正。
- 复验（结构检查）：
  - 重新生成：**13 slides**；第 2 页文本已更新。
  - 全文件扫描：**0 处**「续约」「责任人」「洞察」。
  - 未做逐页像素级渲染（本机无 LibreOffice）。
- 说明：本轮只改对外材料口径，**未改 `ai-copilot` 代码**。
- GitHub Actions run #140（`bba6fe1`）**4 个 job 全部通过**；preflight 通过。

### 5.15 客户侧界面：中文名「智单」+ 左侧菜单栏（AI-30）

- 原因：
  - 英文名 `ai-copilot` 在客户现场不好说、不好找；界面里也没有统一产品名。
  - 原顶部导航是各页各写一套链接：有的页只有「← 返回工作台」，有的页缺 5 个模块；`/settings`、`/batch`、`/demo` 根本进不去。
- 改动（只动 `ai-copilot/static/`，未改 Python 后端）：
  - 新增 `static/nav.css` + `static/nav.js`：固定左侧菜单，品牌「智单 / 托书 · 发票 · 对账 · 结算」；分组：工作台 / 单证 / 对账与结算 / 应收 / 数据与设置。
  - 14 个桌面页接入侧栏：`index / invoice / batch / history / reconcile / pilot / threeway / settlement / fees / aging / learn / settings / users / demo`；`<body class="app-shell">`，页内标题与操作按钮保留。
  - 删除各页头部零散导航链接；`index.html` 同步移除已不存在的 `#learnLink / #feesLink / #historyLink / #userLink` 引用。
  - 按角色隐藏入口（复用现有角色）：确认历史/阈值配置/用户管理仅 admin；异常费用 admin+finance；学习队列非 viewer。
  - 登录页与移动端 `h5.html` 不加侧栏，只统一产品名与页面标题。
  - 窄屏（≤900px）侧栏收成抽屉，左上角按钮展开；打印时隐藏侧栏。
- 验证（本机 8790 实测）：
  - `./scripts/smoke.sh`：**16/16 通过**（health / 登录 / 401 / 解析 / 校验位 / 截港 / 评测 / OCR / 存储 / 指标 / 加固 / 地址 / 费用 / 回写 / 企微加解密 / 企微图片）。
  - 浏览器逐页核对 **13 个路由**（`/`、`/reconcile`、`/pilot`、`/demo`、`/aging`、`/settings`、`/users`、`/learn`、`/invoice`、`/threeway`、`/settlement`、`/fees`、`/history`、`/batch`）：侧栏存在、当前项高亮正确、`body` 左内边距 220px、控制台 0 错误。
  - 登录页、`/demo`、`/reconcile`、`/pilot` 已截图目视确认布局；移动端仅做 CSS 断点检查，**未真机验证**。
- 未做 / 遗留：
  - 客户老板版 PPT 第 5 页对账截图仍是旧版顶部导航，需重截（已记 `TODO.md`）。
  - 客户现场培训材料与截图未同步替换为「智单」。
- 说明：产品名只改显示层；目录 `ai-copilot/`、服务名、环境变量、API 路径、数据库均未改。
- GitHub Actions run #142（`324df9b`）**4 个 job 全部通过**（backend 93s、frontend 28s、e2e 125s、docker 71s）；preflight 通过。

### 5.16 客户老板版 PPT 第 5 页对账截图重抓

- 原因：界面改为左侧菜单栏后，原截图仍是旧版顶部导航；且旧截图用的是旧演示数据（9 条系统无此单），与第 5 页正文写的 8/2/1/1 不一致。
- 改动：
  - 新增 `会客包/reports/capture_ui.mjs`：Playwright（系统 Edge）以 1440×900 @2x 抓图，固定输出 **2880×1800**；账号密码读 `ai-copilot/.env`，可重复执行。
  - 重抓 `会客包/reports/ppt_assets/ui-copilot-reconcile.png`：显示侧栏、「智单」品牌、11 条对账、8 一致 / 2 金额不符 / 1 系统无此单 / 1 客户漏单、差额 −370。
  - 重新生成 PPTX：**13 slides**，第 5 页图片哈希与新截图一致，且不含 `ui-platform-insights.png`。
  - 顺带修正 UI 文案：`static/reconcile.html` 演示提示条与 `static/demo.html` 第 7 步的数字改为实际结果（原文写「10 条正常」，与实际 8 条一致不符）。
  - `app/main.py` 中 `/api/reconcile/demo` 的 docstring 同步更正（不影响行为）。
- 验证：
  - 图片尺寸 2880×1800（1.6）；PPT 第 5 页引用哈希一致。
  - `./scripts/smoke.sh` **16/16 通过**。
  - 浏览器复核：页面滚动时顶栏吸顶（`position: sticky`，top=0），侧栏与高亮正常，控制台 0 错误。
- 未做：PPT 未做逐页像素级渲染（本机无 LibreOffice）。
- GitHub Actions run #144（`7a77d8a`）**4 个 job 全部通过**；preflight 通过。

### 5.17 客户现场培训材料按新界面重写

- 原因：界面改成「智单」+ 左侧菜单栏后，`会客包/托书结构化试用指南.md` 里的「点左侧任意样例」「左侧『托书原文』」会指错；全篇没有系统名，也没有覆盖对账、账龄等已上线页面。
- 改动：
  - 更名《智单 · 托书结构化试用指南》，开头写明系统名与「目录/服务名仍是 `ai-copilot`」。
  - 新增「零、界面怎么走」：14 个菜单按 5 组列出，标注每个入口做什么、哪些角色可见；说明手机端抽屉与「客户不登录诊断平台」。
  - 修正「左侧」歧义：改为「左侧菜单」或「页面左栏」；批量导入、H5、样例按钮的入口描述同步。
  - 新增「一之六 自动对账怎么试（3 步）」「一之七 账龄催收怎么试（3 步）」，并写明口径：匹配/分类/分档是规则，模型只在差异解释时写原因与建议动作，最终处理由人决定。
  - 新增 `会客包/assets/ui-index.png`、`ui-reconcile.png`、`ui-aging.png` 三张 2880×1800 截图，由 `会客包/reports/capture_ui.mjs` 生成。
  - `capture_ui.mjs` 扩展为多页抓取（托书录入 / 自动对账 / 账龄催收），对账图继续同步到 `ppt_assets/ui-copilot-reconcile.png`。
  - `实施全景图.md` 9.1 培训表补充菜单入口与「统一叫智单」；PREP-04 证据更新。
- 验证：
  - 三张图均为 2880×1800（1.6），目视确认侧栏、菜单高亮、数据正确（对账 8/2/1/1、账龄 6 客户）。
  - 文档内图片路径 `assets/ui-*.png` 与文件一致；「左侧」扫描后仅剩「左侧菜单」等正确用法。
  - `./scripts/smoke.sh` **16/16 通过**（本轮未改后端逻辑）。
- 未做：培训未真机投屏演练；企微图片真实端到端验证见 5.18（2026-11-07 当日完成）。
- GitHub Actions run #146（`fa6b69a`）**4 个 job 全部通过**；preflight 通过。

### 5.18 企业微信图片通道：测试租户真实端到端

- 环境：测试租户（1 名成员，企业未认证）；自建应用「托书录入助手」，AgentId `1000002`。
- 后台配置：
  - 回调 URL：`https://similar-hopkins-watch-oakland.trycloudflare.com/api/wecom/callback`（临时隧道）
  - Token / EncodingAESKey：与 `ai-copilot/.env` 一致；保存时企业微信 URL 验证通过
  - 企业可信 IP：本机当前出口 `223.73.193.13`
  - Secret：已写入本机 `.env`，未入库、未提交
- 真实链路与证据（时间为 UTC）：

| 环节 | 证据 |
|---|---|
| 文字消息 | 回调 `POST /api/wecom/callback` 200（企业微信 IP `183.47.98.227`）；`msg_id=7705416653568453725`，`kind=text`；`inbound.source=wecom`，`run=f473441684f4` |
| 文字解析 | `engine=rule-based-v1`，0 阻断 0 提醒，`auto`；客户 / 单号 / 箱型 / 箱量 / 箱号 / 提箱地 / 卸货地 / 截港全部抽出 |
| 图片消息 | 回调 200（IP `14.116.241.251`）；`msg_id=7705417168708823133`，`kind=image`，`status=done`；`inbound.source=wecom-image`，`run=a3d395e4af2b` |
| 图片链路 | 回执「已收到图片，正在识别」→ OCR 235 字 → 抽取 17 字段 → 主动推送结果；原图存 `data/uploads/booking/20261107/c2e95b5c38cb4f1b.png` |
| 规则检查 | 1 项阻断：截港 `2026-11-07 18:00` 已过 → `review_level=blocked`（符合预期） |
| 主动推送 | `message/send` 返回 `errcode=0`；用户确认收到测试消息与图片结果 |

- 边界（不得写成已完全上线）：
  - 回调是 **`trycloudflare` 临时隧道**，重启即变；公网 IP 为动态，IP 变化后主动推送会被拒。
  - 图片用 `samples/fixtures/booking_sample.png` 合成测试图，**不是客户真实托书**。
  - 企业未认证；客户现场仍需固定域名 + 正式认证，见 AI-08 / EXT-13。
  - 企业微信后台曾明文显示 Token/EncodingAESKey；如担心泄露可重置后同步 `.env` 并重启。

### 5.19 CI preflight 浅克隆误判修复

- 现象：`527887b` 的 run #148 中，frontend job 的 `preflight.py --commit HEAD` 失败，报“改了代码但没有节点 ID”。
- 原因：
  - `actions/checkout` 默认浅克隆（`fetch-depth: 1`），`git show HEAD` 把整仓库当成本次改动，于是文档提交也被判为“改了代码”。
  - 节点 ID 正则 `\[[A-Z]{2,4}-\d{2,3}\]` 不认 `AI-07E` 这种带字母后缀的 ID。
- 修复：
  - `.github/workflows/ci.yml`：frontend job 的 checkout 增加 `fetch-depth: 2`，preflight 能拿到父提交做 diff。
  - `scripts/preflight.py`：节点 ID 正则改为 `\[[A-Z]{2,4}-\d{2,3}[A-Z]?\]`。
- 验证：
  - 正则单测：`[AI-07E] / [AI-21] / [DEP-14] / [CI-12]` 全部匹配。
  - `git clone --depth 2` 后执行 `preflight.py --commit HEAD`：识别 5 个文件、通过；`--depth 1` 仍会把全仓库当改动（已在 CI 侧规避）。
- GitHub Actions run #149（`af5734e`）**4 个 job 全部通过**（修复生效）；此前 run #148 因该误判失败。

### 5.20 运行月报改为可读页面

- 现象：托书录入页点「月报」，打开的是 `/api/report.md`，浏览器按 `text/plain` 原样显示 Markdown（`#`、`|`、`**`），看起来像一坨 JSON/原始数据。
- 改动：
  - 新增 `app/report_view.py`：最小 Markdown 渲染（标题 / 表格 / 引用 / 列表 / 粗体 / 代码），**不引入新依赖**，所有文本先 `html.escape`。
  - 新增 `GET /report`：服务端渲染成完整页面，复用 `nav.css` / `nav.js` 左侧菜单；页面带「下载 Markdown」与「打印」。
  - `static/index.html` 头部「月报 ↗」改为「运行月报」→ `/report`；侧栏「数据与设置」新增「运行月报」。
  - `report_md()` 标题改为「智单 · 运行月报」，说明补一条：本表统计整条链路（OCR + 规则 + 人工确认），**不拆分大模型单独贡献**。
  - `/api/report.md` 保留，Content-Type 仍为 `text/plain`，供下载或程序读取。
- 验证：
  - `/report` 返回 200，渲染 5 张表格、6 个二级标题；侧栏「运行月报」高亮；浏览器控制台 0 错误。
  - 未登录访问 `/report` → 307 跳 `/login`。
  - `./scripts/smoke.sh` **16/16 通过**。
- 未做：未做打印预览逐页检查。
- GitHub Actions run #151（`1ae0416`）**4 个 job 全部通过**；preflight 通过。

### 5.21 左侧菜单全路由巡检 + HTML 禁止缓存

- 现象：反馈「发票识别页没有左侧菜单」。巡检结果为**旧页面缓存**：`static/invoice.html` 已包含 `nav.css` / `nav.js` / `body.app-shell`，新开标签访问 `/invoice` 侧栏正常。
- 巡检范围：`/`、`/invoice`、`/batch`、`/history`、`/reconcile`、`/pilot`、`/threeway`、`/settlement`、`/fees`、`/aging`、`/learn`、`/settings`、`/users`、`/demo`、`/report`，共 **15 个路由**。
- 结果：15/15 有侧栏、当前项高亮正确、`body` 左内边距 220px、无横向溢出、控制台 0 错误。
- 修复：`observe_middleware` 对 `text/html` 响应加 `Cache-Control: no-cache`，部署后普通刷新即可拿到新页面，不再需要清缓存。
- 验证：
  - `GET /invoice` 响应头包含 `cache-control: no-cache`。
  - `./scripts/smoke.sh` **16/16 通过**。
  - 静态资源（`nav.css` / `nav.js`）仍按 ETag 缓存，不受影响。
- GitHub Actions run #153（`8da9d8d`）**4 个 job 全部通过**；preflight 通过。

### 5.22 账号信息与退出移到顶栏

- 改动：
  - `static/nav.js`：侧栏底部只保留「演示环境 · 数据为合成样本」；账号（姓名 / 角色 / 退出）改为注入各页顶栏右侧 `.nav-user`，所有页面统一。
  - `static/nav.css`：新增顶栏账号样式；窄窗口先隐藏说明文字，保证标题、操作、账号在同一行。
  - `static/index.html`：移除页内 `#userChip` / `#logoutLink` 与相关 JS，避免与顶栏重复。
  - 14 个页面与 `/report` 的 `nav.css` / `nav.js` 引用加版本号（当前 `?v=20261107d`）；`observe_middleware` 对这两个资源也加 `Cache-Control: no-cache`，以后改版不再需要手动清缓存。
- 验证（本机 1056px 宽窗口）：
  - 15 个路由：侧栏底部均无「退出」；顶栏均出现「系统管理员 · 管理员 · 退出」。
  - 顶栏高度 44–55px（单行）；`/` 在窄窗口隐藏说明文字后仍单行。
  - 控制台 0 错误；`./scripts/smoke.sh` **16/16 通过**。
- 未做：退出按钮未真点（避免中断当前会话）；窄屏（<620px）只做 CSS 检查。
- GitHub Actions run #155（`f979cfe`）**4 个 job 全部通过**；preflight 通过。

### 5.23 配置中心 P0

- 后端：
  - `thresholds.py`：每次保存记录变更（谁/何时/旧值→新值/原因），支持按记录回滚；新增阈值依赖校验（自动通过阈值不得低于复核下限）。
  - `storage.delete()`：本地/S3 删除，用于存储连通性测试后的清理。
  - 新增 `GET /api/settings/history`、`POST /api/settings/rollback`、`GET /api/config/integrations`、`POST /api/config/test/{llm,wecom,storage}`。
- 前端 `/settings` 重写：左侧分组导航（概览 / 4 组阈值 / 模型 / 企微 / 存储 / 变更历史）；每项显示默认值、范围、生效方式；降低风险阈值必须填原因；只读账号禁用输入；集成配置只读 + 测试连接按钮。
- 实测（本机）：
  - 保存容差 `0.01 → 0.03`，历史记录显示「系统管理员 / 原因 / 0.01 → 0.03」。
  - 依赖校验：`booking.risk_auto_floor=0.70` 被拒，返回「不能低于双人复核下限（0.7 < 0.8）」。
  - 危险项：不填原因保存被前端拦下；填原因后保存成功；恢复默认成功。
  - 回滚：把 `0.03` 回滚回 `0.01`，并新增一条回滚记录。
  - 测试连接：存储 1 ms（local）、企微 182 ms（token 获取成功）、模型 4604 ms / 58 tokens（真实请求）。
  - 页面控制台 0 错误；`./scripts/smoke.sh` **16/16 通过**。
- 已知边界：
  - `/api/settings` 仍为 admin-only，非管理员只读视图未实测（页面已有禁用逻辑，权限细分留 P1）。
  - 变更历史仍写 `data/settings_history.json`；PG 多实例下需要改表（P1）。
  - 集成配置只能看和测，不能在页面改 `.env`。
- GitHub Actions run #158（`4ce7fde`）**4 个 job 全部通过**；preflight 通过。

### 5.24 配置中心 P1

- 配置项从 9 项扩到 **18 项**：
  - 对账/结算：新增「默认生成差异解释」（开关）。
  - 账龄：第一/二/三档上限、提醒档上限、催收档上限。
  - 指标与月报：人工单票基线、人工时薪（默认值读 `BASELINE_MANUAL_SEC` / `HOURLY_COST`）、绕过率告警阈值。
- 接线（不是只加开关）：
  - `aging._bucket()` / `aging()` / `_advice()` 改读配置；改档位后 `/api/aging/demo` 的分档名称与金额立即变化。
  - `/api/meta`、`/api/metrics`、`/api/risk-sim`、`/api/report.md`、`/report` 全部改读配置；页面值优先于环境变量。
  - `/api/reconcile` 未显式传 `explain` 时读配置开关。
- 其它：
  - `GET /api/settings/export`、`POST /api/settings/import`（只含运行级配置，不含密钥）。
  - 配置页显示「环境变量已设置，页面值优先」标签。
  - 校验：账龄档位必须递增、提醒档 < 催收档。
- 实测：
  - `aging.bucket_1=15` → 分档变为 `1–15 / 16–60 / 61–90 / 90+`；`bucket_2=10` 被拒；回滚后恢复 `1–30`。
  - 基线改 200 → `/api/meta` 返回 200，月报显示「人工单票 200 秒」。
  - 解释开关打开 → `/api/reconcile` 返回 `differences`（`engines: llm+rule`）；关闭 → 不返回。
  - 导出 18 项 → 改基线 210 → 导入 → `/api/meta` 返回 210；重置后 0 项非默认。
  - 页面：18 个输入、1 个开关、11 个区块，控制台 0 错误；`./scripts/smoke.sh` **16/16 通过**。
- 未做（保持 `[ ]`，不在页面放没有接线的开关）：
  - 规则开关与必填字段
  - 通知渠道与触发条件
  - 账龄催收建议模板
  - PG 多实例的变更历史表（单租户/一客一实例，不是多租户）
- GitHub Actions run #160（`8c1b0bc`）**4 个 job 全部通过**；preflight 通过。

### 5.25 单证规则开关 + 可配置必填字段

- 配置项从 18 项扩到 **22 项**：
  - `rules.required`：字段多选（默认客户/委托单号/箱型/提箱地/卸货地）。
  - `rules.container_checksum`：箱号 ISO 6346 校验位 + 箱量一致性。
  - `rules.closing`：截港已过 + 24 小时内截港 + 装柜时间矛盾。
  - `rules.address`：错别字、区县/城市冲突、提卸同址。
- 接线：
  - `rules.run_checks()` 按配置执行；`decide_review_level()` 的 watch 集合改用配置的必填字段。
  - 关闭规则或减少必填字段时，前端要求填写变更原因。
- 实测：
  - 默认：缺提箱地 + 箱号校验位错 + 截港已过 → `E_REQUIRED / E_CONTAINER_CHECKSUM / E_CLOSING_PASSED`，`blocked`。
  - 关闭两条规则并移除提箱地必填 → 同一张单 0 check，`review_level=auto`。
  - 空必填列表被拒（至少 1 项）；未知字段被拒（`nope`）。
  - 恢复默认后，三条检查重新出现。
  - 页面：22 项配置、4 个开关、必填字段 20 个复选框；不填原因移除必填被拦下，填原因后保存成功；控制台 0 错误。
  - `./scripts/smoke.sh` **16/16 通过**。
- 未做：
  - 费用 / 多票拆分 / 改单开关：不在 `run_checks` 同一条校验链，需单独接线后再上页面。
  - 通知与告警、账龄催收建议模板（P1 剩余）。
- GitHub Actions run #162（`a9ce2af`）**4 个 job 全部通过**；preflight 通过。

### 5.26 通知与告警

- 配置项从 22 项扩到 **27 项**：启用开关、企微群机器人 Webhook（密钥）、触发事件（多选）、静默时段、重复抑制。
- 新增 `app/notify.py`：
  - `notify(event, title, detail, key)` 写 `data/notifications.jsonl`，按开关/订阅/静默/去重决定是否外发。
  - 企微群机器人 markdown 消息；失败只记录，不阻断业务。
  - 后台巡检线程每 30 分钟检查绕过率，超阈按天去重发一次。
- 已接线事件：
  - `batch_failed`：批次结束有失败项，或任务异常。
  - `wecom_image_failed`：企微图片下载/OCR/入库失败。
  - `bypass_alert`：绕过率超过配置阈值。
- 实测：
  - Webhook 校验：`ftp://` 被拒；静默时段 `25:00-08:00` 被拒。
  - 未配置 Webhook 时测试返回 `sent=false / 未配置 webhook`。
  - 起本地接收端后配置 `http://127.0.0.1:8899/hook`，测试发送成功；收到的 body 为
    `{"msgtype":"markdown","markdown":{"content":"**智单通知测试**..."}}`。
  - 静默时段：当前 01:13 落在 `22:00-08:00` 内，`in_quiet=True`；测试消息因 `force=True` 仍发送。
  - 去重：同 key 30 分钟内第一次 `True`、第二次 `False`。
  - `/api/notify/recent` 返回测试记录（含 `sent` 与 `error`）。
  - 配置页：2 个文本框、3 个事件复选框、测试按钮、最近通知列表；控制台 0 错误。
  - `./scripts/smoke.sh` **16/16 通过**。
- 未做：
  - 邮件渠道（需 SMTP）；站内信不做（产品形态未定义）。
  - 通知模板自定义。
  - 账龄催收建议模板、费用/多票/改单开关（仍为 P1 剩余）。
- GitHub Actions run #164（`8dee745`）**4 个 job 全部通过**；preflight 通过。

### 5.27 账龄催收话术模板

- 配置项从 27 项扩到 **30 项**，新增三个可编辑模板：
  - `aging.tpl_remind`、`aging.tpl_collect`、`aging.tpl_serious`，分别对应提醒 / 催收 / 重点催收档。
  - 占位符：`{client}` `{count}` `{outstanding}` `{overdue}` `{days}`，按客户数据自动替换。
- 接线：
  - `aging()` 为每个客户返回 `advice_text`；正常档为空串，不发催收话术。
  - 账龄页新增「催款话术」列与「复制」按钮（正常档置灰）。
  - CSV 导出新增「催款话术」列。
  - 设置页模板用多行文本框编辑，保存后立即影响下一次分析。
- 实测：
  - 演示数据：重点催收 130 天渲染出完整话术；提醒档 14 天使用提醒模板；正常客户无话术。
  - 自定义 `【重点】{client}：逾期 {days} 天，未收 {outstanding} 元...` → 下次分析立即生效。
  - `{amount}` 被拒：`含未知占位符：{amount}；可用：{client} {count} {outstanding} {overdue} {days}`。
  - 缺 `{client}` 被拒；空白模板被拒；恢复默认后回到内置话术。
  - 页面：3 个多行模板框、保存后出现「已修改」、错误原因显示在提示条；控制台 0 错误。
  - 复制按钮：`closest('button')` 命中、点击后提示「话术已复制」；正常客户按钮禁用。
  - CSV：表头含「催款话术」，重点催收行带完整话术。
  - `./scripts/smoke.sh` **16/16 通过**。
- 未做：
  - 邮件渠道（需 SMTP）；站内信不做。
  - 费用 / 多票 / 改单开关（不在同一条校验链）。
  - 话术变量自定义、按客户单独模板。
- GitHub Actions run #166（`d1dd702`）**4 个 job 全部通过**；preflight 通过。

---


### 5.28 待办与边界口径清理（文档）

- 修正的边界错误：
  - `ai-copilot/docs/系统配置设计.md` P2 的「多租户配置」：智单是单租户客户交付系统，一客一实例；多租户只在诊断平台（供应商 SaaS）。
  - `ai-copilot/docs/未实现清单.md` C3、`ai-copilot/README.md` §8.2、`会客包/12_系统边界与落地清单.md`、`会客包/00_实施计划.md`、`会客包/README.md` 中「多租户待补 / 不做登录权限」等过时口径。
  - 部署形态表述：把「云上 SaaS」改为「云上托管（单租户实例）」；多副本共享标注为「仅多副本部署时」。
- 修正的计划/文档矛盾：
  - 配置设计 §3.3 把未接线的 `rules.fees/split/amend` 写成已有开关 → 改为仅列已接线项，并注明未接线。
  - 配置设计 §3.5 的「按逾期占比分级」与代码不一致 → 改为按最长逾期天数分档；话术模板改为实际 3 档。
  - 配置设计 §3.10 的「站内信渠道」未实现且无产品形态 → 改为当前唯一渠道企微群机器人。
  - 配置设计 §3.12 的 `features.*` 功能开关页面化 → 明确不做，避免假开关。
  - `会客包/13_AI能力路线图.md` 把催收话术写成生成式 AI → 改为分档模板 + 占位符，不是大模型。
  - 培训指南「9 项规则阈值」→ 30 项运行级配置。
- 结论：
  - **不做**：智单多租户配置、`features.*` 页面开关、站内信。
  - **保留为条件项**：TMS 写回（C2，需客户接口文档）、费用/多票/改单开关（需先接线）、邮件渠道（需 SMTP）。
- 验证：`make preflight` 通过；`python3 scripts/build_impl_map.py` 重新生成 `实施全景图.html`。
- GitHub Actions run #173（`041046a`）**4 个 job 全部通过**；preflight 通过。
- GitHub Actions run #169（`f5a820e`）**4 个 job 全部通过**；preflight 通过。
- GitHub Actions run #171（`b3acd66`）**4 个 job 全部通过**；preflight 通过。

---

### 5.29 催收话术可选 AI 润色（AI-36）

- 配置项从 30 项扩到 **31 项**：`aging.ai_draft`，默认关闭。
- 新增 `app/advice_ai.py`：
  - 规则先定档位、金额、逾期天数、客户名，填充模板。
  - 模型只改写措辞；输出必须是 JSON `{"draft":"..."}`。
  - 校验：客户名必须在；未收/逾期/天数三个数字必须出现；不得出现模板之外的数字；
    付款期限（N 个工作日）必须保留；不得新增减免/免息/折扣/延期/起诉/律师函/法院/仲裁/威胁等表述。
  - 校验失败、模型不可用、未配置模型 → 自动回退模板；不返回未校验文本。
- 实测：
  - 校验单测：正常改写通过；改金额 `9,900` 被拒；少天数被拒；编造 `5 个工作日` 被拒；把 `2 个工作日` 改成 `2 天` 被拒；出现「起诉」被拒。
  - 未启用时接口返回 `{"ok":false,"error":"未启用 AI 润色","fallback":true,"text":""}`。
  - 启用后真实调用：5.37 秒、1011 tokens；输出保留 `8,800 元 / 130 天 / 2 个工作日`，仅改写措辞；
    第二次调用命中缓存。
  - 页面：启用后 4 个客户行出现「AI 润色」，弹窗显示建议与「AI 建议 · 命中缓存」提示；
    关闭后 0 个 AI 按钮，复制功能仍正常；控制台 0 错误。
  - `./scripts/smoke.sh` **16/16 通过**。
- 边界：
  - 不做自动发送；只提供人工核对后的复制。
  - 不按历史沟通记录生成个性化内容（缺数据），当前只是模板措辞润色。
  - 默认关闭，避免每次分析都产生 token 成本。

---

### 5.30 批量金标导出/比对（AI-24）+ 合成回归样本

- 新增 `app/batchgold.py`：
  - 导出 `run_id,file,text` + `gold_*`（空）+ `pred_*`（系统值）的金标模板。
  - 导入填好的 CSV，按 `run_id` 找系统值，只比对填了 gold 的字段。
  - 结果落 `data/batch_evals/{batch}-{eval}.json`；当前只支持托书批次。
- 实测：
  - 新建批次 `3652679185d6`，上传 2 个 txt，后台处理 2/2 成功。
  - 导出模板 2 行 × 43 列（3 + 20 gold + 20 pred）。
  - 故意把第 2 条客户改成「错误客户」，其余填对 → 字段准确率 75%、整单全对 50%、
    客户字段 50%、委托单号 100%；结果落盘 `eval_id=3f1ebbe120`。
  - 页面：`/batch` 出现「导出金标模板」「导入金标比对」按钮，选择批次后 2 条结果可见；
    控制台 0 错误。
- 合成回归样本：
  - 新增 `samples/synthetic_batch50.jsonl`，50 份合成托书，覆盖单/双箱、三种写法。
  - `run_eval`：50/50、字段 100%、整单 100%；**只证明格式与批量链路，不构成真实准确率**。
  - 真实脱敏样本仍为 0，AI-23 保持 `[ ]`。
- 顺带修复：同一行同时出现「装柜时间 + 截港时间」时，截港会取到装柜时间；
  `_dt_near` 改为从命中的关键词之后找时间。修复后 tuned 100% / holdout 98.7% / 整单 87.5%。
- `./scripts/smoke.sh` **16/16 通过**。
- GitHub Actions run #175（`e6ac7e6`）**4 个 job 全部通过**；preflight 通过。

---

### 5.31 TMS 通用写回适配层（AI-37）

- 配置项从 31 项扩到 **35 项**：`tms.enabled`、`tms.endpoint`、`tms.token`、`tms.timeout_sec`。
- 新增 `app/tms.py`：
  - 固定契约 `schema=ai-copilot/tms-generic-v1`，字段为 `booking.*`。
  - `tms_outbox` 发件箱；按 `run_id+version` 幂等。
  - 2xx → sent；4xx → failed（不重试）；5xx / 网络 → pending（后台重试）。
- 实测（本地 mock TMS `scripts/mock_tms.py`，token `dev-token`）：
  - 测试连接：`ok=true`、`status=sent`、52 ms。
  - 推送已确认单 `bb68767f367e`：`sent`，mock 收到 17 个字段；再次推送 `created=false`，不重复发。
  - 把 endpoint 指向 `/fail`：HTTP 500 → `pending`、attempts=1；改回 `/hook` 后 `flush` → `sent`。
  - 把 endpoint 指向 `/nope`：HTTP 404 → `failed`、attempts=1；改回 `/hook` 再推同一单 → `sent`。
  - 关闭 TMS 后推送：422 `TMS 写回未启用或未配置 endpoint`。
  - 页面：`/history` 出现「TMS 写回已启用」提示和 4 个「推送 TMS」按钮；点击提示「已推送到 TMS」，控制台 0 错误。
  - `/settings`：TMS 分组显示 4 项；测试连接可用。
- 顺带修复：密钥类配置不再通过 `/api/settings` 回显明文；`tms.token` / `notify.webhook`
  返回 `value=""`、`configured=true/false`，导出配置跳过；PUT 响应与变更历史也脱敏为 `••••`；页面留空表示不修改。
- `./scripts/smoke.sh` **16/16 通过**。
- 边界：**没有对接真实客户 TMS**；AI-26 保持 `[ ]`，需客户接口文档与字段映射。
- GitHub Actions run #177（`5ee58b8`）**4 个 job 全部通过**；preflight 通过。

---

### 5.32 邮件告警渠道（AI-38）

- 配置项从 35 项扩到 **37 项**：`notify.channels`（webhook / email 多选）、`notify.email_to`。
- 部署级：`SMTP_HOST/PORT/USER/PASSWORD/FROM/TLS/STARTTLS/TIMEOUT` 放 `.env`。
- 实测（本地 `scripts/mock_smtp.py`，`SMTP_HOST=127.0.0.1:8025`）：
  - 渠道只勾「邮件」、收件人 `ops@example.com,finance@example.com` → 测试发送 `sent=true`。
  - mock 收到 1 封，收件人两个都在；主题 `[智单] 智单通知测试`。
  - `/api/config/test/email` 单独测试 → `ok=true`。
  - 清空收件人 → `sent=false / 未配置邮件收件人`，只记录不抛异常。
  - 渠道填 `sms` → 422「通知渠道 含未知项：sms」。
  - 企微 webhook 渠道逻辑保持不变；未配置 webhook 时只报该渠道错误。
- 顺带修复：列表配置校验支持 `options`，不再只认托书字段（否则 `webhook/email` 会被拒）。
- `./scripts/smoke.sh` **16/16 通过**。
- GitHub Actions run #179（`bab683b`）**4 个 job 全部通过**；preflight 通过。

---

## 6. 未验证 / 阻塞项

| 项 | 状态 | 说明 |
|---|---|---|
| 真实客户机会点走完 S2 | 未验证 | 需要真实客户、访谈、样本与确认 |
| 真实 POC 与客户确认 | 未验证 | 合成样本不能替代真实托书 |
| 真实试点上线/UAT 签收 | 未验证 | 需要客户环境与签收人 |
| 企微图片真实端到端 | 已用测试租户验证 | 文字、图片、主动推送均跑通；**固定域名未验证**，回调仍是临时隧道 |
| K8s 预发滚动发布 | 未验证 | 只有本地演练 |
| 真实支付/发票/扣费 | 未验证 | 当前 mock/manual |
| 真实模型联调与提示词评测 | 未验证 | 规则引擎可跑；LLM 评测未执行 |
| 真实 Alertmanager 触发与值班 | 未验证 | 只有本地路由/抑制演练 |
| 真实 S3/MinIO | 未验证 | 本地 S3 兼容演练 |
| 生产配置 | FAIL 3 | `AUTH_REQUIRED`、`AUTH_SECRET`、`METRICS_TOKEN` 未配置 |
| 依赖漏洞 | 已知风险 | 后端生产 5 moderate；含开发依赖 9（6 moderate、3 high）；前端 0 |

详见 `SECURITY.md` 与 `企业AI化项目管理系统/09_试点启动包.md`。

---

## 7. 复现命令

```bash
# 后端
cd backend
npm run typecheck
npm run verify
npm run verify:report
npm run verify:write
npm run readiness:check -- --report-only

# 前端
cd ../frontend
npm run typecheck
npm run test:unit
npm run build
PW_CHANNEL=msedge npx playwright test

# ai-copilot
cd ../ai-copilot
make smoke
for t in test_address test_fees test_metrics test_delivery test_hardening test_wecom_crypto test_storage; do
  PYTHONPATH=. .venv/bin/python scripts/$t.py
done
```

---

## 8. 放行建议

- **内部演示 / 代码评审：可以放行。**
- **真实客户试点：先补齐 `AUTH_REQUIRED`、`AUTH_SECRET`、`METRICS_TOKEN`，配置 `ops/oncall.yml`，按 `09_试点启动包.md` 取得客户授权、样本与确认人。**
- **生产上线：另需 K8s 预发、真实支付/模型、Alertmanager 接收端、真实 S3 与安全评审；在此之前不应把外部项勾选为完成。**
