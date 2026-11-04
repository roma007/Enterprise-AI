# 试点一 · API 与 Schema 草图

> 目标：D4 前先把接口和数据形状定下来，避免抽取、规则、前端各写一套。
> 原则：**规则算金额和差异，大模型只做解释；所有结果可人工复核。**
> 鉴权：除登录/健康检查外，以下接口需携带 `sid` 会话 cookie。

## 1. 接口总览

| 方法 | 路径 | 用途 | 复用/新增 |
|---|---|---|---|
| POST | `/api/statement/extract` | 对账单文本/CSV → 结构化 | 新增 |
| POST | `/api/statement/extract/file` | 对账单 txt/csv/pdf/图片 → 结构化 | 新增 |
| POST | `/api/settlement/extract` | 结算单文本/CSV → 结构化 | 新增 |
| POST | `/api/settlement/extract/file` | 结算单 txt/csv/pdf/图片 → 结构化 | 新增 |
| POST | `/api/reconcile` | 对账单 vs 运单 → 差异 | 已有，扩展 `explain` |
| POST | `/api/settlement` | 结算单 vs 合同价 → 差异 | 已有，扩展 `explain` |
| POST | `/api/invoice/extract` | 发票抽取 | 已有 |
| POST | `/api/threeway/match` | 订单/运单/发票三单匹配 | 已有 |

## 2. 通用响应

```json
{
  "ok": true,
  "data": {},
  "warnings": [],
  "meta": {
    "engine": "ocr+llm+rules",
    "elapsed_ms": 1832,
    "document_id": "stmt-001",
    "needs_review": false
  }
}
```

- `warnings`：低置信字段、格式回退、未识别页
- `needs_review`：有低置信或金额校验不通过时为 `true`
- 所有金额单位：元，保留两位小数

## 3. 对账单抽取

### 请求

`multipart/form-data`

```text
file: statement.pdf          # txt/csv/tsv/pdf/jpg/png
source_format: pdf_scan       # 可选；不传按扩展名推断
document_id: stmt-001         # 可选；不传用文件名
```

PDF 优先取文本层，取不到再走 OCR；OCR 不可用返回 503。

或 JSON：

```json
{
  "text": "客户对账单原文……",
  "source_format": "text",
  "document_id": "stmt-001"
}
```

### 响应

```json
{
  "ok": true,
  "data": {
    "document_id": "stmt-001",
    "statement_no": "ST-2026-09-001",
    "customer_name": "宁波宏运集卡运输有限公司",
    "period_start": "2026-09-01",
    "period_end": "2026-09-30",
    "currency": "CNY",
    "total_amount": 5434.00,
    "source_format": "pdf_scan",
    "page_count": 2,
    "lines": [
      {
        "line_no": 1,
        "waybill_no": "HY20260901001",
        "container_no": "MSCU1234567",
        "container_type": "40HQ",
        "amount": 2600.00,
        "tax_amount": 234.00,
        "total_amount": 2834.00,
        "due_date": "2026-10-15",
        "confidence": 0.95,
        "source_page": 1
      }
    ]
  },
  "warnings": ["第 2 页右下角有手写备注，未纳入结构化"],
  "meta": { "engine": "ocr+llm+rules", "elapsed_ms": 1832, "needs_review": false }
}
```

## 4. 结算单抽取

请求同上，路径 `/api/settlement/extract`。

响应：

```json
{
  "ok": true,
  "data": {
    "document_id": "set-001",
    "settlement_no": "JS-2026-09-001",
    "carrier_name": "宁波顺达车队",
    "period_start": "2026-09-01",
    "period_end": "2026-09-30",
    "currency": "CNY",
    "total_amount": 8600.00,
    "source_format": "excel",
    "page_count": 1,
    "lines": [
      {
        "line_no": 1,
        "trip_no": "T001",
        "waybill_no": "HY20260901001",
        "plate_no": "浙B12345",
        "route": "宁波-上海",
        "container_type": "40HQ",
        "quantity": 1,
        "unit_price": 5600.00,
        "amount": 5600.00,
        "deduction": 0.00,
        "confidence": 0.98
      }
    ]
  },
  "warnings": [],
  "meta": { "needs_review": false }
}
```

## 5. 对账差异 + 解释

在现有 `POST /api/reconcile` 上扩展：

```json
{
  "statement": { "...": "对账单对象" },
  "waybills": [
    { "waybill_no": "HY20260901001", "amount": 2600.00, "customer_name": "宁波宏运集卡运输有限公司" }
  ],
  "explain": true
}
```

响应：

```json
{
  "ok": true,
  "data": {
    "differences": [
      {
        "difference_id": "diff-001",
        "document_id": "stmt-001",
        "type": "amount_mismatch",
        "waybill_no": "HY20260901001",
        "statement_amount": 2834.00,
        "system_amount": 2600.00,
        "delta": 234.00,
        "evidence": ["对账单第 2 行", "运单应收 2600", "税率 9%"],
        "possible_causes": ["对账单含税额，运单未含税"],
        "suggested_action": "核对合同税率与报价口径",
        "confidence": 0.80,
        "source": "llm+rule"
      }
    ],
    "summary": {
      "gold_lines": 3,
      "matched": 3,
      "differences": 1,
      "total_delta": 234.00
    }
  },
  "meta": { "needs_review": true }
}
```

- `explain=false` 时只返回规则差异，不调用大模型
- `explain=true` 时大模型只基于 `evidence` 生成 `possible_causes` / `suggested_action`
- 大模型失败自动回退规则模板，`source` 标为 `rule`

## 6. 结算差异 + 解释

同样在 `POST /api/settlement` 上扩展 `explain`：

```json
{
  "settlement": { "...": "结算单对象" },
  "contract_prices": [
    { "carrier_name": "宁波顺达车队", "route": "宁波-上海", "container_type": "40HQ", "unit_price": 5600.00 }
  ],
  "explain": true
}
```

差异类型：`unit_price_mismatch`、`quantity_mismatch`、`deduction_mismatch`、`missing_line`、`extra_line`、`no_rate`。

## 7. 错误码

| HTTP | error | 说明 |
|---|---|---|
| 400 | `EMPTY_INPUT` | 没有文件/文本 |
| 415 | `UNSUPPORTED_FORMAT` | 不支持的文件类型 |
| 422 | `PARSE_FAILED` | 无法解析表头/明细 |
| 422 | `TOTAL_MISMATCH` | 明细合计与表头合计差异过大 |
| 422 | `NO_WAYBILLS` | 没有可比对的运单 |
| 503 | `LLM_UNAVAILABLE` | 解释模型不可用；可回退规则 |

## 8. Schema

完整 JSON Schema：

[`schemas/pilot.schema.json`](./schemas/pilot.schema.json)

包含：

- `StatementDocument` / `StatementLine`
- `SettlementDocument` / `SettlementLine`
- `Difference`

扩展原则：

- 客户模板有额外列 → 在对象上加字段，不改已有字段含义
- 金额字段统一 `number`，不要用字符串
- 日期统一 `YYYY-MM-DD`
- 置信度统一 0–1
- 不确定的字段填 `null`，不要猜

## 9. 实现建议

1. 复用 `app/invoice.py` 的 OCR + LLM + 规则管线，只换 schema
2. 复用 `app/reconcile.py`、`app/settlement.py` 的规则，新增 `explain`
3. 解释模块用 `app/llm.py`，加超时、重试、脱敏、失败回退
4. 所有接口返回 `warnings` / `needs_review`，前端必须显式提示
5. 不做自动付款/记账/开票；复核后才允许导出/入账
