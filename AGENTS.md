# AGENTS.md · 项目协作铁律

> 本文件适用于在本仓库工作的所有 Agent、开发者和自动化任务。
> 与 `实施全景图.md` 冲突时，以 `实施全景图.md` 的最新状态与证据为准；但**本文件的铁律不可绕过**。

---

## 0. 第一铁律：实施全景图是单一事实源

**任何改动，开工前先读 `实施全景图.md`，提交前再复核一次。**

1. **图先于改**：先定位受影响节点（如 `AI-21`、`MT-05`、`G3`），再动手。
2. **同一提交更新**：代码、文档、状态、证据必须同一次提交更新。只改代码不改图 = **未完成**。
3. **完成只认证据**：`[x]` 必须有可复现命令、测试记录、CI run、截图/日志或客户签字。
4. **无影响也要留痕**：判断不影响本图时，在提交说明写 `图无影响：<原因>`。
5. **每次发布更新**：更新图顶部日期/基线、受影响节点、`VERIFICATION.md` 对应章节。
6. **HTML 不手改**：`实施全景图.html` 由 `python3 scripts/build_impl_map.py` 生成；改完 MD 必须重新生成。CI 会重新生成并校验 HTML 与 MD 同步，漂移即失败。

> 违反任一条，变更不得合并、不得推送。

---

## 1. 项目结构

| 目录 | 作用 | 技术栈 |
|---|---|---|
| `backend/` | 诊断平台 API（S1–S5、多租户、RLS、PDF、账单） | Node.js / TypeScript / Fastify / PostgreSQL |
| `frontend/` | 诊断平台前端 + Playwright e2e | React / Vite / Playwright |
| `ai-copilot/` | 客户交付的 AI 托书结构化系统 | Python / FastAPI / SQLite 或 PostgreSQL / RapidOCR |
| `企业AI化项目管理系统/` | 阶段计划、角色矩阵、试点启动包 | Markdown |
| `会客包/` | 销售/会客/试用材料与流程图 | Markdown / HTML |
| `ops/` | SLO、告警、K8s、值班模板 | YAML / Markdown |
| `scripts/` | 备份、恢复、演练、构建脚本 | Shell / Python |
| `VERIFICATION.md` | 全项目核验报告（证据总账） | Markdown |
| `实施全景图.md` | 实施单一事实源（脑图 + 流程图 + 检查表 + 铁律） | Markdown / Mermaid |

---

## 2. 语言与命名

- 面向用户的 UI、文档、汇报材料用**中文**。
- 代码、数据库字段、API 路径、环境变量用**英文 / `snake_case`**。
- 不在中文 UI 里混用英文缩写，除非是行业通用词（OCR、POC、UAT、RLS）。
- 合成数据必须显式标注“合成 / 演示”，不得写成真实客户结论。

---

## 3. 不包装 AI（对外口径铁律）

- OCR、规则引擎、脚本、人工复核、指标计算都是**系统能力**，不是大模型。
- 只有明确调用大模型的节点才能标 🤖；当前 ai-copilot 的模型只做 `fill_only`（补空），失败回退规则。
- 金标标的是**原文写了什么**，不是业务上“应该是什么”；箱号校验失败也不改金标原值。
- 金标评测不是“训练一次就关闭人工复核”的开关；仍需抽样审计、变更回归、新格式准入。
- 企业微信只自动处理文字消息；图片走 H5/批量导入；“会话内容存档”不做；个人微信无官方接口，不做。

---

## 4. 验证顺序（禁止并行）

```bash
# 后端
cd backend
npm run typecheck
npm run verify
npm run verify:write          # 与 e2e 不能同时跑

# 前端
cd ../frontend
npm run typecheck
npm run test:unit
npm run build
PW_CHANNEL=msedge npx playwright test

# ai-copilot
cd ../ai-copilot
./scripts/smoke.sh            # 15 项
```

- `verify:write` 与 e2e 共用测试库/端口，**必须串行**。
- 合并前 GitHub Actions 四个 job 全绿：backend / frontend / e2e / docker。
- 本地跑过什么就写什么；没跑过的测试不得写成通过。
- 外部依赖（真实客户、支付、模型、S3、Alertmanager、K8s 预发）不能用 mock/样例冒充。

---

## 5. Git 与发布

- 远端：`origin` = GitHub `roma007/Enterprise-AI`；`gitee` = `roma007007/enterprise-ai`。
- 默认分支 `main`；提交信息用 `type(scope): 中文摘要`，涉及图节点时带上 ID，例如：
  `feat(copilot): 学习队列按来源筛选 [AI-21]`
- 推送前确认工作区只包含本任务改动；禁止 `git add -A` 扫入无关文件。
- 推送后等 CI；CI 红先修，不带红合并。
- 不强制推送、不重写历史迁移、不删除用户分支。
- 真实联系人、`.env`、`ops/oncall.yml`、数据库/日志/备份不得提交。

---

## 6. 每次改动的完成定义（DoD）

- [ ] 已在 `实施全景图.md` 定位并更新受影响节点
- [ ] 已更新 `VERIFICATION.md`（有代码/部署/功能变化时）
- [ ] 已更新 `TODO.md` / `AUTOPILOT_QUEUE.md`（涉及待办状态时）
- [ ] 已跑对应验证，记录命令与结果
- [ ] 已重新生成 `实施全景图.html`
- [ ] commit message 带节点 ID 或 `图无影响：<原因>`
- [ ] 已推送双远端，CI 四 job 全绿
- [ ] 外部未验证项仍保持 🟡/⬜，没有写成 ✅

---

## 7. 遇到不确定时

- 先读 `实施全景图.md`、`VERIFICATION.md`、`TODO.md`、`09_试点启动包.md`。
- 仍不确定：停下来问用户，不猜、不伪造、不用样例替代真实证据。
- 发现图与代码/证据不一致：**先修图**，再继续开发。
