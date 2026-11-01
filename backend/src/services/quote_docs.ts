import { fmtLocalDateTime } from './time';
import { one, query } from '../db';

export interface QuoteBundle {
  quote: any;
  items: any[];
  totals: { oneTime: number; annualOps: number };
}

const KIND_LABEL: Record<string, string> = {
  one_time: '一次性',
  annual_ops: '年运维',
};

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  sent: '已发送',
  accepted: '已接受',
  rejected: '已拒绝',
  expired: '已过期',
};

export async function loadQuoteBundle(
  quoteId: string,
  orgId?: string,
): Promise<QuoteBundle | null> {
  const quote = await one<any>(
    `SELECT q.*, e.name AS engagement_name, c.name AS client_name
       FROM quotes q
       JOIN engagements e ON e.id = q.engagement_id
       JOIN clients c ON c.id = e.client_id
      WHERE q.id = $1
        AND e.deleted_at IS NULL AND c.deleted_at IS NULL
        ${orgId ? 'AND e.org_id = $2' : ''}`,
    orgId ? [quoteId, orgId] : [quoteId],
  );
  if (!quote) return null;

  const items = await query(
    `SELECT qi.*, s.version AS solution_version, o.code AS opportunity_code,
            o.title AS opportunity_title
       FROM quote_items qi
       LEFT JOIN solutions s ON s.id = qi.solution_id
       LEFT JOIN opportunities o ON o.id = s.opportunity_id
      WHERE qi.quote_id = $1
      ORDER BY qi.sort_order, qi.created_at`,
    [quoteId],
  );

  const oneTime = items
    .filter((i: any) => i.kind === 'one_time')
    .reduce((a: number, i: any) => a + Number(i.amount ?? 0), 0);
  const annualOps = items
    .filter((i: any) => i.kind === 'annual_ops')
    .reduce((a: number, i: any) => a + Number(i.amount ?? 0), 0);

  return {
    quote,
    items,
    totals: {
      oneTime: Number(oneTime.toFixed(2)),
      annualOps: Number(annualOps.toFixed(2)),
    },
  };
}

export function renderQuoteDoc(bundle: QuoteBundle): {
  title: string;
  markdown: string;
  meta: { client: string; project: string; version: string };
} {
  const q = bundle.quote;
  const title = `${q.engagement_name} · 报价单 v${q.version}`;
  const meta = {
    client: q.client_name,
    project: q.engagement_name,
    version: `v${q.version}`,
  };

  const rows = bundle.items.map((i: any) => [
    KIND_LABEL[i.kind] ?? i.kind,
    i.opportunity_code
      ? `${i.opportunity_code}${i.solution_version ? ` v${i.solution_version}` : ''}`
      : '—',
    i.description,
    String(i.qty),
    String(i.unit_price),
    String(i.amount),
  ]);

  return {
    title,
    meta,
    markdown: [
      `# ${q.client_name} · 报价单 v${q.version}`,
      '',
      `> 项目：${q.engagement_name}　｜　币种：${q.currency}　｜　状态：${STATUS_LABEL[q.status] ?? q.status}`,
      `> 有效期：${q.valid_until ?? '—'}　｜　生成时间：${fmtLocalDateTime()}`,
      '',
      '## 1. 报价汇总',
      '',
      '| 类型 | 金额（万元） |',
      '|---|---|',
      `| 一次性投入 | ${bundle.totals.oneTime} |`,
      `| 年运维 | ${bundle.totals.annualOps} |`,
      '',
      '## 2. 报价明细',
      '',
      rows.length
        ? [
            '| 类型 | 方案 | 说明 | 数量 | 单价（万元） | 金额（万元） |',
            '|---|---|---|---|---|---|',
            ...rows.map((r) => `| ${r.join(' | ')} |`),
          ].join('\n')
        : '暂无报价行。',
      '',
      '## 3. 付款条款',
      '',
      q.payment_terms?.trim() || '待确认。',
      '',
      '## 4. 备注',
      '',
      q.notes?.trim() || '—',
      '',
      '> 本报价单为方案阶段测算，最终以合同为准。',
    ].join('\n'),
  };
}
