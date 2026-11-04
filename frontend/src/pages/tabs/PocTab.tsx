import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { api, type BatchActionEvent } from '../../api';
import { getStoredUser } from '../../auth';
import { useDebouncedValue, useLoad } from '../../hooks';
import type {
  CopilotReconcileReview,
  CopilotReconcileReviewDetail,
  EngagementDetail,
  ReconcileBatch,
  ReconcileDifference,
  PocDetail,
  PocExperiment,
  PocRun,
  User,
} from '../../types';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Stat,
  Textarea,
} from '../../ui';
import {
  deliverableStatusLabel,
  fmtDate,
  fmtDateTime,
} from '../../utils';

const STATUS_LABEL: Record<string, string> = {
  planned: '计划中',
  running: '运行中',
  reviewing: '复盘中',
  passed: '已通过',
  failed: '未通过',
  cancelled: '已取消',
};

const DECISION_LABEL: Record<string, string> = {
  go: 'Go',
  no_go: 'No-Go',
  conditional: '有条件',
  pending: '待定',
};

const ACCESS_LABEL: Record<string, string> = {
  pending: '待申请',
  approved: '已批准',
  rejected: '已拒绝',
  not_required: '无需申请',
};

const statusTone = (status: string) =>
  status === 'passed'
    ? 'green'
    : status === 'failed'
      ? 'red'
      : status === 'reviewing'
        ? 'amber'
        : 'gray';

export function PocTab({
  engagementId,
  detail,
  initialReviewId,
  initialViewId,
  onChanged,
  onGoReports,
}: {
  engagementId: string;
  detail: EngagementDetail;
  initialReviewId?: string;
  initialViewId?: string;
  onChanged: () => void;
  onGoReports: () => void;
}) {
  const { data, error, loading, reload } = useLoad(
    async () => {
      const [e, u] = await Promise.all([
        api.listExperiments(engagementId),
        api.listUsers(),
      ]);
      return { experiments: e.items, users: u.items };
    },
    [engagementId],
  );
  const g3 = useLoad(() => api.g3Checks(engagementId), [engagementId]);
  const [reviewDecisionFilter, setReviewDecisionFilter] = useState<
    'all' | 'pending' | 'ignored' | 'decided'
  >('all');
  const [reviewSearch, setReviewSearch] = useState('');
  const debouncedReviewSearch = useDebouncedValue(reviewSearch, 300);
  const copilotReviews = useLoad(
    () =>
      api.listCopilotReconcileReviews(engagementId, {
        decision_state: reviewDecisionFilter,
        q: debouncedReviewSearch.trim() || undefined,
      }),
    [engagementId, reviewDecisionFilter, debouncedReviewSearch],
  );
  const diffStats = useLoad(
    () => api.getReconcileDiffStats(engagementId),
    [engagementId],
  );
  const [statsExportError, setStatsExportError] = useState<unknown>(null);
  const [exportingStats, setExportingStats] = useState(false);
  const exportDiffStats = async () => {
    setExportingStats(true);
    setStatsExportError(null);
    try {
      const blob = await api.exportReconcileDiffStatsCsv(engagementId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'copilot-diff-stats.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setStatsExportError(err);
    } finally {
      setExportingStats(false);
    }
  };
  const decisionCount = (key: string) =>
    diffStats.data?.by_decision.find((row) => row.decision === key)?.count ??
    0;
  const [selectedReview, setSelectedReview] = useState<CopilotReconcileReviewDetail | null>(null);
  const closeReview = () => {
    setSelectedReview(null);
    clearBatchFiltersFromUrl();
  };
  const [reviewError, setReviewError] = useState<unknown>(null);
  const [reviewLoading, setReviewLoading] = useState(false);

  const openReview = async (id: string) => {
    setReviewLoading(true);
    setReviewError(null);
    try {
      const res = await api.getCopilotReconcileReview(id);
      setSelectedReview(res.item);
    } catch (err) {
      setReviewError(err);
    } finally {
      setReviewLoading(false);
    }
  };

  const openedInitialReview = useRef<string | null>(null);
  useEffect(() => {
    if (!initialReviewId) return;
    if (openedInitialReview.current === initialReviewId) return;
    openedInitialReview.current = initialReviewId;
    void openReview(initialReviewId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialReviewId]);

  const reportable = detail.opportunities.filter(
    (o) => o.targetPhase === 'phase1' || o.targetPhase === 'phase2',
  );
  const [selectedOppId, setSelectedOppId] = useState<string | null>(
    reportable[0]?.id ?? detail.opportunities[0]?.id ?? null,
  );
  const [selectedExperimentId, setSelectedExperimentId] = useState<string | null>(null);

  const experiments = data?.experiments ?? [];
  const users = data?.users ?? [];
  const selectedOpp = detail.opportunities.find((o) => o.id === selectedOppId);
  const oppExperiments = useMemo(
    () =>
      experiments
        .filter((e) => e.opportunity_id === selectedOppId)
        .sort((a, b) => b.version - a.version),
    [experiments, selectedOppId],
  );

  useEffect(() => {
    setSelectedExperimentId(null);
  }, [selectedOppId]);

  useEffect(() => {
    if (!selectedExperimentId && oppExperiments.length) {
      setSelectedExperimentId(oppExperiments[0].id);
    }
  }, [oppExperiments, selectedExperimentId]);

  const after = async () => {
    await reload();
    g3.reload();
    void copilotReviews.reload();
    onChanged();
  };

  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorBox error={error} onRetry={() => void reload()} />;

  return (
    <div className="tab-body">
      <Card
        title="G3 验证门禁"
        subtitle="实验设计 → 可用样本 → 运行 → 人工复核 → 结论/证据 → 决策。"
        actions={
          <Button size="sm" disabled={g3.loading} onClick={() => void g3.reload()}>
            刷新校验
          </Button>
        }
      >
        {g3.loading ? <Spinner label="校验中…" /> : null}
        {g3.error ? <ErrorBox error={g3.error} onRetry={() => void g3.reload()} /> : null}
        {g3.data ? (
          <>
            <div className="check-summary">
              <span className="check-pill check-pass">{g3.data.summary.pass} pass</span>
              <span className="check-pill check-warn">{g3.data.summary.warn} warn</span>
              <span className="check-pill check-block">{g3.data.summary.block} block</span>
            </div>
            <div className="check-list">
              {g3.data.checks.map((c) => (
                <div key={c.code} className="check-row">
                  <span className={`check-dot check-dot-${c.outcome}`} />
                  <strong>{c.code}</strong>
                  <span className="check-title">{c.title}</span>
                  {c.outcome !== 'pass' ? <span className="check-msg">{c.message}</span> : null}
                </div>
              ))}
            </div>
          </>
        ) : null}
      </Card>

      <div className="opp-layout">
        <Card title="POC 实验对象" subtitle="按一期/二期机会点；每个机会点可有多个实验版本。" className="opp-list-card">
          <div className="opp-list">
            {reportable.map((o) => {
              const list = experiments
                .filter((e) => e.opportunity_id === o.id)
                .sort((a, b) => b.version - a.version);
              const latest = list[0];
              return (
                <button
                  key={o.id}
                  className={`opp-item ${selectedOppId === o.id ? 'opp-item-active' : ''}`}
                  onClick={() => setSelectedOppId(o.id)}
                >
                  <div className="opp-item-top">
                    <span className="mono">{o.code}</span>
                    {latest ? (
                      <Badge tone={statusTone(latest.status)}>
                        {STATUS_LABEL[latest.status] ?? latest.status}
                      </Badge>
                    ) : (
                      <Badge tone="gray">未建实验</Badge>
                    )}
                  </div>
                  <strong>{o.title}</strong>
                  <div className="opp-item-meta">
                    <span>{list.length} 个版本</span>
                    {latest?.decision ? <span>{DECISION_LABEL[latest.decision] ?? latest.decision}</span> : null}
                  </div>
                </button>
              );
            })}
          </div>
        </Card>

        <div className="opp-editor">
          {!selectedOpp ? (
            <Card><Empty title="选择一个机会点" /></Card>
          ) : oppExperiments.length === 0 ? (
            <CreateExperimentForm
              opportunityId={selectedOpp.id}
              label={`${selectedOpp.code} ${selectedOpp.title}`}
              onCreated={async (e) => {
                await after();
                setSelectedExperimentId(e.id);
              }}
            />
          ) : (
            <div className="editor-stack">
              <Card
                title={`${selectedOpp.code} · ${selectedOpp.title}`}
                subtitle={`${oppExperiments.length} 个实验版本`}
                actions={
                  <Select
                    value={selectedExperimentId ?? oppExperiments[0].id}
                    onChange={(e) => setSelectedExperimentId(e.target.value)}
                  >
                    {oppExperiments.map((e) => (
                      <option key={e.id} value={e.id}>
                        v{e.version} · {STATUS_LABEL[e.status] ?? e.status}
                      </option>
                    ))}
                  </Select>
                }
              >
                <p className="hint-line">实验详情、样本、运行、复核与结论在下方。</p>
              </Card>
              <ExperimentEditor
                experimentId={selectedExperimentId ?? oppExperiments[0].id}
                users={users}
                onChanged={after}
                onGoReports={onGoReports}
              />
            </div>
          )}
        </div>
      </div>

      <Card
        title="ai-copilot 对账复核记录"
        subtitle="客户/车队对账单抽取、差异解释与人工决策的回写；由 ai-copilot 复核页推送。"
        actions={
          <div className="row">
            <Input
              placeholder="单据号 / 运单号"
              value={reviewSearch}
              onChange={(e) => setReviewSearch(e.target.value)}
              style={{ maxWidth: 160 }}
            />
            <Select
              value={reviewDecisionFilter}
              onChange={(e) =>
                setReviewDecisionFilter(
                  e.target.value as 'all' | 'pending' | 'ignored' | 'decided',
                )
              }
              style={{ maxWidth: 150 }}
            >
              <option value="all">全部决策</option>
              <option value="pending">有未决差异</option>
              <option value="ignored">含已忽略</option>
              <option value="decided">已全部决策</option>
            </Select>
            <Button size="sm" disabled={copilotReviews.loading} onClick={() => void copilotReviews.reload()}>
              刷新
            </Button>
          </div>
        }
      >
        {copilotReviews.loading && !copilotReviews.data ? <Spinner /> : null}
        {copilotReviews.error ? (
          <ErrorBox error={copilotReviews.error} onRetry={() => void copilotReviews.reload()} />
        ) : null}
        {copilotReviews.data ? (
          copilotReviews.data.items.length === 0 ? (
            <Empty
              title="还没有对账复核记录"
              hint="在 ai-copilot 复核页保存并推送后，会出现在这里。"
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>收到时间</th><th>类型</th><th>单据号</th>
                    <th>差异</th><th>决策进度</th><th>决策</th><th>来源</th><th />
                  </tr>
                </thead>
                <tbody>
                  {copilotReviews.data.items.map((r) => (
                    <tr key={r.id}>
                      <td className="muted">{fmtDateTime(r.received_at)}</td>
                      <td>{r.kind === 'statement' ? '客户对账单' : '车队结算单'}</td>
                      <td className="mono">{r.document_id || '—'}</td>
                      <td>
                        <Badge tone={r.differences.length ? 'red' : 'green'}>
                          {r.differences.length}
                        </Badge>
                      </td>
                      <td>
                        {(() => {
                          const { total, decided } = decisionProgress(r);
                          if (!total) return <span className="muted">—</span>;
                          const tone =
                            decided === total
                              ? 'green'
                              : decided > 0
                                ? 'amber'
                                : 'gray';
                          return (
                            <Badge tone={tone}>
                              {decided}/{total}
                            </Badge>
                          );
                        })()}
                      </td>
                      <td className="muted">{decisionSummary(r.decisions)}</td>
                      <td className="muted">{r.source}</td>
                      <td className="actions-cell">
                        <Button size="sm" onClick={() => void openReview(r.id)}>查看</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}
      </Card>

      <Card
        title="差异分布"
        subtitle="规则命中、解释来源、置信度与决策进度"
        actions={
          <div className="row">
            <Button
              size="sm"
              disabled={exportingStats || !diffStats.data}
              onClick={() => void exportDiffStats()}
            >
              {exportingStats ? '导出中…' : '导出分布 CSV'}
            </Button>
            <Button
              size="sm"
              disabled={diffStats.loading}
              onClick={() => void diffStats.reload()}
            >
              刷新
            </Button>
          </div>
        }
      >
        {statsExportError ? <ErrorBox error={statsExportError} /> : null}
        {diffStats.data ? (
          <>
            <div className="stat-grid" style={{ marginBottom: 10 }}>
              <Stat label="复核记录" value={diffStats.data.reviews} tone="brand" />
              <Stat label="差异总数" value={diffStats.data.differences} tone="amber" />
              <Stat label="已采纳" value={decisionCount('采纳')} tone="green" />
              <Stat label="已忽略" value={decisionCount('忽略')} tone="gray" />
            </div>
            <div className="form-grid">
              <div>
                <div className="muted small">按类型</div>
                {diffStats.data.by_type.length ? (
                  diffStats.data.by_type.map((row) => (
                    <div key={row.type} style={{ marginTop: 4 }}>
                      {RECONCILE_DIFF_LABEL[row.type] ?? row.type}{' '}
                      <Badge tone="red">{row.count}</Badge>
                    </div>
                  ))
                ) : (
                  <div className="muted">—</div>
                )}
              </div>
              <div>
                <div className="muted small">按来源</div>
                {diffStats.data.by_source.length ? (
                  diffStats.data.by_source.map((row) => (
                    <div key={row.source} style={{ marginTop: 4 }}>
                      {DIFF_SOURCE_LABEL[row.source] ?? row.source}{' '}
                      <Badge tone="blue">{row.count}</Badge>
                    </div>
                  ))
                ) : (
                  <div className="muted">—</div>
                )}
              </div>
              <div>
                <div className="muted small">按置信度</div>
                {diffStats.data.by_confidence.map((row) => (
                  <div key={row.bucket} style={{ marginTop: 4 }}>
                    {row.bucket === 'high'
                      ? '高 (≥0.8)'
                      : row.bucket === 'medium'
                        ? '中 (0.6–0.8)'
                        : row.bucket === 'low'
                          ? '低 (<0.6)'
                          : '未知'}{' '}
                    <Badge tone="gray">{row.count}</Badge>
                  </div>
                ))}
              </div>
              <div>
                <div className="muted small">决策</div>
                {diffStats.data.by_decision.length ? (
                  diffStats.data.by_decision.map((row) => (
                    <div key={row.decision} style={{ marginTop: 4 }}>
                      {row.decision}{' '}
                      <Badge tone={row.decision === '忽略' ? 'gray' : 'green'}>
                        {row.count}
                      </Badge>
                    </div>
                  ))
                ) : (
                  <div className="muted">—</div>
                )}
              </div>
            </div>
          </>
        ) : diffStats.loading ? (
          <Spinner />
        ) : (
          <Empty title="暂无差异数据" />
        )}
      </Card>

      <Modal
        open={Boolean(selectedReview)}
        title={selectedReview ? `对账复核 · ${selectedReview.document_id || selectedReview.id}` : '对账复核'}
        subtitle={
          selectedReview
            ? `${selectedReview.kind === 'statement' ? '客户对账单' : '车队结算单'} · ${fmtDateTime(selectedReview.received_at)}`
            : undefined
        }
        onClose={closeReview}
        wide
      >
        {reviewError ? <ErrorBox error={reviewError} /> : null}
        {reviewLoading ? (
          <Spinner />
        ) : selectedReview ? (
          <ReconcileReviewDetail
            review={selectedReview}
            engagementId={engagementId}
            users={users}
            initialViewId={initialViewId}
            onChanged={after}
            onAction={(patch) => setSelectedReview((prev) => (prev ? { ...prev, ...patch } : prev))}
          />
        ) : null}
      </Modal>
    </div>
  );
}

const RECONCILE_DIFF_LABEL: Record<string, string> = {
  amount_mismatch: '金额不符',
  missing_line: '对账单缺行',
  extra_line: '对账单多行',
  duplicate: '重复',
  tax_mismatch: '税额不符',
  unit_price_mismatch: '单价不符',
  quantity_mismatch: '数量不符',
  period_mismatch: '账期不符',
  customer_mismatch: '主体不符',
  rounding: '舍入',
  no_rate: '无合同价',
};

const DIFF_SOURCE_LABEL: Record<string, string> = {
  'llm+rule': '模型 + 规则',
  rule: '规则',
  llm: '模型',
};

function localDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addBusinessDays(start: Date, days: number, holidays: Set<string> = new Set()): Date {
  const d = new Date(start.getTime());
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const weekday = d.getDay();
    if (weekday !== 0 && weekday !== 6 && !holidays.has(localDate(d))) added += 1;
  }
  return d;
}

function slaDate(severity: string, holidays: Set<string> = new Set()): string {
  const days = severity === 'P0' ? 1 : severity === 'P1' ? 3 : severity === 'P2' ? 7 : 14;
  return localDate(addBusinessDays(new Date(), days, holidays));
}

const VIEW_ROLE_LABEL: Record<string, string> = {
  admin: '管理员',
  director: '总监',
  pm: '项目经理',
  consultant: '顾问',
  tech_lead: '技术负责人',
};

type BatchStatusFilter = '' | 'running' | 'completed' | 'failed' | 'cancelled';
type BatchTypeFilter = '' | 'risk' | 'issue';

const BATCH_FILTER_KEYS = {
  review: 'batch_review',
  status: 'batch_status',
  type: 'batch_type',
  from: 'batch_from',
  to: 'batch_to',
  view: 'batch_view',
} as const;

interface BatchFilters {
  status: BatchStatusFilter;
  type: BatchTypeFilter;
  from: string;
  to: string;
}

function readBatchFiltersFromUrl(reviewId: string): BatchFilters {
  if (typeof window === 'undefined') {
    return { status: '', type: '', from: '', to: '' };
  }
  const params = new URLSearchParams(window.location.search);
  const scopedReview = params.get(BATCH_FILTER_KEYS.review);
  if (scopedReview && scopedReview !== reviewId) {
    return { status: '', type: '', from: '', to: '' };
  }
  const status = params.get(BATCH_FILTER_KEYS.status) ?? '';
  const type = params.get(BATCH_FILTER_KEYS.type) ?? '';
  const from = params.get(BATCH_FILTER_KEYS.from) ?? '';
  const to = params.get(BATCH_FILTER_KEYS.to) ?? '';
  const validStatus = ['running', 'completed', 'failed', 'cancelled'];
  const validType = ['risk', 'issue'];
  const dateOk = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
  return {
    status: validStatus.includes(status) ? (status as BatchStatusFilter) : '',
    type: validType.includes(type) ? (type as BatchTypeFilter) : '',
    from: dateOk(from) ? from : '',
    to: dateOk(to) ? to : '',
  };
}

function readBatchViewFromUrl(reviewId: string): string {
  if (typeof window === 'undefined') return '';
  const params = new URLSearchParams(window.location.search);
  const scopedReview = params.get(BATCH_FILTER_KEYS.review);
  if (scopedReview && scopedReview !== reviewId) return '';
  return params.get(BATCH_FILTER_KEYS.view) ?? '';
}

function writeBatchFiltersToUrl(
  reviewId: string,
  filters: BatchFilters,
  viewId: string,
) {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  const entries: Array<[string, string]> = [
    [BATCH_FILTER_KEYS.status, filters.status],
    [BATCH_FILTER_KEYS.type, filters.type],
    [BATCH_FILTER_KEYS.from, filters.from],
    [BATCH_FILTER_KEYS.to, filters.to],
  ];
  let hasFilter = false;
  for (const [key, value] of entries) {
    if (value) {
      params.set(key, value);
      hasFilter = true;
    } else {
      params.delete(key);
    }
  }
  if (hasFilter) params.set(BATCH_FILTER_KEYS.review, reviewId);
  else params.delete(BATCH_FILTER_KEYS.review);
  if (viewId) params.set(BATCH_FILTER_KEYS.view, viewId);
  else params.delete(BATCH_FILTER_KEYS.view);
  const qs = params.toString();
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`,
  );
}

function clearBatchFiltersFromUrl() {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  params.delete(BATCH_FILTER_KEYS.review);
  params.delete(BATCH_FILTER_KEYS.status);
  params.delete(BATCH_FILTER_KEYS.type);
  params.delete(BATCH_FILTER_KEYS.from);
  params.delete(BATCH_FILTER_KEYS.to);
  params.delete(BATCH_FILTER_KEYS.view);
  const qs = params.toString();
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`,
  );
}

const BATCH_FILTER_STORAGE = 'ai-delivery-batch-filters';
const BATCH_FILTER_REMEMBER = 'ai-delivery-batch-filters-remember';

function normalizeBatchFilters(input: any): BatchFilters {
  const validStatus = ['running', 'completed', 'failed', 'cancelled'];
  const validType = ['risk', 'issue'];
  const dateOk = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const status = typeof input?.status === 'string' ? input.status : '';
  const type = typeof input?.type === 'string' ? input.type : '';
  return {
    status: validStatus.includes(status) ? (status as BatchStatusFilter) : '',
    type: validType.includes(type) ? (type as BatchTypeFilter) : '',
    from: dateOk(input?.from) ? String(input.from) : '',
    to: dateOk(input?.to) ? String(input.to) : '',
  };
}

function readRememberedBatchFilters(): BatchFilters | null {
  if (typeof window === 'undefined') return null;
  if (window.localStorage.getItem(BATCH_FILTER_REMEMBER) !== '1') return null;
  try {
    const raw = window.localStorage.getItem(BATCH_FILTER_STORAGE);
    return raw ? normalizeBatchFilters(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function saveRememberedBatchFilters(filters: BatchFilters, remember: boolean) {
  if (typeof window === 'undefined') return;
  if (!remember) {
    window.localStorage.removeItem(BATCH_FILTER_STORAGE);
    window.localStorage.removeItem(BATCH_FILTER_REMEMBER);
    return;
  }
  window.localStorage.setItem(BATCH_FILTER_REMEMBER, '1');
  window.localStorage.setItem(BATCH_FILTER_STORAGE, JSON.stringify(filters));
}

const ACTION_STATUS_LABEL: Record<string, string> = {
  open: '待处理',
  in_progress: '处理中',
  mitigated: '已缓解',
  resolved: '已解决',
  closed: '已关闭',
  rejected: '已拒绝',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function statusLabel(status?: string | null): string {
  if (!status) return '已生成';
  return ACTION_STATUS_LABEL[status] ?? status;
}

function groupDifferences<T extends { type?: string | null }>(
  diffs: T[],
): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const diff of diffs) {
    const key = diff.type ?? 'unknown';
    const list = groups.get(key) ?? [];
    list.push(diff);
    groups.set(key, list);
  }
  return [...groups.entries()];
}

function decisionProgress(review: CopilotReconcileReview): {
  total: number;
  decided: number;
} {
  const total = review.differences.length;
  const ignored = new Set(
    review.decisions
      .filter((d) => d.decision === '采纳' || d.decision === '忽略')
      .map((d) => d.difference_id),
  );
  const decided = review.differences.filter(
    (d) => d.difference_id && ignored.has(d.difference_id),
  ).length;
  return { total, decided };
}

function decisionSummary(decisions: Array<{ decision: string }>): string {
  if (!decisions.length) return '—';
  const counts: Record<string, number> = {};
  for (const d of decisions) counts[d.decision] = (counts[d.decision] ?? 0) + 1;
  return Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' / ');
}

function ReconcileReviewDetail({
  review,
  engagementId,
  users,
  initialViewId,
  onChanged,
  onAction,
}: {
  review: CopilotReconcileReviewDetail;
  engagementId: string;
  users: User[];
  initialViewId?: string;
  onChanged: () => Promise<void> | void;
  onAction: (patch: Partial<CopilotReconcileReviewDetail>) => void;
}) {
  const doc = review.document as any;
  const [actionBusy, setActionBusy] = useState<'risk' | 'issue' | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [exportingDiffs, setExportingDiffs] = useState(false);
  const [exportingDocx, setExportingDocx] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [generatingDoc, setGeneratingDoc] = useState(false);
  const [decisionBusy, setDecisionBusy] = useState<string | null>(null);
  const [batchDecisionBusy, setBatchDecisionBusy] = useState<
    '采纳' | '忽略' | null
  >(null);
  const [latestDoc, setLatestDoc] = useState<{
    id: string;
    title: string;
    version: number;
    status: string;
    is_stale: boolean;
  } | null>(null);
  const [batchProgress, setBatchProgress] = useState<{
    type: 'risk' | 'issue';
    done: number;
    total: number;
  } | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [resumeTarget, setResumeTarget] = useState<ReconcileBatch | null>(null);
  const [collapsedRoots, setCollapsedRoots] = useState<Set<string>>(new Set());
  const [collapsedTypes, setCollapsedTypes] = useState<Set<string>>(new Set());
  const [diffSourceFilter, setDiffSourceFilter] = useState('');
  const [diffConfidenceFilter, setDiffConfidenceFilter] = useState('');
  const confidenceBucket = (diff: ReconcileDifference) => {
    const value = Number(diff.confidence);
    if (!Number.isFinite(value)) return 'unknown';
    if (value >= 0.8) return 'high';
    if (value >= 0.6) return 'medium';
    return 'low';
  };
  const diffSources = Array.from(
    new Set(review.differences.map((diff) => diff.source ?? 'unknown')),
  );
  const filteredDifferences = review.differences.filter((diff) => {
    if (diffSourceFilter && (diff.source ?? 'unknown') !== diffSourceFilter) {
      return false;
    }
    if (
      diffConfidenceFilter &&
      confidenceBucket(diff) !== diffConfidenceFilter
    ) {
      return false;
    }
    return true;
  });
  const allDiffTypes = groupDifferences(filteredDifferences).map(
    ([type]) => type,
  );
  const allDiffTypesCollapsed =
    allDiffTypes.length > 0 &&
    allDiffTypes.every((type) => collapsedTypes.has(type));
  const toggleDiffType = (type: string) =>
    setCollapsedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  const [exportingBatches, setExportingBatches] = useState(false);
  const [exportingItems, setExportingItems] = useState(false);
  const [exportingZip, setExportingZip] = useState(false);
  const urlFilters = useMemo(() => readBatchFiltersFromUrl(review.id), [review.id]);
  const urlViewId = useMemo(() => readBatchViewFromUrl(review.id), [review.id]);
  const rememberedFilters = useMemo(() => {
    const hasUrlFilter = Boolean(
      urlFilters.status || urlFilters.type || urlFilters.from || urlFilters.to,
    );
    return hasUrlFilter ? null : readRememberedBatchFilters();
  }, [urlFilters]);
  const [exportStatus, setExportStatus] = useState<BatchStatusFilter>(
    urlFilters.status || rememberedFilters?.status || '',
  );
  const [exportType, setExportType] = useState<BatchTypeFilter>(
    urlFilters.type || rememberedFilters?.type || '',
  );
  const [exportFrom, setExportFrom] = useState(
    urlFilters.from || rememberedFilters?.from || '',
  );
  const [exportTo, setExportTo] = useState(
    urlFilters.to || rememberedFilters?.to || '',
  );
  const [selectedViewId, setSelectedViewId] = useState(urlViewId);
  const [pendingViewId, setPendingViewId] = useState(
    initialViewId || urlViewId,
  );
  useEffect(() => {
    if (initialViewId) setPendingViewId(initialViewId);
  }, [initialViewId]);
  const [shareView, setShareView] = useState(false);
  const [sharedRole, setSharedRole] = useState<
    '' | 'admin' | 'director' | 'pm' | 'consultant' | 'tech_lead'
  >('');
  const [sharedUserIds, setSharedUserIds] = useState<string[]>([]);
  const [rememberFilters, setRememberFilters] = useState(() =>
    typeof window === 'undefined'
      ? false
      : window.localStorage.getItem(BATCH_FILTER_REMEMBER) === '1',
  );
  const filterValues = useMemo(
    () => ({
      status: exportStatus,
      type: exportType,
      from: exportFrom,
      to: exportTo,
    }),
    [exportStatus, exportType, exportFrom, exportTo],
  );
  const debouncedFilters = useDebouncedValue(filterValues, 300);
  const filterError =
    exportFrom && exportTo && exportFrom > exportTo
      ? '开始日期不能晚于结束日期'
      : '';
  const debouncedFilterError =
    debouncedFilters.from &&
    debouncedFilters.to &&
    debouncedFilters.from > debouncedFilters.to
      ? '开始日期不能晚于结束日期'
      : '';
  const [resumeOwner, setResumeOwner] = useState('');
  const [resumeSeverity, setResumeSeverity] = useState<'P0' | 'P1' | 'P2' | 'P3'>('P2');
  const [resumeDue, setResumeDue] = useState('');
  const [owner, setOwner] = useState(() => getStoredUser()?.id ?? users[0]?.id ?? '');
  const holidays = useLoad(() => api.listHolidays({ effective: true }), []);
  const [batchLimit, setBatchLimit] = useState(20);
  const batches = useLoad(
    () =>
      debouncedFilterError
        ? Promise.resolve({
            items: [],
            total: 0,
            batch_total: 0,
            roots_returned: 0,
            limit: batchLimit,
            offset: 0,
          })
        : api.listReconcileBatches(review.id, {
            limit: batchLimit,
            ...(debouncedFilters.status ? { status: debouncedFilters.status } : {}),
            ...(debouncedFilters.type ? { action_type: debouncedFilters.type } : {}),
            ...(debouncedFilters.from ? { from: debouncedFilters.from } : {}),
            ...(debouncedFilters.to ? { to: debouncedFilters.to } : {}),
          }),
    [review.id, batchLimit, debouncedFilters, debouncedFilterError],
  );
  const estimate = useLoad(
    () =>
      debouncedFilterError
        ? Promise.resolve({
            batches: 0,
            items: 0,
            estimated_bytes: { summary: 0, items: 0, zip: 0 },
            large: false,
            filters: {},
          })
        : api.getBatchExportEstimate(review.id, {
            ...(debouncedFilters.status ? { status: debouncedFilters.status } : {}),
            ...(debouncedFilters.type ? { action_type: debouncedFilters.type } : {}),
            ...(debouncedFilters.from ? { from: debouncedFilters.from } : {}),
            ...(debouncedFilters.to ? { to: debouncedFilters.to } : {}),
          }),
    [review.id, debouncedFilters, debouncedFilterError],
  );
  const views = useLoad(
    () => api.listBatchFilterViews(review.id),
    [review.id],
  );
  const [auditLimit] = useState(5);
  const [auditOffset, setAuditOffset] = useState(0);
  const [exportingAudits, setExportingAudits] = useState(false);
  const viewAudits = useLoad(
    () => api.listBatchFilterViewAudits(review.id, { limit: auditLimit, offset: auditOffset }),
    [review.id, auditLimit, auditOffset],
  );
  useEffect(() => {
    if (!pendingViewId) return;
    const items = views.data?.items;
    if (!items) return;
    const view = items.find((v) => v.id === pendingViewId);
    if (view) {
      setExportStatus(view.status ?? '');
      setExportType(view.action_type ?? '');
      setExportFrom(view.from ?? '');
      setExportTo(view.to ?? '');
      setSelectedViewId(view.id);
      setShareView(Boolean(view.shared));
      setSharedRole(view.shared_role ?? '');
      setSharedUserIds(view.shared_user_ids ?? []);
    } else {
      setSelectedViewId('');
    }
    setPendingViewId('');
  }, [pendingViewId, views.data]);

  const selectedView = (views.data?.items ?? []).find(
    (v) => v.id === selectedViewId,
  );
  useEffect(() => {
    writeBatchFiltersToUrl(
      review.id,
      {
        status: exportStatus,
        type: exportType,
        from: exportFrom,
        to: exportTo,
      },
      selectedViewId,
    );
  }, [exportStatus, exportType, exportFrom, exportTo, selectedViewId]);

  useEffect(() => {
    saveRememberedBatchFilters(
      {
        status: exportStatus,
        type: exportType,
        from: exportFrom,
        to: exportTo,
      },
      rememberFilters,
    );
  }, [rememberFilters, exportStatus, exportType, exportFrom, exportTo]);
  const holidaySet = useMemo(
    () => new Set((holidays.data?.items ?? []).map((h) => h.date)),
    [holidays.data],
  );
  const [dueDate, setDueDate] = useState(() => slaDate('P2'));
  const [severity, setSeverity] = useState<'P0' | 'P1' | 'P2' | 'P3'>('P2');

  useEffect(() => {
    if (holidays.data) setDueDate(slaDate(severity, holidaySet));
  }, [holidays.data, holidaySet, severity]);
  const lines: Array<Record<string, any>> = doc.lines ?? [];
  const decisions = new Map(review.decisions.map((d) => [d.difference_id, d]));
  const sourceSummary = (() => {
    const counts = new Map<string, number>();
    for (const diff of review.differences) {
      const key =
        DIFF_SOURCE_LABEL[diff.source ?? ''] ?? diff.source ?? '未知';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return (
      [...counts.entries()]
        .map(([key, count]) => `${key} ${count}`)
        .join(' · ') || '—'
    );
  })();
  const confidenceSummary = (() => {
    let high = 0;
    let medium = 0;
    let low = 0;
    let unknown = 0;
    for (const diff of review.differences) {
      const value = Number(diff.confidence);
      if (!Number.isFinite(value)) unknown += 1;
      else if (value >= 0.8) high += 1;
      else if (value >= 0.6) medium += 1;
      else low += 1;
    }
    return `高 ${high} · 中 ${medium} · 低 ${low}${
      unknown ? ` · 未知 ${unknown}` : ''
    }`;
  })();
  const decisionStateSummary = (() => {
    const counts: Record<string, number> = {
      采纳: 0,
      忽略: 0,
      待确认: 0,
      未决: 0,
    };
    for (const diff of review.differences) {
      const value = diff.difference_id
        ? decisions.get(diff.difference_id)?.decision
        : undefined;
      if (value === '采纳' || value === '忽略' || value === '待确认') {
        counts[value] += 1;
      } else {
        counts['未决'] += 1;
      }
    }
    return `采纳 ${counts['采纳']} · 忽略 ${counts['忽略']} · 待确认 ${counts['待确认']} · 未决 ${counts['未决']}`;
  })();
  const lineFields = review.kind === 'statement'
    ? ['waybill_no', 'container_no', 'container_type', 'amount', 'tax_amount', 'total_amount', 'due_date']
    : ['trip_no', 'waybill_no', 'plate_no', 'route', 'container_type', 'quantity', 'unit_price', 'amount', 'deduction'];
  const lineLabels: Record<string, string> = {
    waybill_no: '运单号', container_no: '箱号', container_type: '箱型',
    amount: '金额', tax_amount: '税额', total_amount: '价税合计', due_date: '到期日',
    trip_no: '趟次', plate_no: '车牌', route: '线路', quantity: '数量',
    unit_price: '单价', deduction: '扣款',
  };
  const actionFor = (differenceId: string | undefined, type: 'risk' | 'issue') =>
    differenceId
      ? review.actions?.find((a) => a.difference_id === differenceId && a.action_type === type)
      : undefined;

  const selectableDiffs = review.differences.filter((d) => {
    const decision = d.difference_id ? decisions.get(d.difference_id)?.decision : undefined;
    return Boolean(d.difference_id) && decision !== '忽略';
  });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(selectableDiffs.map((d) => d.difference_id as string)),
  );
  const [expandedDiff, setExpandedDiff] = useState<string | null>(null);
  const selectedDiffs = selectableDiffs.filter((d) => selectedIds.has(d.difference_id as string));
  const allSelected = selectableDiffs.length > 0 && selectedDiffs.length === selectableDiffs.length;
  const toggleDiff = (differenceId: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(differenceId)) next.delete(differenceId);
      else next.add(differenceId);
      return next;
    });
  const toggleAll = () =>
    setSelectedIds(
      allSelected
        ? new Set()
        : new Set(selectableDiffs.map((d) => d.difference_id as string)),
    );
  const exportDiffs = async () => {
    setExportingDiffs(true);
    setActionNotice(null);
    try {
      const blob = await api.exportReconcileDifferencesCsv(review.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `copilot-differences-${review.id}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setActionNotice('差异 CSV 已导出（含来源、置信度与证据）。');
    } catch (err) {
      setActionError(err);
    } finally {
      setExportingDiffs(false);
    }
  };

  const decisionsKey = JSON.stringify(review.decisions ?? []);
  useEffect(() => {
    let alive = true;
    api
      .listReconcileDocuments(review.id)
      .then((res) => {
        if (alive) setLatestDoc(res.items[0] ?? null);
      })
      .catch(() => {
        if (alive) setLatestDoc(null);
      });
    return () => {
      alive = false;
    };
  }, [review.id, decisionsKey]);

  const applyBatchDecision = async (decision: '采纳' | '忽略') => {
    const ids = selectedDiffs
      .map((d) => d.difference_id)
      .filter((id): id is string => Boolean(id));
    if (!ids.length) return;
    setBatchDecisionBusy(decision);
    setActionError(null);
    try {
      const res = await api.batchDecideReconcileDifferences(review.id, {
        difference_ids: ids,
        decision,
      });
      onAction({ decisions: res.decisions });
      setActionNotice(`已批量标记 ${res.updated} 条差异为「${decision}」。`);
    } catch (err) {
      setActionError(err);
    } finally {
      setBatchDecisionBusy(null);
    }
  };

  const saveDecision = async (
    diff: ReconcileDifference,
    decision: string,
    note: string,
  ) => {
    if (!diff.difference_id) return;
    setDecisionBusy(diff.difference_id);
    setActionError(null);
    try {
      const res = await api.decideReconcileDifference(review.id, {
        difference_id: diff.difference_id,
        decision,
        note: note.trim() ? note.trim() : null,
      });
      onAction({ decisions: res.decisions });
      setActionNotice('决策已保存。');
    } catch (err) {
      setActionError(err);
    } finally {
      setDecisionBusy(null);
    }
  };

  const exportReviewPdf = async () => {
    setExportingPdf(true);
    setActionNotice(null);
    try {
      const blob = await api.exportReconcileDocumentPdf(review.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const docNo = String(doc.statement_no ?? doc.settlement_no ?? review.id);
      link.href = url;
      link.download = `对账复核-${docNo}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setActionNotice('复核 PDF 已导出。');
    } catch (err) {
      setActionError(err);
    } finally {
      setExportingPdf(false);
    }
  };

  const exportReviewDocx = async () => {
    setExportingDocx(true);
    setActionNotice(null);
    try {
      const blob = await api.exportReconcileDocumentDocx(review.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const docNo = String(doc.statement_no ?? doc.settlement_no ?? review.id);
      link.href = url;
      link.download = `对账复核-${docNo}.docx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setActionNotice('复核 Word 已导出（含差异依据）。');
    } catch (err) {
      setActionError(err);
    } finally {
      setExportingDocx(false);
    }
  };

  const generateReviewDoc = async () => {
    setGeneratingDoc(true);
    setActionNotice(null);
    try {
      const res = await api.generateReconcileDocument(review.id);
      setLatestDoc({ ...res.item, is_stale: false });
      setActionNotice(
        `已生成交付物《${res.item.title}》v${res.item.version}，请在「报告」页签审批后分享给客户。`,
      );
    } catch (err) {
      setActionError(err);
    } finally {
      setGeneratingDoc(false);
    }
  };

  const riskEligible = selectedDiffs.filter((d) => !actionFor(d.difference_id, 'risk'));
  const issueEligible = selectedDiffs.filter((d) => !actionFor(d.difference_id, 'issue'));
  const docLabel = String(doc.statement_no ?? doc.settlement_no ?? review.document_id ?? review.id);
  const kindLabel = review.kind === 'statement' ? '客户对账单' : '车队结算单';

  const batchItems = batches.data?.items ?? [];
  const batchRows = batchItems.map((b) => ({ batch: b, depth: b.depth ?? 0 }));
  const rootsReturned =
    batches.data?.roots_returned ??
    batchItems.filter((b) => !b.parent_batch_id).length;
  const rootTotal = batches.data?.total ?? 0;
  const childCounts = new Map<string, number>();
  let currentRootId: string | null = null;
  for (const row of batchRows) {
    if (row.depth === 0) currentRootId = row.batch.id;
    else if (currentRootId) {
      childCounts.set(currentRootId, (childCounts.get(currentRootId) ?? 0) + 1);
    }
  }
  const visibleBatchRows: Array<{ batch: ReconcileBatch; depth: number }> = [];
  currentRootId = null;
  for (const row of batchRows) {
    if (row.depth === 0) {
      currentRootId = row.batch.id;
      visibleBatchRows.push(row);
    } else if (!currentRootId || !collapsedRoots.has(currentRootId)) {
      visibleBatchRows.push(row);
    }
  }

  const actionDetail = (diffs: ReconcileDifference[] = selectedDiffs) =>
    diffs
      .map((d) => {
        const decision = d.difference_id ? decisions.get(d.difference_id) : undefined;
        const label = RECONCILE_DIFF_LABEL[d.type] ?? d.type;
        return [
          `- ${label} ${d.waybill_no || d.trip_no || ''} 差额 ${d.delta ?? '—'}`,
          `可能原因：${d.possible_causes?.join('；') || '—'}`,
          `建议：${d.suggested_action || '—'}`,
          `来源：${DIFF_SOURCE_LABEL[d.source ?? ''] ?? d.source ?? '—'}${
            d.confidence != null ? `（置信度 ${d.confidence}）` : ''
          }`,
          `证据：${d.evidence?.join('；') || '—'}`,
          `决策：${decision?.decision || '—'}${decision?.note ? `（${decision.note}）` : ''}`,
        ].join('；');
      })
      .join('\n');

  const riskPayload = (d: ReconcileDifference) => {
    const delta = Math.abs(Number(d.delta ?? 0));
    return {
      type: 'risk' as const,
      difference_id: d.difference_id,
      owner: owner || null,
      due_date: dueDate || null,
      probability: delta >= 1000 ? 4 : 3,
      impact: delta >= 5000 ? 5 : delta >= 1000 ? 4 : 3,
      title: `对账差异：${kindLabel} ${docLabel} / ${d.waybill_no || d.trip_no || d.type}`,
      detail: `关联复核记录 ${review.id}\n${actionDetail([d])}`,
    };
  };

  const issuePayload = (d: ReconcileDifference) => {
    const delta = Math.abs(Number(d.delta ?? 0));
    return {
      type: 'issue' as const,
      difference_id: d.difference_id,
      owner: owner || null,
      due_date: dueDate || null,
      severity,
      title: `对账差异跟进：${kindLabel} ${docLabel} / ${d.waybill_no || d.trip_no || d.type}`,
      detail: `关联复核记录 ${review.id}\n${actionDetail([d])}`,
      impact_text: `应收/应付差异 ${delta.toLocaleString()} 元`,
    };
  };

  const appendActions = (
    type: 'risk' | 'issue',
    rows: Array<{ d: ReconcileDifference; res: { action_id?: string | null; item_id: string; item_code?: string } }>,
  ) => {
    if (!rows.length) return;
    onAction({
      actions: [
        ...(review.actions ?? []),
        ...rows.map(({ d, res }) => ({
          id: res.action_id ?? res.item_id,
          difference_id: d.difference_id as string,
          action_type: type,
          target_id: res.item_id,
          item_code: res.item_code ?? null,
          item_status: 'open',
          created_at: new Date().toISOString(),
        })),
      ],
    });
  };

  const runSingle = async (type: 'risk' | 'issue', d: ReconcileDifference) => {
    if (!d.difference_id) return;
    setActionBusy(type);
    setActionError(null);
    setActionNotice(null);
    try {
      const res = await api.createReconcileReviewAction(
        review.id,
        type === 'risk' ? riskPayload(d) : issuePayload(d),
      );
      appendActions(type, [{ d, res }]);
      setActionNotice(
        res.duplicate
          ? `该差异已生成过${type === 'risk' ? '风险' : '待办'}。`
          : type === 'risk'
            ? '已生成风险，可在「风险与局限」页查看。'
            : `已生成交付待办${res.item_code ? ` ${res.item_code}` : ''}，可在「交付」页查看。`,
      );
      await onChanged();
    } catch (err) {
      setActionError(err);
    } finally {
      setActionBusy(null);
    }
  };

  const consumeBatchStream = async (
    type: 'risk' | 'issue',
    total: number,
    runner: (onEvent: (event: BatchActionEvent) => void) => Promise<void>,
  ) => {
    setActionBusy(type);
    setActionError(null);
    setActionNotice(null);
    setBatchProgress({ type, done: 0, total });

    const diffById = new Map(
      review.differences
        .filter((d) => d.difference_id)
        .map((d) => [d.difference_id as string, d]),
    );
    const createdRows: Array<{
      d: ReconcileDifference;
      res: { action_id?: string | null; item_id: string; item_code?: string };
    }> = [];
    let created = 0;
    let skipped = 0;
    let failed = 0;
    let firstError: string | undefined;
    let errored = false;
    let cancelled = false;
    try {
      await runner((event) => {
        if (event.done) {
          if (typeof event.created === 'number') created = event.created;
          if (typeof event.skipped === 'number') skipped = event.skipped;
          if (typeof event.failed === 'number') failed = event.failed;
          if (event.cancelled) cancelled = true;
          return;
        }
        const d = event.difference_id ? diffById.get(event.difference_id) : undefined;
        if (event.status === 'created') {
          created += 1;
          if (d && event.item_id) {
            createdRows.push({
              d,
              res: {
                action_id: event.action_id,
                item_id: event.item_id,
                item_code: event.item_code ?? undefined,
              },
            });
          }
        } else if (event.status === 'duplicate') {
          skipped += 1;
        } else {
          failed += 1;
          if (event.error && !firstError) firstError = event.error;
        }
        setBatchProgress({
          type,
          done: created + skipped + failed,
          total,
        });
      });
    } catch (err) {
      errored = true;
      setActionError(err);
    } finally {
      appendActions(type, createdRows);
      setBatchProgress(null);
      const label = type === 'risk' ? '风险' : '待办';
      if (cancelled) {
        setActionNotice(
          `批次已取消：已生成 ${created} 条${label}，跳过 ${skipped} 条，失败 ${failed} 条。`,
        );
      } else if (!errored) {
        setActionNotice(
          `已生成 ${created} 条${label}，跳过 ${skipped} 条已存在` +
            (failed ? `，失败 ${failed} 条${firstError ? `（${firstError}）` : ''}` : '') +
            '。',
        );
      } else if (created || skipped || failed) {
        setActionNotice(
          `已生成 ${created} 条${label}，跳过 ${skipped} 条，失败 ${failed} 条（连接中断）。`,
        );
      }
      setActionBusy(null);
      await batches.reload();
      await onChanged();
    }
  };

  const runBatch = async (
    type: 'risk' | 'issue',
    only?: ReconcileDifference[],
  ) => {
    const targets = only ?? (type === 'risk' ? riskEligible : issueEligible);
    if (!targets.length) return;
    await consumeBatchStream(type, targets.length, (onEvent) =>
      api.streamReconcileReviewActionsBatch(
        review.id,
        {
          type,
          difference_ids: targets.map((d) => d.difference_id as string),
          owner: owner || null,
          due_date: dueDate || null,
          severity,
        },
        onEvent,
      ),
    );
  };

  const retryBatch = async (batch: ReconcileBatch) => {
    if (!batch.failed_count) return;
    await consumeBatchStream(batch.action_type, batch.failed_count, (onEvent) =>
      api.streamRetryReconcileBatch(batch.id, onEvent),
    );
  };

  const openResume = (batch: ReconcileBatch) => {
    const severity = (
      ['P0', 'P1', 'P2', 'P3'].includes(batch.severity) ? batch.severity : 'P2'
    ) as 'P0' | 'P1' | 'P2' | 'P3';
    setResumeTarget(batch);
    setResumeOwner(batch.owner ?? getStoredUser()?.id ?? '');
    setResumeSeverity(severity);
    setResumeDue(batch.due_date ?? slaDate(severity, holidaySet));
  };

  const confirmResume = async () => {
    const batch = resumeTarget;
    if (!batch) return;
    const total = batch.remaining_difference_ids?.length ?? 0;
    if (!total) return;
    setResumeTarget(null);
    await consumeBatchStream(batch.action_type, total, (onEvent) =>
      api.streamResumeReconcileBatch(
        batch.id,
        {
          owner: resumeOwner || null,
          severity: resumeSeverity,
          due_date: resumeDue || null,
        },
        onEvent,
      ),
    );
  };

  const toggleGroup = (rootId: string) => {
    setCollapsedRoots((prev) => {
      const next = new Set(prev);
      if (next.has(rootId)) next.delete(rootId);
      else next.add(rootId);
      return next;
    });
  };

  const clearBatchFilters = () => {
    setExportStatus('');
    setExportType('');
    setExportFrom('');
    setExportTo('');
    setSelectedViewId('');
    setBatchLimit(20);
  };

  const applyBatchView = (viewId: string) => {
    setSelectedViewId(viewId);
    if (!viewId) return;
    const view = (views.data?.items ?? []).find((v) => v.id === viewId);
    if (!view) return;
    setExportStatus(view.status ?? '');
    setExportType(view.action_type ?? '');
    setExportFrom(view.from ?? '');
    setExportTo(view.to ?? '');
    setShareView(Boolean(view.shared));
    setSharedRole(view.shared_role ?? '');
    setSharedUserIds(view.shared_user_ids ?? []);
    setBatchLimit(20);
  };

  const saveBatchView = async () => {
    const name = window.prompt('视图名称', '');
    if (name === null || !name.trim()) return;
    setActionError(null);
    setActionNotice(null);
    try {
      const res = await api.saveBatchFilterView(review.id, {
        name: name.trim(),
        shared: shareView,
        shared_role: sharedRole || null,
        shared_user_ids: sharedUserIds,
        ...batchExportFilters(),
      });
      setSelectedViewId(res.item.id);
      await views.reload();
      setAuditOffset(0);
      await viewAudits.reload();
      setActionNotice('筛选视图已保存。');
    } catch (err) {
      setActionError(err);
    }
  };

  const deleteBatchView = async () => {
    if (!selectedViewId) return;
    setActionError(null);
    setActionNotice(null);
    try {
      await api.deleteBatchFilterView(selectedViewId);
      setSelectedViewId('');
      await views.reload();
      setAuditOffset(0);
      await viewAudits.reload();
      setActionNotice('筛选视图已删除。');
    } catch (err) {
      setActionError(err);
    }
  };

  const batchExportFilters = () => ({
    ...(exportStatus ? { status: exportStatus } : {}),
    ...(exportType ? { action_type: exportType } : {}),
    ...(exportFrom ? { from: exportFrom } : {}),
    ...(exportTo ? { to: exportTo } : {}),
  });

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const exportBatches = async () => {
    setExportingBatches(true);
    setActionError(null);
    setActionNotice(null);
    try {
      const blob = await api.exportReconcileBatchesCsv(review.id, batchExportFilters());
      downloadBlob(blob, `copilot-batches-${review.id}.csv`);
      setActionNotice('批量历史已导出 CSV。');
    } catch (err) {
      setActionError(err);
    } finally {
      setExportingBatches(false);
    }
  };

  const exportBatchItems = async () => {
    setExportingItems(true);
    setActionError(null);
    setActionNotice(null);
    try {
      const blob = await api.exportReconcileBatchItemsCsv(review.id, batchExportFilters());
      downloadBlob(blob, `copilot-batch-items-${review.id}.csv`);
      setActionNotice('批量逐条明细已导出 CSV。');
    } catch (err) {
      setActionError(err);
    } finally {
      setExportingItems(false);
    }
  };

  const exportViewAudits = async () => {
    setExportingAudits(true);
    setActionError(null);
    setActionNotice(null);
    try {
      const blob = await api.exportBatchFilterViewAuditsCsv(review.id);
      downloadBlob(blob, `copilot-batch-filter-view-audits-${review.id}.csv`);
      setActionNotice('视图审计已导出 CSV。');
    } catch (err) {
      setActionError(err);
    } finally {
      setExportingAudits(false);
    }
  };

  const exportBatchesZip = async () => {
    setExportingZip(true);
    setActionError(null);
    setActionNotice(null);
    try {
      const blob = await api.exportReconcileBatchesZip(review.id, batchExportFilters());
      downloadBlob(blob, `copilot-batches-${review.id}.zip`);
      setActionNotice('批量汇总与明细已打包为 ZIP。');
    } catch (err) {
      setActionError(err);
    } finally {
      setExportingZip(false);
    }
  };

  const cancelBatch = async (batch: ReconcileBatch) => {
    const reason = window.prompt('取消原因（可留空）', '');
    if (reason === null) return;
    const trimmed = reason.trim();
    setCancellingId(batch.id);
    setActionError(null);
    setActionNotice(null);
    try {
      await api.cancelReconcileBatch(batch.id, { reason: trimmed || null });
      setActionNotice(
        trimmed
          ? `批量任务已取消：${trimmed}`
          : '批量任务已取消，已生成的动作保留。',
      );
      await batches.reload();
    } catch (err) {
      setActionError(err);
    } finally {
      setCancellingId(null);
    }
  };

  const createRisk = (d: ReconcileDifference) => runSingle('risk', d);
  const createIssue = (d: ReconcileDifference) => runSingle('issue', d);

  return (
    <div>
      {actionError ? <ErrorBox error={actionError} /> : null}
      <div className="form-grid" style={{ marginBottom: 10 }}>
        <Field label="待办负责人">
          <Select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">不指定</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
        </Field>
        <Field label="待办截止日期">
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
        <Field label="待办级别">
          <Select
            value={severity}
            onChange={(e) => {
              const v = e.target.value as 'P0' | 'P1' | 'P2' | 'P3';
              setSeverity(v);
              setDueDate(slaDate(v, holidaySet));
            }}
          >
            <option value="P0">P0</option>
            <option value="P1">P1</option>
            <option value="P2">P2</option>
            <option value="P3">P3</option>
          </Select>
        </Field>
      </div>
      <div className="row" style={{ marginBottom: 10 }}>
        <Button
          size="sm"
          variant="primary"
          disabled={!riskEligible.length || actionBusy !== null}
          onClick={() => void runBatch('risk')}
        >
          {actionBusy === 'risk' ? '生成中…' : `批量生成风险（${riskEligible.length}）`}
        </Button>
        <Button
          size="sm"
          disabled={!issueEligible.length || actionBusy !== null}
          onClick={() => void runBatch('issue')}
        >
          {actionBusy === 'issue' ? '生成中…' : `批量生成待办（${issueEligible.length}）`}
        </Button>
        <span className="hint">
          已选 {selectedDiffs.length} / 可处理 {selectableDiffs.length} 条
        </span>
        <Button
          size="sm"
          disabled={!selectedDiffs.length || Boolean(batchDecisionBusy)}
          onClick={() => void applyBatchDecision('采纳')}
        >
          {batchDecisionBusy === '采纳' ? '处理中…' : '批量采纳'}
        </Button>
        <Button
          size="sm"
          disabled={!selectedDiffs.length || Boolean(batchDecisionBusy)}
          onClick={() => void applyBatchDecision('忽略')}
        >
          {batchDecisionBusy === '忽略' ? '处理中…' : '批量忽略'}
        </Button>
        {review.risk_id ? (
          <span className="hint">风险状态：{statusLabel(review.risk_status)}</span>
        ) : null}
        {review.issue_id ? (
          <span className="hint">待办状态：{statusLabel(review.issue_status)}</span>
        ) : null}
        {batchProgress ? (
          <span className="hint">
            处理中 {batchProgress.done}/{batchProgress.total} 条
          </span>
        ) : null}
        {batchProgress ? (
          <div className="progress" style={{ width: 180 }}>
            <span
              style={{
                width: `${Math.round(
                  (batchProgress.done / Math.max(1, batchProgress.total)) * 100,
                )}%`,
              }}
            />
          </div>
        ) : null}
        {actionNotice ? <span className="hint">{actionNotice}</span> : null}
      </div>
      <div className="stat-grid">
        <Stat label="类型" value={review.kind === 'statement' ? '对账单' : '结算单'} tone="brand" />
        <Stat label="明细行" value={lines.length} tone="blue" />
        <Stat label="差异" value={review.differences.length} tone={review.differences.length ? 'red' : 'green'} />
        <Stat label="决策" value={decisionSummary(review.decisions)} tone="amber" />
      </div>
      <div
        className="row"
        style={{ flexWrap: 'wrap', gap: 12, margin: '-4px 0 8px' }}
      >
        <span className="muted small">来源：{sourceSummary}</span>
        <span className="muted small">置信度：{confidenceSummary}</span>
        <span className="muted small">决策：{decisionStateSummary}</span>
      </div>

      <div className="form-grid">
        <Field label="单据号"><Input value={String(doc.statement_no ?? doc.settlement_no ?? '')} disabled /></Field>
        <Field label={review.kind === 'statement' ? '客户' : '车队'}>
          <Input value={String(doc.customer_name ?? doc.carrier_name ?? '')} disabled />
        </Field>
        <Field label="账期">
          <Input
            value={`${doc.period_start ?? '—'} → ${doc.period_end ?? '—'}`}
            disabled
          />
        </Field>
        <Field label="合计"><Input value={String(doc.total_amount ?? '')} disabled /></Field>
      </div>

      <div className="table-wrap" style={{ marginTop: 12 }}>
        <table>
          <thead>
            <tr><th>#</th>{lineFields.map((f) => <th key={f}>{lineLabels[f] ?? f}</th>)}</tr>
          </thead>
          <tbody>
            {lines.map((line, i) => (
              <tr key={i}>
                <td>{String(line.line_no ?? i + 1)}</td>
                {lineFields.map((f) => <td key={f}>{String(line[f] ?? '—')}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="row" style={{ marginTop: 12, marginBottom: 6 }}>
        <strong>差异明细</strong>
        <Select
          value={diffSourceFilter}
          onChange={(e) => setDiffSourceFilter(e.target.value)}
          style={{ maxWidth: 130 }}
        >
          <option value="">全部来源</option>
          {diffSources.map((source) => (
            <option key={source} value={source}>
              {DIFF_SOURCE_LABEL[source] ?? source}
            </option>
          ))}
        </Select>
        <Select
          value={diffConfidenceFilter}
          onChange={(e) => setDiffConfidenceFilter(e.target.value)}
          style={{ maxWidth: 140 }}
        >
          <option value="">全部置信度</option>
          <option value="high">高 (≥0.8)</option>
          <option value="medium">中 (0.6–0.8)</option>
          <option value="low">低 (&lt;0.6)</option>
          <option value="unknown">未知</option>
        </Select>
        {review.differences.length !== filteredDifferences.length ? (
          <span className="muted small">
            已筛选 {filteredDifferences.length} / 共 {review.differences.length} 条
          </span>
        ) : null}
        {allDiffTypes.length > 1 ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setCollapsedTypes(
                allDiffTypesCollapsed
                  ? new Set()
                  : new Set(allDiffTypes),
              )
            }
          >
            {allDiffTypesCollapsed ? '全部展开' : '全部折叠'}
          </Button>
        ) : null}
        <Button size="sm" disabled={exportingDiffs} onClick={() => void exportDiffs()}>
          {exportingDiffs ? '导出中…' : '导出差异 CSV'}
        </Button>
        <Button size="sm" disabled={exportingDocx} onClick={() => void exportReviewDocx()}>
          {exportingDocx ? '生成中…' : '导出复核 Word'}
        </Button>
        <Button size="sm" disabled={exportingPdf} onClick={() => void exportReviewPdf()}>
          {exportingPdf ? '生成中…' : '导出复核 PDF'}
        </Button>
        <Button size="sm" disabled={generatingDoc} onClick={() => void generateReviewDoc()}>
          {generatingDoc ? '生成中…' : '生成报告交付物'}
        </Button>
        {latestDoc ? (
          <span className="hint">
            报告交付物 v{latestDoc.version} ·{' '}
            {deliverableStatusLabel(latestDoc.status)}
            {latestDoc.is_stale ? ' · 已过期，建议重新生成' : ' · 最新'}
          </span>
        ) : null}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label="全选差异"
                  checked={allSelected}
                  disabled={!selectableDiffs.length}
                  onChange={toggleAll}
                />
              </th>
              <th>类型</th><th>运单/趟次</th><th>对账单</th><th>系统</th><th>差额</th>
              <th>可能原因</th><th>建议动作</th><th>决策</th><th>备注</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {filteredDifferences.length === 0 ? (
              <tr>
                <td colSpan={11} className="muted">
                  {review.differences.length === 0
                    ? '没有差异'
                    : '没有符合筛选的差异'}
                </td>
              </tr>
            ) : groupDifferences(filteredDifferences).map(([type, diffs]) => (
              <Fragment key={type}>
                <tr>
                  <td
                    colSpan={11}
                    style={{ background: 'var(--surface-2)' }}
                  >
                    <button
                      className="link-btn"
                      onClick={() => toggleDiffType(type)}
                    >
                      {collapsedTypes.has(type) ? '▸' : '▾'}{' '}
                      {RECONCILE_DIFF_LABEL[type] ?? type}（{diffs.length}）
                    </button>
                  </td>
                </tr>
                {collapsedTypes.has(type)
                  ? null
                  : diffs.map((d, i) => {
              const rowKey = d.difference_id || `row-${i}`;
              const decision = d.difference_id ? decisions.get(d.difference_id) : undefined;
              const riskAction = actionFor(d.difference_id, 'risk');
              const issueAction = actionFor(d.difference_id, 'issue');
              const riskStatus = review.risk_id ? review.risk_status : riskAction?.item_status;
              const issueStatus = review.issue_id ? review.issue_status : issueAction?.item_status;
              return (
                <Fragment key={rowKey}>
                  <tr>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`选择差异 ${d.difference_id ?? i + 1}`}
                        checked={Boolean(d.difference_id && selectedIds.has(d.difference_id))}
                        disabled={!d.difference_id || decision?.decision === '忽略'}
                        title={decision?.decision === '忽略' ? '已标记忽略，不参与批量生成' : undefined}
                        onChange={() => d.difference_id && toggleDiff(d.difference_id)}
                      />
                    </td>
                    <td>
                      <Badge tone="red">{RECONCILE_DIFF_LABEL[d.type] ?? d.type}</Badge>
                      <div>
                        <button
                          className="link-btn"
                          onClick={() =>
                            setExpandedDiff(expandedDiff === rowKey ? null : rowKey)
                          }
                        >
                          {expandedDiff === rowKey ? '收起依据' : '依据'}
                        </button>
                      </div>
                    </td>
                    <td>{d.waybill_no || d.trip_no || '—'}</td>
                    <td>{d.statement_amount ?? '—'}</td>
                    <td>{d.system_amount ?? '—'}</td>
                    <td>{d.delta ?? '—'}</td>
                    <td className="muted">{d.possible_causes?.join('；') || '—'}</td>
                    <td className="muted">{d.suggested_action || '—'}</td>
                    <td>
                      <Select
                        value={decision?.decision || '待确认'}
                        disabled={!d.difference_id || decisionBusy === d.difference_id}
                        onChange={(e) =>
                          void saveDecision(d, e.target.value, decision?.note ?? '')
                        }
                        style={{ minWidth: 96 }}
                      >
                        <option value="待确认">待确认</option>
                        <option value="采纳">采纳</option>
                        <option value="忽略">忽略</option>
                      </Select>
                    </td>
                    <td>
                      <Input
                        key={`${rowKey}-${decision?.note ?? ''}`}
                        defaultValue={decision?.note ?? ''}
                        placeholder="备注"
                        disabled={!d.difference_id || decisionBusy === d.difference_id}
                        style={{ minWidth: 120 }}
                        onBlur={(e) => {
                          const next = e.target.value.trim();
                          if (next === (decision?.note ?? '')) return;
                          void saveDecision(
                            d,
                            decision?.decision || '待确认',
                            next,
                          );
                        }}
                      />
                    </td>
                    <td className="actions-cell">
                      <Button
                        size="sm"
                        disabled={
                          !d.difference_id ||
                          actionBusy !== null ||
                          Boolean(review.risk_id) ||
                          Boolean(actionFor(d.difference_id, 'risk'))
                        }
                        onClick={() => void createRisk(d)}
                      >
                        {actionFor(d.difference_id, 'risk') || review.risk_id
                          ? `风险·${statusLabel(riskStatus)}`
                          : '风险'}
                      </Button>
                      <Button
                        size="sm"
                        disabled={
                          !d.difference_id ||
                          actionBusy !== null ||
                          Boolean(review.issue_id) ||
                          Boolean(actionFor(d.difference_id, 'issue'))
                        }
                        onClick={() => void createIssue(d)}
                      >
                        {actionFor(d.difference_id, 'issue') || review.issue_id
                          ? `待办·${statusLabel(issueStatus)}`
                          : '待办'}
                      </Button>
                    </td>
                  </tr>
                  {expandedDiff === rowKey ? (
                    <tr>
                      <td
                        colSpan={11}
                        className="muted"
                        style={{ background: 'var(--surface-2)' }}
                      >
                        <div>
                          来源：
                          <strong>
                            {DIFF_SOURCE_LABEL[d.source ?? ''] ?? d.source ?? '—'}
                          </strong>
                          {' · '}置信度：
                          <strong>{d.confidence != null ? d.confidence : '—'}</strong>
                        </div>
                        {d.evidence?.length ? (
                          <ul style={{ margin: '4px 0 0 18px' }}>
                            {d.evidence.map((item, idx) => (
                              <li key={idx}>{item}</li>
                            ))}
                          </ul>
                        ) : (
                          <div>无证据条目</div>
                        )}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 16 }}>
        <div className="row" style={{ marginBottom: 6 }}>
          <strong>批量生成记录</strong>
          <Button size="sm" onClick={() => void batches.reload()}>
            刷新
          </Button>
          <Button
            size="sm"
            disabled={exportingBatches || batchItems.length === 0 || Boolean(filterError)}
            onClick={() => void exportBatches()}
          >
            {exportingBatches ? '导出中…' : '导出 CSV'}
          </Button>
          <Button
            size="sm"
            disabled={exportingItems || batchItems.length === 0 || Boolean(filterError)}
            onClick={() => void exportBatchItems()}
          >
            {exportingItems ? '导出中…' : '导出明细 CSV'}
          </Button>
          <Button
            size="sm"
            disabled={exportingZip || batchItems.length === 0 || Boolean(filterError)}
            onClick={() => void exportBatchesZip()}
          >
            {exportingZip ? '打包中…' : '导出 ZIP'}
          </Button>
        </div>
        <div className="form-grid" style={{ marginBottom: 8 }}>
          <Field label="导出状态">
            <Select
              value={exportStatus}
              onChange={(e) => {
                setExportStatus(e.target.value as BatchStatusFilter);
                setSelectedViewId('');
                setBatchLimit(20);
              }}
            >
              <option value="">全部</option>
              <option value="running">进行中</option>
              <option value="completed">已完成</option>
              <option value="failed">失败</option>
              <option value="cancelled">已取消</option>
            </Select>
          </Field>
          <Field label="导出类型">
            <Select
              value={exportType}
              onChange={(e) => {
                setExportType(e.target.value as BatchTypeFilter);
                setSelectedViewId('');
                setBatchLimit(20);
              }}
            >
              <option value="">全部</option>
              <option value="risk">风险</option>
              <option value="issue">待办</option>
            </Select>
          </Field>
          <Field label="开始日期">
            <Input
              type="date"
              value={exportFrom}
              onChange={(e) => {
                setExportFrom(e.target.value);
                setSelectedViewId('');
                setBatchLimit(20);
              }}
            />
          </Field>
          <Field label="结束日期">
            <Input
              type="date"
              value={exportTo}
              onChange={(e) => {
                setExportTo(e.target.value);
                setSelectedViewId('');
                setBatchLimit(20);
              }}
            />
          </Field>
        </div>
        <div className="row" style={{ marginTop: -6, marginBottom: 4 }}>
          <Select
            value={selectedViewId}
            onChange={(e) => applyBatchView(e.target.value)}
            style={{ maxWidth: 220 }}
          >
            <option value="">选择已保存视图</option>
            {(views.data?.items ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.shared ? '（全员）' : ''}
                {v.shared_role ? `（${VIEW_ROLE_LABEL[v.shared_role] ?? v.shared_role}）` : ''}
                {v.shared_user_ids?.length
                  ? `（指定 ${v.shared_user_ids.length} 人）`
                  : ''}
                {!v.is_owner && v.owner_name ? ` · ${v.owner_name}` : ''}
              </option>
            ))}
          </Select>
          <Button size="sm" disabled={Boolean(filterError)} onClick={() => void saveBatchView()}>
            保存视图
          </Button>
          <Button
            size="sm"
            disabled={!selectedViewId || !selectedView?.is_owner}
            onClick={() => void deleteBatchView()}
          >
            删除视图
          </Button>
          <Button size="sm" onClick={clearBatchFilters}>
            清空筛选
          </Button>
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={rememberFilters}
              onChange={(e) => setRememberFilters(e.target.checked)}
            />
            <span>记住筛选</span>
          </label>
        </div>
        <div className="row" style={{ marginTop: -2, marginBottom: 4 }}>
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={shareView}
              onChange={(e) => setShareView(e.target.checked)}
            />
            <span>全员共享</span>
          </label>
          <Select
            value={sharedRole}
            onChange={(e) =>
              setSharedRole(
                e.target.value as
                  | ''
                  | 'admin'
                  | 'director'
                  | 'pm'
                  | 'consultant'
                  | 'tech_lead',
              )
            }
            style={{ maxWidth: 180 }}
          >
            <option value="">按角色共享</option>
            <option value="admin">管理员</option>
            <option value="director">总监</option>
            <option value="pm">项目经理</option>
            <option value="consultant">顾问</option>
            <option value="tech_lead">技术负责人</option>
          </Select>
          <Select
            multiple
            size={3}
            value={sharedUserIds}
            onChange={(e) =>
              setSharedUserIds(
                Array.from(e.target.selectedOptions).map((o) => o.value),
              )
            }
            style={{ minWidth: 180 }}
          >
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
          <span className="hint">指定同事（可多选）</span>
        </div>
        {filterError ? (
          <p style={{ marginTop: -4, color: '#b42318' }}>{filterError}</p>
        ) : null}
        <p className="muted" style={{ marginTop: -4 }}>
          筛选同时作用于列表和导出；按批次组筛选，组内任一批次命中即整组显示。
          {filterError
            ? ''
            : estimate.loading
              ? ' 正在估算导出体积…'
              : estimate.data
                ? ` 预计 ${estimate.data.batches} 个批次 / ${estimate.data.items} 条明细 · 约 ${formatBytes(
                    estimate.data.estimated_bytes.zip,
                  )}（ZIP）${estimate.data.large ? '，数据较大，建议缩小筛选范围' : ''}`
                : ''}
        </p>
        {batches.error ? <ErrorBox error={batches.error} /> : null}
        {batchItems.length === 0 ? (
          <p className="muted">
            {exportStatus || exportType || exportFrom || exportTo
              ? '没有匹配筛选条件的批量记录。'
              : '暂无批量生成记录。'}
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>时间</th><th>类型</th><th>状态</th><th>结果</th><th>操作</th>
                </tr>
              </thead>
              <tbody>
                {visibleBatchRows.map(({ batch: b, depth }) => (
                  <tr key={b.id}>
                    <td
                      className="muted"
                      style={{ paddingLeft: 8 + depth * 16 }}
                    >
                      {depth === 0 && (childCounts.get(b.id) ?? 0) > 0 ? (
                        <button
                          type="button"
                          className="link-btn"
                          style={{ marginRight: 6 }}
                          onClick={() => toggleGroup(b.id)}
                          title={collapsedRoots.has(b.id) ? '展开子批次' : '收起子批次'}
                        >
                          {collapsedRoots.has(b.id)
                            ? `▸${childCounts.get(b.id)}`
                            : '▾'}
                        </button>
                      ) : null}
                      {depth > 0 ? '↳ ' : ''}
                      {fmtDateTime(b.created_at)}
                    </td>
                    <td>
                      {b.action_type === 'risk' ? '风险' : '待办'}
                      {b.parent_batch_id ? (
                        <Badge tone="gray">
                          {b.parent_relation === 'resume' ? '继续' : '重试'}
                        </Badge>
                      ) : null}
                    </td>
                    <td>
                      <Badge
                        tone={
                          b.status === 'completed'
                            ? 'green'
                            : b.status === 'failed'
                              ? 'red'
                              : b.status === 'cancelled'
                                ? 'gray'
                                : 'amber'
                        }
                      >
                        {b.status === 'completed'
                          ? '已完成'
                          : b.status === 'failed'
                            ? '失败'
                            : b.status === 'cancelled'
                              ? '已取消'
                              : '进行中'}
                      </Badge>
                      {b.status === 'cancelled' &&
                      (b.cancel_reason || b.cancelled_by_name) ? (
                        <div
                          className="muted"
                          style={{
                            marginTop: 2,
                            maxWidth: 180,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={[b.cancel_reason, b.cancelled_by_name]
                            .filter(Boolean)
                            .join(' · ')}
                        >
                          {b.cancel_reason || '未填原因'}
                          {b.cancelled_by_name ? ` · ${b.cancelled_by_name}` : ''}
                        </div>
                      ) : null}
                    </td>
                    <td className="muted">
                      成功 {b.created_count} · 跳过 {b.skipped_count} · 失败 {b.failed_count}
                      {b.status === 'cancelled' &&
                      !b.has_child &&
                      (b.remaining_difference_ids?.length ?? 0) > 0
                        ? ` · 剩余 ${b.remaining_difference_ids?.length}`
                        : ''}
                    </td>
                    <td className="actions-cell">
                      {b.status === 'running' ? (
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={cancellingId === b.id}
                          onClick={() => void cancelBatch(b)}
                        >
                          {cancellingId === b.id ? '取消中…' : '取消'}
                        </Button>
                      ) : b.status === 'cancelled' &&
                        !b.has_child &&
                        (b.remaining_difference_ids?.length ?? 0) > 0 ? (
                        <Button
                          size="sm"
                          disabled={actionBusy !== null}
                          onClick={() => openResume(b)}
                        >
                          继续剩余（{b.remaining_difference_ids?.length}）
                        </Button>
                      ) : b.status === 'failed' && b.failed_count > 0 && !b.has_child ? (
                        <Button
                          size="sm"
                          disabled={actionBusy !== null}
                          onClick={() => void retryBatch(b)}
                        >
                          重试失败项（{b.failed_count}）
                        </Button>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="row" style={{ marginTop: 6 }}>
          <span className="muted">
            已显示 {rootsReturned} / {rootTotal} 组 · {batchItems.length} 条
          </span>
          {rootsReturned < rootTotal ? (
            <Button
              size="sm"
              disabled={batches.loading}
              onClick={() => setBatchLimit((n) => n + 20)}
            >
              {batches.loading ? '加载中…' : '加载更多'}
            </Button>
          ) : null}
        </div>
        {resumeTarget ? (
          <div
            style={{
              marginTop: 10,
              padding: 10,
              border: '1px solid rgba(0, 0, 0, 0.12)',
              borderRadius: 8,
            }}
          >
            <div className="row" style={{ marginBottom: 8 }}>
              <strong>继续剩余差异</strong>
              <span className="muted">
                共 {resumeTarget.remaining_difference_ids?.length ?? 0} 条
              </span>
            </div>
            <div className="form-grid">
              <Field label="负责人">
                <Select
                  value={resumeOwner}
                  onChange={(e) => setResumeOwner(e.target.value)}
                >
                  <option value="">不指定</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="待办级别">
                <Select
                  value={resumeSeverity}
                  onChange={(e) => {
                    const v = e.target.value as 'P0' | 'P1' | 'P2' | 'P3';
                    setResumeSeverity(v);
                    setResumeDue(slaDate(v, holidaySet));
                  }}
                >
                  <option value="P0">P0</option>
                  <option value="P1">P1</option>
                  <option value="P2">P2</option>
                  <option value="P3">P3</option>
                </Select>
              </Field>
              <Field label="截止日期">
                <Input
                  type="date"
                  value={resumeDue}
                  onChange={(e) => setResumeDue(e.target.value)}
                />
              </Field>
            </div>
            <div className="row">
              <Button size="sm" variant="primary" onClick={() => void confirmResume()}>
                继续执行
              </Button>
              <Button size="sm" onClick={() => setResumeTarget(null)}>
                取消
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <div style={{ marginTop: 16 }}>
        <div className="row" style={{ marginBottom: 6 }}>
          <strong>视图审计</strong>
          <Button size="sm" onClick={() => void viewAudits.reload()}>
            刷新
          </Button>
          <Button
            size="sm"
            disabled={exportingAudits}
            onClick={() => void exportViewAudits()}
          >
            {exportingAudits ? '导出中…' : '导出审计 CSV'}
          </Button>
        </div>
        {viewAudits.error ? <ErrorBox error={viewAudits.error} /> : null}
        {(viewAudits.data?.items ?? []).length === 0 ? (
          <p className="muted">暂无筛选视图审计。</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>时间</th><th>操作</th><th>视图</th><th>操作人</th><th>共享设置</th>
                </tr>
              </thead>
              <tbody>
                {(viewAudits.data?.items ?? []).map((a) => {
                  const detail = a.detail ?? {};
                  const sharing = [
                    detail.shared ? '全员' : '',
                    detail.shared_role
                      ? VIEW_ROLE_LABEL[detail.shared_role] ?? detail.shared_role
                      : '',
                    Array.isArray(detail.shared_user_ids) && detail.shared_user_ids.length
                      ? `指定 ${detail.shared_user_ids.length} 人`
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' / ');
                  return (
                    <tr key={a.id}>
                      <td className="muted">{fmtDateTime(a.created_at)}</td>
                      <td>
                        <Badge tone={a.action.startsWith('DELETE') ? 'red' : 'blue'}>
                          {a.action.startsWith('DELETE') ? '删除' : '保存'}
                        </Badge>
                      </td>
                      <td>{detail.name || '—'}</td>
                      <td>{a.actor_name || '—'}</td>
                      <td className="muted">{sharing || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {(viewAudits.data?.items ?? []).length > 0 ? (
          <div className="row" style={{ marginTop: 6 }}>
            <span className="muted">
              第 {auditOffset + 1}–
              {auditOffset + (viewAudits.data?.items.length ?? 0)} 条 / 共{' '}
              {viewAudits.data?.total ?? 0} 条
            </span>
            <Button
              size="sm"
              disabled={auditOffset === 0}
              onClick={() => setAuditOffset(Math.max(0, auditOffset - auditLimit))}
            >
              上一页
            </Button>
            <Button
              size="sm"
              disabled={
                auditOffset + (viewAudits.data?.items.length ?? 0) >=
                (viewAudits.data?.total ?? 0)
              }
              onClick={() => setAuditOffset(auditOffset + auditLimit)}
            >
              下一页
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CreateExperimentForm({
  opportunityId,
  label,
  onCreated,
}: {
  opportunityId: string;
  label: string;
  onCreated: (e: PocExperiment) => Promise<void> | void;
}) {
  const [form, setForm] = useState({
    hypothesis: '',
    method: '',
    sample_size: '100',
    success_metric: '',
    threshold: '',
    start_date: '',
    end_date: '',
  });
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (!form.hypothesis.trim() || !form.method.trim() || !form.success_metric.trim() || !form.threshold.trim()) {
        throw new Error('假设、方法、指标、阈值必填');
      }
      const res = await api.createExperiment(opportunityId, {
        hypothesis: form.hypothesis.trim(),
        method: form.method.trim(),
        sample_size: form.sample_size ? Number(form.sample_size) : undefined,
        success_metric: form.success_metric.trim(),
        threshold: form.threshold.trim(),
        start_date: form.start_date || undefined,
        end_date: form.end_date || undefined,
      });
      await onCreated(res.item);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title={`创建 POC 实验 · ${label}`} subtitle="先锁定假设、样本、方法和成功阈值，再开始跑。">
      {error ? <ErrorBox error={error} /> : null}
      <div className="form-grid">
        <Field label="假设" required className="span-2">
          <Textarea rows={3} value={form.hypothesis} onChange={(e) => setForm({ ...form, hypothesis: e.target.value })} />
        </Field>
        <Field label="方法" required className="span-2">
          <Textarea rows={2} value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })} />
        </Field>
        <Field label="样本量">
          <Input type="number" value={form.sample_size} onChange={(e) => setForm({ ...form, sample_size: e.target.value })} />
        </Field>
        <Field label="成功指标" required>
          <Input value={form.success_metric} onChange={(e) => setForm({ ...form, success_metric: e.target.value })} placeholder="如：托书字段准确率" />
        </Field>
        <Field label="成功阈值" required>
          <Input value={form.threshold} onChange={(e) => setForm({ ...form, threshold: e.target.value })} placeholder="如：≥95%" />
        </Field>
        <Field label="开始日期">
          <Input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
        </Field>
        <Field label="结束日期">
          <Input type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} />
        </Field>
      </div>
      <div className="form-actions">
        <Button variant="primary" disabled={saving} onClick={() => void save()}>
          {saving ? '创建中…' : '创建实验 v1'}
        </Button>
      </div>
    </Card>
  );
}

function ExperimentEditor({
  experimentId,
  users,
  onChanged,
  onGoReports,
}: {
  experimentId: string;
  users: User[];
  onChanged: () => Promise<void> | void;
  onGoReports: () => void;
}) {
  const { data, error, loading, reload } = useLoad<PocDetail>(
    () => api.getExperiment(experimentId),
    [experimentId],
  );
  const [basic, setBasic] = useState({
    hypothesis: '', method: '', sample_size: '', success_metric: '',
    threshold: '', start_date: '', end_date: '', status: 'planned',
  });
  const [dataset, setDataset] = useState({
    name: '', source: '', sample_count: '', fields: '', access_status: 'pending',
  });
  const [run, setRun] = useState({
    dataset_id: '', config: '', metrics: '{\n  "accuracy": 0.95\n}', issues: '',
  });
  const [review, setReview] = useState({
    run_id: '', reviewer: '', sample_count: '', accuracy: '', false_positive: '', notes: '',
  });
  const [conclusion, setConclusion] = useState({
    decision: 'go', evidence: '', conditions: '',
  });
  const [errorBox, setErrorBox] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [docNotice, setDocNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const e = data.item;
    setBasic({
      hypothesis: e.hypothesis, method: e.method,
      sample_size: e.sample_size != null ? String(e.sample_size) : '',
      success_metric: e.success_metric, threshold: e.threshold,
      start_date: e.start_date ? fmtDate(e.start_date) : '',
      end_date: e.end_date ? fmtDate(e.end_date) : '',
      status: e.status,
    });
    setReview((r) => ({
      ...r,
      run_id: r.run_id || data.runs[0]?.id || '',
      reviewer: r.reviewer || users[0]?.id || '',
    }));
    if (data.conclusion) {
      setConclusion({
        decision: data.conclusion.decision,
        evidence: data.conclusion.evidence,
        conditions: data.conclusion.conditions ?? '',
      });
    }
  }, [data, users]);

  const after = async () => {
    await reload();
    await onChanged();
  };
  const runOp = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErrorBox(null);
    try {
      await fn();
      await after();
    } catch (err) {
      setErrorBox(err);
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorBox error={error} onRetry={() => void reload()} />;
  if (!data) return null;

  const e = data.item;

  const saveBasic = () =>
    runOp(() =>
      api.updateExperiment(e.id, {
        ...basic,
        sample_size: basic.sample_size ? Number(basic.sample_size) : null,
        start_date: basic.start_date || null,
        end_date: basic.end_date || null,
      }),
    );

  const addDataset = () =>
    runOp(async () => {
      if (!dataset.name.trim()) throw new Error('样本名称必填');
      await api.createDataset(e.id, {
        name: dataset.name.trim(),
        source: dataset.source || undefined,
        sample_count: dataset.sample_count ? Number(dataset.sample_count) : undefined,
        fields: dataset.fields || undefined,
        access_status: dataset.access_status,
      });
      setDataset({ name: '', source: '', sample_count: '', fields: '', access_status: 'pending' });
    });

  const addRun = () =>
    runOp(async () => {
      let metrics: Record<string, unknown> = {};
      try {
        metrics = JSON.parse(run.metrics || '{}');
      } catch {
        throw new Error('指标 JSON 格式不正确');
      }
      await api.createRun(e.id, {
        dataset_id: run.dataset_id || undefined,
        config: run.config || undefined,
        metrics,
        issues: run.issues || undefined,
      });
      setRun({ dataset_id: '', config: '', metrics: '{\n  "accuracy": 0.95\n}', issues: '' });
    });

  const addReview = () =>
    runOp(async () => {
      if (!review.run_id) throw new Error('请选择运行记录');
      if (!review.reviewer) throw new Error('请选择复核人');
      await api.createPocReview(review.run_id, {
        reviewer: review.reviewer,
        sample_count: review.sample_count ? Number(review.sample_count) : undefined,
        accuracy: review.accuracy ? Number(review.accuracy) : undefined,
        false_positive: review.false_positive ? Number(review.false_positive) : undefined,
        notes: review.notes || undefined,
      });
      setReview({ ...review, sample_count: '', accuracy: '', false_positive: '', notes: '' });
    });

  const generateReport = () =>
    runOp(async () => {
      const res = await api.generatePocDocument(e.id);
      setDocNotice(`已生成《${res.item.title}》v${res.item.version}`);
    });

  const downloadReport = () =>
    runOp(async () => {
      const blob = await api.exportPocDocx(e.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${e.opportunity_title} POC 验证报告 v${e.version}.docx`;
      a.click();
      URL.revokeObjectURL(url);
    });

  const saveConclusion = () =>
    runOp(async () => {
      if (!conclusion.evidence.trim()) throw new Error('结论证据必填');
      await api.saveConclusion(e.id, {
        decision: conclusion.decision,
        evidence: conclusion.evidence.trim(),
        conditions: conclusion.conditions || undefined,
        decided_by: users[0]?.id,
      });
    });

  return (
    <div className="editor-stack">
      <Card
        title={`实验 v${e.version}`}
        subtitle={`${e.opportunity_code} ${e.opportunity_title}`}
        actions={<Badge tone={statusTone(e.status)}>{STATUS_LABEL[e.status] ?? e.status}</Badge>}
      >
        {errorBox ? <ErrorBox error={errorBox} /> : null}
        <div className="stat-grid">
          <Stat label="样本" value={data.datasets.length} hint="可用/申请中" />
          <Stat label="运行" value={data.runs.length} hint="每次配置" tone="blue" />
          <Stat label="复核" value={data.reviews.length} hint="人工复核" tone="amber" />
          <Stat label="结论" value={data.conclusion ? DECISION_LABEL[data.conclusion.decision] ?? '—' : '—'} tone={data.conclusion?.decision === 'go' ? 'green' : 'gray'} />
        </div>
        <div className="form-grid">
          <Field label="假设" className="span-2">
            <Textarea rows={2} value={basic.hypothesis} onChange={(ev) => setBasic({ ...basic, hypothesis: ev.target.value })} />
          </Field>
          <Field label="方法" className="span-2">
            <Textarea rows={2} value={basic.method} onChange={(ev) => setBasic({ ...basic, method: ev.target.value })} />
          </Field>
          <Field label="指标"><Input value={basic.success_metric} onChange={(ev) => setBasic({ ...basic, success_metric: ev.target.value })} /></Field>
          <Field label="阈值"><Input value={basic.threshold} onChange={(ev) => setBasic({ ...basic, threshold: ev.target.value })} /></Field>
          <Field label="样本量"><Input type="number" value={basic.sample_size} onChange={(ev) => setBasic({ ...basic, sample_size: ev.target.value })} /></Field>
          <Field label="状态">
            <Select value={basic.status} onChange={(ev) => setBasic({ ...basic, status: ev.target.value })}>
              {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
        </div>
        <div className="form-actions">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void saveBasic()}>保存实验</Button>
        </div>
      </Card>

      <Card title="样本数据" subtitle="来源、数量、字段、访问状态。">
        {data.datasets.length === 0 ? <Empty title="还没有样本" hint="至少一份可用样本才能跑实验。" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>名称</th><th>来源</th><th>数量</th><th>访问</th><th /></tr></thead>
              <tbody>
                {data.datasets.map((d) => (
                  <tr key={d.id}>
                    <td><strong>{d.name}</strong></td>
                    <td className="muted">{d.source || '—'}</td>
                    <td>{d.sample_count ?? '—'}</td>
                    <td><Badge tone={d.access_status === 'approved' || d.access_status === 'not_required' ? 'green' : 'amber'}>{ACCESS_LABEL[d.access_status] ?? d.access_status}</Badge></td>
                    <td className="actions-cell"><Button size="sm" variant="danger" disabled={busy} onClick={() => void runOp(() => api.deleteDataset(d.id))}>删除</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="inline-form">
          <Input placeholder="样本名称" value={dataset.name} onChange={(ev) => setDataset({ ...dataset, name: ev.target.value })} />
          <Input placeholder="来源" value={dataset.source} onChange={(ev) => setDataset({ ...dataset, source: ev.target.value })} />
          <Input type="number" placeholder="数量" value={dataset.sample_count} onChange={(ev) => setDataset({ ...dataset, sample_count: ev.target.value })} />
          <Select value={dataset.access_status} onChange={(ev) => setDataset({ ...dataset, access_status: ev.target.value })}>
            {Object.entries(ACCESS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void addDataset()}>添加</Button>
        </div>
      </Card>

      <Card title="运行记录" subtitle="每次配置和指标；run_no 自动递增。">
        {data.runs.length === 0 ? <Empty title="还没有运行" hint="至少跑一次并记录指标。" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>#</th><th>样本</th><th>配置</th><th>指标</th><th>时间</th><th /></tr></thead>
              <tbody>
                {data.runs.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">#{r.run_no}</td>
                    <td>{r.dataset_name || '—'}</td>
                    <td className="muted">{r.config || '—'}</td>
                    <td className="mono muted">{JSON.stringify(r.metrics)}</td>
                    <td className="muted">{fmtDateTime(r.started_at)}</td>
                    <td className="actions-cell"><Button size="sm" variant="danger" disabled={busy} onClick={() => void runOp(() => api.deleteRun(r.id))}>删除</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="form-grid">
          <Field label="样本">
            <Select value={run.dataset_id} onChange={(ev) => setRun({ ...run, dataset_id: ev.target.value })}>
              <option value="">不指定</option>
              {data.datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          </Field>
          <Field label="配置">
            <Input value={run.config} onChange={(ev) => setRun({ ...run, config: ev.target.value })} placeholder="模型/规则版本" />
          </Field>
          <Field label="指标 JSON" className="span-2">
            <Textarea rows={3} className="mono" value={run.metrics} onChange={(ev) => setRun({ ...run, metrics: ev.target.value })} />
          </Field>
          <Field label="问题" className="span-2">
            <Input value={run.issues} onChange={(ev) => setRun({ ...run, issues: ev.target.value })} />
          </Field>
        </div>
        <div className="form-actions">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void addRun()}>记录一次运行</Button>
        </div>
      </Card>

      <Card title="人工复核" subtitle="复核人、样本量、准确率、误报数。">
        {data.reviews.length === 0 ? <Empty title="还没有复核" hint="运行记录需要人工复核，G3 才放行。" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>时间</th><th>复核人</th><th>样本</th><th>准确率</th><th>误报</th><th>备注</th></tr></thead>
              <tbody>
                {data.reviews.map((r) => (
                  <tr key={r.id}>
                    <td className="muted">{fmtDateTime(r.reviewed_at)}</td>
                    <td>{r.reviewer_name || '—'}</td>
                    <td>{r.sample_count ?? '—'}</td>
                    <td>{r.accuracy != null ? `${(Number(r.accuracy) * 100).toFixed(1)}%` : '—'}</td>
                    <td>{r.false_positive ?? '—'}</td>
                    <td className="muted">{r.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="form-grid">
          <Field label="运行记录">
            <Select value={review.run_id} onChange={(ev) => setReview({ ...review, run_id: ev.target.value })}>
              <option value="">请选择</option>
              {data.runs.map((r) => <option key={r.id} value={r.id}>#{r.run_no} {r.dataset_name || ''}</option>)}
            </Select>
          </Field>
          <Field label="复核人">
            <Select value={review.reviewer} onChange={(ev) => setReview({ ...review, reviewer: ev.target.value })}>
              <option value="">请选择</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
          </Field>
          <Field label="样本量"><Input type="number" value={review.sample_count} onChange={(ev) => setReview({ ...review, sample_count: ev.target.value })} /></Field>
          <Field label="准确率（0–1）"><Input type="number" step="0.01" value={review.accuracy} onChange={(ev) => setReview({ ...review, accuracy: ev.target.value })} /></Field>
          <Field label="误报数"><Input type="number" value={review.false_positive} onChange={(ev) => setReview({ ...review, false_positive: ev.target.value })} /></Field>
          <Field label="备注" className="span-2"><Input value={review.notes} onChange={(ev) => setReview({ ...review, notes: ev.target.value })} /></Field>
        </div>
        <div className="form-actions">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void addReview()}>提交复核</Button>
        </div>
      </Card>

      <Card title="结论与 Go / No-Go" subtitle="结论必须带证据；No-Go / 有条件时写后续条件。">
        <div className="form-grid">
          <Field label="决策">
            <Select value={conclusion.decision} onChange={(ev) => setConclusion({ ...conclusion, decision: ev.target.value })}>
              {Object.entries(DECISION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="证据" required className="span-2">
            <Textarea rows={3} value={conclusion.evidence} onChange={(ev) => setConclusion({ ...conclusion, evidence: ev.target.value })} placeholder="样本量、指标、阈值对比、失败案例" />
          </Field>
          <Field label="后续条件" className="span-2">
            <Textarea rows={2} value={conclusion.conditions} onChange={(ev) => setConclusion({ ...conclusion, conditions: ev.target.value })} />
          </Field>
        </div>
        <div className="form-actions">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void saveConclusion()}>保存结论</Button>
          {data.conclusion ? (
            <Badge tone={data.conclusion.decision === 'go' ? 'green' : data.conclusion.decision === 'no_go' ? 'red' : 'amber'}>
              当前：{DECISION_LABEL[data.conclusion.decision] ?? data.conclusion.decision}
            </Badge>
          ) : null}
        </div>
      </Card>

      <Card
        title="生成 POC 报告"
        subtitle="实验设计、样本、运行、复核、结论 → 版本化交付物；可导出 Word。"
        actions={
          <div className="generate-bar">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void generateReport()}>
              生成 POC 报告
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void downloadReport()}>
              导出 Word
            </Button>
          </div>
        }
      >
        {docNotice ? (
          <div className="notice notice-green">
            {docNotice}{' '}
            <button className="link-btn" onClick={onGoReports}>
              去报告页查看 →
            </button>
          </div>
        ) : (
          <p className="hint-line">
            报告按项目内 poc_report 类型自动版本化；Word 导出为当前实验的最新快照。
          </p>
        )}
      </Card>
    </div>
  );
}
