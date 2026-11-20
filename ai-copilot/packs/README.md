# 行业包（packs/）

> 目的：把“会随行业/客户变化的领域知识”从代码里搬出来，让进入一个新行业从
> “再写一套系统”变成“写一个包 + 拿 20–50 份样例 + 定验收指标”。

## 当前状态

- **Step 0 已完成**：`packs/trucking/` 是当前代码的**冻结基线**，不参与运行时加载；
  `scripts/pack_snapshot.py` 证明它与现有常量逐项一致。
- **Step 1 起**：`app/schema.py`、`app/rules.py`、`app/reconcile.py` 等改为读 pack；
  pack 才成为源。
- `packs/freight_audit/`（买方运费审计）尚未创建，等 Step 3。

## 目录

```text
packs/
  trucking/
    pack.json          # 元信息、依赖的 settings key
    fields.json        # 单据字段（托书 / 发票）
    rules.json         # 校验规则（内置校验器 + 参数）
    reconcile.json     # 对账表头同义词、匹配键、金额字段、状态
    aging.json         # 账龄表头同义词
    fees.json          # 费用表头、内置费用名
    cost.json          # 毛利收入/成本表头同义词
    geo.json           # 城市/区县/港区/错别字/镇街词表
    acceptance.json    # 验收指标与最小样本量
```

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
make pack-export     # 从当前代码重新导出基线（Step 0 工具）
make pack-lint       # 检查 pack 自身是否自洽
make pack-snapshot   # 对照当前代码常量，证明逐项一致
```

## 规则

1. **只抽真实用到的**：第二个包真的需要不同值时才抽；不预先抽象。
2. **不做低代码平台 / 插件市场**：pack 只允许内置校验器 + 参数，不写任意 Python。
3. **不把数字阈值搬进 pack**：阈值留在 `settings`，避免两套配置打架。
4. **改 pack 必须过**：`pack-lint` + `pack-snapshot`（Step 1 后加 smoke/eval）。
5. **pack 版本化**：`pack.json` 的 `version` 记录在每次解析结果里，保证可追溯。
