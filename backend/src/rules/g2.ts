import type { Outcome } from './consistency';

export type G2Level = 'block' | 'warn';

export interface G2Check {
  code: string;
  title: string;
  level: G2Level;
  outcome: Outcome;
  message: string;
  evidence?: unknown;
}

export interface G2Data {
  opportunities: any[];
  solutions: any[];
  quotes: any[];
  unlinkedOneTimeItems: any[];
}

export interface G2Result {
  summary: { pass: number; warn: number; block: number };
  blocked: boolean;
  checks: G2Check[];
}

const ok = (code: string, title: string, level: G2Level, message: string, evidence?: unknown): G2Check => ({
  code, title, level, outcome: 'pass', message, evidence,
});
const warn = (code: string, title: string, level: G2Level, message: string, evidence?: unknown): G2Check => ({
  code, title, level, outcome: 'warn', message, evidence,
});
const block = (code: string, title: string, level: G2Level, message: string, evidence?: unknown): G2Check => ({
  code, title, level, outcome: 'block', message, evidence,
});

export function runG2Checks(data: G2Data): G2Result {
  const checks: G2Check[] = [];
  const opps = data.opportunities;
  const solutions = data.solutions;

  // G2-1 覆盖：每个一期/二期机会点都有方案
  {
    const missing = opps.filter((o) => !solutions.some((s) => s.opportunity_id === o.id));
    checks.push(
      missing.length
        ? block('G2-1', '每个一期/二期机会点都有方案', 'block',
            `${missing.map((o) => o.code).join('、')} 还没有方案`, missing.map((o) => ({ code: o.code, title: o.title })))
        : ok('G2-1', '每个一期/二期机会点都有方案', 'block',
            `${opps.length}/${opps.length} 个机会点有方案`, opps.map((o) => o.code)),
    );
  }

  // G2-2 方案范围
  {
    const missing = solutions.filter((s) => !String(s.scope ?? '').trim());
    checks.push(
      missing.length
        ? block('G2-2', '方案必须写清范围', 'block',
            `${missing.map((s) => `${s.opportunity_code} v${s.version}`).join('、')} 缺少范围`,
            missing.map((s) => ({ code: s.opportunity_code, version: s.version })))
        : ok('G2-2', '方案必须写清范围', 'block', `${solutions.length} 个方案均有范围`),
    );
  }

  // G2-3 组件
  {
    const missing = solutions.filter((s) => Number(s.component_count) === 0);
    checks.push(
      missing.length
        ? block('G2-3', '方案至少有一个组件', 'block',
            `${missing.map((s) => `${s.opportunity_code} v${s.version}`).join('、')} 没有组件`,
            missing.map((s) => ({ code: s.opportunity_code, version: s.version })))
        : ok('G2-3', '方案至少有一个组件', 'block', `${solutions.length} 个方案均有组件`),
    );
  }

  // G2-4 验收标准
  {
    const missing = solutions.filter((s) => Number(s.criteria_count) === 0);
    checks.push(
      missing.length
        ? block('G2-4', '方案至少有一条验收标准', 'block',
            `${missing.map((s) => `${s.opportunity_code} v${s.version}`).join('、')} 没有验收标准`,
            missing.map((s) => ({ code: s.opportunity_code, version: s.version })))
        : ok('G2-4', '方案至少有一条验收标准', 'block', `${solutions.length} 个方案均有验收标准`),
    );
  }

  // G2-5 工作量
  {
    const missing = solutions.filter((s) => Number(s.workload_count) === 0);
    checks.push(
      missing.length
        ? warn('G2-5', '方案应有人天/成本估算', 'warn',
            `${missing.map((s) => `${s.opportunity_code} v${s.version}`).join('、')} 没有工作量明细`,
            missing.map((s) => ({ code: s.opportunity_code, version: s.version })))
        : ok('G2-5', '方案应有人天/成本估算', 'warn', `${solutions.length} 个方案均有工作量`),
    );
  }

  // G2-6 报价
  {
    const usable = data.quotes.filter(
      (q) => Number(q.item_count) > 0 && Number(q.total) > 0,
    );
    checks.push(
      usable.length
        ? ok('G2-6', '至少有一份可用报价（金额 > 0）', 'block',
            `${usable.length} 份报价可用，最高 v${Math.max(...usable.map((q) => q.version))}`,
            usable.map((q) => ({ version: q.version, total: q.total })))
        : block('G2-6', '至少有一份可用报价（金额 > 0）', 'block',
            '没有报价，或报价行金额为 0'),
    );
  }

  // G2-7 报价行与方案关联
  {
    const unlinked = data.unlinkedOneTimeItems;
    checks.push(
      unlinked.length
        ? warn('G2-7', '一次性报价行建议关联方案', 'warn',
            `${unlinked.length} 条一次性报价行未关联方案，客户版可能难以追溯`,
            unlinked.map((i) => ({ description: i.description, amount: i.amount })))
        : ok('G2-7', '一次性报价行建议关联方案', 'warn', '所有一次性报价行都已关联方案'),
    );
  }

  // G2-8 技术阻断
  {
    const blocked = solutions.filter(
      (s) => s.has_tech_blocker && !s.blocker_owner,
    );
    checks.push(
      blocked.length
        ? block('G2-8', '技术阻断必须指定承担人', 'block',
            `${blocked.map((s) => `${s.opportunity_code} v${s.version}`).join('、')} 存在未承担的技术阻断`,
            blocked.map((s) => ({ code: s.opportunity_code, version: s.version })))
        : ok('G2-8', '技术阻断必须指定承担人', 'block', '没有未承担的技术阻断'),
    );
  }

  // G2-9 评审
  {
    const unreviewed = solutions.filter((s) => Number(s.review_count) === 0);
    const notApproved = solutions.filter(
      (s) => Number(s.review_count) > 0 && s.latest_review !== 'approved',
    );
    if (unreviewed.length) {
      checks.push(
        block('G2-9', '方案必须经过评审并批准', 'block',
          `${unreviewed.map((s) => `${s.opportunity_code} v${s.version}`).join('、')} 没有评审记录`,
          unreviewed.map((s) => ({ code: s.opportunity_code, version: s.version }))),
      );
    } else if (notApproved.length) {
      checks.push(
        block('G2-9', '方案必须经过评审并批准', 'block',
          `${notApproved.map((s) => `${s.opportunity_code} v${s.version}`).join('、')} 最新评审不是 approved`,
          notApproved.map((s) => ({ code: s.opportunity_code, version: s.version, decision: s.latest_review }))),
      );
    } else {
      checks.push(
        ok('G2-9', '方案必须经过评审并批准', 'block', `${solutions.length} 个方案均已批准`),
      );
    }
  }

  // G2-10 报价覆盖成本（仅有报价且低于工作量成本时告警）
  {
    const under = solutions
      .map((s) => ({
        code: s.opportunity_code,
        version: s.version,
        cost: Number(s.workload_cost ?? 0),
        quote: Number(s.quote_one_time ?? 0),
      }))
      .filter((s) => s.cost > 0 && s.quote > 0 && s.quote < s.cost);
    checks.push(
      under.length
        ? warn('G2-10', '关联报价应覆盖工作量成本', 'warn',
            `${under.map((s) => `${s.code} v${s.version}（报价 ${s.quote} / 成本 ${s.cost} 万元）`).join('、')} 报价低于工作量成本`,
            under.map((s) => ({
              code: s.code,
              version: s.version,
              quote_one_time: s.quote,
              workload_cost: s.cost,
              margin: Number((s.quote - s.cost).toFixed(2)),
            })))
        : ok('G2-10', '关联报价应覆盖工作量成本', 'warn',
            '没有报价低于工作量成本的方案'),
    );
  }

  const summary = { pass: 0, warn: 0, block: 0 };
  for (const c of checks) summary[c.outcome] += 1;
  return { summary, blocked: summary.block > 0, checks };
}
