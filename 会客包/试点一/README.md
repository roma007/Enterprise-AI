# 试点一启动包 · 对账单 / 结算单抽取与差异解释

> 用途：D1–D3 不需要等客户数据就能先准备的材料。
> 目标：客户一给数据，就能在 2 周内跑出可验收的抽取 + 差异解释。

## 目录

| 文件 | 用途 |
|---|---|
| `01_数据需求清单.xlsx` | 给客户的清单：要哪些数据、什么格式、多少份、谁负责 |
| `02_金标标注模板.xlsx` | 人工逐字段标注 / 差异标注 / 解释评分 |
| `schemas/pilot.schema.json` | 对账单、结算单、差异的 JSON Schema |
| `samples/*.jsonl` | 评测用示例数据（含故意错误） |
| `reports/*.example.md` | 评测脚本示例输出 |
| `03_API与Schema.md` | 接口与数据结构草图 |
| `../ai-copilot/scripts/eval_statement_pilot.py` | 评测脚本 |

## D1–D3 启动清单

- [ ] D1：和客户开 30 分钟会，确认范围、样本、验收指标
- [ ] D1：发 `01_数据需求清单.xlsx`，约定回收时间
- [ ] D2：收到第一批样本（≥5 份对账单 + ≥5 份结算单）先做格式评估
- [ ] D2：确定 `document_id` 命名规则（如 `stmt-001` / `set-001`）
- [ ] D3：用 `02_金标标注模板.xlsx` 标 10 份金标
- [ ] D3：填 `人工基线`：单张耗时、月工时、错误率
- [ ] D3：确认数据能否脱敏/出内网；不能则准备客户内网环境
- [ ] D3：把基线写进试点章程，冻结验收指标

## 怎么用数据需求清单

1. 先填 `说明` 页的项目信息
2. 把 `数据需求清单` 发给客户财务/IT
3. 客户按 `对账单表头`、`对账单明细`、`结算单表头`、`结算单明细` 填
4. `运单与合同价` 是比对基准，必须提供
5. `人工基线` 用来算“时间下降 ≥50%”的起点

> 至少需要：对账单 ≥30 份、结算单 ≥30 份、运单/合同价、10 份金标。

## 怎么标注金标

1. 打开 `02_金标标注模板.xlsx`
2. 每份文件在 `statement_gold` / `settlement_gold` 写一行表头
3. 每个明细行在 `statement_lines_gold` / `settlement_lines_gold` 写一行
4. 确认的差异写进 `differences_gold`
5. 评测时用 `explanation_review` 给解释打 1–5 分并标记是否采纳
6. 金额照原文抄，不要“修正”；不确定的写 remark

字段定义见 `schemas/pilot.schema.json` 和 Excel 表头。

## 评测

从仓库根目录：

```bash
python3 ai-copilot/scripts/eval_statement_pilot.py \
  --kind statement \
  --gold 会客包/试点一/samples/statement_gold.example.jsonl \
  --pred 会客包/试点一/samples/statement_pred.example.jsonl \
  --diff-gold 会客包/试点一/samples/differences_gold.example.jsonl \
  --diff-pred 会客包/试点一/samples/differences_pred.example.jsonl \
  --out 会客包/试点一/reports/statement_eval.example.json \
  --out-md 会客包/试点一/reports/statement_eval.example.md
```

结算单：

```bash
python3 ai-copilot/scripts/eval_statement_pilot.py \
  --kind settlement \
  --gold 会客包/试点一/samples/settlement_gold.example.jsonl \
  --pred 会客包/试点一/samples/settlement_pred.example.jsonl \
  --diff-gold 会客包/试点一/samples/differences_gold.example.jsonl \
  --diff-pred 会客包/试点一/samples/differences_pred.example.jsonl \
  --out-md 会客包/试点一/reports/settlement_eval.example.md
```

加 `--strict` 时低于验收阈值退出码为 1，可直接接 CI。

### 示例数据是故意有错的

- 对账单示例少了一行、客户名写错、差异多报一条
- 结算单示例单价写错
- 所以示例报告会显示不达标；这是为了验证评测脚本能抓出问题，不是产品效果

真实数据上应把 `--strict` 作为 Go/No-Go 门槛。

## 代码骨架（D4 已起步）

| 模块 | 作用 |
|---|---|
| `ai-copilot/app/table_extract.py` | 通用表头/分隔符/金额/日期解析 |
| `ai-copilot/app/statement.py` | 对账单文本 → StatementDocument；转 reconcile 行与差异 |
| `ai-copilot/app/settlement_extract.py` | 结算单文本 → SettlementDocument；转 bills 与差异 |
| `ai-copilot/app/diff_explain.py` | 规则模板 + 可选大模型解释；失败回退规则 |
| `ai-copilot/app/main.py` | `/api/statement/extract`、`/api/settlement/extract`、`/api/*/extract/file`；`/api/reconcile`、`/api/settlement` 支持 `explain` |

闭环命令：

```bash
# 抽取 → 规则比对 → 差异解释
python3 ai-copilot/scripts/pilot_flow.py

# 用原始文本样本评测（应全部通过）
python3 ai-copilot/scripts/eval_statement_pilot.py   --kind statement   --gold 会客包/试点一/samples/statement_raw_gold.example.jsonl   --pred 会客包/试点一/reports/statement_extracted.example.jsonl   --diff-gold 会客包/试点一/samples/differences_gold.example.jsonl   --diff-pred 会客包/试点一/reports/statement_differences.example.jsonl   --strict

python3 ai-copilot/scripts/eval_statement_pilot.py   --kind settlement   --gold 会客包/试点一/samples/settlement_raw_gold.example.jsonl   --pred 会客包/试点一/reports/settlement_extracted.example.jsonl   --diff-gold 会客包/试点一/samples/differences_gold.example.jsonl   --diff-pred 会客包/试点一/reports/settlement_differences.example.jsonl   --strict
```

当前骨架支持文本/CSV/TSV，以及 PDF/图片 OCR（复用现有 OCR 管线）。OCR 列粘连、低置信或金额校验不通过时会标记 `needs_review`，必须人工复核；文本/CSV 路径可做到严格评测全通过。

生成 OCR 测试文件：

```bash
ai-copilot/.venv/bin/python ai-copilot/scripts/make_pilot_ocr_fixtures.py
```

已实测：`statement_ocr.png`、`settlement_ocr.png`、`statement_ocr.pdf` 均能解析出正确行金额。

已验证：

- `pilot_flow.py` 跑通抽取 → 规则比对 → 差异解释
- 原始文本样本 `--strict` 评测：对账单、结算单全部通过
- API：`/api/statement/extract`、`/api/settlement/extract`、`/api/*/extract/file`、`/api/reconcile?explain`、`/api/settlement?explain`

## 复核页（/pilot）

启动 ai-copilot 后登录，打开：

```text
http://127.0.0.1:8790/pilot
```

流程：

1. 选“对账单 / 结算单”
2. 粘贴文本，或上传 PDF/图片/CSV
3. 点“加载示例”可一键填入示例 + 运单/合同价
4. “抽取并比对” → 看表头、明细、差异解释
5. 修改字段后可“按当前编辑重新比对”
6. 每条差异选择“采纳 / 修改后采纳 / 忽略”，填备注
7. “保存复核” → 本地 `pilot_reviews`
8. “推送到对账记录” → 交付平台 `copilot_reconcile_reviews`
9. 在交付平台项目 →「POC 验证」页底部可看到「ai-copilot 对账复核记录」，点“查看”看字段、明细、差异、决策
10. 详情弹窗可「生成风险」（写入项目 `risks`）或「生成待办」（写入 `delivery_issues`，编号 ISS-xxx）
    - 待办/风险可选负责人、截止日期；未选时默认当前用户，按 P0/P1/P2/P3 计算 1/3/7/14 个工作日 SLA（跳过周末与组织已配置节假日）
    - 节假日由管理员在「组织设置 → 工作日与节假日」维护；SLA 地区在 `settings.region`（默认 CN），只跳过该地区或 ALL 的节假日；未配置时只跳过周末
    - 风险登记册可在行内直接改负责人/截止日期
    - 差异行会显示关联风险/待办的最新状态（待处理/处理中/已解决/已关闭/已拒绝）；关闭风险或解决待办后会即时反映
    - 支持整张复核或单条差异生成；每条差异/每类动作最多一次，重复点击返回已有记录
    - 差异表右侧有单行「风险 / 待办」按钮；也可勾选多条差异后批量生成，每条差异单独生成一条风险/待办
    - 批量接口逐条独立处理并返回 `created / skipped / failed` 与失败明细，单条失败不会回滚其他条
    - 批量生成走 NDJSON 流式接口，界面显示「处理中 N/M 条」进度；批次与逐条结果持久化，刷新后仍可查看
    - 「批量生成记录」按批次组翻页，一次加载完整父子树；时间、类型、状态、成功/跳过/失败数，子批次缩进显示
    - 批次组可展开/收起；「导出 CSV」导出批次汇总，「导出明细 CSV」导出逐条差异与失败原因
    - 两个 CSV 都做了 Excel 公式注入防护，`= + - @` 开头的内容会加 `'` 前缀
    - 可按状态、类型、创建日期筛选；筛选同时作用于列表和导出，按批次组整组展示
    - 筛选区会显示预计批次数、明细数与 ZIP 体积
    - 筛选条件写入 URL，并带 `batch_review` 命名空间；仅对对应复核生效，关闭详情时清除
    - 筛选请求 300ms 防抖；开始日期晚于结束日期时前端提示并禁用导出，后端返回 `INVALID_DATE_RANGE`
    - 可勾选「记住筛选」，关闭后下次打开自动应用；取消勾选会清除本地记录
    - 可把当前筛选保存为命名视图，之后从下拉框一键套用或删除
    - 共享支持全员、按组织角色、指定同事三种方式；只有创建者可删
    - 视图保存/删除会写独立审计事件，详情区可查看「视图审计」
    - 被共享的同事会收到站内通知，左侧「通知」显示未读数
    - 通知支持未读、类型、创建日期筛选与分页；筛选条件写入 URL，刷新后保留
    - 可跨页「全选筛选结果」后批量删除，最多一次 100 条或按筛选条件全删
    - 删除进入「回收站」，可恢复或彻底删除；删除/恢复/彻底删除都有审计事件
    - 回收站默认保留 30 天，过期自动清理；管理员可在「通知审计」按操作/日期/操作人查询
    - 「协作审计」顶部显示总数/通知/筛选视图/导出统计，类型切换后只显示对应操作
    - 支持操作人/日期筛选与 CSV 导出；热表默认保留 365 天，超期自动归档
    - 范围支持「热表 / 归档 / 全部」；全部视图合并热表与归档并标注归档时间
    - 全部范围支持导出与合并统计
    - 「归档」视图显示归档时间、最近归档摘要与分页的归档执行记录；执行记录可按日期筛选
    - 页面底部「审计快照」支持 30/90/180/365 天范围与按日/周/月聚合，展示连续柱状趋势
    - 表格含周期区间、总数、新增与各类型计数；导出与页面同口径
    - 快照按组织 `settings.timezone` 生成（默认 Asia/Shanghai，时区下拉选择并校验），查询窗口以组织时区当天截止
    - 累计口径同时统计热表与归档表，归档后不会出现累计量下降
    - 修改时区后可「重算快照日期」，按快照创建时间重新映射到本地日期
    - 趋势图可切换「新增 / 累计」口径
    - 快照表上方展示「本周期 / 上周期 / 环比」的新增对比（总数、通知、筛选视图、导出）
    - 快照默认保留 365 天，过期随快照任务清理；支持导出快照 CSV
    - 归档视图支持导出 CSV
    - 通知审计也保留独立入口与导出
    - 通知可勾选批量删除；视图审计按 5 条一页翻页，可导出审计 CSV
    - 视图 ID 会写入 URL，刷新或分享链接后仍保持选中的视图
    - 「导出 ZIP」把批次汇总和逐条明细两个 CSV 打包下载
    - 每次导出都会在「审计日志」留下 `EXPORT copilot-batch-*` 事件
    - 失败批次可「重试失败项（N）」，只重试失败差异；刷新后记录仍在，超时未完成的批次会被标记为失败
    - 运行中的批次可「取消」并填写原因，已生成的动作保留；记录取消人和时间
    - 已取消批次可「继续剩余（N）」，只处理尚未执行的差异并生成子批次；可重新指定负责人、级别和截止日期
    - 剩余差异会减去所有子批次已处理的差异，避免父子批次重复执行
    - 已标记忽略的差异不参与批量选择；已生成的差异会自动从待生成数量中剔除

回写配置（`ai-copilot/.env`）：

```env
DELIVERY_PLATFORM_URL=http://127.0.0.1:8788
DELIVERY_HOOK_TOKEN=<与 backend COPILOT_HOOK_TOKEN 一致>
DELIVERY_ENGAGEMENT_ID=<目标项目 uuid>
```

复核页也可以手填 engagement_id，不必写死。

## 验收阈值

| 指标 | 目标 |
|---|---|
| 表头字段准确率 | ≥98% |
| 明细字段准确率（匹配行） | ≥95% |
| 明细行召回率 | ≥98% |
| 金额合计准确率 | 100% |
| 差异召回率 | ≥95% |
| 差异精确率 | ≥95%（误报 ≤5%） |
| 解释人工采纳率 | ≥70%（人工评分） |
| 单张处理时间下降 | ≥50% |

## 数据与隐私

- 优先客户内网或我方沙箱
- 外发前脱敏客户名/金额/车牌
- 不把原文发给未批准的外部模型
- 评测文件、金标、报告都放在受控目录
- 不自动付款、不自动记账、不自动开票

## 下一步

D3 结束后进入 D4–D10：抽取 → 规则比对 → 差异解释 → 复核界面 → 评测 → 验收。
详见 [`../14_试点一_对账单抽取与差异解释.md`](../14_试点一_对账单抽取与差异解释.md)。
