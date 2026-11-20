# 行业包（packs/）

> 目的：把“会随行业/客户变化的领域知识”从代码里搬出来，让进入一个新行业从
> “再写一套系统”变成“写一个包 + 拿 20–50 份样例 + 定验收指标”。

## 当前状态

- **Step 0 已完成**：`packs/trucking/` 冻结了原有字段/校验/口径。
- **Step 1 已完成**：`app/schema.py`、`app/invoice.py`、`app/rules.py` 已经读 pack。
- **Step 2 已完成**：`reconcile` / `aging` / `fees` / `margin` / `geo` 也已读 pack；
  `packs/trucking/` 现在是托书、发票、校验、对账、账龄、费用、成本、地域的运行时源。
- **Step 3 已完成**：新增 `packs/freight_audit/`（买方运费审计 dry-run），
  同一套 `app/` 内核不改代码可跑通；`packdiff` 证明差异只在配置。
- **Step 4 待做**：`/api/packs`、激活/回滚、审计、设置页“行业包”页签。

## 目录

```text
packs/
  trucking/            # 集卡/拖车（默认，完整 9 个文件）
    pack.json          # 元信息、依赖的 settings key
    fields.json        # 单据字段（托书 / 发票）
    rules.json         # 校验规则（内置校验器 + 参数）
    reconcile.json     # 对账表头同义词、匹配键、金额字段、状态、展示字段
    aging.json         # 账龄表头同义词
    fees.json          # 费用表头、内置费用名、外协结算表头
    cost.json          # 毛利收入/成本表头同义词
    geo.json           # 城市/区县/港区/错别字/镇街词表
    acceptance.json    # 验收指标与最小样本量
  freight_audit/       # 买方运费审计（dry-run，部分 pack）
    pack.json
    fields.json        # 审计行 + 承运商发票
    rules.json         # 必填 / 低置信 / 金额格式
    reconcile.json     # 账单号 → 运单号 → 费用代码
    acceptance.json
```

> 部分 pack：`pack.json` / `fields.json` / `rules.json` / `reconcile.json` 必需；
> `aging` / `fees` / `cost` / `geo` / `acceptance` 可省略，加载器按空字典处理。

## 边界：什么进 pack，什么留 settings

| 放 pack | 放 settings（`data/settings.json`） |
|---|---|
| 有哪些字段、字段含义、是否必填 | 必填项勾选（`rules.required`） |
| 校验用哪种、参数是什么 | 校验开关（`rules.closing` / `rules.address`） |
| 对账表头同义词、匹配键、金额字段 | 金额容差（`reconcile.tolerance`） |
| 账龄表头、费用科目、成本口径 | 账龄分档天数、毛利预警线 |
| 验收目标 | 提醒/催收话术模板 |

判据：

> 改了会改变“字段含义/报告口径” → pack；只是松紧、开关、文案 → settings。

## 命令

```bash
cd ai-copilot
make pack-export     # 重新导出基线（Step 0 工具；Step 1 后为 round-trip）
make pack-lint       # 检查 pack 自身是否自洽
make pack-snapshot   # pack 加载 / 代码接线与 JSON 源对照
make pack-test       # 固定时间跑 schema/invoice/rules 行为断言
make pack-test-freight  # 买方运费审计 dry-run（PACK_ID=freight_audit）
make pack-diff       # trucking -> freight_audit 的差异
```

## 规则

1. **只抽真实用到的**：第二个包真的需要不同值时才抽；不预先抽象。
2. **不做低代码平台 / 插件市场**：pack 只允许内置校验器 + 参数，不写任意 Python。
3. **不把数字阈值搬进 pack**：阈值留在 `settings`，避免两套配置打架。
4. **改 pack 必须过**：`pack-lint` + `pack-snapshot`（Step 1 后加 smoke/eval）。
5. **pack 版本化**：`pack.json` 的 `version` 记录在每次解析结果里，保证可追溯。
