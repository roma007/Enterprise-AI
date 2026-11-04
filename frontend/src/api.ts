import { authHeaders, type StoredUser } from './auth';
import type {
  ApiErrorBody,
  AuditLog,
  Baseline,
  Benchmark,
  ChainStage,
  Client,
  Deliverable,
  DeliverableShare,
  Confirmation,
  Dependency,
  ImportKind,
  EngagementDetail,
  EngagementSummary,
  Gate,
  InventoryItem,
  Interview,
  Limitation,
  OpportunityDetail,
  OpportunityRow,
  PainPoint,
  ProcessModel,
  Risk,
  RoiModel,
  Quote,
  QuoteDetail,
  G2Checks,
  G3Checks,
  DeliveryOverview,
  DeliveryPlan,
  DeliveryTask,
  UatCase,
  GoLiveItem,
  Training,
  DeliveryIssue,
  G4Checks,
  G5Checks,
  KnowledgeItem,
  KnowledgeMatch,
  AiDraft,
  EngagementMember,
  PdfJob,
  PublicShareData,
  ShareView,
  UserSession,
  AdminUser,
  OrganizationSummary,
  OrgBilling,
  PlanDefinition,
  Invoice,
  CopilotReconcileReview,
  CopilotReconcileReviewDetail,
  ReconcileBatch,
  ReconcileDecision,
  BatchFilterView,
  UserNotification,
  BatchFilterViewAudit,
  NotificationAudit,
  CollabAudit,
  Holiday,
  ValueOverview,
  MetricTarget,
  MetricSnapshot,
  ValueRecord,
  UsageRecord,
  RenewalRisk,
  PocDetail,
  PocExperiment,
  Solution,
  SolutionDetail,
  Stakeholder,
  TrashBatch,
  User,
} from './types';

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

export interface BatchExportFilters {
  status?: 'running' | 'completed' | 'failed' | 'cancelled';
  action_type?: 'risk' | 'issue';
  from?: string;
  to?: string;
}

function batchExportQuery(filters: BatchExportFilters = {}): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.action_type) params.set('action_type', filters.action_type);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export interface BatchActionEvent {
  difference_id?: string;
  status?: 'created' | 'duplicate' | 'failed';
  item_id?: string;
  item_code?: string | null;
  action_id?: string | null;
  code?: string;
  error?: string;
  done?: boolean;
  created?: number;
  skipped?: number;
  failed?: number;
  cancelled?: boolean;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  issues?: Array<{ path: string; message: string }>;
  details?: any;

  constructor(status: number, body: ApiErrorBody | null) {
    super(body?.message ?? body?.error ?? `请求失败（${status}）`);
    this.status = status;
    this.code = body?.error;
    this.issues = body?.issues;
    this.details = body;
  }
}

async function requestStream(
  path: string,
  body: unknown,
  onEvent: (event: BatchActionEvent) => void,
): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    let parsed: any = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    throw new ApiError(res.status, parsed as ApiErrorBody);
  }
  if (!res.body) {
    throw new ApiError(500, { error: 'NO_STREAM', message: '浏览器不支持流式响应' } as ApiErrorBody);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      onEvent(JSON.parse(line) as BatchActionEvent);
    }
  }
  const tail = buffer.trim();
  if (tail) onEvent(JSON.parse(tail) as BatchActionEvent);
}

async function requestBlob(path: string): Promise<Blob> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (!res.ok) {
    const text = await res.text();
    let body: any = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    throw new ApiError(res.status, body as ApiErrorBody);
  }
  return res.blob();
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...authHeaders(),
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) throw new ApiError(res.status, body as ApiErrorBody);
  return body as T;
}

const json = (method: string, payload: unknown): RequestInit => ({
  method,
  body: JSON.stringify(payload),
});

function pageQuery(limit?: number, offset?: number, q?: string) {
  const params = new URLSearchParams();
  if (limit != null) params.set('limit', String(limit));
  if (offset != null) params.set('offset', String(offset));
  if (q?.trim()) params.set('q', q.trim());
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export interface SnapshotPeriod {
  start: string;
  end: string;
  total: number;
  delta_total: number;
  delta_notification: number;
  delta_filter_view: number;
  delta_export: number;
}

export const api = {
  health: () => request<{ ok: boolean; db: { tables: number } }>('/api/health'),

  // 项目
  listEngagements: (params: { limit?: number; offset?: number; q?: string } = {}) =>
    request<{ items: EngagementSummary[]; total: number; limit: number; offset: number }>(
      `/api/engagements${pageQuery(params.limit, params.offset, params.q)}`,
    ),
  getEngagement: (id: string) =>
    request<EngagementDetail>(`/api/engagements/${id}`),
  createEngagement: (payload: Record<string, unknown>) =>
    request<{ item: { id: string }; gates: Gate[] }>(
      '/api/engagements',
      json('POST', payload),
    ),
  updateEngagement: (id: string, payload: Record<string, unknown>) =>
    request<{ item: EngagementSummary }>(`/api/engagements/${id}`, json('PATCH', payload)),

  // 客户
  listClients: (params: { limit?: number; offset?: number; q?: string } = {}) =>
    request<{ items: Client[]; total: number; limit: number; offset: number }>(
      `/api/clients${pageQuery(params.limit, params.offset, params.q)}`,
    ),
  createClient: (payload: Record<string, unknown>) =>
    request<{ item: Client }>('/api/clients', json('POST', payload)),

  // 门禁
  listGates: (id: string) =>
    request<{ items: Gate[] }>(`/api/engagements/${id}/gates`),
  updateGate: (id: string, code: string, payload: Record<string, unknown>) =>
    request<{ item: Gate }>(`/api/engagements/${id}/gates/${code}`, json('PUT', payload)),
  refreshGates: (id: string) =>
    request<{ item: Gate }>(`/api/engagements/${id}/gates/refresh`, json('POST', {})),

  // 干系人 / 访谈
  listStakeholders: (id: string) =>
    request<{ items: Stakeholder[] }>(`/api/engagements/${id}/stakeholders`),
  createStakeholder: (id: string, payload: Record<string, unknown>) =>
    request<{ item: Stakeholder }>(
      `/api/engagements/${id}/stakeholders`,
      json('POST', payload),
    ),
  deleteStakeholder: (sid: string) =>
    request<{ ok: boolean }>(`/api/stakeholders/${sid}`, { method: 'DELETE' }),

  listInterviews: (id: string) =>
    request<{ items: Interview[] }>(`/api/engagements/${id}/interviews`),
  createInterview: (id: string, payload: Record<string, unknown>) =>
    request<{ item: Interview }>(`/api/engagements/${id}/interviews`, json('POST', payload)),
  deleteInterview: (iid: string) =>
    request<{ ok: boolean }>(`/api/interviews/${iid}`, { method: 'DELETE' }),

  // 痛点
  listPains: (id: string, params: { limit?: number; offset?: number; q?: string } = {}) =>
    request<{ items: PainPoint[]; total: number; limit: number; offset: number }>(
      `/api/engagements/${id}/pain-points${pageQuery(params.limit, params.offset, params.q)}`,
    ),
  createPain: (id: string, payload: Record<string, unknown>) =>
    request<{ item: PainPoint }>(`/api/engagements/${id}/pain-points`, json('POST', payload)),
  deletePain: (pid: string) =>
    request<{ ok: boolean }>(`/api/pain-points/${pid}`, { method: 'DELETE' }),

  // 盘点
  listInventory: (id: string, params: { limit?: number; offset?: number; q?: string } = {}) =>
    request<{ items: InventoryItem[]; total: number; limit: number; offset: number }>(
      `/api/engagements/${id}/inventory${pageQuery(params.limit, params.offset, params.q)}`,
    ),
  createInventory: (id: string, payload: Record<string, unknown>) =>
    request<{ item: InventoryItem }>(`/api/engagements/${id}/inventory`, json('POST', payload)),
  deleteInventory: (iid: string) =>
    request<{ ok: boolean }>(`/api/inventory/${iid}`, { method: 'DELETE' }),

  // 流程
  getProcessModel: (id: string) =>
    request<ProcessModel>(`/api/engagements/${id}/process-model`),
  saveProcessModel: (id: string, payload: Record<string, unknown>) =>
    request<{ item: { id: string; version: number } }>(
      `/api/engagements/${id}/process-model`,
      json('PUT', payload),
    ),

  // 机会点
  listOpportunities: (id: string, params: { limit?: number; offset?: number; q?: string } = {}) =>
    request<{ items: OpportunityRow[]; total: number; limit: number; offset: number }>(
      `/api/engagements/${id}/opportunities${pageQuery(params.limit, params.offset, params.q)}`,
    ),
  getOpportunity: (id: string) =>
    request<OpportunityDetail>(`/api/opportunities/${id}`),
  createOpportunity: (engagementId: string, payload: Record<string, unknown>) =>
    request<{ item: OpportunityRow }>(
      `/api/engagements/${engagementId}/opportunities`,
      json('POST', payload),
    ),
  updateOpportunity: (id: string, payload: Record<string, unknown>) =>
    request<{ item: OpportunityRow }>(`/api/opportunities/${id}`, json('PATCH', payload)),
  deleteOpportunity: (id: string) =>
    request<{ ok: boolean }>(`/api/opportunities/${id}`, { method: 'DELETE' }),
  setOpportunityPains: (id: string, painPointIds: string[]) =>
    request<{ items: PainPoint[] }>(
      `/api/opportunities/${id}/pain-points`,
      json('PUT', { pain_point_ids: painPointIds }),
    ),

  // 基线 / ROI / 传导链
  createBaseline: (oppId: string, payload: Record<string, unknown>) =>
    request<{ item: Baseline }>(`/api/opportunities/${oppId}/baselines`, json('POST', payload)),
  deleteBaseline: (bid: string) =>
    request<{ ok: boolean }>(`/api/baselines/${bid}`, { method: 'DELETE' }),
  saveRoi: (oppId: string, payload: Record<string, unknown>) =>
    request<{ item: RoiModel }>(`/api/opportunities/${oppId}/roi`, json('PUT', payload)),
  saveChain: (oppId: string, stages: Array<Record<string, unknown>>) =>
    request<{ product: number | null; stages: ChainStage[] }>(
      `/api/opportunities/${oppId}/chain`,
      json('PUT', { stages }),
    ),
  confirmRoi: (oppId: string, payload: Record<string, unknown>) =>
    request<{ roi: RoiModel; product: number }>(
      `/api/opportunities/${oppId}/roi/confirm`,
      json('POST', payload),
    ),

  // 局限 / 依赖 / 风险
  listLimitations: async (id: string) => {
    const res = await request<{ items: any[] }>(`/api/engagements/${id}/limitations`);
    return {
      items: res.items.map((x) => ({
        ...x,
        impactClass: x.impact_class,
        affectedRefs: x.affected_refs ?? [],
        inCustomerDoc: x.impact_class !== 'internal',
      })) as Limitation[],
    };
  },
  createLimitation: (id: string, payload: Record<string, unknown>) =>
    request<{ item: Limitation }>(`/api/engagements/${id}/limitations`, json('POST', payload)),
  deleteLimitation: (lid: string) =>
    request<{ ok: boolean }>(`/api/limitations/${lid}`, { method: 'DELETE' }),

  listDependencies: (id: string) =>
    request<{ items: Dependency[] }>(`/api/engagements/${id}/dependencies`),
  createDependency: (id: string, payload: Record<string, unknown>) =>
    request<{ item: Dependency }>(`/api/engagements/${id}/dependencies`, json('POST', payload)),
  deleteDependency: (did: string) =>
    request<{ ok: boolean }>(`/api/dependencies/${did}`, { method: 'DELETE' }),

  listRisks: (id: string) =>
    request<{ items: Risk[] }>(`/api/engagements/${id}/risks`),
  createRisk: (id: string, payload: Record<string, unknown>) =>
    request<{ item: Risk }>(`/api/engagements/${id}/risks`, json('POST', payload)),
  updateRisk: (rid: string, payload: Record<string, unknown>) =>
    request<{ item: Risk }>(`/api/risks/${rid}`, json('PATCH', payload)),
  deleteRisk: (rid: string) =>
    request<{ ok: boolean }>(`/api/risks/${rid}`, { method: 'DELETE' }),

  // 交付物
  listDeliverables: (id: string, params: { limit?: number; offset?: number; q?: string } = {}) =>
    request<{ items: Deliverable[]; total: number; limit: number; offset: number }>(
      `/api/engagements/${id}/deliverables${pageQuery(params.limit, params.offset, params.q)}`,
    ),
  generate: (engagementId: string, type: 'diagnosis_report' | 'one_pager') =>
    request<{ id: string; version: number; title: string; summary: unknown }>(
      '/api/deliverables/generate',
      json('POST', { engagementId, type }),
    ),
  deliverableMarkdown: (id: string) =>
    fetch(`${BASE}/api/deliverables/${id}/markdown`, { headers: authHeaders() }).then((r) => {
      if (!r.ok) throw new ApiError(r.status, null);
      return r.text();
    }),
  setDeliverableStatus: (id: string, status: string) =>
    request<{ item: { id: string; status: string } }>(
      `/api/deliverables/${id}/status`,
      json('PATCH', { status }),
    ),
  getDeliverable: (id: string) =>
    request<Deliverable & { shares: DeliverableShare[] }>(`/api/deliverables/${id}`),
  listShares: (engagementId: string) =>
    request<{ items: DeliverableShare[] }>(`/api/engagements/${engagementId}/shares`),
  createShare: (
    deliverableId: string,
    payload: { shared_to: string; channel: string; note?: string; expires_in_days?: number },
  ) =>
    request<{ item: DeliverableShare; deliverableStatus: string }>(
      `/api/deliverables/${deliverableId}/shares`,
      json('POST', payload),
    ),
  rotateShare: (id: string, expiresInDays = 30) =>
    request<{ item: DeliverableShare }>(
      `/api/shares/${id}/rotate`,
      json('POST', { expires_in_days: expiresInDays }),
    ),
  revokeShare: (id: string) =>
    request<{ item: DeliverableShare }>(`/api/shares/${id}/revoke`, json('POST', {})),
  publicShare: (token: string) =>
    request<PublicShareData>(`/api/public/shares/${token}`),
  listShareViews: (id: string) =>
    request<{
      items: ShareView[];
      summary: { views: number; docx: number; pdf: number };
    }>(`/api/shares/${id}/views`),
  publicShareDocxUrl: (token: string) =>
    `${BASE}/api/public/shares/${token}/export.docx`,
  publicSharePdfUrl: (token: string) =>
    `${BASE}/api/public/shares/${token}/export.pdf`,
  deleteShare: (id: string) =>
    request<{ ok: boolean }>(`/api/shares/${id}`, { method: 'DELETE' }),
  exportDocx: async (id: string) => {
    const res = await fetch(`${BASE}/api/deliverables/${id}/export.docx`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, body);
    }
    return res.blob();
  },
  exportPdf: async (id: string) => {
    const res = await fetch(`${BASE}/api/deliverables/${id}/export.pdf`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, body);
    }
    return res.blob();
  },
  createPdfJob: (deliverableId: string) =>
    request<{ item: PdfJob }>(`/api/deliverables/${deliverableId}/pdf-jobs`, {
      method: 'POST',
    }),
  getPdfJob: (id: string) => request<{ item: PdfJob }>(`/api/pdf-jobs/${id}`),
  downloadPdfJob: async (id: string) => {
    const res = await fetch(`${BASE}/api/pdf-jobs/${id}/file`, { headers: authHeaders() });
    if (!res.ok) {
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, body);
    }
    return res.blob();
  },
  exportHtmlUrl: (id: string) =>
    `${BASE}/api/deliverables/${id}/export.html?print=1`,

  // 14 项一致性校验
  consistencyChecks: (id: string) =>
    request<{
      blocked: boolean;
      summary: { pass: number; warn: number; block: number };
      checks: Array<{
        code: string;
        title: string;
        level: string;
        outcome: string;
        message: string;
      }>;
    }>(`/api/engagements/${id}/consistency-checks`),

  // 报告预览（Markdown 原文）
  preview: (id: string) =>
    fetch(`${BASE}/api/engagements/${id}/preview`, { headers: authHeaders() }).then((r) => {
      if (!r.ok) throw new ApiError(r.status, null);
      return r.text();
    }),

  // 导入
  importRows: async (engagementId: string, kind: ImportKind, file: File) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${BASE}/api/engagements/${engagementId}/import?kind=${kind}`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    });
    const text = await res.text();
    let body: any = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!res.ok) throw new ApiError(res.status, body);
    return body as { kind: ImportKind; inserted: number; rows: number };
  },
  importTemplateUrl: (kind: ImportKind) => `${BASE}/api/import/templates/${kind}.csv`,
  importSchema: (kind: ImportKind) =>
    request<{ kind: ImportKind; columns: string[]; required: string[] }>(
      `/api/import/schema/${kind}`,
    ),

  // S2 方案设计
  g2Checks: (engagementId: string) =>
    request<G2Checks>(`/api/engagements/${engagementId}/g2-checks`),
  listSolutions: (engagementId: string) =>
    request<{ items: Solution[] }>(`/api/engagements/${engagementId}/solutions`),
  createSolution: (opportunityId: string, payload: Record<string, unknown>) =>
    request<{ item: Solution }>(
      `/api/opportunities/${opportunityId}/solutions`,
      json('POST', payload),
    ),
  getSolution: (id: string) => request<SolutionDetail>(`/api/solutions/${id}`),
  updateSolution: (id: string, payload: Record<string, unknown>) =>
    request<{ item: Solution }>(`/api/solutions/${id}`, json('PATCH', payload)),
  deleteSolution: (id: string) =>
    request<{ ok: boolean }>(`/api/solutions/${id}`, { method: 'DELETE' }),

  createComponent: (solutionId: string, payload: Record<string, unknown>) =>
    request<{ item: any }>(`/api/solutions/${solutionId}/components`, json('POST', payload)),
  updateComponent: (id: string, payload: Record<string, unknown>) =>
    request<{ item: any }>(`/api/components/${id}`, json('PATCH', payload)),
  deleteComponent: (id: string) =>
    request<{ ok: boolean }>(`/api/components/${id}`, { method: 'DELETE' }),

  createIntegration: (solutionId: string, payload: Record<string, unknown>) =>
    request<{ item: any }>(`/api/solutions/${solutionId}/integrations`, json('POST', payload)),
  updateIntegration: (id: string, payload: Record<string, unknown>) =>
    request<{ item: any }>(`/api/integrations/${id}`, json('PATCH', payload)),
  deleteIntegration: (id: string) =>
    request<{ ok: boolean }>(`/api/integrations/${id}`, { method: 'DELETE' }),

  saveWorkload: (solutionId: string, items: Array<Record<string, unknown>>) =>
    request<{ items: any[]; total: number }>(
      `/api/solutions/${solutionId}/workload`,
      json('PUT', { items }),
    ),

  createAcceptance: (solutionId: string, payload: Record<string, unknown>) =>
    request<{ item: any }>(
      `/api/solutions/${solutionId}/acceptance-criteria`,
      json('POST', payload),
    ),
  updateAcceptance: (id: string, payload: Record<string, unknown>) =>
    request<{ item: any }>(`/api/acceptance-criteria/${id}`, json('PATCH', payload)),
  deleteAcceptance: (id: string) =>
    request<{ ok: boolean }>(`/api/acceptance-criteria/${id}`, { method: 'DELETE' }),

  createReview: (solutionId: string, payload: Record<string, unknown>) =>
    request<{ review: any; status: string }>(
      `/api/solutions/${solutionId}/reviews`,
      json('POST', payload),
    ),
  generateSolutionDocument: (
    solutionId: string,
    type: 'proposal' | 'architecture' | 'prd' | 'acceptance',
  ) =>
    request<{ item: { id: string; title: string; version: number; type: string } }>(
      `/api/solutions/${solutionId}/documents`,
      json('POST', { type }),
    ),

  listQuotes: (engagementId: string) =>
    request<{ items: Quote[] }>(`/api/engagements/${engagementId}/quotes`),
  createQuote: (engagementId: string, payload: Record<string, unknown>) =>
    request<{ item: Quote }>(`/api/engagements/${engagementId}/quotes`, json('POST', payload)),
  getQuote: (id: string) => request<QuoteDetail>(`/api/quotes/${id}`),
  updateQuote: (id: string, payload: Record<string, unknown>) =>
    request<{ item: Quote }>(`/api/quotes/${id}`, json('PATCH', payload)),
  createQuoteItem: (quoteId: string, payload: Record<string, unknown>) =>
    request<{ item: any }>(`/api/quotes/${quoteId}/items`, json('POST', payload)),
  deleteQuoteItem: (id: string) =>
    request<{ ok: boolean }>(`/api/quote-items/${id}`, { method: 'DELETE' }),
  generateQuoteDocument: (quoteId: string) =>
    request<{ item: { id: string; title: string; version: number; type: string } }>(
      `/api/quotes/${quoteId}/documents`,
      { method: 'POST' },
    ),
  exportQuoteDocx: async (quoteId: string) => {
    const res = await fetch(`${BASE}/api/quotes/${quoteId}/document.docx`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, body);
    }
    return res.blob();
  },

  // S3 POC
  g3Checks: (engagementId: string) =>
    request<G3Checks>(`/api/engagements/${engagementId}/g3-checks`),
  listExperiments: (engagementId: string) =>
    request<{ items: PocExperiment[] }>(`/api/engagements/${engagementId}/poc-experiments`),
  createExperiment: (opportunityId: string, payload: Record<string, unknown>) =>
    request<{ item: PocExperiment }>(
      `/api/opportunities/${opportunityId}/poc-experiments`,
      json('POST', payload),
    ),
  getExperiment: (id: string) => request<PocDetail>(`/api/poc-experiments/${id}`),
  updateExperiment: (id: string, payload: Record<string, unknown>) =>
    request<{ item: PocExperiment }>(`/api/poc-experiments/${id}`, json('PATCH', payload)),
  deleteExperiment: (id: string) =>
    request<{ ok: boolean }>(`/api/poc-experiments/${id}`, { method: 'DELETE' }),
  createDataset: (experimentId: string, payload: Record<string, unknown>) =>
    request<{ item: any }>(`/api/poc-experiments/${experimentId}/datasets`, json('POST', payload)),
  deleteDataset: (id: string) =>
    request<{ ok: boolean }>(`/api/poc-datasets/${id}`, { method: 'DELETE' }),
  createRun: (experimentId: string, payload: Record<string, unknown>) =>
    request<{ item: any }>(`/api/poc-experiments/${experimentId}/runs`, json('POST', payload)),
  deleteRun: (id: string) =>
    request<{ ok: boolean }>(`/api/poc-runs/${id}`, { method: 'DELETE' }),
  createPocReview: (runId: string, payload: Record<string, unknown>) =>
    request<{ item: any }>(`/api/poc-runs/${runId}/reviews`, json('POST', payload)),
  deletePocReview: (id: string) =>
    request<{ ok: boolean }>(`/api/poc-reviews/${id}`, { method: 'DELETE' }),
  saveConclusion: (experimentId: string, payload: Record<string, unknown>) =>
    request<{ conclusion: any; status: string }>(
      `/api/poc-experiments/${experimentId}/conclusion`,
      json('PUT', payload),
    ),

  generateDeliveryDocument: (
    engagementId: string,
    type: 'plan' | 'uat' | 'go_live' | 'training',
  ) =>
    request<{ item: { id: string; title: string; version: number; type: string } }>(
      `/api/engagements/${engagementId}/delivery-documents`,
      json('POST', { type }),
    ),
  exportDeliveryDocx: async (
    engagementId: string,
    type: 'plan' | 'uat' | 'go_live' | 'training',
  ) => {
    const res = await fetch(
      `${BASE}/api/engagements/${engagementId}/delivery-document.docx?type=${type}`,
      { headers: authHeaders() },
    );
    if (!res.ok) {
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, body);
    }
    return res.blob();
  },

  generateValueDocument: (engagementId: string, type: 'value' | 'renewal') =>
    request<{ item: { id: string; title: string; version: number; type: string } }>(
      `/api/engagements/${engagementId}/value-documents`,
      json('POST', { type }),
    ),
  exportValueDocx: async (engagementId: string, type: 'value' | 'renewal') => {
    const res = await fetch(
      `${BASE}/api/engagements/${engagementId}/value-document.docx?type=${type}`,
      { headers: authHeaders() },
    );
    if (!res.ok) {
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, body);
    }
    return res.blob();
  },

  listKnowledge: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v) qs.set(k, v);
    });
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ items: KnowledgeItem[]; total: number; limit: number; offset: number }>(
      `/api/knowledge${suffix}`,
    );
  },
  createKnowledge: (payload: Record<string, unknown>) =>
    request<{ item: KnowledgeItem }>('/api/knowledge', json('POST', payload)),
  updateKnowledge: (id: string, payload: Record<string, unknown>) =>
    request<{ item: KnowledgeItem }>(`/api/knowledge/${id}`, json('PATCH', payload)),
  reviewKnowledge: (id: string, decision: 'approve' | 'reject', note?: string) =>
    request<{ item: KnowledgeItem }>(
      `/api/knowledge/${id}/review`,
      json('POST', { decision, note }),
    ),
  deleteKnowledge: (id: string) =>
    request<{ ok: boolean }>(`/api/knowledge/${id}`, { method: 'DELETE' }),
  similarKnowledge: (engagementId: string) =>
    request<{ items: KnowledgeMatch[] }>(`/api/engagements/${engagementId}/similar-knowledge`),

  aiConfig: () =>
    request<{ configured: boolean; model: string }>('/api/ai/config'),
  listAiDrafts: (engagementId: string, params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v) qs.set(k, v);
    });
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ items: AiDraft[] }>(
      `/api/engagements/${engagementId}/ai-drafts${suffix}`,
    );
  },
  createAiDraft: (engagementId: string, payload: Record<string, unknown>) =>
    request<{ item: AiDraft; context: { model: string } }>(
      `/api/engagements/${engagementId}/ai-drafts`,
      json('POST', payload),
    ),
  updateAiDraft: (id: string, payload: Record<string, unknown>) =>
    request<{ item: AiDraft }>(`/api/ai-drafts/${id}`, json('PATCH', payload)),
  confirmAiDraft: (id: string) =>
    request<{ item: AiDraft }>(`/api/ai-drafts/${id}/confirm`, json('POST', {})),
  rejectAiDraft: (id: string) =>
    request<{ item: AiDraft }>(`/api/ai-drafts/${id}/reject`, json('POST', {})),
  deleteAiDraft: (id: string) =>
    request<{ ok: boolean }>(`/api/ai-drafts/${id}`, { method: 'DELETE' }),

  listMembers: (engagementId: string) =>
    request<{ items: EngagementMember[]; canManage: boolean }>(
      `/api/engagements/${engagementId}/members`,
    ),
  addMember: (engagementId: string, payload: Record<string, unknown>) =>
    request<{ item: EngagementMember }>(
      `/api/engagements/${engagementId}/members`,
      json('POST', payload),
    ),
  updateMember: (id: string, payload: Record<string, unknown>) =>
    request<{ item: EngagementMember }>(`/api/engagement-members/${id}`, json('PATCH', payload)),
  removeMember: (id: string) =>
    request<{ ok: boolean }>(`/api/engagement-members/${id}`, { method: 'DELETE' }),

  g5Checks: (engagementId: string) =>
    request<G5Checks>(`/api/engagements/${engagementId}/g5-checks`),
  valueOverview: (engagementId: string) =>
    request<ValueOverview>(`/api/engagements/${engagementId}/value-overview`),
  createMetricTarget: (engagementId: string, payload: Record<string, unknown>) =>
    request<{ item: MetricTarget }>(
      `/api/engagements/${engagementId}/metric-targets`,
      json('POST', payload),
    ),
  updateMetricTarget: (id: string, payload: Record<string, unknown>) =>
    request<{ item: MetricTarget }>(`/api/metric-targets/${id}`, json('PATCH', payload)),
  deleteMetricTarget: (id: string) =>
    request<{ ok: boolean }>(`/api/metric-targets/${id}`, { method: 'DELETE' }),
  createSnapshot: (targetId: string, payload: Record<string, unknown>) =>
    request<{ item: MetricSnapshot }>(
      `/api/metric-targets/${targetId}/snapshots`,
      json('POST', payload),
    ),
  deleteSnapshot: (id: string) =>
    request<{ ok: boolean }>(`/api/metric-snapshots/${id}`, { method: 'DELETE' }),
  createValueRecord: (engagementId: string, payload: Record<string, unknown>) =>
    request<{ item: ValueRecord }>(
      `/api/engagements/${engagementId}/value-records`,
      json('POST', payload),
    ),
  deleteValueRecord: (id: string) =>
    request<{ ok: boolean }>(`/api/value-records/${id}`, { method: 'DELETE' }),
  createUsageRecord: (engagementId: string, payload: Record<string, unknown>) =>
    request<{ item: UsageRecord }>(
      `/api/engagements/${engagementId}/usage-records`,
      json('POST', payload),
    ),
  deleteUsageRecord: (id: string) =>
    request<{ ok: boolean }>(`/api/usage-records/${id}`, { method: 'DELETE' }),
  createRenewalRisk: (engagementId: string, payload: Record<string, unknown>) =>
    request<{ item: RenewalRisk }>(
      `/api/engagements/${engagementId}/renewal-risks`,
      json('POST', payload),
    ),
  updateRenewalRisk: (id: string, payload: Record<string, unknown>) =>
    request<{ item: RenewalRisk }>(`/api/renewal-risks/${id}`, json('PATCH', payload)),
  deleteRenewalRisk: (id: string) =>
    request<{ ok: boolean }>(`/api/renewal-risks/${id}`, { method: 'DELETE' }),

  g4Checks: (engagementId: string) =>
    request<G4Checks>(`/api/engagements/${engagementId}/g4-checks`),
  deliveryOverview: (engagementId: string) =>
    request<DeliveryOverview>(`/api/engagements/${engagementId}/delivery-overview`),
  createDeliveryPlan: (engagementId: string, payload: Record<string, unknown>) =>
    request<{ item: DeliveryPlan }>(
      `/api/engagements/${engagementId}/delivery-plans`,
      json('POST', payload),
    ),
  updateDeliveryPlan: (id: string, payload: Record<string, unknown>) =>
    request<{ item: DeliveryPlan }>(`/api/delivery-plans/${id}`, json('PATCH', payload)),
  deleteDeliveryPlan: (id: string) =>
    request<{ ok: boolean }>(`/api/delivery-plans/${id}`, { method: 'DELETE' }),
  createDeliveryTask: (planId: string, payload: Record<string, unknown>) =>
    request<{ item: DeliveryTask }>(`/api/delivery-plans/${planId}/tasks`, json('POST', payload)),
  updateDeliveryTask: (id: string, payload: Record<string, unknown>) =>
    request<{ item: DeliveryTask }>(`/api/delivery-tasks/${id}`, json('PATCH', payload)),
  deleteDeliveryTask: (id: string) =>
    request<{ ok: boolean }>(`/api/delivery-tasks/${id}`, { method: 'DELETE' }),
  createUatCase: (engagementId: string, payload: Record<string, unknown>) =>
    request<{ item: UatCase }>(`/api/engagements/${engagementId}/uat-cases`, json('POST', payload)),
  updateUatCase: (id: string, payload: Record<string, unknown>) =>
    request<{ item: UatCase }>(`/api/uat-cases/${id}`, json('PATCH', payload)),
  deleteUatCase: (id: string) =>
    request<{ ok: boolean }>(`/api/uat-cases/${id}`, { method: 'DELETE' }),
  createGoLiveItem: (engagementId: string, payload: Record<string, unknown>) =>
    request<{ item: GoLiveItem }>(
      `/api/engagements/${engagementId}/go-live-items`,
      json('POST', payload),
    ),
  updateGoLiveItem: (id: string, payload: Record<string, unknown>) =>
    request<{ item: GoLiveItem }>(`/api/go-live-items/${id}`, json('PATCH', payload)),
  deleteGoLiveItem: (id: string) =>
    request<{ ok: boolean }>(`/api/go-live-items/${id}`, { method: 'DELETE' }),
  createTraining: (engagementId: string, payload: Record<string, unknown>) =>
    request<{ item: Training }>(`/api/engagements/${engagementId}/trainings`, json('POST', payload)),
  updateTraining: (id: string, payload: Record<string, unknown>) =>
    request<{ item: Training }>(`/api/trainings/${id}`, json('PATCH', payload)),
  deleteTraining: (id: string) =>
    request<{ ok: boolean }>(`/api/trainings/${id}`, { method: 'DELETE' }),
  createDeliveryIssue: (engagementId: string, payload: Record<string, unknown>) =>
    request<{ item: DeliveryIssue }>(
      `/api/engagements/${engagementId}/delivery-issues`,
      json('POST', payload),
    ),
  updateDeliveryIssue: (id: string, payload: Record<string, unknown>) =>
    request<{ item: DeliveryIssue }>(`/api/delivery-issues/${id}`, json('PATCH', payload)),
  deleteDeliveryIssue: (id: string) =>
    request<{ ok: boolean }>(`/api/delivery-issues/${id}`, { method: 'DELETE' }),

  generatePocDocument: (experimentId: string) =>
    request<{ item: { id: string; title: string; version: number; type: string } }>(
      `/api/poc-experiments/${experimentId}/documents`,
      { method: 'POST' },
    ),
  exportPocDocx: async (experimentId: string) => {
    const res = await fetch(`${BASE}/api/poc-experiments/${experimentId}/document.docx`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, body);
    }
    return res.blob();
  },

  // 回收站 / 审计
  listTrash: () => request<{ items: TrashBatch[] }>('/api/trash'),
  restoreTrash: (batch: string) =>
    request<{ ok: boolean; restored: { clients: number; engagements: number; deliverables: number } }>(
      `/api/trash/${batch}/restore`,
      { method: 'POST' },
    ),
  listAuditLogs: (params: { limit?: number; offset?: number; q?: string; action?: string; object_type?: string } = {}) => {
    const search = new URLSearchParams();
    if (params.limit) search.set('limit', String(params.limit));
    if (params.offset) search.set('offset', String(params.offset));
    if (params.q) search.set('q', params.q);
    if (params.action) search.set('action', params.action);
    if (params.object_type) search.set('object_type', params.object_type);
    const qs = search.toString();
    return request<{ items: AuditLog[]; total: number; limit: number; offset: number }>(
      `/api/audit-logs${qs ? `?${qs}` : ''}`,
    );
  },

  listArchivedAuditLogs: (
    params: { limit?: number; offset?: number; q?: string; action?: string; object_type?: string } = {},
  ) => {
    const search = new URLSearchParams();
    if (params.limit) search.set('limit', String(params.limit));
    if (params.offset) search.set('offset', String(params.offset));
    if (params.q) search.set('q', params.q);
    if (params.action) search.set('action', params.action);
    if (params.object_type) search.set('object_type', params.object_type);
    const qs = search.toString();
    return request<{ items: AuditLog[]; total: number; limit: number; offset: number }>(
      `/api/audit-logs/archive${qs ? `?${qs}` : ''}`,
    );
  },
  archiveAuditLogs: (payload: {
    before: string;
    dry_run: boolean;
    confirm?: string;
    batch_size?: number;
  }) =>
    request<{
      before: string;
      dryRun: boolean;
      candidates: number;
      moved: number;
      remaining: number;
    }>('/api/audit-logs/archive', json('POST', payload)),

  // 行业标杆
  listBenchmarks: (all = true, industry = 'logistics') =>
    request<{ items: Benchmark[] }>(
      `/api/benchmarks?all=${all ? '1' : '0'}&industry=${encodeURIComponent(industry)}`,
    ),
  createBenchmark: (payload: Record<string, unknown>) =>
    request<{ item: Benchmark }>('/api/benchmarks', json('POST', payload)),
  updateBenchmark: (id: string, payload: Record<string, unknown>) =>
    request<{ item: Benchmark }>(`/api/benchmarks/${id}`, json('PATCH', payload)),
  deleteBenchmark: (id: string) =>
    request<{ ok: boolean }>(`/api/benchmarks/${id}`, { method: 'DELETE' }),

  // 客户确认
  listConfirmations: (engagementId: string) =>
    request<{ items: Confirmation[] }>(
      `/api/engagements/${engagementId}/confirmations`,
    ),
  createConfirmation: (engagementId: string, payload: Record<string, unknown>) =>
    request<{ item: Confirmation }>(
      `/api/engagements/${engagementId}/confirmations`,
      json('POST', payload),
    ),
  deleteConfirmation: (id: string) =>
    request<{ ok: boolean }>(`/api/confirmations/${id}`, { method: 'DELETE' }),

  // 认证
  authConfig: () => request<{ required: boolean }>('/api/auth/config'),
  login: (email: string, password: string, orgSlug?: string) =>
    request<{ token: string; user: StoredUser }>(
      '/api/auth/login',
      json('POST', { email, password, org_slug: orgSlug || undefined }),
    ),
  register: (payload: {
    org_name: string;
    org_slug?: string;
    name: string;
    email: string;
    password: string;
  }) => request<{ token: string; user: StoredUser }>('/api/auth/register', json('POST', payload)),
  me: () => request<{ user: StoredUser }>('/api/me'),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  getOrg: () => request<{ item: OrganizationSummary }>('/api/org'),
  getOrgBilling: () => request<{ item: OrgBilling }>('/api/org/billing'),
  listOrgInvoices: () =>
    request<{ items: Invoice[] }>('/api/org/billing/invoices'),
  createCheckout: (payload: { plan?: string; cycle?: 'monthly' | 'yearly' }) =>
    request<{ item: Invoice; provider: string; mock: boolean; reused: boolean }>(
      '/api/org/billing/checkout',
      json('POST', payload),
    ),
  payMockInvoice: (id: string) =>
    request<{ item: Invoice; billing: OrgBilling }>(
      `/api/org/billing/invoices/${id}/pay`,
      { method: 'POST' },
    ),
  retimeOrgSnapshots: () =>
    request<{ ok: boolean; updated: number; timezone: string }>(
      '/api/org/snapshots/retime',
      json('POST', {}),
    ),
  updateOrg: (payload: Record<string, unknown>) =>
    request<{ item: OrganizationSummary }>('/api/org', json('PATCH', payload)),
  listPlatformTenants: () =>
    request<{ items: OrganizationSummary[] }>('/api/platform/tenants'),
  listPlatformPlans: () =>
    request<{ items: PlanDefinition[] }>('/api/platform/plans'),
  listHolidays: (opts: { year?: number; effective?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (opts.year) params.set('year', String(opts.year));
    if (opts.effective) params.set('effective', '1');
    const qs = params.toString();
    return request<{ items: Holiday[] }>(`/api/holidays${qs ? `?${qs}` : ''}`);
  },
  createHoliday: (payload: { date: string; name: string; region?: string }) =>
    request<{ item: Holiday }>('/api/holidays', json('POST', payload)),
  deleteHoliday: (id: string) =>
    request<{ ok: boolean }>(`/api/holidays/${id}`, { method: 'DELETE' }),
  listCopilotReconcileReviews: (engagementId: string) =>
    request<{ items: CopilotReconcileReview[] }>(
      `/api/engagements/${engagementId}/copilot-reconcile-reviews`,
    ),
  getCopilotReconcileReview: (id: string) =>
    request<{ item: CopilotReconcileReviewDetail }>(
      `/api/copilot-reconcile-reviews/${id}`,
    ),
  createReconcileReviewAction: (id: string, payload: Record<string, unknown>) =>
    request<{
      ok: boolean;
      duplicate: boolean;
      type: 'risk' | 'issue';
      item_id: string;
      item_code?: string;
      action_id?: string | null;
      difference_id?: string | null;
    }>(
      `/api/copilot-reconcile-reviews/${id}/actions`,
      json('POST', payload),
    ),
  createReconcileReviewActionsBatch: (
    id: string,
    payload: {
      type: 'risk' | 'issue';
      difference_ids: string[];
      owner?: string | null;
      due_date?: string | null;
      severity?: 'P0' | 'P1' | 'P2' | 'P3';
    },
  ) =>
    request<{
      ok: boolean;
      type: 'risk' | 'issue';
      created: number;
      skipped: number;
      failed: number;
      items: Array<{
        difference_id: string;
        status: 'created' | 'duplicate' | 'failed';
        item_id?: string;
        item_code?: string | null;
        action_id?: string | null;
        code?: string;
        error?: string;
      }>;
    }>(`/api/copilot-reconcile-reviews/${id}/actions/batch`, json('POST', payload)),

  streamReconcileReviewActionsBatch: async (
    id: string,
    payload: {
      type: 'risk' | 'issue';
      difference_ids: string[];
      owner?: string | null;
      due_date?: string | null;
      severity?: 'P0' | 'P1' | 'P2' | 'P3';
    },
    onEvent: (event: BatchActionEvent) => void,
  ): Promise<void> => {
    await requestStream(
      `/api/copilot-reconcile-reviews/${id}/actions/batch/stream`,
      payload,
      onEvent,
    );
  },
  listReconcileBatches: (
    reviewId: string,
    opts: ({ limit?: number; offset?: number } & BatchExportFilters) = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.offset) params.set('offset', String(opts.offset));
    if (opts.status) params.set('status', opts.status);
    if (opts.action_type) params.set('action_type', opts.action_type);
    if (opts.from) params.set('from', opts.from);
    if (opts.to) params.set('to', opts.to);
    const qs = params.toString();
    return request<{
      items: ReconcileBatch[];
      total: number;
      batch_total: number;
      roots_returned: number;
      limit: number;
      offset: number;
    }>(
      `/api/copilot-reconcile-reviews/${reviewId}/action-batches${qs ? `?${qs}` : ''}`,
    );
  },
  streamRetryReconcileBatch: (
    batchId: string,
    onEvent: (event: BatchActionEvent) => void,
  ) => requestStream(`/api/copilot-reconcile-batches/${batchId}/retry/stream`, {}, onEvent),
  notificationsUnreadCount: () =>
    request<{ count: number }>('/api/notifications/unread-count'),
  listNotifications: (
    opts: {
      unread?: boolean;
      kind?: string;
      from?: string;
      to?: string;
      trash?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.unread) params.set('unread', '1');
    if (opts.kind) params.set('kind', opts.kind);
    if (opts.from) params.set('from', opts.from);
    if (opts.to) params.set('to', opts.to);
    if (opts.trash) params.set('trash', '1');
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.offset) params.set('offset', String(opts.offset));
    const qs = params.toString();
    return request<{
      items: UserNotification[];
      total: number;
      unread_count: number;
      kinds: string[];
      trash_retention_days: number;
      limit: number;
      offset: number;
    }>(`/api/notifications${qs ? `?${qs}` : ''}`);
  },
  markNotificationRead: (id: string) =>
    request<{ ok: boolean }>(`/api/notifications/${id}/read`, json('POST', {})),
  markAllNotificationsRead: () =>
    request<{ ok: boolean; updated: number }>(
      '/api/notifications/read-all',
      json('POST', {}),
    ),
  listNotificationAudits: (
    opts: {
      action?: string;
      from?: string;
      to?: string;
      actor_id?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.action) params.set('action', opts.action);
    if (opts.from) params.set('from', opts.from);
    if (opts.to) params.set('to', opts.to);
    if (opts.actor_id) params.set('actor_id', opts.actor_id);
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.offset) params.set('offset', String(opts.offset));
    const qs = params.toString();
    return request<{
      items: NotificationAudit[];
      total: number;
      limit: number;
      offset: number;
    }>(`/api/notification-audits${qs ? `?${qs}` : ''}`);
  },
  exportNotificationAuditsCsv: (opts: {
    action?: string;
    from?: string;
    to?: string;
    actor_id?: string;
  } = {}) => {
    const params = new URLSearchParams();
    if (opts.action) params.set('action', opts.action);
    if (opts.from) params.set('from', opts.from);
    if (opts.to) params.set('to', opts.to);
    if (opts.actor_id) params.set('actor_id', opts.actor_id);
    const qs = params.toString();
    return requestBlob(
      `/api/notification-audits/export.csv${qs ? `?${qs}` : ''}`,
    );
  },
  getCollabAuditStats: (
    opts: {
      from?: string;
      to?: string;
      actor_id?: string;
      scope?: 'live' | 'archive' | 'all';
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.from) params.set('from', opts.from);
    if (opts.to) params.set('to', opts.to);
    if (opts.actor_id) params.set('actor_id', opts.actor_id);
    if (opts.scope) params.set('scope', opts.scope);
    const qs = params.toString();
    return request<{
      total: number;
      by_type: { notification: number; filter_view: number; export: number };
      top_actions: Array<{ action: string; count: number }>;
      top_actors: Array<{
        user_id: string | null;
        actor_name: string | null;
        count: number;
      }>;
      retention_days: number;
    }>(`/api/collab-audits/stats${qs ? `?${qs}` : ''}`);
  },
  listCollabAudits: (
    opts: {
      type?: 'all' | 'notification' | 'filter_view' | 'export';
      action?: string;
      from?: string;
      to?: string;
      actor_id?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.type && opts.type !== 'all') params.set('type', opts.type);
    if (opts.action) params.set('action', opts.action);
    if (opts.from) params.set('from', opts.from);
    if (opts.to) params.set('to', opts.to);
    if (opts.actor_id) params.set('actor_id', opts.actor_id);
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.offset) params.set('offset', String(opts.offset));
    const qs = params.toString();
    return request<{
      items: CollabAudit[];
      total: number;
      limit: number;
      offset: number;
    }>(`/api/collab-audits${qs ? `?${qs}` : ''}`);
  },
  listCollabAuditsMerged: (
    opts: {
      type?: 'all' | 'notification' | 'filter_view' | 'export';
      action?: string;
      from?: string;
      to?: string;
      actor_id?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.type && opts.type !== 'all') params.set('type', opts.type);
    if (opts.action) params.set('action', opts.action);
    if (opts.from) params.set('from', opts.from);
    if (opts.to) params.set('to', opts.to);
    if (opts.actor_id) params.set('actor_id', opts.actor_id);
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.offset) params.set('offset', String(opts.offset));
    const qs = params.toString();
    return request<{
      items: CollabAudit[];
      total: number;
      limit: number;
      offset: number;
    }>(`/api/collab-audits/merged${qs ? `?${qs}` : ''}`);
  },
  exportCollabSnapshotsCsv: (
    days = 30,
    bucket: 'day' | 'week' | 'month' = 'day',
  ) =>
    requestBlob(
      `/api/collab-audits/snapshots/export.csv?days=${days}&bucket=${bucket}`,
    ),
  exportCollabSnapshotComparisonCsv: (
    days = 30,
    bucket: 'day' | 'week' | 'month' = 'day',
  ) =>
    requestBlob(
      `/api/collab-audits/snapshots/comparison/export.csv?days=${days}&bucket=${bucket}`,
    ),
  listCollabSnapshots: (
    opts: { days?: number; bucket?: 'day' | 'week' | 'month' } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.days) params.set('days', String(opts.days));
    if (opts.bucket) params.set('bucket', opts.bucket);
    const qs = params.toString();
    return request<{
      items: Array<{
        id: string;
        snapshot_date: string;
        total: number;
        notification_count: number;
        filter_view_count: number;
        export_count: number;
        created_at: string;
        delta_total: number;
        delta_notification: number;
        delta_filter_view: number;
        delta_export: number;
        period_start: string;
        period_end: string;
      }>;
      bucket: 'day' | 'week' | 'month';
      comparison: {
        current: SnapshotPeriod;
        previous: SnapshotPeriod | null;
        change: {
          delta_total: number;
          delta_notification: number;
          delta_filter_view: number;
          delta_export: number;
        };
      } | null;
      total: number;
      limit: number;
      offset: number;
    }>(`/api/collab-audits/snapshots${qs ? `?${qs}` : ''}`);
  },
  listCollabAuditArchive: (
    opts: {
      type?: 'all' | 'notification' | 'filter_view' | 'export';
      action?: string;
      from?: string;
      to?: string;
      actor_id?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.type && opts.type !== 'all') params.set('type', opts.type);
    if (opts.action) params.set('action', opts.action);
    if (opts.from) params.set('from', opts.from);
    if (opts.to) params.set('to', opts.to);
    if (opts.actor_id) params.set('actor_id', opts.actor_id);
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.offset) params.set('offset', String(opts.offset));
    const qs = params.toString();
    return request<{
      items: CollabAudit[];
      total: number;
      last_archive: {
        count: number;
        days: number;
        created_at: string;
      } | null;
      limit: number;
      offset: number;
    }>(`/api/collab-audits/archive${qs ? `?${qs}` : ''}`);
  },
  exportCollabMergedCsv: (opts: {
    type?: 'all' | 'notification' | 'filter_view' | 'export';
    action?: string;
    from?: string;
    to?: string;
    actor_id?: string;
  } = {}) => {
    const params = new URLSearchParams();
    if (opts.type && opts.type !== 'all') params.set('type', opts.type);
    if (opts.action) params.set('action', opts.action);
    if (opts.from) params.set('from', opts.from);
    if (opts.to) params.set('to', opts.to);
    if (opts.actor_id) params.set('actor_id', opts.actor_id);
    const qs = params.toString();
    return requestBlob(
      `/api/collab-audits/merged/export.csv${qs ? `?${qs}` : ''}`,
    );
  },
  listCollabArchiveRuns: (
    opts: { limit?: number; offset?: number; from?: string; to?: string } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.offset) params.set('offset', String(opts.offset));
    if (opts.from) params.set('from', opts.from);
    if (opts.to) params.set('to', opts.to);
    const qs = params.toString();
    return request<{
      items: Array<{ id: string; count: number; days: number; created_at: string }>;
      total: number;
      limit: number;
      offset: number;
    }>(`/api/collab-audits/archive-runs${qs ? `?${qs}` : ''}`);
  },
  exportCollabArchiveCsv: (opts: {
    type?: 'all' | 'notification' | 'filter_view' | 'export';
    action?: string;
    from?: string;
    to?: string;
    actor_id?: string;
  } = {}) => {
    const params = new URLSearchParams();
    if (opts.type && opts.type !== 'all') params.set('type', opts.type);
    if (opts.action) params.set('action', opts.action);
    if (opts.from) params.set('from', opts.from);
    if (opts.to) params.set('to', opts.to);
    if (opts.actor_id) params.set('actor_id', opts.actor_id);
    const qs = params.toString();
    return requestBlob(
      `/api/collab-audits/archive/export.csv${qs ? `?${qs}` : ''}`,
    );
  },
  exportCollabAuditsCsv: (opts: {
    type?: 'all' | 'notification' | 'filter_view' | 'export';
    action?: string;
    from?: string;
    to?: string;
    actor_id?: string;
  } = {}) => {
    const params = new URLSearchParams();
    if (opts.type && opts.type !== 'all') params.set('type', opts.type);
    if (opts.action) params.set('action', opts.action);
    if (opts.from) params.set('from', opts.from);
    if (opts.to) params.set('to', opts.to);
    if (opts.actor_id) params.set('actor_id', opts.actor_id);
    const qs = params.toString();
    return requestBlob(`/api/collab-audits/export.csv${qs ? `?${qs}` : ''}`);
  },
  restoreNotifications: (ids: string[]) =>
    request<{ ok: boolean; restored: number }>(
      '/api/notifications/restore',
      json('POST', { ids }),
    ),
  purgeNotifications: (ids: string[]) =>
    request<{ ok: boolean; deleted: number }>(
      '/api/notifications/purge',
      json('POST', { ids }),
    ),
  deleteNotifications: (
    payload:
      | { ids: string[] }
      | {
          all: true;
          unread?: boolean;
          kind?: string;
          from?: string;
          to?: string;
        },
  ) =>
    request<{ ok: boolean; deleted: number }>(
      '/api/notifications/delete',
      json('POST', payload),
    ),
  exportBatchFilterViewAuditsCsv: (reviewId: string) =>
    requestBlob(
      `/api/copilot-reconcile-reviews/${reviewId}/batch-filter-view-audits/export.csv`,
    ),
  listBatchFilterViewAudits: (
    reviewId: string,
    opts: { limit?: number; offset?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.offset) params.set('offset', String(opts.offset));
    const qs = params.toString();
    return request<{
      items: BatchFilterViewAudit[];
      total: number;
      limit: number;
      offset: number;
    }>(
      `/api/copilot-reconcile-reviews/${reviewId}/batch-filter-view-audits${qs ? `?${qs}` : ''}`,
    );
  },
  listBatchFilterViews: (reviewId: string) =>
    request<{ items: BatchFilterView[] }>(
      `/api/copilot-reconcile-reviews/${reviewId}/batch-filter-views`,
    ),
  saveBatchFilterView: (
    reviewId: string,
    payload: {
      name: string;
      status?: 'running' | 'completed' | 'failed' | 'cancelled' | null;
      action_type?: 'risk' | 'issue' | null;
      from?: string | null;
      to?: string | null;
      shared?: boolean;
      shared_role?: 'admin' | 'director' | 'pm' | 'consultant' | 'tech_lead' | null;
      shared_user_ids?: string[];
    },
  ) =>
    request<{ item: BatchFilterView }>(
      `/api/copilot-reconcile-reviews/${reviewId}/batch-filter-views`,
      json('POST', payload),
    ),
  deleteBatchFilterView: (viewId: string) =>
    request<{ ok: boolean }>(`/api/copilot-batch-filter-views/${viewId}`, {
      method: 'DELETE',
    }),
  getBatchExportEstimate: (reviewId: string, filters: BatchExportFilters = {}) =>
    request<{
      batches: number;
      items: number;
      estimated_bytes: { summary: number; items: number; zip: number };
      large: boolean;
      filters: BatchExportFilters;
    }>(
      `/api/copilot-reconcile-reviews/${reviewId}/action-batches/export-estimate${batchExportQuery(filters)}`,
    ),
  decideReconcileDifference: (
    reviewId: string,
    payload: { difference_id: string; decision: string; note?: string | null },
  ) =>
    request<{ decisions: ReconcileDecision[] }>(
      `/api/copilot-reconcile-reviews/${reviewId}/decisions`,
      json('PUT', payload),
    ),
  batchDecideReconcileDifferences: (
    reviewId: string,
    payload: {
      difference_ids: string[];
      decision: '采纳' | '忽略' | '待确认';
      note?: string | null;
    },
  ) =>
    request<{ decisions: ReconcileDecision[]; updated: number }>(
      `/api/copilot-reconcile-reviews/${reviewId}/decisions/batch`,
      json('POST', payload),
    ),
  listReconcileDocuments: (reviewId: string) =>
    request<{
      items: Array<{
        id: string;
        title: string;
        version: number;
        status: string;
        created_at: string;
        is_stale: boolean;
      }>;
    }>(`/api/copilot-reconcile-reviews/${reviewId}/documents`),
  generateReconcileDocument: (reviewId: string) =>
    request<{
      item: {
        id: string;
        title: string;
        version: number;
        type: string;
        status: string;
      };
    }>(`/api/copilot-reconcile-reviews/${reviewId}/documents`, json('POST', {})),
  exportReconcileDocumentDocx: (reviewId: string) =>
    requestBlob(`/api/copilot-reconcile-reviews/${reviewId}/document.docx`),
  exportReconcileDifferencesCsv: (reviewId: string) =>
    requestBlob(
      `/api/copilot-reconcile-reviews/${reviewId}/differences/export.csv`,
    ),
  exportReconcileBatchesCsv: (
    reviewId: string,
    filters: BatchExportFilters = {},
  ) =>
    requestBlob(
      `/api/copilot-reconcile-reviews/${reviewId}/action-batches/export.csv${batchExportQuery(filters)}`,
    ),
  exportReconcileBatchItemsCsv: (
    reviewId: string,
    filters: BatchExportFilters = {},
  ) =>
    requestBlob(
      `/api/copilot-reconcile-reviews/${reviewId}/action-batches/export-items.csv${batchExportQuery(filters)}`,
    ),
  exportReconcileBatchesZip: (
    reviewId: string,
    filters: BatchExportFilters = {},
  ) =>
    requestBlob(
      `/api/copilot-reconcile-reviews/${reviewId}/action-batches/export.zip${batchExportQuery(filters)}`,
    ),
  cancelReconcileBatch: (
    batchId: string,
    payload: { reason?: string | null } = {},
  ) =>
    request<{ item: ReconcileBatch }>(
      `/api/copilot-reconcile-batches/${batchId}/cancel`,
      json('POST', payload),
    ),
  streamResumeReconcileBatch: (
    batchId: string,
    payload: {
      owner?: string | null;
      severity?: 'P0' | 'P1' | 'P2' | 'P3';
      due_date?: string | null;
    },
    onEvent: (event: BatchActionEvent) => void,
  ) =>
    requestStream(
      `/api/copilot-reconcile-batches/${batchId}/resume/stream`,
      payload,
      onEvent,
    ),
  listPlatformInvoices: () =>
    request<{ items: Invoice[] }>('/api/platform/invoices'),
  markPlatformInvoicePaid: (id: string) =>
    request<{ item: Invoice }>(`/api/platform/invoices/${id}/mark-paid`, {
      method: 'POST',
    }),
  voidPlatformInvoice: (id: string) =>
    request<{ item: Invoice }>(`/api/platform/invoices/${id}/void`, {
      method: 'POST',
    }),
  updatePlatformTenant: (id: string, payload: Record<string, unknown>) =>
    request<{ item: OrganizationSummary }>(
      `/api/platform/tenants/${id}`,
      json('PATCH', payload),
    ),
  exportPlatformTenant: async (id: string) => {
    const res = await fetch(`${BASE}/api/platform/tenants/${id}/export`, {
      headers: authHeaders(),
    });
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
    return res.blob();
  },
  deletePlatformTenant: (id: string, confirm: string) =>
    request<{ ok: boolean; deleted: string }>(
      `/api/platform/tenants/${id}?confirm=${encodeURIComponent(confirm)}`,
      { method: 'DELETE' },
    ),

  listAdminUsers: () => request<{ items: AdminUser[] }>('/api/admin/users'),
  createAdminUser: (payload: Record<string, unknown>) =>
    request<{ item: AdminUser }>('/api/admin/users', json('POST', payload)),
  updateAdminUser: (id: string, payload: Record<string, unknown>) =>
    request<{ item: AdminUser }>(`/api/admin/users/${id}`, json('PATCH', payload)),
  resetAdminPassword: (id: string, password: string) =>
    request<{ ok: boolean; revoked: number }>(
      `/api/admin/users/${id}/reset-password`,
      json('POST', { password }),
    ),

  changePassword: (oldPassword: string, newPassword: string) =>
    request<{ ok: boolean; revoked_others: number }>(
      '/api/auth/change-password',
      json('POST', { old_password: oldPassword, new_password: newPassword }),
    ),
  listMySessions: () => request<{ items: UserSession[] }>('/api/auth/sessions'),
  revokeMySession: (id: string) =>
    request<{ ok: boolean }>(`/api/auth/sessions/${id}`, { method: 'DELETE' }),
  logoutAll: () =>
    request<{ ok: boolean; revoked: number }>('/api/auth/logout-all', { method: 'POST' }),

  // 字典
  listUsers: () => request<{ items: User[] }>('/api/users'),
};
