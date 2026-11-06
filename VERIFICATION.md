# 全项目核验报告

> 核验日期：2026-11-06
> 基线提交：`c1a3c0c` + 本轮 CI/种子数据修正
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
| ai-copilot | **通过（内部样例）**：7 个专项测试 + 15 项 smoke 通过；规则评测通过 |
| CI | **通过**：GitHub Actions 4 个 job 全部通过（`d6351db`，run #117；已升级 Node 24 Actions） |
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
| `make smoke` | **15/15 通过** |
| H5 拍照/上传（本机实测） | **通过**：上传 `samples/fixtures/booking_sample.png`，OCR + 规则抽出 17 个字段，`review_level=single`，带逐字段置信度与截港预警 |
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

### 5.5 H5 上传入口补齐（已修复）

- 现象：H5 `/api/extract/upload` 只写 `runs`，不写 `inbound`，导致拍照/上传不在「绕过率」分母里。
- 修复：OCR 成功后先 `record_inbound(res.text, source="h5-upload")` 再解析；`save_run` 按文本哈希自动回填 `run_id`。
- 复验：上传 `booking_sample.png` 生成 `h5-upload` inbound 并关联 run；ai-copilot smoke **15/15 通过**。

---

## 6. 未验证 / 阻塞项

| 项 | 状态 | 说明 |
|---|---|---|
| 真实客户机会点走完 S2 | 未验证 | 需要真实客户、访谈、样本与确认 |
| 真实 POC 与客户确认 | 未验证 | 合成样本不能替代真实托书 |
| 真实试点上线/UAT 签收 | 未验证 | 需要客户环境与签收人 |
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
