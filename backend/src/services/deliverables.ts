import { withTransaction } from '../db';
import { loadBundle, reportableOpportunities, roiFor, templateFor } from '../repo';
import { runChecks, type CheckSummary } from '../rules/consistency';
import { renderOnePager } from '../templates/one_pager';
import type { DeliverableType } from './types';

export interface GenerateInput {
  engagementId: string;
  type: DeliverableType;
  title?: string;
  requestedBy?: string;
}

export interface GenerateResult {
  blocked: boolean;
  checks: CheckSummary;
  deliverable?: {
    id: string;
    version: number;
    title: string;
    templateId: string;
    templateVersion: string;
    markdown: string;
    createdAt: string;
  };
}

const DEFAULT_TITLES: Record<string, string> = {
  diagnosis_report: 'AI 化诊断报告',
  one_pager: '一页纸简报',
  roi_sheet: 'ROI 测算表',
  roadmap: '实施路线图',
};

/** 已实现的渲染器。其余类型宁可明确拒绝，也不要返回一份类型对不上的文档。 */
const SUPPORTED_TYPES = new Set<DeliverableType>(['diagnosis_report', 'one_pager']);

function notImplemented(type: string): never {
  const err: any = new Error(
    `交付物类型 ${type} 尚未实现渲染器；当前支持 diagnosis_report、one_pager`,
  );
  err.statusCode = 400;
  err.code = 'DELIVERABLE_TYPE_NOT_IMPLEMENTED';
  throw err;
}

export async function generateDeliverable(
  input: GenerateInput,
  orgId?: string,
): Promise<GenerateResult> {
  const bundle = await loadBundle(input.engagementId, orgId);
  if (!bundle) {
    const err: any = new Error('ENGAGEMENT_NOT_FOUND');
    err.statusCode = 404;
    err.code = 'ENGAGEMENT_NOT_FOUND';
    throw err;
  }

  const type = input.type ?? 'diagnosis_report';
  if (!SUPPORTED_TYPES.has(type)) notImplemented(type);

  const checks = runChecks(bundle);
  // 硬规则：有 block 级失败时拒绝生成，而不是警告后继续
  if (checks.blocked) {
    return { blocked: true, checks };
  }

  // 诊断报告与一页纸用各自的模板；模板缺失时回退到诊断模板并记录版本。
  const templateKey = type === 'one_pager' ? 'logistics_one_pager' : 'logistics_diagnosis';
  const template = (await templateFor(templateKey)) ?? bundle.template;
  const templateId = template?.template_key ?? templateKey;
  const templateVersion = template?.version ?? '2.2.0';
  const title = input.title ?? `${bundle.engagement.client_name} ${DEFAULT_TITLES[type] ?? type}`;

  const rendered =
    type === 'one_pager'
      ? renderOnePager(bundle, checks.report)
      : { markdown: checks.report.markdown, sections: checks.report.sections };
  const portfolio = checks.report.portfolio;

  const opps = reportableOpportunities(bundle);
  const content = {
    markdown: rendered.markdown,
    portfolio,
    sections: rendered.sections.map((s) => ({
      key: s.key,
      kind: s.kind,
      ref: s.ref ?? null,
      limitationIds: s.limitationIds ?? [],
    })),
    opportunities: opps.map((o) => {
      const r = roiFor(bundle, o.id);
      return {
        code: o.code,
        title: o.title,
        phase: o.target_phase,
        score: o.score,
        theory: r?.neutral_value ?? null,
        realized: r?.realized_value ?? null,
        investment: r?.one_time_cost ?? null,
        paybackMonths: r?.payback_months ?? null,
        paybackMonthsWithOps: r?.payback_months_with_ops ?? null,
        realizationMode: r?.realization_mode ?? null,
        realizationFactor: r?.realization_factor ?? null,
      };
    }),
    limitations: {
      amount: checks.report.amountLimitations.map((l) => l.title),
      scope: checks.report.scopeLimitations.map((l) => l.title),
      method: checks.report.methodLimitations.map((l) => l.title),
      internalExcluded: checks.report.excludedInternal.length,
    },
  };

  const generatedFrom = {
    opportunityIds: bundle.opportunities.map((o) => o.id),
    baselineIds: bundle.baselines.map((b) => b.id),
    chainIds: bundle.chains.map((c) => c.id),
    limitationIds: bundle.limitations.map((l) => l.id),
    benchmarkIds: bundle.benchmarks.map((b) => b.id),
    templateId,
    templateVersion,
  };

  // 生成那一刻的数据快照：三个月后必须能复现"当时为什么是这个数"
  const generatedSnapshot = {
    asOf: new Date().toISOString(),
    engagementStage: bundle.engagement.stage,
    portfolio,
    rois: opps.map((o) => {
      const r = roiFor(bundle, o.id);
      return r
        ? {
            code: o.code,
            neutralValue: r.neutral_value,
            realizationFactor: r.realization_factor,
            realizedValue: r.realized_value,
            oneTimeCost: r.one_time_cost,
            annualCost: r.annual_cost,
            paybackMonths: r.payback_months,
            paybackMonthsWithOps: r.payback_months_with_ops,
          }
        : null;
    }),
    chains: bundle.chains.map((c) => ({
      opportunityId: c.opportunity_id,
      stage: c.stage,
      variableKey: c.variable_key,
      multBase: c.mult_base,
      multLow: c.mult_low,
      isDerived: c.is_derived,
    })),
    checks: checks.checks.map((c) => ({ code: c.code, outcome: c.outcome, message: c.message })),
  };

  // 版本号在同一个事务里分配：并发生成时用咨询锁按 (项目, 类型) 串行，
  // 避免 MAX(version)+1 的经典竞态，也避免交付物与审计记录只写一半。
  const inserted = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
      input.engagementId,
      type,
    ]);

    const prev = await client.query<{ version: number }>(
      `SELECT COALESCE(MAX(version), 0) AS version FROM deliverables
        WHERE engagement_id = $1 AND type = $2`,
      [input.engagementId, type],
    );
    const version = (prev.rows[0]?.version ?? 0) + 1;

    const ins = await client.query<{ id: string; created_at: string }>(
      `INSERT INTO deliverables
         (engagement_id, type, title, version, status, content, generated_from,
          template_id, template_version, generated_snapshot)
       VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9)
       RETURNING id, created_at`,
      [
        input.engagementId,
        type,
        title,
        version,
        JSON.stringify(content),
        JSON.stringify(generatedFrom),
        templateId,
        templateVersion,
        JSON.stringify(generatedSnapshot),
      ],
    );

    const deliverableId = ins.rows[0].id;
    for (const c of checks.checks) {
      await client.query(
        `INSERT INTO consistency_checks (deliverable_id, check_code, level, passed, detail)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          deliverableId,
          c.code,
          c.outcome === 'block' ? 'block' : c.level,
          c.outcome === 'pass',
          JSON.stringify({ outcome: c.outcome, message: c.message, evidence: c.evidence ?? null }),
        ],
      );
    }

    return { id: deliverableId, version, createdAt: ins.rows[0].created_at };
  });

  return {
    blocked: false,
    checks,
    deliverable: {
      id: inserted.id,
      version: inserted.version,
      title,
      templateId,
      templateVersion,
      markdown: rendered.markdown,
      createdAt: inserted.createdAt,
    },
  };
}
