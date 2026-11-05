import type { QuoteBundle } from './quote_docs';

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  sent: '已发送',
  accepted: '已接受',
  rejected: '已拒绝',
  expired: '已过期',
};

const KIND_LABEL: Record<string, string> = {
  one_time: '一次性',
  annual_ops: '年运维',
};

const DIFF_LABEL: Record<string, string> = {
  added: '新增',
  removed: '删除',
  changed: '变更',
  same: '未变',
};

const text = (value: unknown) => (value == null ? '' : String(value).trim());

const table = (headers: string[], rows: string[][]) =>
  [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');

/** 生成两个报价版本的 Markdown 对比稿，供 Word 导出复用。 */
export function renderQuoteCompare(
  before: QuoteBundle,
  after: QuoteBundle,
): { title: string; markdown: string; meta: { client: string; project: string; version: string } } {
  const q1 = before.quote;
  const q2 = after.quote;
  const title = `${q1.engagement_name} · 报价版本对比 v${q1.version} → v${q2.version}`;

  const fields: Array<[string, string, string]> = [
    ['状态', STATUS_LABEL[q1.status] ?? q1.status, STATUS_LABEL[q2.status] ?? q2.status],
    ['币种', text(q1.currency), text(q2.currency)],
    ['付款条款', text(q1.payment_terms), text(q2.payment_terms)],
    ['有效期', text(q1.valid_until), text(q2.valid_until)],
    ['备注', text(q1.notes), text(q2.notes)],
  ];
  const changedFields = fields.filter(([, a, b]) => a !== b);

  const beforeMap = new Map(
    before.items.map((item) => [
      `${item.kind}|${item.description}`,
      `${item.qty}|${item.unit_price}|${item.amount}|${item.solution_id ?? ''}`,
    ]),
  );
  const afterMap = new Map(
    after.items.map((item) => [
      `${item.kind}|${item.description}`,
      `${item.qty}|${item.unit_price}|${item.amount}|${item.solution_id ?? ''}`,
    ]),
  );
  const itemDiffs = Array.from(
    new Set([...beforeMap.keys(), ...afterMap.keys()]),
  ).map((key) => {
    const [kind, description] = key.split('|');
    const left = beforeMap.get(key);
    const right = afterMap.get(key);
    if (left === undefined) {
      return { kind, description, status: 'added', detail: right ?? '' };
    }
    if (right === undefined) {
      return { kind, description, status: 'removed', detail: left };
    }
    return {
      kind,
      description,
      status: left === right ? 'same' : 'changed',
      detail: right,
    };
  });

  const lines = [
    `# ${title}`,
    '',
    `> 客户：${q1.client_name} ｜ 项目：${q1.engagement_name} ｜ 币种：${text(q2.currency)}`,
    '',
    `- 一次性投入：${before.totals.oneTime} → ${after.totals.oneTime} 万元`,
    `- 年运维：${before.totals.annualOps} → ${after.totals.annualOps} 万元`,
    '',
    '## 一、报价头',
    '',
    changedFields.length
      ? table(
          ['字段', '基准', '对比'],
          changedFields.map(([label, a, b]) => [label, a || '—', b || '—']),
        )
      : '无变化。',
    '',
    '## 二、报价行',
    '',
  ];

  const changedItems = itemDiffs.filter((item) => item.status !== 'same');
  if (!changedItems.length) {
    lines.push('无变化。');
  } else {
    for (const item of changedItems) {
      lines.push(
        `- **${DIFF_LABEL[item.status] ?? item.status}**：${
          KIND_LABEL[item.kind] ?? item.kind
        } / ${item.description}${item.detail ? `（${item.detail}）` : ''}`,
      );
    }
  }

  lines.push('', '> 本对比稿用于报价版本沟通，正式报价以签署版本为准。');

  return {
    title,
    markdown: `${lines.join('\n')}\n`,
    meta: {
      client: q1.client_name,
      project: q1.engagement_name,
      version: `v${q1.version} → v${q2.version}`,
    },
  };
}
