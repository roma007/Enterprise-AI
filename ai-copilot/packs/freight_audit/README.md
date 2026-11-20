# freight_audit · 买方运费审计（dry-run）

> **合成样例，不代表任何真实客户。** 用途：证明同一个内核不改代码，
> 只换 pack 就能跑另一套字段与对账口径。

## 场景

货主 / 制造企业的物流费用审计：

- 承运商寄来账单，逐行列费用（运费、燃油、等候、路桥等）；
- 企业拿合同价 / 运单核对，找出多收、少收、重复、无合同价；
- 输出差异清单，交给承运商申诉或财务付款。

和 `trucking`（承运方/货代侧）的区别：

| 项 | trucking | freight_audit |
|---|---|---|
| 谁用 | 承运方/货代 | 货主/制造企业 |
| 对账对象 | 客户对账单 ↔ 系统运单 | 承运商账单 ↔ 合同价/运单 |
| 匹配键 | 运单号 → 箱号 | 账单号 → 运单号 → 费用代码 |
| 金额侧 | freight / amount / total_amount | contract_rate / contract_amount / rate |
| 展示字段 | 单号 / 箱号 | 账单号 / 运单号 |
| 不做的领域 | — | 不跑箱号/截港/地址规则；不装 aging/fees/cost/geo |

## 文件

```text
freight_audit/
  pack.json          # 元信息
  fields.json        # 审计行 10 个字段 + 承运商发票 15 个字段
  rules.json         # 必填 / 低置信 / 金额格式 / 合同价格式
  reconcile.json     # 账单号 → 运单号 → 费用代码；账单金额 vs 合同价
  acceptance.json    # 字段准确率 / 修正秒数 / 差异召回 / 误报率
```

`aging.json` / `fees.json` / `cost.json` / `geo.json` 未提供：这些领域在本包里不使用；
加载器会按空字典处理，不报错。

## 命令

```bash
cd ai-copilot
PACK_ID=freight_audit make pack-test-freight
PYTHONPATH=. .venv/bin/python scripts/pack_lint.py packs/freight_audit
PACK_ID=freight_audit make pack-snapshot
make pack-diff          # trucking -> freight_audit 的差异
```

`reconcile.json` 还包含 `line_hints` / `line_map`，让文本对账单 API
（`POST /api/reconcile` 的 `statement_text`）也能把“账单号/运单号/费用代码/账单金额”
映射到本包的匹配键。当前 `charge_code` 在文本层临时映射到 `remark`；
正式接入时应给 StatementDocument 增加独立 `charge_code` 字段。

## 边界

- 这是**可移植性证明**，不是产品交付；没有真实客户账单样本。
- 金额规则只校验格式，不替代合同/税率/币种口径；真实项目要客户确认。
- 不自动付款、不自动申诉；只出差异清单。
