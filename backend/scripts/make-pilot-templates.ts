/**
 * 生成试点一（对账单/结算单抽取）的数据需求与金标标注 Excel 模板。
 *
 * 运行：npx tsx scripts/make-pilot-templates.ts
 * 输出：../会客包/试点一/01_数据需求清单.xlsx
 *       ../会客包/试点一/02_金标标注模板.xlsx
 */
import ExcelJS from 'exceljs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const OUT_DIR = join(process.cwd(), '..', '会客包', '试点一');

type Col = { header: string; key: string; width: number };
type Row = Record<string, string | number | null>;

function addSheet(
  wb: ExcelJS.Workbook,
  name: string,
  columns: Col[],
  rows: Row[] = [],
  note?: string,
) {
  const ws = wb.addWorksheet(name, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
  header.alignment = { vertical: 'middle', wrapText: true };
  header.height = 28;
  for (const row of rows) ws.addRow(row);
  ws.eachRow((row, index) => {
    if (index === 1) return;
    row.alignment = { vertical: 'top', wrapText: true };
  });
  if (note) {
    const last = ws.rowCount + 2;
    ws.getCell(`A${last}`).value = note;
    ws.getCell(`A${last}`).font = { italic: true, color: { argb: 'FF666666' } };
  }
  return ws;
}

async function makeRequestWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AI 交付云';
  wb.created = new Date();

  addSheet(wb, '说明', [
    { header: '项目', key: 'k', width: 18 },
    { header: '内容', key: 'v', width: 100 },
  ], [
    { k: '用途', v: '试点一：对账单/结算单抽取与差异解释。请客户按本文件提供数据与基线。' },
    { k: '期间', v: '建议近 6 个月；至少覆盖 3 个客户/车队。' },
    { k: '格式', v: 'PDF 扫描件、手机照片、Excel/CSV、粘贴文本均可；请保留原始文件。' },
    { k: '数量', v: '对账单 ≥ 30 份；结算单 ≥ 30 份；其中各 ≥ 10 份做人工金标。' },
    { k: '隐私', v: '可先脱敏客户名、金额、车牌；优先客户内网或我方沙箱。' },
    { k: '原则', v: '不自动付款、不自动记账、不自动开票；只做抽取、比对、解释，人工确认。' },
    { k: '对账单表头', v: '一行一份对账单；document_id 由试点统一编号，如 stmt-001。' },
    { k: '对账单明细', v: '一行一条明细；金额单位元，保留两位小数。' },
    { k: '结算单表头', v: '一行一份结算单；document_id 如 set-001。' },
    { k: '结算单明细', v: '一行一条明细；amount 为应付金额，deduction 为扣款/罚款。' },
    { k: '运单与合同价', v: '用于对账与结算比对；没有的列可留空，但 waybill_no 必填。' },
  ]);

  addSheet(wb, '数据需求清单', [
    { header: '编号', key: 'no', width: 8 },
    { header: '数据项', key: 'item', width: 24 },
    { header: '格式', key: 'format', width: 20 },
    { header: '期间', key: 'period', width: 16 },
    { header: '是否必需', key: 'required', width: 12 },
    { header: '负责人', key: 'owner', width: 14 },
    { header: '数量/说明', key: 'note', width: 60 },
  ], [
    { no: 1, item: '客户对账单（扫描/PDF）', format: 'PDF / JPG / PNG', period: '近 6 个月', required: '必需', owner: '财务', note: '≥ 30 份；含多页、盖章、手写、扣款等难点' },
    { no: 2, item: '客户对账单（Excel）', format: 'XLSX / CSV', period: '近 6 个月', required: '必需', owner: '财务', note: '如有；用于验证结构化输入' },
    { no: 3, item: '外协/车队结算单（扫描/PDF）', format: 'PDF / JPG / PNG', period: '近 6 个月', required: '必需', owner: '财务/车队', note: '≥ 30 份；含扣款、罚款、不同线路' },
    { no: 4, item: '外协/车队结算单（Excel）', format: 'XLSX / CSV', period: '近 6 个月', required: '必需', owner: '财务/车队', note: '如有' },
    { no: 5, item: '运单清单', format: 'XLSX / CSV / API', period: '近 6 个月', required: '必需', owner: '调度/TMS', note: '运单号、客户、金额、日期、车牌、箱号、线路' },
    { no: 6, item: '合同价表', format: 'XLSX / CSV', period: '当前有效', required: '必需', owner: '商务/财务', note: '车队、线路、箱型、单价、有效期' },
    { no: 7, item: '客户/车队主数据', format: 'XLSX / CSV', period: '当前', required: '建议', owner: '财务', note: '名称、税号、账期、联系人' },
    { no: 8, item: '历史差异记录', format: 'Excel / 邮件', period: '近 6 个月', required: '建议', owner: '财务', note: '已发生差异、原因、处理结果' },
    { no: 9, item: '人工耗时基线', format: '访谈 / 本表', period: '当前', required: '必需', owner: '财务', note: '单张耗时、月工时、错误率' },
    { no: 10, item: '脱敏与环境说明', format: '说明', period: '—', required: '必需', owner: 'IT/法务', note: '数据能否出内网、可用沙箱/内网环境' },
  ]);

  addSheet(wb, '对账单表头', [
    { header: 'document_id', key: 'document_id', width: 16 },
    { header: 'statement_no', key: 'statement_no', width: 20 },
    { header: 'customer_name', key: 'customer_name', width: 32 },
    { header: 'period_start', key: 'period_start', width: 14 },
    { header: 'period_end', key: 'period_end', width: 14 },
    { header: 'currency', key: 'currency', width: 10 },
    { header: 'total_amount', key: 'total_amount', width: 14 },
    { header: 'source_format', key: 'source_format', width: 16 },
    { header: 'page_count', key: 'page_count', width: 10 },
    { header: '备注', key: 'remark', width: 40 },
  ]);

  addSheet(wb, '对账单明细', [
    { header: 'document_id', key: 'document_id', width: 16 },
    { header: 'line_no', key: 'line_no', width: 8 },
    { header: 'waybill_no', key: 'waybill_no', width: 22 },
    { header: 'container_no', key: 'container_no', width: 16 },
    { header: 'container_type', key: 'container_type', width: 10 },
    { header: 'amount', key: 'amount', width: 12 },
    { header: 'tax_amount', key: 'tax_amount', width: 12 },
    { header: 'total_amount', key: 'total_amount', width: 12 },
    { header: 'due_date', key: 'due_date', width: 14 },
    { header: 'remark', key: 'remark', width: 40 },
  ]);

  addSheet(wb, '结算单表头', [
    { header: 'document_id', key: 'document_id', width: 16 },
    { header: 'settlement_no', key: 'settlement_no', width: 20 },
    { header: 'carrier_name', key: 'carrier_name', width: 32 },
    { header: 'period_start', key: 'period_start', width: 14 },
    { header: 'period_end', key: 'period_end', width: 14 },
    { header: 'currency', key: 'currency', width: 10 },
    { header: 'total_amount', key: 'total_amount', width: 14 },
    { header: 'source_format', key: 'source_format', width: 16 },
    { header: 'page_count', key: 'page_count', width: 10 },
    { header: '备注', key: 'remark', width: 40 },
  ]);

  addSheet(wb, '结算单明细', [
    { header: 'document_id', key: 'document_id', width: 16 },
    { header: 'line_no', key: 'line_no', width: 8 },
    { header: 'trip_no', key: 'trip_no', width: 18 },
    { header: 'waybill_no', key: 'waybill_no', width: 22 },
    { header: 'plate_no', key: 'plate_no', width: 14 },
    { header: 'route', key: 'route', width: 20 },
    { header: 'container_type', key: 'container_type', width: 10 },
    { header: 'quantity', key: 'quantity', width: 8 },
    { header: 'unit_price', key: 'unit_price', width: 12 },
    { header: 'amount', key: 'amount', width: 12 },
    { header: 'deduction', key: 'deduction', width: 12 },
    { header: 'remark', key: 'remark', width: 36 },
  ]);

  addSheet(wb, '运单与合同价', [
    { header: 'waybill_no', key: 'waybill_no', width: 22 },
    { header: 'customer_name', key: 'customer_name', width: 30 },
    { header: 'carrier_name', key: 'carrier_name', width: 24 },
    { header: 'plate_no', key: 'plate_no', width: 14 },
    { header: 'route', key: 'route', width: 20 },
    { header: 'container_type', key: 'container_type', width: 10 },
    { header: 'revenue_amount', key: 'revenue_amount', width: 14 },
    { header: 'cost_amount', key: 'cost_amount', width: 14 },
    { header: 'contract_unit_price', key: 'contract_unit_price', width: 16 },
    { header: 'trip_date', key: 'trip_date', width: 14 },
    { header: '备注', key: 'remark', width: 36 },
  ]);

  addSheet(wb, '人工基线', [
    { header: '指标', key: 'metric', width: 32 },
    { header: '当前值', key: 'value', width: 14 },
    { header: '单位', key: 'unit', width: 12 },
    { header: '备注', key: 'note', width: 50 },
  ], [
    { metric: '单张对账单人工耗时', value: '', unit: '分钟', note: '含录入 + 找差异' },
    { metric: '单张结算单人工耗时', value: '', unit: '分钟', note: '含录入 + 核对合同价' },
    { metric: '月对账工时', value: '', unit: '人天', note: '按实际团队统计' },
    { metric: '差异复核工时', value: '', unit: '人天/月', note: '' },
    { metric: '对账错误率', value: '', unit: '%', note: '抽检或财务估计' },
    { metric: '差异漏报率', value: '', unit: '%', note: '抽检或财务估计' },
    { metric: '月对账单数量', value: '', unit: '份', note: '' },
    { metric: '月结算单数量', value: '', unit: '份', note: '' },
  ]);

  addSheet(wb, '数据检查清单', [
    { header: '检查项', key: 'item', width: 56 },
    { header: '是否满足', key: 'ok', width: 12 },
    { header: '负责人', key: 'owner', width: 14 },
    { header: '备注', key: 'note', width: 40 },
  ], [
    { item: '能导出近 3–6 个月对账单/结算单', ok: '', owner: '', note: '' },
    { item: '能提供对应运单/合同价数据', ok: '', owner: '', note: '' },
    { item: '有财务/单证 owner 确认口径', ok: '', owner: '', note: '' },
    { item: '能提供 ≥10 份人工金标', ok: '', owner: '', note: '' },
    { item: '允许脱敏后在沙箱处理，或提供内网环境', ok: '', owner: '', note: '' },
    { item: '明确哪些字段不能出内网', ok: '', owner: '', note: '' },
    { item: '能提供当前人工耗时/错误率基线', ok: '', owner: '', note: '' },
    { item: '能安排 D9/D10 评测与验收', ok: '', owner: '', note: '' },
    { item: '确认不自动付款/记账，只做辅助', ok: '', owner: '', note: '' },
    { item: '确认失败回退到人工流程', ok: '', owner: '', note: '' },
  ]);

  await wb.xlsx.writeFile(join(OUT_DIR, '01_数据需求清单.xlsx'));
}

async function makeGoldWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AI 交付云';
  wb.created = new Date();

  addSheet(wb, '说明', [
    { header: '项目', key: 'k', width: 18 },
    { header: '内容', key: 'v', width: 100 },
  ], [
    { k: '用途', v: '人工金标：逐字段标注真实对账单/结算单，用于评测抽取准确率与差异识别。' },
    { k: '方法', v: '每份文件一行表头 + N 行明细；金额照原文抄录，不做“修正”。' },
    { k: '单位', v: '金额：元，两位小数；日期：YYYY-MM-DD；箱号/运单号保持原文大写。' },
    { k: '差异', v: '只记录“核对后确认”的差异；不确定的写 remark，不要猜。' },
    { k: '示例', v: '见“示例_对账单 / 示例_结算单 / 示例_差异”；正式标注请删除示例。' },
    { k: '隐私', v: '客户名/金额/车牌可脱敏，但同一份文件内保持一致。' },
    { k: 'statement_gold', v: '一行一份对账单表头；document_id 如 stmt-001。' },
    { k: 'statement_lines_gold', v: '一行一条明细；金额单位元，两位小数。' },
    { k: 'settlement_gold', v: '一行一份结算单表头；document_id 如 set-001。' },
    { k: 'settlement_lines_gold', v: '一行一条明细；amount 为应付金额，deduction 为扣款。' },
    { k: 'differences_gold', v: 'type 取值：amount_mismatch / missing_line / extra_line / duplicate / tax_mismatch / unit_price_mismatch / quantity_mismatch / period_mismatch / customer_mismatch / rounding。' },
    { k: 'explanation_review', v: 'D9 评测：每条解释由财务打 1–5 分，并标记是否采纳。' },
  ]);

  addSheet(wb, 'statement_gold', [
    { header: 'document_id', key: 'document_id', width: 16 },
    { header: 'statement_no', key: 'statement_no', width: 20 },
    { header: 'customer_name', key: 'customer_name', width: 32 },
    { header: 'period_start', key: 'period_start', width: 14 },
    { header: 'period_end', key: 'period_end', width: 14 },
    { header: 'currency', key: 'currency', width: 10 },
    { header: 'total_amount', key: 'total_amount', width: 14 },
    { header: 'source_format', key: 'source_format', width: 16 },
    { header: 'page_count', key: 'page_count', width: 10 },
    { header: '备注', key: 'remark', width: 40 },
  ]);

  addSheet(wb, 'statement_lines_gold', [
    { header: 'document_id', key: 'document_id', width: 16 },
    { header: 'line_no', key: 'line_no', width: 8 },
    { header: 'waybill_no', key: 'waybill_no', width: 22 },
    { header: 'container_no', key: 'container_no', width: 16 },
    { header: 'container_type', key: 'container_type', width: 10 },
    { header: 'amount', key: 'amount', width: 12 },
    { header: 'tax_amount', key: 'tax_amount', width: 12 },
    { header: 'total_amount', key: 'total_amount', width: 12 },
    { header: 'due_date', key: 'due_date', width: 14 },
    { header: 'remark', key: 'remark', width: 40 },
  ]);

  addSheet(wb, 'settlement_gold', [
    { header: 'document_id', key: 'document_id', width: 16 },
    { header: 'settlement_no', key: 'settlement_no', width: 20 },
    { header: 'carrier_name', key: 'carrier_name', width: 32 },
    { header: 'period_start', key: 'period_start', width: 14 },
    { header: 'period_end', key: 'period_end', width: 14 },
    { header: 'currency', key: 'currency', width: 10 },
    { header: 'total_amount', key: 'total_amount', width: 14 },
    { header: 'source_format', key: 'source_format', width: 16 },
    { header: 'page_count', key: 'page_count', width: 10 },
    { header: '备注', key: 'remark', width: 40 },
  ]);

  addSheet(wb, 'settlement_lines_gold', [
    { header: 'document_id', key: 'document_id', width: 16 },
    { header: 'line_no', key: 'line_no', width: 8 },
    { header: 'trip_no', key: 'trip_no', width: 18 },
    { header: 'waybill_no', key: 'waybill_no', width: 22 },
    { header: 'plate_no', key: 'plate_no', width: 14 },
    { header: 'route', key: 'route', width: 20 },
    { header: 'container_type', key: 'container_type', width: 10 },
    { header: 'quantity', key: 'quantity', width: 8 },
    { header: 'unit_price', key: 'unit_price', width: 12 },
    { header: 'amount', key: 'amount', width: 12 },
    { header: 'deduction', key: 'deduction', width: 12 },
    { header: 'remark', key: 'remark', width: 36 },
  ]);

  addSheet(wb, 'differences_gold', [
    { header: 'difference_id', key: 'difference_id', width: 16 },
    { header: 'document_id', key: 'document_id', width: 16 },
    { header: 'type', key: 'type', width: 20 },
    { header: 'waybill_no', key: 'waybill_no', width: 22 },
    { header: 'statement_amount', key: 'statement_amount', width: 16 },
    { header: 'system_amount', key: 'system_amount', width: 16 },
    { header: 'delta', key: 'delta', width: 12 },
    { header: 'evidence', key: 'evidence', width: 40 },
    { header: 'possible_causes', key: 'possible_causes', width: 40 },
    { header: 'suggested_action', key: 'suggested_action', width: 40 },
    { header: 'confidence', key: 'confidence', width: 10 },
    { header: 'source', key: 'source', width: 12 },
  ]);

  addSheet(wb, 'explanation_review', [
    { header: 'difference_id', key: 'difference_id', width: 16 },
    { header: 'reviewer', key: 'reviewer', width: 16 },
    { header: 'rating_1_5', key: 'rating', width: 10 },
    { header: 'adopted', key: 'adopted', width: 10 },
    { header: 'comment', key: 'comment', width: 60 },
  ]);

  addSheet(wb, '示例_对账单', [
    { header: 'document_id', key: 'document_id', width: 16 },
    { header: 'statement_no', key: 'statement_no', width: 20 },
    { header: 'customer_name', key: 'customer_name', width: 32 },
    { header: 'period_start', key: 'period_start', width: 14 },
    { header: 'period_end', key: 'period_end', width: 14 },
    { header: 'currency', key: 'currency', width: 10 },
    { header: 'total_amount', key: 'total_amount', width: 14 },
    { header: 'source_format', key: 'source_format', width: 16 },
    { header: 'page_count', key: 'page_count', width: 10 },
    { header: '备注', key: 'remark', width: 40 },
  ], [
    { document_id: 'stmt-demo-001', statement_no: 'ST-2026-09-001', customer_name: '宁波宏运集卡运输有限公司', period_start: '2026-09-01', period_end: '2026-09-30', currency: 'CNY', total_amount: 5434.00, source_format: 'pdf_scan', page_count: 2, 备注: '示例，正式标注请删除' },
  ]);

  addSheet(wb, '示例_结算单', [
    { header: 'document_id', key: 'document_id', width: 16 },
    { header: 'settlement_no', key: 'settlement_no', width: 20 },
    { header: 'carrier_name', key: 'carrier_name', width: 32 },
    { header: 'period_start', key: 'period_start', width: 14 },
    { header: 'period_end', key: 'period_end', width: 14 },
    { header: 'currency', key: 'currency', width: 10 },
    { header: 'total_amount', key: 'total_amount', width: 14 },
    { header: 'source_format', key: 'source_format', width: 16 },
    { header: 'page_count', key: 'page_count', width: 10 },
    { header: '备注', key: 'remark', width: 40 },
  ], [
    { document_id: 'set-demo-001', settlement_no: 'JS-2026-09-001', carrier_name: '宁波顺达车队', period_start: '2026-09-01', period_end: '2026-09-30', currency: 'CNY', total_amount: 8600.00, source_format: 'excel', page_count: 1, 备注: '示例，正式标注请删除' },
  ]);

  addSheet(wb, '示例_差异', [
    { header: 'difference_id', key: 'difference_id', width: 16 },
    { header: 'document_id', key: 'document_id', width: 16 },
    { header: 'type', key: 'type', width: 20 },
    { header: 'waybill_no', key: 'waybill_no', width: 22 },
    { header: 'statement_amount', key: 'statement_amount', width: 16 },
    { header: 'system_amount', key: 'system_amount', width: 16 },
    { header: 'delta', key: 'delta', width: 12 },
    { header: 'evidence', key: 'evidence', width: 40 },
    { header: 'possible_causes', key: 'possible_causes', width: 40 },
    { header: 'suggested_action', key: 'suggested_action', width: 40 },
    { header: 'confidence', key: 'confidence', width: 10 },
    { header: 'source', key: 'source', width: 12 },
  ], [
    { difference_id: 'diff-demo-001', document_id: 'stmt-demo-001', type: 'amount_mismatch', waybill_no: 'HY20260901001', statement_amount: 2834.00, system_amount: 2600.00, delta: 234.00, evidence: '对账单第 2 行；运单应收 2600；税率 9%', possible_causes: '对账单含税额，运单未含税', suggested_action: '核对合同税率与报价口径', confidence: 0.8, source: 'llm+rule' },
  ]);

  await wb.xlsx.writeFile(join(OUT_DIR, '02_金标标注模板.xlsx'));
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await makeRequestWorkbook();
  await makeGoldWorkbook();
  console.log(`模板已生成：${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
