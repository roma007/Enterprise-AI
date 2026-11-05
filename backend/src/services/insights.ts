import { one, query } from '../db';

export type InsightLevel = 'positive' | 'warning' | 'critical' | 'info';

export interface InsightItem {
  code: string;
  level: InsightLevel;
  title: string;
  detail: string;
  action?: string;
  evidence?: unknown;
}

export interface InsightMetric {
  key: string;
  name: string;
  unit: string;
  direction: 'higher_better' | 'lower_better';
  baseline: number | null;
  target: number | null;
  latest: number | null;
  period: string | null;
  status: 'achieved' | 'behind' | 'unknown';
  gap_pct: number | null;
}

export interface InsightReport {
  generated_at: string;
  engagement: {
    id: string;
    name: string;
    client_name: string;
    stage: string;
  };
  summary: string[];
  metrics: InsightMetric[];
  insights: InsightItem[];
  recommendations: string[];
  evidence: Record<string, number>;
}

const levelLabel: Record<InsightLevel, string> = {
  positive: '已验证',
  warning: '需关注',
  critical: '需立即处理',
  info: '说明',
};

const fmt = (value: unknown, unit = '') =>
  value == null || value === '' ? '—' : `${Number(value)}${unit}`;

/** 规则引擎生成经营洞察：每条结论都能追到项目数据，不调用外部模型。 */
export async function buildInsights(
  engagementId: string,
  orgId?: string,
): Promise<InsightReport | null> {
  const engagement = await one<any>(
    `SELECT e.id, e.name, e.stage, c.name AS client_name
       FROM engagements e
       JOIN clients c ON c.id = e.client_id
      WHERE e.id = $1 AND e.deleted_at IS NULL AND c.deleted_at IS NULL
        ${orgId ? 'AND e.org_id = $2' : ''}`,
    orgId ? [engagementId, orgId] : [engagementId],
  );
  if (!engagement) return null;

  const [opportunities, solutions, quotes, experiments, plans, targets, usage, risks] =
    await Promise.all([
      query<any>(
        `SELECT code, title, stage, target_phase, data_status, has_tech_blocker
           FROM opportunities WHERE engagement_id = $1 ORDER BY code`,
        [engagementId],
      ),
      query<any>(
        `SELECT s.id, s.version, s.status, s.owner_id, o.code, o.title,
                (SELECT COALESCE(sum(w.cost), 0) FROM workload_estimates w WHERE w.solution_id = s.id) AS workload_cost,
                (SELECT COALESCE(sum(qi.amount), 0)
                   FROM quote_items qi JOIN quotes q ON q.id = qi.quote_id
                  WHERE qi.solution_id = s.id AND qi.kind = 'one_time'
                    AND q.status NOT IN ('expired','rejected')) AS quote_one_time
           FROM solutions s JOIN opportunities o ON o.id = s.opportunity_id
          WHERE o.engagement_id = $1 AND s.status <> 'archived'
          ORDER BY o.code, s.version DESC`,
        [engagementId],
      ),
      query<any>(
        `SELECT COALESCE(sum(qi.amount) FILTER (WHERE qi.kind = 'one_time'), 0)::float8 AS one_time,
                COALESCE(sum(qi.amount) FILTER (WHERE qi.kind = 'annual_ops'), 0)::float8 AS annual_ops,
                (SELECT count(*)::int FROM quotes q2
                  WHERE q2.engagement_id = $1 AND q2.status NOT IN ('expired','rejected')) AS quote_count
           FROM quote_items qi JOIN quotes q ON q.id = qi.quote_id
          WHERE q.engagement_id = $1 AND q.status NOT IN ('expired','rejected')`,
        [engagementId],
      ),
      query<any>(
        `SELECT e.*,
                (SELECT count(*) FROM poc_datasets d
                  WHERE d.experiment_id = e.id AND d.access_status IN ('approved','not_required')) AS usable_datasets,
                (SELECT count(*) FROM poc_runs r WHERE r.experiment_id = e.id) AS runs,
                (SELECT count(*) FROM poc_reviews rv JOIN poc_runs r ON r.id = rv.run_id
                  WHERE r.experiment_id = e.id) AS reviews,
                (SELECT rv.accuracy FROM poc_reviews rv JOIN poc_runs r ON r.id = rv.run_id
                  WHERE r.experiment_id = e.id ORDER BY rv.reviewed_at DESC LIMIT 1) AS latest_accuracy,
                c.decision, c.evidence, c.conditions
           FROM poc_experiments e
           JOIN opportunities o ON o.id = e.opportunity_id
           LEFT JOIN poc_conclusions c ON c.experiment_id = e.id
          WHERE o.engagement_id = $1 AND e.status <> 'cancelled'
          ORDER BY e.created_at DESC`,
        [engagementId],
      ),
      query<any>(
        `SELECT p.*,
                (SELECT count(*) FROM delivery_tasks t WHERE t.plan_id = p.id) AS task_count,
                (SELECT count(*) FROM delivery_tasks t WHERE t.plan_id = p.id AND t.status = 'done') AS task_done,
                (SELECT count(*) FROM delivery_tasks t WHERE t.plan_id = p.id AND t.is_milestone) AS milestones
           FROM delivery_plans p
          WHERE p.engagement_id = $1 AND p.status <> 'cancelled'
          ORDER BY p.version DESC LIMIT 1`,
        [engagementId],
      ),
      query<any>(
        `SELECT t.*, m.key, m.name, m.unit, m.direction,
                (SELECT s.value FROM metric_snapshots s WHERE s.target_id = t.id
                  ORDER BY s.period DESC LIMIT 1) AS latest_value,
                (SELECT s.period FROM metric_snapshots s WHERE s.target_id = t.id
                  ORDER BY s.period DESC LIMIT 1) AS latest_period
           FROM metric_targets t JOIN metric_definitions m ON m.id = t.metric_id
          WHERE t.engagement_id = $1 ORDER BY m.name`,
        [engagementId],
      ),
      query<any>(
        `SELECT COALESCE(sum(volume), 0)::float8 AS volume,
                COALESCE(sum(errors), 0)::int AS errors,
                count(*)::int AS records
           FROM usage_records WHERE engagement_id = $1`,
        [engagementId],
      ),
      query<any>(
        `SELECT r.*, u.name AS owner_name
           FROM renewal_risks r LEFT JOIN users u ON u.id = r.owner
          WHERE r.engagement_id = $1 AND r.status <> 'closed'
          ORDER BY r.due_date NULLS LAST, r.created_at`,
        [engagementId],
      ),
    ]);

  const [deliveryStats, signoff] = await Promise.all([
    query<any>(
      `SELECT
         (SELECT count(*) FROM uat_cases WHERE engagement_id = $1) AS uat_total,
         (SELECT count(*) FROM uat_cases WHERE engagement_id = $1 AND status = 'passed') AS uat_passed,
         (SELECT count(*) FROM delivery_issues WHERE engagement_id = $1
            AND severity IN ('P0','P1') AND status NOT IN ('closed','resolved','rejected')) AS open_high,
         (SELECT count(*) FROM delivery_issues WHERE engagement_id = $1
            AND kind = 'change' AND approval_status = 'pending') AS pending_changes`,
      [engagementId],
    ),
    one<any>(
      `SELECT count(*)::int AS n
         FROM confirmations c JOIN deliverables d ON d.id = c.object_id
        WHERE c.engagement_id = $1 AND c.object_type = 'deliverable'
          AND d.type IN ('uat_report','go_live_checklist')`,
      [engagementId],
    ),
  ]);

  const plan = plans[0];
  const dstats = deliveryStats[0] ?? {};
  const usageTotals = usage[0] ?? { volume: 0, errors: 0, records: 0 };
  const errorRate =
    Number(usageTotals.volume) > 0
      ? Number(usageTotals.errors) / Number(usageTotals.volume)
      : 0;

  const metrics: InsightMetric[] = targets.map((t) => {
    const target = t.target == null ? null : Number(t.target);
    const latest = t.latest_value == null ? null : Number(t.latest_value);
    let status: InsightMetric['status'] = 'unknown';
    if (target != null && latest != null) {
      const achieved =
        t.direction === 'lower_better' ? latest <= target : latest >= target;
      status = achieved ? 'achieved' : 'behind';
    }
    const gap =
      target != null && target !== 0 && latest != null
        ? Number((((latest - target) / target) * 100).toFixed(1))
        : null;
    return {
      key: t.key,
      name: t.name,
      unit: t.unit ?? '',
      direction: t.direction,
      baseline: t.baseline == null ? null : Number(t.baseline),
      target,
      latest,
      period: t.latest_period ?? null,
      status,
      gap_pct: gap,
    };
  });

  const insights: InsightItem[] = [];
  const recommendations: string[] = [];

  for (const m of metrics) {
    if (m.status === 'achieved') {
      insights.push({
        code: `M-${m.key}`,
        level: 'positive',
        title: `${m.name}已达到目标`,
        detail: `最新 ${fmt(m.latest, m.unit)}，目标 ${fmt(m.target, m.unit)}`,
        evidence: { period: m.period, latest: m.latest, target: m.target },
      });
    } else if (m.status === 'behind') {
      const gap = Math.abs(m.gap_pct ?? 0);
      insights.push({
        code: `M-${m.key}`,
        level: gap >= 20 ? 'critical' : 'warning',
        title: `${m.name}尚未达标`,
        detail: `最新 ${fmt(m.latest, m.unit)}，目标 ${fmt(m.target, m.unit)}，偏差 ${m.gap_pct ?? 0}%`,
        action: `复盘「${m.name}」的差异来源，明确下月改进动作与责任人。`,
        evidence: { period: m.period, latest: m.latest, target: m.target },
      });
      recommendations.push(
        `「${m.name}」：当前 ${fmt(m.latest, m.unit)}，目标 ${fmt(m.target, m.unit)}；定位差异并给出下月动作。`,
      );
    }
  }

  const latestPoc = experiments[0];
  if (latestPoc) {
    if (latestPoc.latest_accuracy != null) {
      const accuracy = Number(latestPoc.latest_accuracy);
      insights.push({
        code: 'POC-ACC',
        level: accuracy >= 0.95 ? 'positive' : 'warning',
        title: `POC 准确率 ${(accuracy * 100).toFixed(1)}%`,
        detail: `${latestPoc.hypothesis}；目标 ${latestPoc.threshold}`,
        evidence: { sample_size: latestPoc.sample_size, runs: latestPoc.runs, reviews: latestPoc.reviews },
      });
    }
    if (latestPoc.decision === 'go') {
      insights.push({
        code: 'POC-GO',
        level: 'positive',
        title: 'POC 已给出 Go 结论',
        detail: latestPoc.evidence ?? '有结论与证据',
        evidence: { conditions: latestPoc.conditions },
      });
    } else if (latestPoc.decision) {
      insights.push({
        code: 'POC-DECISION',
        level: latestPoc.decision === 'no_go' ? 'critical' : 'warning',
        title: `POC 结论：${latestPoc.decision}`,
        detail: latestPoc.evidence ?? '需要补充证据',
        action: '复核实验设计、样本与失败案例，再决定是否进入交付。',
      });
    } else {
      insights.push({
        code: 'POC-MISSING',
        level: 'critical',
        title: 'POC 还没有结论',
        detail: '有实验数据但未形成 Go / No-Go / 有条件结论',
        action: '补结论与证据，否则不能进入交付。',
      });
    }
  }

  if (plan) {
    const taskTotal = Number(plan.task_count ?? 0);
    const taskDone = Number(plan.task_done ?? 0);
    insights.push({
      code: 'DELIVERY-PROGRESS',
      level: 'info',
      title: `实施计划进度 ${taskDone}/${taskTotal}`,
      detail: `${plan.name}，${plan.start_date} → ${plan.end_date}，里程碑 ${plan.milestones} 个`,
      evidence: { plan_id: plan.id, version: plan.version },
    });
  }
  if (Number(dstats.uat_total ?? 0) > 0) {
    const passed = Number(dstats.uat_passed ?? 0);
    const total = Number(dstats.uat_total ?? 0);
    insights.push({
      code: 'DELIVERY-UAT',
      level: passed === total ? 'positive' : 'warning',
      title: `UAT 通过 ${passed}/${total}`,
      detail: passed === total ? '全部用例已通过' : '仍有未通过用例',
      evidence: { passed, total },
    });
  }
  if (Number(dstats.open_high ?? 0) > 0) {
    insights.push({
      code: 'DELIVERY-ISSUE',
      level: 'critical',
      title: `仍有 ${dstats.open_high} 个未关闭 P0/P1 问题`,
      detail: '上线/验收前必须关闭或书面接受',
      action: '逐条确认负责人、截止日期与风险接受人。',
    });
    recommendations.push('关闭未解决的 P0/P1 问题，或在验收前完成书面风险接受。');
  }
  if (Number(dstats.pending_changes ?? 0) > 0) {
    insights.push({
      code: 'DELIVERY-CHANGE',
      level: 'warning',
      title: `${dstats.pending_changes} 条变更待审批`,
      detail: '变更未审批会影响范围与验收',
      action: '在下次经营会前完成变更审批。',
    });
  }
  if (Number(signoff?.n ?? 0) > 0) {
    insights.push({
      code: 'DELIVERY-SIGNOFF',
      level: 'positive',
      title: 'UAT / 上线检查表已获客户签收',
      detail: `共 ${signoff.n} 条签收记录`,
      evidence: { signoffs: signoff.n },
    });
  }

  if (Number(usageTotals.records) > 0) {
    const ratePct = errorRate * 100;
    insights.push({
      code: 'USAGE-ERROR',
      level: errorRate > 0.05 ? 'warning' : 'positive',
      title: `使用错误率 ${ratePct.toFixed(2)}%`,
      detail: `${usageTotals.records} 条使用记录，错误 ${usageTotals.errors} / 处理量 ${usageTotals.volume}`,
      evidence: usageTotals,
    });
    if (errorRate > 0.05) {
      recommendations.push('使用错误率超过 5%，先定位高频错误类型，再决定是否扩大使用范围。');
    }
  }

  for (const risk of risks) {
    insights.push({
      code: `RISK-${risk.kind}`,
      level: risk.probability === 'high' ? 'critical' : 'warning',
      title: risk.title,
      detail: `${risk.kind === 'renewal' ? '续约' : '二期'}风险；概率 ${risk.probability}；${risk.impact ?? ''}`,
      action: `${risk.action ?? '补充应对动作'}（负责人 ${risk.owner_name ?? '待指定'}，截止 ${risk.due_date ?? '待定'}）`,
      evidence: { risk_id: risk.id, value_potential: risk.value_potential },
    });
    recommendations.push(
      `「${risk.title}」：${risk.action ?? '补充动作'}；负责人 ${risk.owner_name ?? '待指定'}，截止 ${risk.due_date ?? '待定'}。`,
    );
  }

  const missingOwner = solutions.filter((s) => !s.owner_id);
  if (missingOwner.length) {
    insights.push({
      code: 'S2-OWNER',
      level: 'warning',
      title: `${missingOwner.length} 个方案未指定负责人`,
      detail: missingOwner.map((s) => `${s.code} v${s.version}`).join('、'),
      action: '为每个方案指定负责人，避免评审与交付责任悬空。',
    });
  }
  const underQuote = solutions.filter(
    (s) => Number(s.workload_cost) > 0 && Number(s.quote_one_time) > 0 &&
      Number(s.quote_one_time) < Number(s.workload_cost),
  );
  if (underQuote.length) {
    insights.push({
      code: 'S2-MARGIN',
      level: 'warning',
      title: `${underQuote.length} 个方案报价低于工作量成本`,
      detail: underQuote.map((s) => `${s.code} v${s.version}`).join('、'),
      action: '复核报价与范围，必要时调整报价或缩减范围。',
    });
  }

  const blocked = opportunities.filter(
    (o) => o.has_tech_blocker || o.data_status !== 'ready',
  );
  if (blocked.length) {
    insights.push({
      code: 'S1-DATA',
      level: 'warning',
      title: `${blocked.length} 个机会点存在数据/技术前置条件`,
      detail: blocked.map((o) => `${o.code}（${o.data_status}）`).join('、'),
      action: '先补齐数据/接口条件，再扩大试点范围。',
    });
  }

  const achieved = metrics.filter((m) => m.status === 'achieved').length;
  const behind = metrics.filter((m) => m.status === 'behind').length;
  const summary: string[] = [];
  if (solutions.length) {
    summary.push(
      `${solutions.length} 个一期/二期机会点已形成方案；报价合计一次性 ${fmt(quotes[0]?.one_time, ' 万元')}、年运维 ${fmt(quotes[0]?.annual_ops, ' 万元')}。`,
    );
  }
  if (latestPoc) {
    summary.push(
      latestPoc.latest_accuracy != null
        ? `POC 最新复核准确率 ${(Number(latestPoc.latest_accuracy) * 100).toFixed(1)}%，结论 ${latestPoc.decision ?? '待定'}。`
        : `POC 已有 ${latestPoc.runs ?? 0} 次运行，尚未形成人工复核准确率。`,
    );
  }
  if (metrics.length) {
    summary.push(`指标 ${achieved}/${metrics.length} 达标${behind ? `，${behind} 项仍有差距` : ''}。`);
  }
  if (Number(signoff?.n ?? 0) > 0) summary.push('UAT / 上线检查表已获客户签收。');
  if (risks.length) summary.push(`${risks.length} 条续约/二期风险待处理。`);

  const levelOrder: Record<InsightLevel, number> = {
    critical: 0,
    warning: 1,
    positive: 2,
    info: 3,
  };
  insights.sort((a, b) => levelOrder[a.level] - levelOrder[b.level]);

  const evidence = {
    opportunities: opportunities.length,
    solutions: solutions.length,
    quotes: Number(quotes[0]?.quote_count ?? 0),
    experiments: experiments.length,
    plan_tasks: Number(plan?.task_count ?? 0),
    uat_cases: Number(dstats.uat_total ?? 0),
    metrics: metrics.length,
    value_records: metrics.filter((m) => m.latest != null).length,
    usage_records: Number(usageTotals.records ?? 0),
    renewal_risks: risks.length,
  };

  return {
    generated_at: new Date().toISOString(),
    engagement: {
      id: engagement.id,
      name: engagement.name,
      client_name: engagement.client_name,
      stage: engagement.stage,
    },
    summary,
    metrics,
    insights,
    recommendations: Array.from(new Set(recommendations)).slice(0, 8),
    evidence,
  };
}

export function renderInsightsMarkdown(report: InsightReport): string {
  const lines = [
    `# ${report.engagement.client_name} · 经营洞察`,
    '',
    `> 项目：${report.engagement.name}　｜　阶段：${report.engagement.stage}　｜　生成时间：${report.generated_at}`,
    '',
    '## 一、结论',
    '',
    ...report.summary.map((s) => `- ${s}`),
    '',
    '## 二、指标',
    '',
    '| 指标 | 基线 | 目标 | 最新 | 状态 |',
    '|---|---|---|---|---|',
    ...report.metrics.map((m) => [
      m.name,
      `${fmt(m.baseline, m.unit)}`,
      `${fmt(m.target, m.unit)}`,
      `${fmt(m.latest, m.unit)}`,
      m.status === 'achieved' ? '达标' : m.status === 'behind' ? `未达（${m.gap_pct ?? 0}%）` : '缺数据',
    ].join(' | ')).map((row) => `| ${row} |`),
    '',
    '## 三、洞察与风险',
    '',
  ];
  for (const item of report.insights) {
    lines.push(`### ${levelLabel[item.level]}：${item.title}`);
    lines.push('');
    lines.push(item.detail);
    if (item.action) lines.push('', `**建议动作**：${item.action}`);
    lines.push('');
  }
  lines.push('## 四、建议动作', '');
  if (report.recommendations.length) {
    lines.push(...report.recommendations.map((r) => `- ${r}`));
  } else {
    lines.push('暂无需要立即处理的建议。');
  }
  lines.push(
    '',
    '## 五、证据口径',
    '',
    `- 机会点 ${report.evidence.opportunities} 个；方案 ${report.evidence.solutions} 个；实验 ${report.evidence.experiments} 个`,
    `- 实施任务 ${report.evidence.plan_tasks} 个；UAT ${report.evidence.uat_cases} 条；指标 ${report.evidence.metrics} 个`,
    `- 使用记录 ${report.evidence.usage_records} 条；续约/二期风险 ${report.evidence.renewal_risks} 条`,
    '',
    '> 本报告由规则引擎基于项目数据生成，每条结论可追到记录；不是外部模型的主观判断。',
  );
  return `${lines.join('\n')}\n`;
}
