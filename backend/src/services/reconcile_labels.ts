/** 对账差异类型的中文名称；接口、导出与报告共用。 */
export const DIFF_LABEL: Record<string, string> = {
  amount_mismatch: '金额不符',
  missing_line: '对账单缺行',
  extra_line: '对账单多行',
  duplicate: '重复',
  tax_mismatch: '税额不符',
  unit_price_mismatch: '单价不符',
  quantity_mismatch: '数量不符',
  period_mismatch: '账期不符',
  customer_mismatch: '主体不符',
  rounding: '舍入',
  no_rate: '无合同价',
};

export const DIFF_SOURCE_LABEL: Record<string, string> = {
  'llm+rule': '模型 + 规则',
  rule: '规则',
  llm: '模型',
};
