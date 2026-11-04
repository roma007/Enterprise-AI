export interface EngagementSummary {
  id: string;
  name: string;
  stage: string;
  status: string;
  type: string;
  start_date: string | null;
  target_end_date: string | null;
  client_name: string;
  sub_industry: string | null;
  opportunity_count: number;
  pain_point_count: number;
  deliverable_count: number;
}

export interface Client {
  id: string;
  name: string;
  industry: string;
  sub_industry: string | null;
  scale: string | null;
  region: string | null;
  annual_revenue: number | null;
  tags: string[];
  engagement_count?: number;
}

export interface RoiSummary {
  neutralValue: number;
  realizationFactor: number | null;
  realizedValue: number | null;
  oneTimeCost: number;
  annualCost: number;
  paybackMonths: number | null;
  paybackMonthsWithOps: number | null;
  confidence: string;
}

export interface OpportunitySummary {
  id: string;
  code: string;
  title: string;
  score: number;
  priorityBand: string;
  stage: string;
  targetPhase: string | null;
  dataStatus: string;
  hasTechBlocker: boolean;
  roi: RoiSummary | null;
}

export interface GateItem {
  item: string;
  passed: boolean;
  note?: string;
  actual?: number;
  required?: number;
}

export interface Gate {
  id: string;
  code: string;
  status: string;
  checklist: GateItem[];
}

export interface Limitation {
  id: string;
  title: string;
  detail?: string;
  source_type?: string;
  impactClass: 'amount' | 'scope' | 'method' | 'internal' | string;
  affectedRefs: string[];
  severity: number;
  inCustomerDoc: boolean;
}

export interface EngagementDetail {
  engagement: {
    id: string;
    client_id: string;
    name: string;
    type: string;
    stage: string;
    status: string;
    owner_id: string | null;
    external_owner: string | null;
    start_date: string | null;
    target_end_date: string | null;
    contract_amount: number | null;
    client_name: string;
    sub_industry: string | null;
    annual_revenue: number | null;
  };
  counts: Record<string, number>;
  opportunities: OpportunitySummary[];
  gates: Gate[];
  limitations: Limitation[];
  template: { template_key: string; version: string; name: string } | null;
}

export interface Stakeholder {
  id: string;
  client_id: string;
  name: string;
  title: string | null;
  department: string | null;
  role_type: string;
  influence: number;
  attitude: string;
  concerns: string[];
  is_key: boolean;
  notes: string | null;
}

export interface Interview {
  id: string;
  stakeholder_id: string;
  stakeholder_name?: string;
  date: string;
  duration_min: number | null;
  mode: string;
  transcript: string | null;
  ai_summary: string | null;
  status: string;
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
  dimension: 'business' | 'data' | 'system' | 'org' | string;
  category: string | null;
  name: string;
  attributes: Record<string, unknown>;
  completeness: number;
  verified: boolean;
  verified_note: string | null;
  is_implicit: boolean;
  discovered_by: string | null;
}

export interface ProcessNode {
  id: string;
  lane: string;
  name: string;
  node_type: string;
  owner_role: string | null;
  duration_min: number | null;
  abnormal_rate: number | null;
  is_implicit: boolean;
  discovered_by: string | null;
  sort_order: number | null;
}

export interface ProcessEdge {
  id: string;
  from_node_id: string;
  to_node_id: string;
  label: string | null;
  condition: string | null;
}

export interface ProcessModel {
  item: { id: string; version: number; status: string } | null;
  nodes: ProcessNode[];
  edges: ProcessEdge[];
}

export interface OpportunityRow {
  id: string;
  engagement_id: string;
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
  target_phase: string | null;
  kill_reason: string | null;
}

export interface Baseline {
  id: string;
  opportunity_id: string;
  metric: string;
  value: number;
  unit: string | null;
  source: string;
  collected_at: string | null;
  confidence: string;
}

export interface RoiModel {
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
  realization_confirmed_at: string | null;
  realized_value: number | null;
  payback_months: number | null;
  payback_months_with_ops: number | null;
}

export interface ChainStage {
  id?: string;
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

export interface OpportunityDetail {
  item: OpportunityRow;
  painPoints: PainPoint[];
  baselines: Baseline[];
  roi: RoiModel | null;
  chain: ChainStage[];
}

export interface Deliverable {
  id: string;
  type: string;
  title: string;
  version: number;
  status: string;
  template_id: string | null;
  template_version: string | null;
  chars?: number;
  is_stale?: boolean;
  review_id?: string | null;
  share_count?: number;
  last_shared_at?: string | null;
  created_at: string;
}

export interface DeliverableShare {
  id: string;
  deliverable_id: string;
  deliverable_title?: string;
  deliverable_type?: string;
  deliverable_version?: number;
  shared_to: string;
  shared_to_name?: string;
  shared_to_title?: string | null;
  channel: string;
  shared_at: string;
  note: string | null;
  token: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  view_count: number;
  last_viewed_at: string | null;
}

export interface PublicShareData {
  share: {
    token: string;
    shared_at: string;
    expires_at: string | null;
    shared_to_name: string;
    view_count: number;
    note: string | null;
  };
  deliverable: {
    id: string;
    title: string;
    version: number;
    type: string;
    markdown: string;
  };
  project: {
    name: string;
    client: string;
  };
}

export interface User {
  id: string;
  name: string;
  email: string;
}

export interface Risk {
  id: string;
  title: string;
  category: string;
  probability: number;
  impact: number;
  mitigation: string | null;
  status: string;
  owner: string | null;
  owner_name?: string | null;
  due_date: string | null;
}

export interface Dependency {
  id: string;
  from_id: string;
  to_id: string;
  from_code: string;
  to_code: string;
  type: string;
  note: string | null;
}

export interface ApiErrorBody {
  error?: string;
  message?: string;
  requestId?: string;
  issues?: Array<{ path: string; message: string }>;
}

export type ImportKind = 'pains' | 'inventory' | 'opportunities';

export interface Confirmation {
  id: string;
  engagement_id: string;
  object_type: 'flowchart' | 'pain_point' | 'opportunity' | 'deliverable';
  object_id: string;
  object_label?: string | null;
  confirmed_by: string;
  confirmed_by_name?: string;
  confirmed_by_title?: string | null;
  method: 'meeting' | 'email' | 'wechat' | 'signature';
  evidence: string | null;
  confirmed_at: string;
}

export interface Benchmark {
  id: string;
  industry: string;
  sub_industry: string;
  metric_key: string;
  metric_name: string;
  unit: string;
  direction: 'higher_better' | 'lower_better';
  p25: number | null;
  p50: number | null;
  p75: number | null;
  source: string;
  source_url: string | null;
  sample_size: number | null;
  year: number;
  region: string;
  calibrated: boolean;
  created_at: string;
}

export interface TrashItem {
  batch: string;
  deleted_at: string;
  object_type: 'client' | 'engagement' | 'deliverable';
  id: string;
  title: string;
}

export interface TrashBatch {
  batch: string;
  deleted_at: string;
  items: TrashItem[];
}

export interface AuditLog {
  id: string;
  org_id: string | null;
  user_id: string | null;
  user_name?: string | null;
  action: string;
  object_type: string | null;
  object_id: string | null;
  status_code: number | null;
  request_id: string | null;
  ip: string | null;
  user_agent: string | null;
  detail: Record<string, unknown>;
  created_at: string;
  archived_at?: string | null;
}

export interface Solution {
  id: string;
  opportunity_id: string;
  version: number;
  status: 'draft' | 'in_review' | 'approved' | 'rejected' | 'archived';
  scope: string;
  approach: string | null;
  architecture: string | null;
  deployment: string | null;
  security: string | null;
  assumptions: string | null;
  exclusions: string | null;
  created_at: string;
  updated_at: string;
  opportunity_code?: string;
  opportunity_title?: string;
  component_count?: number;
  workload_cost?: number;
  criteria_count?: number;
}

export interface SolutionComponent {
  id: string;
  solution_id: string;
  name: string;
  type: 'build' | 'buy' | 'integrate' | 'service';
  description: string | null;
  effort_days: number;
  sort_order: number;
}

export interface Integration {
  id: string;
  solution_id: string;
  system: string;
  direction: 'inbound' | 'outbound' | 'bidirectional';
  protocol: string | null;
  fields: string | null;
  frequency: string | null;
  owner: string | null;
  risk: string | null;
  sort_order: number;
}

export interface WorkloadEstimate {
  id: string;
  solution_id: string;
  role: string;
  days: number;
  rate: number;
  cost: number;
}

export interface AcceptanceCriterion {
  id: string;
  solution_id: string;
  metric: string;
  baseline: string | null;
  target: string;
  method: string;
  owner: string | null;
  status: 'pending' | 'met' | 'not_met' | 'waived';
  sort_order: number;
}

export interface SolutionReview {
  id: string;
  solution_id: string;
  reviewer: string | null;
  reviewer_name?: string | null;
  decision: 'approved' | 'rejected' | 'changes_requested';
  comments: string | null;
  reviewed_at: string;
}

export interface SolutionDetail {
  item: Solution & {
    opportunity_code: string;
    opportunity_title: string;
    engagement_id: string;
    engagement_name: string;
  };
  components: SolutionComponent[];
  integrations: Integration[];
  workload: WorkloadEstimate[];
  workloadTotal: number;
  acceptanceCriteria: AcceptanceCriterion[];
  reviews: SolutionReview[];
}

export interface Quote {
  id: string;
  engagement_id: string;
  version: number;
  currency: string;
  payment_terms: string | null;
  valid_until: string | null;
  status: string;
  notes: string | null;
  one_time?: number;
  annual_ops?: number;
  item_count?: number;
  engagement_name?: string;
  created_at: string;
}

export interface QuoteItem {
  id: string;
  quote_id: string;
  solution_id: string | null;
  kind: 'one_time' | 'annual_ops';
  description: string;
  qty: number;
  unit_price: number;
  amount: number;
  sort_order: number;
}

export interface QuoteDetail {
  item: Quote;
  items: QuoteItem[];
  totals: { oneTime: number; annualOps: number };
}

export interface G2Check {
  code: string;
  title: string;
  level: 'block' | 'warn';
  outcome: 'pass' | 'warn' | 'block';
  message: string;
  evidence?: unknown;
}

export interface G2Checks {
  summary: { pass: number; warn: number; block: number };
  blocked: boolean;
  checks: G2Check[];
}

export interface PocDataset {
  id: string;
  experiment_id: string;
  name: string;
  source: string | null;
  sample_count: number | null;
  fields: string | null;
  access_status: 'pending' | 'approved' | 'rejected' | 'not_required';
  version: string | null;
  note: string | null;
  created_at: string;
}

export interface PocRun {
  id: string;
  experiment_id: string;
  run_no: number;
  dataset_id: string | null;
  dataset_name?: string | null;
  config: string | null;
  started_at: string;
  finished_at: string | null;
  metrics: Record<string, unknown>;
  issues: string | null;
  created_at: string;
}

export interface PocReview {
  id: string;
  run_id: string;
  reviewer: string | null;
  reviewer_name?: string | null;
  sample_count: number | null;
  accuracy: number | null;
  false_positive: number | null;
  notes: string | null;
  reviewed_at: string;
}

export interface PocConclusion {
  id: string;
  experiment_id: string;
  decision: 'go' | 'no_go' | 'conditional' | 'pending';
  evidence: string;
  conditions: string | null;
  decided_by: string | null;
  decided_at: string;
}

export interface PocExperiment {
  id: string;
  opportunity_id: string;
  version: number;
  hypothesis: string;
  method: string;
  sample_size: number | null;
  success_metric: string;
  threshold: string;
  start_date: string | null;
  end_date: string | null;
  owner: string | null;
  status: 'planned' | 'running' | 'reviewing' | 'passed' | 'failed' | 'cancelled';
  created_at: string;
  updated_at: string;
  opportunity_code?: string;
  opportunity_title?: string;
  target_phase?: string | null;
  stage?: string;
  dataset_count?: number;
  run_count?: number;
  review_count?: number;
  decision?: string | null;
}

export interface PocDetail {
  item: PocExperiment & {
    opportunity_code: string;
    opportunity_title: string;
    engagement_id: string;
    stage: string;
  };
  datasets: PocDataset[];
  runs: PocRun[];
  reviews: PocReview[];
  conclusion: PocConclusion | null;
}

export interface G3Checks {
  summary: { pass: number; warn: number; block: number };
  blocked: boolean;
  checks: G2Check[];
}

export interface DeliveryPlan {
  id: string;
  engagement_id: string;
  version: number;
  name: string;
  start_date: string;
  end_date: string;
  status: 'draft' | 'active' | 'completed' | 'on_hold' | 'cancelled';
  owner: string | null;
  owner_name?: string | null;
  notes: string | null;
  task_count?: number;
  milestone_count?: number;
  done_count?: number;
  created_at: string;
  updated_at: string;
}

export interface DeliveryTask {
  id: string;
  plan_id: string;
  phase: string;
  name: string;
  owner: string | null;
  owner_name?: string | null;
  start_date: string | null;
  end_date: string | null;
  status: 'todo' | 'doing' | 'done' | 'blocked';
  progress: number;
  is_milestone: boolean;
  dependency: string | null;
  note: string | null;
  sort_order: number;
}

export interface UatCase {
  id: string;
  engagement_id: string;
  acceptance_id: string | null;
  acceptance_metric?: string | null;
  code: string;
  scenario: string;
  steps: string;
  expected: string;
  actual: string | null;
  status: 'pending' | 'passed' | 'failed' | 'blocked' | 'skipped';
  owner: string | null;
  owner_name?: string | null;
  executed_at: string | null;
  note: string | null;
}

export interface GoLiveItem {
  id: string;
  engagement_id: string;
  category: string;
  item: string;
  status: 'pending' | 'passed' | 'failed' | 'waived';
  blocking: boolean;
  owner: string | null;
  owner_name?: string | null;
  evidence: string | null;
  checked_at: string | null;
  sort_order: number;
}

export interface Training {
  id: string;
  engagement_id: string;
  title: string;
  audience: string | null;
  mode: 'onsite' | 'video' | 'online';
  trainer: string | null;
  trainer_name?: string | null;
  scheduled_at: string | null;
  attendees: number | null;
  materials: string | null;
  status: 'planned' | 'done' | 'cancelled';
  feedback: string | null;
}

export interface DeliveryIssue {
  id: string;
  engagement_id: string;
  code: string;
  kind: 'issue' | 'change';
  title: string;
  description: string | null;
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  status: 'open' | 'in_progress' | 'resolved' | 'closed' | 'rejected';
  owner: string | null;
  owner_name?: string | null;
  due_date: string | null;
  resolution: string | null;
  impact: string | null;
  approval_status: 'not_required' | 'pending' | 'approved' | 'rejected';
  approved_by: string | null;
  approved_by_name?: string | null;
  approved_at: string | null;
  raised_at: string;
  closed_at: string | null;
}

export interface DeliveryOverview {
  plans: DeliveryPlan[];
  activePlan: DeliveryPlan | null;
  tasks: DeliveryTask[];
  uat: UatCase[];
  goLive: GoLiveItem[];
  trainings: Training[];
  issues: DeliveryIssue[];
  criteria: Array<{
    id: string;
    metric: string;
    baseline: string | null;
    target: string;
    method: string;
    owner: string | null;
    status: string;
    solution_version: number;
  }>;
}

export interface G4Checks {
  summary: { pass: number; warn: number; block: number };
  blocked: boolean;
  checks: G2Check[];
}

export interface MetricDefinition {
  id: string;
  key: string;
  name: string;
  unit: string;
  direction: 'higher_better' | 'lower_better';
  category: string;
  formula: string | null;
  source: string | null;
  description: string | null;
}

export interface MetricTarget {
  id: string;
  engagement_id: string;
  opportunity_id: string;
  metric_id: string;
  metric_name?: string;
  unit?: string;
  direction?: string;
  opportunity_code?: string;
  opportunity_title?: string;
  baseline: number | null;
  target: number | null;
  target_date: string | null;
  owner: string | null;
  owner_name?: string | null;
  note: string | null;
  snapshot_count?: number;
  value_count?: number;
}

export interface MetricSnapshot {
  id: string;
  target_id: string;
  period: string;
  value: number;
  source: string;
  confidence: 'high' | 'medium' | 'low';
  note: string | null;
  recorded_by: string | null;
  recorded_by_name?: string | null;
  recorded_at: string;
  metric_name?: string;
  unit?: string;
  target?: number | null;
  opportunity_id?: string;
  opportunity_code?: string;
}

export interface ValueRecord {
  id: string;
  engagement_id: string;
  opportunity_id: string;
  target_id: string | null;
  metric_id: string;
  period: string;
  realized_value: number;
  method: string;
  evidence: string;
  confidence: 'high' | 'medium' | 'low';
  variance_note: string | null;
  verified_by: string | null;
  verified_by_name?: string | null;
  metric_name?: string;
  unit?: string;
  opportunity_code?: string;
  opportunity_title?: string;
  target?: number | null;
}

export interface UsageRecord {
  id: string;
  engagement_id: string;
  solution_id: string | null;
  period: string;
  active_users: number;
  volume: number;
  errors: number;
  source: string;
  note: string | null;
  solution_version?: number | null;
}

export interface RenewalRisk {
  id: string;
  engagement_id: string;
  kind: 'renewal' | 'expansion';
  title: string;
  probability: 'high' | 'medium' | 'low';
  impact: string | null;
  action: string | null;
  owner: string | null;
  owner_name?: string | null;
  due_date: string | null;
  value_potential: number | null;
  status: 'open' | 'mitigating' | 'closed';
  note: string | null;
}

export interface ValueOverview {
  metrics: MetricDefinition[];
  targets: MetricTarget[];
  snapshots: MetricSnapshot[];
  values: ValueRecord[];
  usage: UsageRecord[];
  risks: RenewalRisk[];
  totals: {
    targets: number;
    snapshots: number;
    values: number;
    activeUsers: number;
    openRisks: number;
    realizedValue: number;
  };
}

export interface G5Checks {
  summary: { pass: number; warn: number; block: number };
  blocked: boolean;
  checks: G2Check[];
}

export interface KnowledgeItem {
  id: string;
  org_id: string;
  industry: string;
  category: 'opportunity' | 'pattern' | 'template' | 'lesson' | 'case';
  title: string;
  summary: string;
  content: string;
  tags: string[];
  source: string | null;
  engagement_id: string | null;
  expires_at: string | null;
  status: 'draft' | 'published' | 'archived';
  created_by: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeMatch {
  item: KnowledgeItem;
  score: number;
  reason: string;
}

export interface AiDraft {
  id: string;
  engagement_id: string;
  kind:
    | 'interview_summary'
    | 'report_draft'
    | 'solution_skeleton'
    | 'prd_skeleton'
    | 'answer';
  source_type: string | null;
  source_id: string | null;
  title: string;
  prompt: string | null;
  content: string;
  model: string;
  status: 'draft' | 'confirmed' | 'rejected';
  created_by: string | null;
  created_by_name?: string | null;
  confirmed_by: string | null;
  confirmed_by_name?: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EngagementMember {
  id: string;
  engagement_id: string;
  user_id: string;
  role: 'manager' | 'member' | 'viewer';
  name: string;
  email: string;
  status: string;
  added_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PdfJob {
  id: string;
  deliverable_id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  cache_key: string | null;
  error: string | null;
  requested_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  title?: string;
  version?: number;
}

export interface ShareView {
  id: string;
  share_id: string;
  kind: 'view' | 'docx' | 'pdf';
  ip: string | null;
  user_agent: string | null;
  referer: string | null;
  viewed_at: string;
}

export interface UserSession {
  id: string;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
  current: boolean;
  active: boolean;
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  status: 'active' | 'disabled';
  role: 'admin' | 'director' | 'pm' | 'consultant' | 'tech_lead';
  last_login_at: string | null;
  created_at: string;
  active_sessions: number;
}

export type PlanCode = 'trial' | 'free' | 'pro' | 'enterprise';

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  plan: PlanCode;
  status: 'active' | 'suspended';
  settings: Record<string, unknown>;
  created_at: string;
  trial_ends_at: string | null;
  billing_email: string | null;
  plan_name?: string | null;
  trial_days_left?: number | null;
  user_count: number;
  client_count: number;
  engagement_count: number;
}

export interface PlanDefinition {
  code: PlanCode;
  name: string;
  description: string;
  price_monthly: number;
  price_yearly: number;
  currency: string;
  max_users: number;
  max_clients: number;
  max_engagements: number;
  max_pdf_jobs_month: number;
}

export interface OrgBilling {
  id: string;
  name: string;
  slug: string;
  plan: PlanCode;
  plan_name: string;
  plan_status: 'trialing' | 'trial_expired' | 'active' | 'expired' | 'suspended';
  status: 'active' | 'suspended';
  trial_ends_at: string | null;
  days_left: number | null;
  plan_started_at: string | null;
  plan_expires_at: string | null;
  renewal_days_left: number | null;
  auto_renew: boolean;
  billing_cycle: 'monthly' | 'yearly';
  billing_email: string | null;
  limits: {
    users: number;
    clients: number;
    engagements: number;
    pdf_jobs_month: number;
  };
  usage: {
    users: number;
    clients: number;
    engagements: number;
    pdf_jobs_month: number;
  };
  price: { currency: string; monthly: number; yearly: number };
}

export interface Invoice {
  id: string;
  org_id: string;
  invoice_no: string;
  plan: string;
  cycle: 'monthly' | 'yearly';
  amount: number;
  currency: string;
  status: 'pending' | 'paid' | 'void' | 'overdue';
  period_start: string;
  period_end: string;
  due_at: string;
  paid_at: string | null;
  provider: string;
  external_id: string | null;
  created_at: string;
  org_name?: string;
  org_slug?: string;
}

export interface ReconcileDifference {
  difference_id?: string;
  type: string;
  waybill_no?: string | null;
  trip_no?: string | null;
  statement_amount?: number | null;
  system_amount?: number | null;
  delta?: number | null;
  evidence?: string[];
  possible_causes?: string[];
  suggested_action?: string | null;
  confidence?: number;
  source?: string;
}

export interface ReconcileDecision {
  difference_id: string;
  decision: string;
  note?: string;
}

export interface CopilotReconcileReview {
  id: string;
  kind: 'statement' | 'settlement';
  document_id: string | null;
  status: string;
  summary: Record<string, unknown>;
  differences: ReconcileDifference[];
  decisions: ReconcileDecision[];
  risk_id?: string | null;
  issue_id?: string | null;
  source: string;
  received_at: string;
}

export interface ReconcileAction {
  id: string;
  difference_id: string;
  action_type: 'risk' | 'issue';
  target_id: string;
  item_code?: string | null;
  item_title?: string | null;
  item_status?: string | null;
  created_at: string;
}

export interface CopilotReconcileReviewDetail extends CopilotReconcileReview {
  risk_status?: string | null;
  issue_status?: string | null;
  actions?: ReconcileAction[];
  document: Record<string, unknown> & {
    lines?: Array<Record<string, unknown>>;
    statement_no?: string | null;
    settlement_no?: string | null;
    customer_name?: string | null;
    carrier_name?: string | null;
    period_start?: string | null;
    period_end?: string | null;
    total_amount?: number | null;
  };
  payload?: Record<string, unknown>;
}

export interface Holiday {
  id: string;
  org_id: string | null;
  region: string;
  date: string;
  name: string;
  active: boolean;
}

export interface ReconcileBatch {
  id: string;
  review_id: string;
  parent_batch_id: string | null;
  action_type: 'risk' | 'issue';
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  requested_count: number;
  created_count: number;
  skipped_count: number;
  failed_count: number;
  owner: string | null;
  severity: string;
  due_date: string | null;
  created_by: string | null;
  created_by_name?: string | null;
  created_at: string;
  finished_at: string | null;
  failed_difference_ids?: string[];
  remaining_difference_ids?: string[];
  has_child?: boolean;
  parent_relation?: 'retry' | 'resume' | null;
  depth?: number;
  difference_ids?: string[];
  cancelled_by?: string | null;
  cancelled_by_name?: string | null;
  cancel_reason?: string | null;
  cancelled_at?: string | null;
}

export interface BatchFilterView {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | null;
  action_type: 'risk' | 'issue' | null;
  from: string | null;
  to: string | null;
  shared: boolean;
  shared_role: 'admin' | 'director' | 'pm' | 'consultant' | 'tech_lead' | null;
  shared_user_ids: string[];
  is_owner: boolean;
  owner_name?: string | null;
  created_at: string;
  updated_at: string;
}

export interface NotificationFilterView {
  id: string;
  name: string;
  kind: string | null;
  unread: boolean;
  from: string | null;
  to: string | null;
  scope: 'inbox' | 'trash';
  created_at: string;
  updated_at: string;
}

export interface UserNotification {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  ref_type: string | null;
  ref_id: string | null;
  read_at: string | null;
  deleted_at: string | null;
  created_at: string;
  actor_name?: string | null;
}

export interface BatchFilterViewAudit {
  id: string;
  action: string;
  user_id: string | null;
  actor_name?: string | null;
  detail: Record<string, any>;
  created_at: string;
  archived_at?: string | null;
  is_archived?: boolean;
}

export interface NotificationAudit {
  id: string;
  action: string;
  user_id: string | null;
  actor_name?: string | null;
  detail: Record<string, any>;
  created_at: string;
}

export interface CollabAudit {
  id: string;
  audit_type: 'notification' | 'filter_view' | 'export' | 'decision';
  action: string;
  user_id: string | null;
  actor_name?: string | null;
  object_id?: string | null;
  request_id?: string | null;
  engagement_id?: string | null;
  detail: Record<string, any>;
  created_at: string;
  archived_at?: string | null;
}
