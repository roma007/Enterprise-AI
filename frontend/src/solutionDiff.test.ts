import { describe, expect, it } from 'vitest';
import type { SolutionDetail } from './types';
import {
  diffSolutionDetails,
  solutionDiffCsv,
  solutionDiffMarkdown,
} from './solutionDiff';

const base = (version: number): SolutionDetail =>
  ({
    item: {
      id: `solution-${version}`,
      opportunity_id: 'opp-1',
      version,
      status: 'draft',
      scope: '一期试点',
      approach: '规则 + 人工复核',
      architecture: '单体',
      deployment: '客户内网',
      security: '脱敏',
      assumptions: '样本稳定',
      exclusions: '不做自动派车',
      created_at: '2026-11-05T00:00:00.000Z',
      updated_at: '2026-11-05T00:00:00.000Z',
      opportunity_code: 'OPP-1',
      opportunity_title: '对账',
      engagement_id: 'eng-1',
      engagement_name: '试点',
    },
    components: [
      {
        id: 'c1',
        solution_id: `solution-${version}`,
        name: 'OCR',
        type: 'integrate',
        description: '票据识别',
        effort_days: 3,
        sort_order: 0,
      },
    ],
    integrations: [
      {
        id: 'i1',
        solution_id: `solution-${version}`,
        system: 'TMS',
        direction: 'inbound',
        protocol: 'API',
        fields: '运单',
        frequency: '实时',
        owner: '客户 IT',
        risk: '排期',
        sort_order: 0,
      },
    ],
    workload: [],
    workloadTotal: 3,
    acceptanceCriteria: [
      {
        id: 'a1',
        solution_id: `solution-${version}`,
        metric: '表头准确率',
        baseline: '90%',
        target: '98%',
        method: '抽样',
        owner: '财务',
        status: 'pending',
        sort_order: 0,
      },
    ],
    reviews: [],
  }) as SolutionDetail;

describe('diffSolutionDetails', () => {
  it('相同版本没有变更', () => {
    const diff = diffSolutionDetails(base(1), base(1));
    expect(diff.changedCount).toBe(0);
    expect(diff.fields.every((field) => !field.changed)).toBe(true);
    expect(diff.components.every((item) => item.status === 'same')).toBe(true);
  });

  it('识别字段、组件、集成、验收与工作量变化', () => {
    const before = base(1);
    const after = base(2);
    after.item.scope = '二期推广';
    after.item.status = 'approved';
    after.components[0].effort_days = 5;
    after.components.push({
      id: 'c2',
      solution_id: 'solution-2',
      name: '差异解释',
      type: 'build',
      description: null,
      effort_days: 2,
      sort_order: 1,
    });
    after.integrations = [];
    after.acceptanceCriteria[0].target = '99%';
    after.workloadTotal = 7;

    const diff = diffSolutionDetails(before, after);
    expect(diff.fields.find((field) => field.key === 'scope')?.changed).toBe(
      true,
    );
    expect(diff.fields.find((field) => field.key === 'status')?.changed).toBe(
      true,
    );
    expect(
      diff.components.find((item) => item.name === 'OCR')?.status,
    ).toBe('changed');
    expect(
      diff.components.find((item) => item.name === '差异解释')?.status,
    ).toBe('added');
    expect(diff.integrations[0].status).toBe('removed');
    expect(diff.acceptance[0].status).toBe('changed');
    expect(diff.workloadBefore).toBe(3);
    expect(diff.workloadAfter).toBe(7);
    expect(diff.changedCount).toBeGreaterThanOrEqual(6);
  });

  it('Markdown/CSV 导出包含变化点与表头', () => {
    const before = base(1);
    const after = base(2);
    after.item.scope = '二期推广';
    after.workloadTotal = 5;
    const diff = diffSolutionDetails(before, after);
    const markdown = solutionDiffMarkdown(diff);
    expect(markdown).toContain('# 方案版本对比：v1 → v2');
    expect(markdown).toContain('二期推广');
    expect(markdown).toContain('## 组件');
    const csv = solutionDiffCsv(diff);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"类型","名称","变化","基准","对比"');
    expect(csv).toContain('"工作量"');
    expect(csv).toContain('"5"');
  });
});
