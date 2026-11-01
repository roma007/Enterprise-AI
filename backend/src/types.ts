/** 领域类型 · 只声明 MVP 用到的字段，避免和 DDL 手工同步整张表 */

export type ImpactClass = 'amount' | 'scope' | 'method' | 'internal';

export interface Engagement {
  id: string;
  client_id: string;
  org_id: string;
  name: string;
  type: string;
  stage: string;
  status: string;
  owner_id: string | null;
  external_owner: string | null;
  start_date: string | null;
  target_end_date: string | null;
  contract_amount: number | null;
  industry_template_id: string | null;
  client_name: string;
  sub_industry: string | null;
  annual_revenue: number | null;
}

export interface Opportunity {
  id: string;
  code: string;
  title: string;
  description: string | null;
  stage: string;
  value_score: number;
  feasibility_score: number;
  urgency: number;
  data_readiness: number | null;
  score: number;
  priority_band: string;
  score_rationale: string;
  data_status: string;
  has_tech_blocker: boolean;
  tech_blocker_note: string | null;
  blocker_owner: string | null;
  target_phase: string | null;
  kill_reason: string | null;
}

export interface RoiModel {
  id: string;
  opportunity_id: string;
  benefit_type: string;
  formula: string | null;
  conservative_value: number | null;
  neutral_value: number;
  optimistic_value: number | null;
  one_time_cost: number;
  annual_cost: number;
  confidence: string;
  assumptions_note: string | null;
  realization_mode: string | null;
  realization_factor: number | null;
  realization_note: string | null;
  realization_confirmed_by: string | null;
  realization_confirmed_at: string | null;
  realized_value: number | null;
  payback_months: number | null;
  payback_months_with_ops: number | null;
}

export interface SensitivityStage {
  id: string;
  opportunity_id: string;
  stage: number;
  variable_key: string;
  variable_label: string;
  unit: string | null;
  base_value: number | null;
  low_value: number | null;
  high_value: number | null;
  mult_base: number;
  mult_low: number | null;
  mult_high: number | null;
  shape: 'linear' | 'threshold';
  threshold_note: string | null;
  controllable: boolean;
  owner_role: string | null;
  is_derived: boolean;
  depends_on: string[];
  note: string | null;
}

export interface Baseline {
  id: string;
  opportunity_id: string;
  metric: string;
  value: number;
  unit: string | null;
  source: string;
  collected_at: string | null;
  confidence: 'high' | 'medium' | 'low';
}

export interface Limitation {
  id: string;
  engagement_id: string;
  source_type: string;
  source_id: string | null;
  title: string;
  detail: string;
  affected_refs: string[];
  impact_class: ImpactClass;
  severity: number;
}

export interface Gate {
  id: string;
  code: string;
  status: string;
  checklist: Array<{ item: string; passed: boolean; note?: string; actual?: number; required?: number }>;
}

export interface PainPoint {
  id: string;
  code: string;
  description: string;
  channel: string | null;
  frequency: string | null;
  severity: number | null;
  quantified_impact: string | null;
  source_type: string;
  source_ref: string;
  status: string;
}

export interface InventoryItem {
  id: string;
  dimension: string;
  category: string | null;
  name: string;
  attributes: Record<string, any>;
  completeness: number;
  verified: boolean;
  verified_note: string | null;
  is_implicit: boolean;
  discovered_by: string | null;
}

export interface Dependency {
  from_id: string;
  from_code: string;
  to_id: string;
  to_code: string;
  type: 'requires' | 'blocks' | 'enables';
  note: string | null;
}

export interface Benchmark {
  id: string;
  industry: string;
  metric_key: string;
  metric_name: string;
  unit: string;
  direction: 'higher_better' | 'lower_better';
  p25: number | null;
  p50: number | null;
  p75: number | null;
  year: number;
  calibrated: boolean;
  source: string;
}

export interface ClientFinancial {
  id: string;
  metric_key: string;
  value: number;
  unit: string;
  period_start: string;
  period_end: string;
  source_type: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface Template {
  id: string;
  industry: string;
  template_key: string;
  name: string;
  version: string;
  kind: string;
  payload: Record<string, any>;
  is_active: boolean;
}

export interface ProcessNode {
  id: string;
  lane: string;
  name: string;
  node_type: string;
  duration_min: number | null;
  abnormal_rate: number | null;
  is_implicit: boolean;
  discovered_by: string | null;
  sort_order: number | null;
}

export interface ProcessEdge {
  from_node_id: string;
  to_node_id: string;
  from_name: string;
  to_name: string;
  label: string | null;
  condition: string | null;
}

export interface Interview {
  id: string;
  stakeholder_name: string;
  stakeholder_title: string | null;
  stakeholder_role: string;
  date: string;
  duration_min: number | null;
  mode: string;
  status: string;
  ai_summary: string | null;
}

export interface Risk {
  id: string;
  title: string;
  category: 'data' | 'tech' | 'org' | 'commercial' | 'compliance';
  probability: number;
  impact: number;
  mitigation: string | null;
  status: 'open' | 'mitigated' | 'closed';
}

export interface Bundle {
  engagement: Engagement;
  opportunities: Opportunity[];
  rois: RoiModel[];
  chains: SensitivityStage[];
  baselines: Baseline[];
  limitations: Limitation[];
  gates: Gate[];
  painPoints: PainPoint[];
  inventory: InventoryItem[];
  dependencies: Dependency[];
  benchmarks: Benchmark[];
  financials: ClientFinancial[];
  processNodes: ProcessNode[];
  processEdges: ProcessEdge[];
  interviews: Interview[];
  risks: Risk[];
  template: Template | null;
}
