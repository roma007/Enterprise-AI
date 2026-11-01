import type { Bundle, Limitation } from '../types';
import { chainFor, reportableOpportunities, roiFor } from '../repo';
import { chainProduct } from './chain';
import { renderDiagnosis, type RenderedReport } from '../templates/diagnosis';

export type Outcome = 'pass' | 'warn' | 'block';
export type Level = 'block' | 'warn';

export interface CheckResult {
  code: string;
  title: string;
  /** 这条检查的固有级别；动态检查（C4/C11）按结果决定 */
  level: Level;
  outcome: Outcome;
  message: string;
  evidence?: unknown;
}

export interface CheckSummary {
  engagementId: string;
  ranAt: string;
  blocked: boolean;
  summary: { pass: number; warn: number; block: number };
  checks: CheckResult[];
  report: RenderedReport;
}

const round = (v: number, d = 4) => Number(v.toFixed(d));

/** 与 SQL 的 ratio_level() 保持一致（P3 决策） */
export function ratioLevel(actual: number, required: number): 'pass' | 'warn' | 'block' {
  if (!required) return 'pass';
  const r = actual / required;
  if (r >= 1) return 'pass';
  if (r >= 0.5) return 'warn';
  return 'block';
}

const ok = (code: string, title: string, level: Level, message: string, evidence?: unknown): CheckResult => ({
  code, title, level, outcome: 'pass', message, evidence,
});
const warn = (code: string, title: string, level: Level, message: string, evidence?: unknown): CheckResult => ({
  code, title, level, outcome: 'warn', message, evidence,
});
const block = (code: string, title: string, level: Level, message: string, evidence?: unknown): CheckResult => ({
  code, title, level, outcome: 'block', message, evidence,
});

export function runChecks(bundle: Bundle): CheckSummary {
  const checks: CheckResult[] = [];
  const opps = reportableOpportunities(bundle);
  const report = renderDiagnosis(bundle);

  // ---------------------------------------------------------------- C1
  {
    const missing = opps.filter(
      (o) => !bundle.baselines.some((b) => b.opportunity_id === o.id),
    );
    checks.push(
      missing.length
        ? block('C1', '进入方案设计的机会点必须有基线', 'block',
            `${missing.map((o) => o.code).join('、')} 缺少基线数据`,
            missing.map((o) => ({ code: o.code, title: o.title })))
        : ok('C1', '进入方案设计的机会点必须有基线', 'block', `${opps.length}/${opps.length} 均有基线`,
            opps.map((o) => ({ code: o.code, baselines: bundle.baselines.filter((b) => b.opportunity_id === o.id).length }))),
    );
  }

  // ---------------------------------------------------------------- C2
  {
    // 明细重算：可实现收益 / 回本必须能从基础字段精确复现
    const mismatches: Array<{ code: string; field: string; stored: number | null; expected: number | null }> = [];
    for (const o of opps) {
      const r = roiFor(bundle, o.id);
      if (!r || r.realization_factor === null) continue;
      const expectedRealized = round(r.neutral_value * r.realization_factor, 1);
      const expectedPayback =
        expectedRealized > 0 ? round((r.one_time_cost * 12) / expectedRealized, 2) : null;
      if (r.realized_value !== expectedRealized)
        mismatches.push({ code: o.code, field: 'realized_value', stored: r.realized_value, expected: expectedRealized });
      if ((r.payback_months ?? null) !== expectedPayback)
        mismatches.push({ code: o.code, field: 'payback_months', stored: r.payback_months, expected: expectedPayback });
    }
    const sumParts = round(
      opps.reduce((a, o) => a + (roiFor(bundle, o.id)?.realized_value ?? 0), 0),
      1,
    );
    const sumMatches = sumParts === round(report.portfolio.realized, 1);

    checks.push(
      mismatches.length || !sumMatches
        ? block('C2', '报告汇总数 = 明细之和（容差 0）', 'block',
            mismatches.length
              ? `${mismatches.length} 处明细与重算不一致：${mismatches.map((m) => `${m.code}.${m.field}`).join('、')}`
              : `组合数 ${report.portfolio.realized} ≠ 明细之和 ${sumParts}`,
            { mismatches, portfolio: report.portfolio, sumParts })
        : ok('C2', '报告汇总数 = 明细之和（容差 0）', 'block',
            `组合 ${report.portfolio.realized} = 明细之和 ${sumParts}（${opps.length} 项，容差 0）`,
            { portfolio: report.portfolio, sumParts }),
    );
  }

  // ---------------------------------------------------------------- C3
  {
    const problems: string[] = [];
    for (const g of bundle.gates) {
      if (g.status === 'passed') {
        const failed = g.checklist.filter((i) => i.passed === false);
        if (failed.length) problems.push(`${g.code} 标记 passed，但 checklist 有 ${failed.length} 项未通过`);
      }
    }
    checks.push(
      problems.length
        ? block('C3', '门禁状态与 checklist 一致', 'block', problems.join('；'), bundle.gates.map((g) => ({ code: g.code, status: g.status })))
        : ok('C3', '门禁状态与 checklist 一致', 'block',
            `门禁 ${bundle.gates.map((g) => g.code).join('、')} 状态与 checklist 一致`,
            bundle.gates.map((g) => ({ code: g.code, status: g.status }))),
    );
  }

  // ---------------------------------------------------------------- C4
  {
    const actual = bundle.painPoints.filter((p) => p.status !== 'merged').length;
    const g1 = bundle.gates.find((g) => g.code === 'G1');
    const item = g1?.checklist.find((i) => typeof i.required === 'number' && /痛点/.test(i.item));
    const required = item?.required ?? 10;
    const level = ratioLevel(actual, required);
    checks.push(
      level === 'block'
        ? block('C4', '痛点数达到门禁要求（按 C11 分级）', 'block',
            `痛点 ${actual}/${required} = ${(actual / required).toFixed(2)}，缺口超过一半，诊断未完成`, { actual, required })
        : level === 'warn'
          ? warn('C4', '痛点数达到门禁要求（按 C11 分级）', 'warn',
              `痛点 ${actual}/${required} = ${(actual / required).toFixed(2)} → warn，放行并附待确认清单`, { actual, required })
          : ok('C4', '痛点数达到门禁要求（按 C11 分级）', 'warn', `痛点 ${actual}/${required} 达标`, { actual, required }),
    );
  }

  // ---------------------------------------------------------------- C5
  {
    const bad = bundle.opportunities.filter(
      (o) => (o.stage === 'killed' || o.stage === 'parked') &&
             (o.target_phase === 'phase1' || o.target_phase === 'phase2'),
    );
    checks.push(
      bad.length
        ? block('C5', 'killed/parked 的机会点不得出现在推荐路线', 'block',
            `${bad.map((o) => o.code).join('、')} 已终止/搁置，仍在推荐路线中`,
            bad.map((o) => ({ code: o.code, stage: o.stage, targetPhase: o.target_phase })))
        : ok('C5', 'killed/parked 的机会点不得出现在推荐路线', 'block',
            '推荐路线中无终止/搁置项'),
    );
  }

  // ---------------------------------------------------------------- C6
  {
    const low = bundle.baselines.filter((b) => b.confidence === 'low');
    const uncovered = low.filter(
      (b) => !bundle.limitations.some((l) => l.source_type === 'baseline_low_confidence' && l.source_id === b.id),
    );
    checks.push(
      uncovered.length
        ? block('C6', 'low 置信度基线必须进入局限章节', 'block',
            `${uncovered.length} 条低置信度基线未被局限覆盖`,
            uncovered.map((b) => ({ id: b.id, metric: b.metric })))
        : ok('C6', 'low 置信度基线必须进入局限章节', 'block',
            `低置信度基线 ${low.length} 条，均已分流到局限条目`,
            low.map((b) => ({ id: b.id, metric: b.metric }))),
    );
  }

  // ---------------------------------------------------------------- C7
  {
    const currentYear = new Date().getFullYear();
    const keys = new Set<string>();
    for (const item of bundle.inventory) {
      const key = item.attributes?.benchmark_metric_key as string | undefined;
      if (key) keys.add(key);
    }
    const problems: string[] = [];
    for (const key of keys) {
      const b = bundle.benchmarks.find((x) => x.metric_key === key);
      if (!b) problems.push(`${key} 缺少基准数据`);
      else if (b.year < currentYear - 2) problems.push(`${key} 基准年份 ${b.year} 已过期`);
      else if (!b.calibrated) problems.push(`${key} 未校准（calibrated=false）`);
    }
    checks.push(
      problems.length
        ? warn('C7', '引用的 benchmark 存在且未过期', 'warn',
            `${problems.length} 项基准需说明：${problems.slice(0, 3).join('；')}${problems.length > 3 ? '…' : ''}`,
            problems)
        : ok('C7', '引用的 benchmark 存在且未过期', 'warn', `${keys.size} 项基准均存在且未过期`),
    );
  }

  // ---------------------------------------------------------------- C8
  {
    const requires = bundle.dependencies.filter((d) => d.type === 'requires');
    const graph = new Map<string, string[]>();
    for (const d of requires) {
      const arr = graph.get(d.from_code) ?? [];
      arr.push(d.to_code);
      graph.set(d.from_code, arr);
    }
    const cycles = new Set<string>();
    const visits = new Set<string>();

    const dfs = (node: string, stack: string[]) => {
      if (stack.includes(node)) {
        cycles.add([...stack.slice(stack.indexOf(node)), node].join(' → '));
        return;
      }
      if (visits.has(node)) return;
      for (const next of graph.get(node) ?? []) dfs(next, [...stack, node]);
      visits.add(node);
    };
    for (const node of graph.keys()) dfs(node, []);

    checks.push(
      cycles.size
        ? block('C8', 'requires 依赖无环', 'block', `发现环：${[...cycles].join('；')}`, [...cycles])
        : ok('C8', 'requires 依赖无环', 'block',
            `requires 依赖 ${requires.length} 条，无环`,
            requires.map((d) => `${d.from_code} → ${d.to_code}`)),
    );
  }

  // ---------------------------------------------------------------- C9
  {
    const t = bundle.template;
    checks.push(
      t && t.is_active
        ? ok('C9', 'deliverables.template_id 存在', 'block',
            `模板 ${t.template_key} v${t.version} 已注册且启用`, { id: t.id, version: t.version })
        : block('C9', 'deliverables.template_id 存在', 'block',
            '报告模板未注册或已停用', t),
    );
  }

  // --------------------------------------------------------------- C10
  {
    const missing = opps.filter((o) => {
      const r = roiFor(bundle, o.id);
      return !r || r.realization_confirmed_at === null || r.realization_mode === null;
    });
    checks.push(
      missing.length
        ? block('C10', 'ROI 收益形态已选定并署名确认', 'block',
            `${missing.map((o) => o.code).join('、')} 未完成收益形态判断，回本周期不可计算`,
            missing.map((o) => {
              const r = roiFor(bundle, o.id);
              return { code: o.code, mode: r?.realization_mode ?? null, confirmedAt: r?.realization_confirmed_at ?? null };
            }))
        : ok('C10', 'ROI 收益形态已选定并署名确认', 'block',
            `${opps.length}/${opps.length} 已确认`,
            opps.map((o) => ({ code: o.code, mode: roiFor(bundle, o.id)?.realization_mode }))),
    );
  }

  // --------------------------------------------------------------- C11
  {
    const g1 = bundle.gates.find((g) => g.code === 'G1');
    const items = (g1?.checklist ?? [])
      .filter((i) => typeof i.actual === 'number' && typeof i.required === 'number')
      .map((i) => {
        const ratio = (i.actual as number) / (i.required as number);
        return { item: i.item, actual: i.actual as number, required: i.required as number, ratio, level: ratioLevel(i.actual as number, i.required as number) };
      });

    const worst = items.some((i) => i.level === 'block')
      ? 'block'
      : items.some((i) => i.level === 'warn')
        ? 'warn'
        : 'pass';

    const detail = items
      .map((i) => `${i.item} ${i.actual}/${i.required}=${i.ratio.toFixed(2)} ${i.level}`)
      .join('；');

    checks.push(
      worst === 'block'
        ? block('C11', '门禁量化项缺口分级', 'block', detail, items)
        : worst === 'warn'
          ? warn('C11', '门禁量化项缺口分级', 'warn', detail, items)
          : ok('C11', '门禁量化项缺口分级', 'warn', detail, items),
    );
  }

  // --------------------------------------------------------------- C12
  {
    const bad: Array<{ code: string; product: number | null; factor: number | null; diff: number | null }> = [];
    for (const o of opps) {
      const r = roiFor(bundle, o.id);
      if (!r || r.realization_factor === null) continue;
      const product = chainProduct(chainFor(bundle, o.id));
      if (product === null) continue;
      const diff = round(Math.abs(product - r.realization_factor), 4);
      if (diff > 0.005) bad.push({ code: o.code, product, factor: r.realization_factor, diff });
    }
    checks.push(
      bad.length
        ? block('C12', '传导链乘积 = realization_factor', 'block',
            bad.map((b) => `${b.code}: 链条 ${b.product} ≠ 总系数 ${b.factor}（差 ${b.diff}）`).join('；'),
            bad)
        : ok('C12', '传导链乘积 = realization_factor', 'block',
            opps
              .map((o) => {
                const r = roiFor(bundle, o.id);
                if (!r || r.realization_factor === null) return null;
                const p = chainProduct(chainFor(bundle, o.id));
                return p === null ? null : `${o.code}: ${p} = ${r.realization_factor}`;
              })
              .filter(Boolean)
              .join('；')),
    );
  }

  // --------------------------------------------------------------- C13
  {
    const internal = bundle.limitations.filter((l) => l.impact_class === 'internal');
    const leaked = internal.filter((l) => report.markdown.includes(l.title));
    const leakedBySection = report.sections.filter(
      (s) =>
        s.limitationIds?.some((id) => internal.some((l) => l.id === id)) ||
        (s.kind as string) === 'internal',
    );
    checks.push(
      leaked.length || leakedBySection.length
        ? block('C13', 'internal 类局限不得出现在客户文档', 'block',
            `${leaked.length} 条内部项泄露到客户文档`, leaked.map((l) => l.title))
        : ok('C13', 'internal 类局限不得出现在客户文档', 'block',
            `${internal.length} 条内部项已在模板层剔除`,
            internal.map((l) => l.title)),
    );
  }

  // --------------------------------------------------------------- C14
  {
    const amount = bundle.limitations.filter((l) => l.impact_class === 'amount');
    const problems: string[] = [];
    for (const l of amount) {
      const emitted = report.sections.findIndex(
        (s) => s.kind === 'amount_limitation' && s.limitationIds?.includes(l.id),
      );
      const ref = l.affected_refs[0];
      const roiIdx = report.sections.findIndex((s) => s.kind === 'roi' && s.ref === ref);
      if (emitted === -1) problems.push(`${l.title} 未出现在正文`);
      else if (roiIdx === -1) problems.push(`${l.title} 找不到对应的 ROI 段落（${ref}）`);
      else {
        // 同一张 ROI 可能挂多条金额类局限；要求它们构成紧跟 ROI 的连续块，
        // 而不是中间夹进别的段落（C14 的实质：读者看完数字立刻看到它的不确定性）。
        const between = report.sections.slice(roiIdx + 1, emitted + 1);
        const contiguous = between.length > 0 && between.every(
          (s) => s.kind === 'amount_limitation' && (s.ref === ref || s.ref === undefined),
        );
        if (!contiguous) problems.push(`${l.title} 未紧跟 ${ref} 的 ROI 段（位置 ${emitted}，应在 ${roiIdx + 1} 起的连续块内）`);
      }
    }
    checks.push(
      problems.length
        ? block('C14', 'amount 类局限必须在正文且紧跟对应 ROI', 'block', problems.join('；'), problems)
        : ok('C14', 'amount 类局限必须在正文且紧跟对应 ROI', 'block',
            `${amount.length} 条金额类局限均已归位`,
            amount.map((l: Limitation) => ({ title: l.title, refs: l.affected_refs }))),
    );
  }

  const summary = { pass: 0, warn: 0, block: 0 };
  for (const c of checks) summary[c.outcome] += 1;

  return {
    engagementId: bundle.engagement.id,
    ranAt: new Date().toISOString(),
    blocked: summary.block > 0,
    summary,
    checks,
    report,
  };
}

/** 控制台用的紧凑输出：只写失败项（与产品要求一致） */
export function formatFailures(result: CheckSummary): string {
  const failed = result.checks.filter((c) => c.outcome !== 'pass');
  if (!failed.length) return '✅ 14 项校验全部通过';
  return failed
    .map((c) => `${c.outcome === 'block' ? '⛔' : '⚠️'} [${c.code}] ${c.message}`)
    .join('\n');
}
