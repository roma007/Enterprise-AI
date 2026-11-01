import { query, one } from './db';
import type {
  Bundle,
  Engagement,
  Opportunity,
  RoiModel,
  SensitivityStage,
  Baseline,
  Limitation,
  Gate,
  PainPoint,
  InventoryItem,
  Dependency,
  Benchmark,
  ClientFinancial,
  Template,
  ProcessNode,
  ProcessEdge,
  Interview,
  Risk,
} from './types';

/** 一次把生成报告需要的全部结构化数据取出来。
 *  报告生成必须基于同一时刻的快照，不能一边查一边算。 */
export async function loadBundle(
  engagementId: string,
  orgId?: string,
): Promise<Bundle | null> {
  const engagement = await one<Engagement>(
    `SELECT e.*, c.name AS client_name, c.sub_industry, c.annual_revenue
       FROM engagements e
       JOIN clients c ON c.id = e.client_id
      WHERE e.id = $1 AND e.deleted_at IS NULL AND c.deleted_at IS NULL${orgId ? ' AND e.org_id = $2' : ''}`,
    orgId ? [engagementId, orgId] : [engagementId],
  );
  if (!engagement) return null;

  const [
    opportunities,
    rois,
    chains,
    baselines,
    limitations,
    gates,
    painPoints,
    inventory,
    dependencies,
    benchmarks,
    financials,
    processNodes,
    processEdges,
    interviews,
    risks,
    template,
  ] = await Promise.all([
    query<Opportunity>(
      `SELECT id, code, title, description, stage, value_score, feasibility_score, urgency,
              data_readiness, score, priority_band, score_rationale, data_status,
              has_tech_blocker, tech_blocker_note, blocker_owner, target_phase, kill_reason
         FROM opportunities WHERE engagement_id = $1 ORDER BY score DESC, code`,
      [engagementId],
    ),
    query<RoiModel>(
      `SELECT r.* FROM roi_models r
         JOIN opportunities o ON o.id = r.opportunity_id
        WHERE o.engagement_id = $1`,
      [engagementId],
    ),
    query<SensitivityStage>(
      `SELECT s.* FROM roi_sensitivity s
         JOIN opportunities o ON o.id = s.opportunity_id
        WHERE o.engagement_id = $1
        ORDER BY s.opportunity_id, s.stage`,
      [engagementId],
    ),
    query<Baseline>(
      `SELECT b.* FROM baselines b
         JOIN opportunities o ON o.id = b.opportunity_id
        WHERE o.engagement_id = $1
        ORDER BY o.code, b.metric`,
      [engagementId],
    ),
    query<Limitation>(
      `SELECT * FROM limitations WHERE engagement_id = $1
        ORDER BY CASE impact_class
                   WHEN 'amount' THEN 1 WHEN 'scope' THEN 2
                   WHEN 'method' THEN 3 ELSE 4 END,
                 severity DESC, created_at`,
      [engagementId],
    ),
    query<Gate>(`SELECT id, code, status, checklist FROM gates WHERE engagement_id = $1 ORDER BY code`, [
      engagementId,
    ]),
    query<PainPoint>(
      `SELECT id, code, description, channel, frequency, severity, quantified_impact,
              source_type, source_ref, status
         FROM pain_points WHERE engagement_id = $1 ORDER BY code`,
      [engagementId],
    ),
    query<InventoryItem>(
      `SELECT id, dimension, category, name, attributes, completeness, verified,
              verified_note, is_implicit, discovered_by
         FROM inventory_items WHERE engagement_id = $1 ORDER BY dimension, name`,
      [engagementId],
    ),
    query<Dependency>(
      `SELECT d.from_id, o1.code AS from_code, d.to_id, o2.code AS to_code, d.type, d.note
         FROM opportunity_dependencies d
         JOIN opportunities o1 ON o1.id = d.from_id
         JOIN opportunities o2 ON o2.id = d.to_id
        WHERE o1.engagement_id = $1`,
      [engagementId],
    ),
    query<Benchmark>(
      `SELECT DISTINCT ON (metric_key) id, industry, metric_key, metric_name, unit, direction,
              p25, p50, p75, year, calibrated, source
         FROM benchmarks
        WHERE industry = 'logistics'
        ORDER BY metric_key, year DESC`,
    ),
    query<ClientFinancial>(
      `SELECT id, metric_key, value, unit, period_start, period_end, source_type, confidence
         FROM client_financials WHERE client_id = $1 ORDER BY metric_key`,
      [engagement.client_id],
    ),
    query<ProcessNode>(
      `SELECT n.id, n.lane, n.name, n.node_type, n.duration_min, n.abnormal_rate,
              n.is_implicit, n.discovered_by, n.sort_order
         FROM process_nodes n
         JOIN process_models m ON m.id = n.model_id
        WHERE m.engagement_id = $1 AND m.status <> 'archived'
        ORDER BY n.sort_order NULLS LAST, n.name`,
      [engagementId],
    ),
    query<ProcessEdge>(
      `SELECT e.from_node_id, e.to_node_id,
              n1.name AS from_name, n2.name AS to_name, e.label, e.condition
         FROM process_edges e
         JOIN process_nodes n1 ON n1.id = e.from_node_id
         JOIN process_nodes n2 ON n2.id = e.to_node_id
         JOIN process_models m ON m.id = e.model_id
        WHERE m.engagement_id = $1 AND m.status <> 'archived'
        ORDER BY n1.sort_order NULLS LAST, n2.sort_order NULLS LAST`,
      [engagementId],
    ),
    query<Interview>(
      `SELECT i.id, s.name AS stakeholder_name, s.title AS stakeholder_title,
              s.role_type AS stakeholder_role, i.date::text AS date,
              i.duration_min, i.mode, i.status, i.ai_summary
         FROM interviews i
         JOIN stakeholders s ON s.id = i.stakeholder_id
        WHERE i.engagement_id = $1 AND i.status <> 'archived'
        ORDER BY i.date, s.name`,
      [engagementId],
    ),
    query<Risk>(
      `SELECT id, title, category, probability, impact, mitigation, status
         FROM risks WHERE engagement_id = $1
        ORDER BY (status = 'open') DESC, (probability * impact) DESC, title`,
      [engagementId],
    ),
    one<Template>(
      `SELECT id, industry, template_key, name, version, kind, payload, is_active
         FROM industry_templates
        WHERE industry = 'logistics' AND template_key = 'logistics_diagnosis'
        ORDER BY (version = '2.2.0') DESC, version DESC
        LIMIT 1`,
    ),
  ]);

  return {
    engagement,
    opportunities,
    rois,
    chains,
    baselines,
    limitations,
    gates,
    painPoints,
    inventory,
    dependencies,
    benchmarks,
    financials,
    processNodes,
    processEdges,
    interviews,
    risks,
    template,
  };
}

/** 按交付物类型取模板；找不到就返回 null，由调用方决定回退口径。 */
export async function templateFor(templateKey: string): Promise<Template | null> {
  return one<Template>(
    `SELECT id, industry, template_key, name, version, kind, payload, is_active
       FROM industry_templates
      WHERE industry = 'logistics' AND template_key = $1
      ORDER BY (version = '2.2.0') DESC, version DESC
      LIMIT 1`,
    [templateKey],
  );
}

export function roiFor(bundle: Bundle, opportunityId: string): RoiModel | undefined {
  return bundle.rois.find((r) => r.opportunity_id === opportunityId);
}

export function chainFor(bundle: Bundle, opportunityId: string): SensitivityStage[] {
  return bundle.chains
    .filter((s) => s.opportunity_id === opportunityId && !s.is_derived)
    .sort((a, b) => a.stage - b.stage);
}

export function derivedFor(bundle: Bundle, opportunityId: string): SensitivityStage[] {
  return bundle.chains.filter((s) => s.opportunity_id === opportunityId && s.is_derived);
}

/** 进入"方案设计/报告推荐"的机会点：有目标期，且没被杀死或搁置 */
export function reportableOpportunities(bundle: Bundle): Opportunity[] {
  return bundle.opportunities.filter(
    (o) =>
      (o.target_phase === 'phase1' || o.target_phase === 'phase2') &&
      o.stage !== 'killed' &&
      o.stage !== 'parked',
  );
}
