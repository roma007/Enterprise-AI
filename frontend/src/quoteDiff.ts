import type { QuoteDetail, QuoteItem } from './types';

export interface QuoteFieldDiff {
  key: string;
  label: string;
  before: string;
  after: string;
  changed: boolean;
}

export interface QuoteItemDiff {
  key: string;
  kind: QuoteItem['kind'];
  description: string;
  status: 'added' | 'removed' | 'changed' | 'same';
  before: string;
  after: string;
}

export interface QuoteDiff {
  versionBefore: number;
  versionAfter: number;
  fields: QuoteFieldDiff[];
  items: QuoteItemDiff[];
  totalsBefore: { oneTime: number; annualOps: number };
  totalsAfter: { oneTime: number; annualOps: number };
  changedCount: number;
}

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  sent: '已发送',
  accepted: '已接受',
  rejected: '已拒绝',
  expired: '已过期',
};

const KIND_LABEL: Record<QuoteItem['kind'], string> = {
  one_time: '一次性',
  annual_ops: '年运维',
};

const DIFF_LABEL: Record<QuoteItemDiff['status'], string> = {
  added: '新增',
  removed: '删除',
  changed: '变更',
  same: '未变',
};

const text = (value: unknown) =>
  value == null ? '' : String(value).trim();

const itemKey = (item: QuoteItem) => `${item.kind}|${item.description.trim()}`;

const itemDetail = (item: QuoteItem) =>
  `数量 ${item.qty} / 单价 ${item.unit_price} / 金额 ${item.amount}`;

/** 比较两个报价版本；纯函数，便于组件单测。 */
export function diffQuotes(before: QuoteDetail, after: QuoteDetail): QuoteDiff {
  const q1 = before.item;
  const q2 = after.item;
  const fields: QuoteFieldDiff[] = [
    ['status', '状态', STATUS_LABEL[q1.status] ?? q1.status, STATUS_LABEL[q2.status] ?? q2.status],
    ['currency', '币种', text(q1.currency), text(q2.currency)],
    ['payment_terms', '付款条款', text(q1.payment_terms), text(q2.payment_terms)],
    ['valid_until', '有效期', text(q1.valid_until), text(q2.valid_until)],
    ['notes', '备注', text(q1.notes), text(q2.notes)],
  ].map(([key, label, a, b]) => ({
    key,
    label,
    before: a,
    after: b,
    changed: a !== b,
  }));

  const beforeMap = new Map(before.items.map((item) => [itemKey(item), item]));
  const afterMap = new Map(after.items.map((item) => [itemKey(item), item]));
  const items = Array.from(new Set([...beforeMap.keys(), ...afterMap.keys()]))
    .sort()
    .map((key) => {
      const left = beforeMap.get(key);
      const right = afterMap.get(key);
      const sample = right ?? left!;
      const status = !left
        ? 'added'
        : !right
          ? 'removed'
          : itemDetail(left) === itemDetail(right) &&
              (left.solution_id ?? '') === (right.solution_id ?? '')
            ? 'same'
            : 'changed';
      return {
        key,
        kind: sample.kind,
        description: sample.description,
        status,
        before: left ? itemDetail(left) : '',
        after: right ? itemDetail(right) : '',
      } satisfies QuoteItemDiff;
    });

  const totalsBefore = {
    oneTime: before.totals.oneTime,
    annualOps: before.totals.annualOps,
  };
  const totalsAfter = {
    oneTime: after.totals.oneTime,
    annualOps: after.totals.annualOps,
  };
  const changedCount =
    fields.filter((field) => field.changed).length +
    items.filter((item) => item.status !== 'same').length +
    (totalsBefore.oneTime !== totalsAfter.oneTime ? 1 : 0) +
    (totalsBefore.annualOps !== totalsAfter.annualOps ? 1 : 0);

  return {
    versionBefore: q1.version,
    versionAfter: q2.version,
    fields,
    items,
    totalsBefore,
    totalsAfter,
    changedCount,
  };
}

/** 报价版本对比 Markdown；报价本身是客户口径，不含内部成本。 */
export function quoteDiffMarkdown(diff: QuoteDiff): string {
  const lines = [
    `# 报价版本对比：v${diff.versionBefore} → v${diff.versionAfter}`,
    '',
    `- 变化点：${diff.changedCount}`,
    `- 一次性投入：${diff.totalsBefore.oneTime} → ${diff.totalsAfter.oneTime} 万元`,
    `- 年运维：${diff.totalsBefore.annualOps} → ${diff.totalsAfter.annualOps} 万元`,
    '',
    '## 报价头',
    '',
    '| 字段 | 基准 | 对比 |',
    '|---|---|---|',
  ];
  const changedFields = diff.fields.filter((field) => field.changed);
  if (!changedFields.length) lines.push('| — | 无变化 | — |');
  for (const field of changedFields) {
    lines.push(`| ${field.label} | ${field.before || '—'} | ${field.after || '—'} |`);
  }
  lines.push('', '## 报价行', '');
  const changedItems = diff.items.filter((item) => item.status !== 'same');
  if (!changedItems.length) {
    lines.push('- 无变化');
  } else {
    for (const item of changedItems) {
      lines.push(
        `- ${DIFF_LABEL[item.status]}：${KIND_LABEL[item.kind]} / ${item.description}${
          item.after ? `（${item.after}）` : item.before ? `（${item.before}）` : ''
        }`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

/** 报价版本对比 CSV，含 BOM 便于 Excel 直接打开。 */
export function quoteDiffCsv(diff: QuoteDiff): string {
  const cell = (value: unknown) => {
    let text = value == null ? '' : String(value);
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const lines = [['类型', '名称', '变化', '基准', '对比'].map(cell).join(',')];
  for (const field of diff.fields.filter((item) => item.changed)) {
    lines.push(
      [cell('报价头'), cell(field.label), cell('变更'), cell(field.before), cell(field.after)].join(','),
    );
  }
  for (const item of diff.items.filter((entry) => entry.status !== 'same')) {
    lines.push(
      [
        cell('报价行'),
        cell(`${KIND_LABEL[item.kind]} / ${item.description}`),
        cell(DIFF_LABEL[item.status]),
        cell(item.before),
        cell(item.after),
      ].join(','),
    );
  }
  if (diff.totalsBefore.oneTime !== diff.totalsAfter.oneTime) {
    lines.push(
      [
        cell('合计'),
        cell('一次性投入'),
        cell('变更'),
        cell(diff.totalsBefore.oneTime),
        cell(diff.totalsAfter.oneTime),
      ].join(','),
    );
  }
  if (diff.totalsBefore.annualOps !== diff.totalsAfter.annualOps) {
    lines.push(
      [
        cell('合计'),
        cell('年运维'),
        cell('变更'),
        cell(diff.totalsBefore.annualOps),
        cell(diff.totalsAfter.annualOps),
      ].join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}`;
}
