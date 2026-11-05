import { describe, expect, it } from 'vitest';
import type { QuoteDetail } from './types';
import { diffQuotes, quoteDiffCsv, quoteDiffMarkdown } from './quoteDiff';

const base = (version: number): QuoteDetail =>
  ({
    item: {
      id: `quote-${version}`,
      engagement_id: 'eng-1',
      version,
      currency: 'CNY',
      payment_terms: '3:4:3',
      valid_until: '2026-12-31',
      status: 'draft',
      notes: '方案阶段报价',
      created_at: '2026-11-05T00:00:00.000Z',
    },
    items: [
      {
        id: 'item-1',
        quote_id: `quote-${version}`,
        solution_id: 'sol-1',
        kind: 'one_time',
        description: '一期实施',
        qty: 1,
        unit_price: 50,
        amount: 50,
        sort_order: 1,
      },
      {
        id: 'item-2',
        quote_id: `quote-${version}`,
        solution_id: null,
        kind: 'annual_ops',
        description: '年运维',
        qty: 1,
        unit_price: 8,
        amount: 8,
        sort_order: 2,
      },
    ],
    totals: { oneTime: 50, annualOps: 8 },
  }) as QuoteDetail;

describe('diffQuotes', () => {
  it('相同版本没有变化', () => {
    const diff = diffQuotes(base(1), base(1));
    expect(diff.changedCount).toBe(0);
    expect(diff.fields.every((field) => !field.changed)).toBe(true);
    expect(diff.items.every((item) => item.status === 'same')).toBe(true);
  });

  it('识别报价头、报价行与合计变化', () => {
    const before = base(1);
    const after = base(2);
    after.item.status = 'sent';
    after.item.payment_terms = '5:5';
    after.items[0].unit_price = 45;
    after.items[0].amount = 45;
    after.items.push({
      id: 'item-3',
      quote_id: 'quote-2',
      solution_id: null,
      kind: 'one_time',
      description: '数据治理',
      qty: 1,
      unit_price: 5,
      amount: 5,
      sort_order: 3,
    });
    after.totals = { oneTime: 50, annualOps: 8 };

    const diff = diffQuotes(before, after);
    expect(diff.fields.find((field) => field.key === 'status')?.changed).toBe(true);
    expect(diff.fields.find((field) => field.key === 'payment_terms')?.changed).toBe(true);
    expect(diff.items.find((item) => item.description === '一期实施')?.status).toBe('changed');
    expect(diff.items.find((item) => item.description === '数据治理')?.status).toBe('added');
    expect(diff.totalsBefore.oneTime).toBe(50);
    expect(diff.totalsAfter.oneTime).toBe(50);
    expect(diff.changedCount).toBeGreaterThanOrEqual(3);
  });

  it('Markdown/CSV 导出包含变化点与表头', () => {
    const before = base(1);
    const after = base(2);
    after.item.status = 'sent';
    after.items[1].unit_price = 10;
    after.items[1].amount = 10;
    after.totals = { oneTime: 50, annualOps: 10 };
    const diff = diffQuotes(before, after);

    const markdown = quoteDiffMarkdown(diff);
    expect(markdown).toContain('# 报价版本对比：v1 → v2');
    expect(markdown).toContain('年运维');
    expect(markdown).toContain('## 报价行');

    const csv = quoteDiffCsv(diff);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"类型","名称","变化","基准","对比"');
    expect(csv).toContain('"年运维"');
    expect(csv).toContain('"10"');
  });
});
