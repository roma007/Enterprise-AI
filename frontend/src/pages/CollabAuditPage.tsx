import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useLoad } from '../hooks';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Stat,
} from '../ui';
import { fmtDateTime } from '../utils';
import type { CollabAudit } from '../types';

const ACTION_LABEL: Record<string, string> = {
  'DELETE copilot-notification': '删除通知',
  'RESTORE copilot-notification': '恢复通知',
  'PURGE copilot-notification': '彻底删除通知',
  'SAVE copilot-batch-filter-view': '保存筛选视图',
  'DELETE copilot-batch-filter-view': '删除筛选视图',
  'EXPORT copilot-notification-audits': '导出通知审计',
  'EXPORT copilot-collab-audits': '导出协作审计',
  'EXPORT copilot-batch-filter-view-audits': '导出筛选视图审计',
  'EXPORT copilot-collab-merged': '导出合并协作审计',
  'EXPORT copilot-collab-archive': '导出归档审计',
  'DECIDE copilot-reconcile-difference': '差异决策',
};

const TYPE_LABEL: Record<string, string> = {
  notification: '通知',
  filter_view: '筛选视图',
  export: '导出',
  decision: '决策',
};

const TYPE_TONE: Record<string, 'blue' | 'gray' | 'amber' | 'green'> = {
  notification: 'blue',
  filter_view: 'gray',
  export: 'amber',
  decision: 'green',
};

const BOARD_TYPE: Record<
  string,
  'all' | 'notification' | 'filter_view' | 'export' | 'decision'
> = {
  delta_total: 'all',
  delta_notification: 'notification',
  delta_filter_view: 'filter_view',
  delta_export: 'export',
  delta_decision: 'decision',
};

const ACTION_OPTIONS: Record<
  'all' | 'notification' | 'filter_view' | 'export' | 'decision',
  Array<[string, string]>
> = {
  all: [
    ['DELETE copilot-notification', '删除通知'],
    ['RESTORE copilot-notification', '恢复通知'],
    ['PURGE copilot-notification', '彻底删除通知'],
    ['SAVE copilot-batch-filter-view', '保存筛选视图'],
    ['DELETE copilot-batch-filter-view', '删除筛选视图'],
    ['EXPORT copilot-notification-audits', '导出通知审计'],
    ['EXPORT copilot-collab-audits', '导出协作审计'],
    ['EXPORT copilot-batch-filter-view-audits', '导出视图审计'],
    ['EXPORT copilot-collab-merged', '导出合并审计'],
    ['EXPORT copilot-collab-archive', '导出归档审计'],
    ['DECIDE copilot-reconcile-difference', '差异决策'],
  ],
  notification: [
    ['DELETE copilot-notification', '删除通知'],
    ['RESTORE copilot-notification', '恢复通知'],
    ['PURGE copilot-notification', '彻底删除通知'],
  ],
  filter_view: [
    ['SAVE copilot-batch-filter-view', '保存筛选视图'],
    ['DELETE copilot-batch-filter-view', '删除筛选视图'],
  ],
  export: [
    ['EXPORT copilot-notification-audits', '导出通知审计'],
    ['EXPORT copilot-collab-audits', '导出协作审计'],
    ['EXPORT copilot-batch-filter-view-audits', '导出视图审计'],
    ['EXPORT copilot-collab-merged', '导出合并审计'],
    ['EXPORT copilot-collab-archive', '导出归档审计'],
  ],
  decision: [['DECIDE copilot-reconcile-difference', '差异决策']],
};

const COLLAB_KEYS = {
  type: 'collab_type',
  action: 'collab_action',
  from: 'collab_from',
  to: 'collab_to',
  actor: 'collab_actor',
  offset: 'collab_offset',
  scope: 'collab_scope',
} as const;

interface CollabUrlState {
  type: 'all' | 'notification' | 'filter_view' | 'export' | 'decision';
  action: string;
  from: string;
  to: string;
  actor: string;
  offset: number;
  scope: 'live' | 'archive' | 'all';
}

function readCollabState(): CollabUrlState {
  if (typeof window === 'undefined') {
    return {
      type: 'all',
      action: '',
      from: '',
      to: '',
      actor: '',
      offset: 0,
      scope: 'live',
    };
  }
  const params = new URLSearchParams(window.location.search);
  const rawOffset = Number(params.get(COLLAB_KEYS.offset) ?? '0');
  const rawType = params.get(COLLAB_KEYS.type);
  return {
    type:
      rawType === 'notification' ||
      rawType === 'filter_view' ||
      rawType === 'export' ||
      rawType === 'decision'
        ? rawType
        : 'all',
    action: params.get(COLLAB_KEYS.action) ?? '',
    from: params.get(COLLAB_KEYS.from) ?? '',
    to: params.get(COLLAB_KEYS.to) ?? '',
    actor: params.get(COLLAB_KEYS.actor) ?? '',
    offset:
      Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0,
    scope:
      params.get(COLLAB_KEYS.scope) === 'archive'
        ? 'archive'
        : params.get(COLLAB_KEYS.scope) === 'all'
          ? 'all'
          : 'live',
  };
}

function writeCollabState(state: CollabUrlState) {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  const entries: Array<[string, string]> = [
    [COLLAB_KEYS.type, state.type === 'all' ? '' : state.type],
    [COLLAB_KEYS.action, state.action],
    [COLLAB_KEYS.from, state.from],
    [COLLAB_KEYS.to, state.to],
    [COLLAB_KEYS.actor, state.actor],
    [COLLAB_KEYS.offset, state.offset > 0 ? String(state.offset) : ''],
    [COLLAB_KEYS.scope, state.scope === 'live' ? '' : state.scope],
  ];
  for (const [key, value] of entries) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const qs = params.toString();
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`,
  );
}

export function CollabAuditPage() {
  const initial = useMemo(() => readCollabState(), []);
  const [limit] = useState(20);
  const [offset, setOffset] = useState(initial.offset);
  const [type, setType] = useState<
    'all' | 'notification' | 'filter_view' | 'export' | 'decision'
  >(initial.type);
  const [action, setAction] = useState(initial.action);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [actorId, setActorId] = useState(initial.actor);
  const [scope, setScope] = useState<'live' | 'archive' | 'all'>(initial.scope);
  const [runsOffset, setRunsOffset] = useState(0);
  const [runsFrom, setRunsFrom] = useState('');
  const [runsTo, setRunsTo] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportingSnapshots, setExportingSnapshots] = useState(false);
  const [exportingCompare, setExportingCompare] = useState(false);
  const [exportingFacet, setExportingFacet] = useState(false);
  const [exportingReport, setExportingReport] = useState(false);
  const [snapshotDays, setSnapshotDays] = useState(30);
  const [snapshotBucket, setSnapshotBucket] = useState<'day' | 'week' | 'month'>(
    'day',
  );
  const [snapshotMetric, setSnapshotMetric] = useState<'delta' | 'total'>('delta');
  const [selectedViewId, setSelectedViewId] = useState('');
  const [savingView, setSavingView] = useState(false);
  const [snapshotSeries, setSnapshotSeries] = useState<
    'total' | 'notification' | 'filter_view' | 'export' | 'decision'
  >('total');
  const [detailItem, setDetailItem] = useState<CollabAudit | null>(null);
  const [opError, setOpError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const users = useLoad(() => api.listUsers(), []);
  const auditViews = useLoad(() => api.listCollabAuditFilterViews(), []);
  const selectedAuditView = (auditViews.data?.items ?? []).find(
    (view) => view.id === selectedViewId,
  );
  const [boardDays, setBoardDays] = useState(7);
  const board = useLoad(
    () => api.listCollabSnapshots({ days: boardDays, bucket: 'day' }),
    [boardDays],
  );
  const boardComparison = board.data?.comparison ?? null;
  const applyAuditView = (id: string) => {
    setSelectedViewId(id);
    if (!id) return;
    const item = (auditViews.data?.items ?? []).find((view) => view.id === id);
    if (!item) return;
    setType(item.type);
    setAction(item.action ?? '');
    setFrom(item.from ?? '');
    setTo(item.to ?? '');
    setActorId(item.actor_id ?? '');
    setScope(item.scope);
    setOffset(0);
  };

  const saveAuditView = async () => {
    const name = window.prompt('视图名称（同名会覆盖）')?.trim();
    if (!name) return;
    setSavingView(true);
    setOpError(null);
    try {
      const res = await api.saveCollabAuditFilterView({
        name,
        type,
        action: action || undefined,
        from: from || undefined,
        to: to || undefined,
        actor_id: actorId || undefined,
        scope,
      });
      setSelectedViewId(res.item.id);
      await auditViews.reload();
    } catch (err) {
      setOpError(err);
    } finally {
      setSavingView(false);
    }
  };

  const renameAuditView = async () => {
    if (!selectedAuditView) return;
    const name = window.prompt('新的视图名称', selectedAuditView.name)?.trim();
    if (!name || name === selectedAuditView.name) return;
    setSavingView(true);
    setOpError(null);
    try {
      await api.renameCollabAuditFilterView(selectedAuditView.id, name);
      await auditViews.reload();
    } catch (err) {
      setOpError(err);
    } finally {
      setSavingView(false);
    }
  };

  const deleteAuditView = async () => {
    if (!selectedViewId) return;
    setSavingView(true);
    setOpError(null);
    try {
      await api.deleteCollabAuditFilterView(selectedViewId);
      setSelectedViewId('');
      await auditViews.reload();
    } catch (err) {
      setOpError(err);
    } finally {
      setSavingView(false);
    }
  };

  const scrollToList = () => {
    window.setTimeout(() => {
      document
        .getElementById('collab-audit-list')
        ?.scrollIntoView({ block: 'start' });
    }, 80);
  };
  const boardSpark = (
    deltaKey: string,
    maxPoints = 24,
  ): { values: number[]; labels: string[] } => {
    const rows = [...(board.data?.items ?? [])].reverse();
    const entries = rows.map((row: any) => ({
      value: Number(row[deltaKey] ?? 0),
      label:
        row.period_start === row.period_end
          ? String(row.period_start)
          : `${row.period_start}~${row.period_end}`,
    }));
    if (entries.length <= maxPoints) {
      return {
        values: entries.map((entry) => entry.value),
        labels: entries.map((entry) => entry.label),
      };
    }
    const size = Math.ceil(entries.length / maxPoints);
    const values: number[] = [];
    const labels: string[] = [];
    for (let i = 0; i < entries.length; i += size) {
      const chunk = entries.slice(i, i + size);
      values.push(chunk.reduce((sum, entry) => sum + entry.value, 0));
      labels.push(`${chunk[0].label}~${chunk[chunk.length - 1].label}`);
    }
    return { values, labels };
  };
  const rangeError =
    from && to && from > to ? '开始日期不能晚于结束日期' : '';
  const { data, error, loading, reload } = useLoad(
    async () => {
      if (rangeError) {
        return { items: [], total: 0, last_archive: null, limit, offset };
      }
      if (scope === 'archive') {
        return api.listCollabAuditArchive({
          type,
          action: action || undefined,
          from: from || undefined,
          to: to || undefined,
          actor_id: actorId || undefined,
          limit,
          offset,
        });
      }
      if (scope === 'all') {
        const merged = await api.listCollabAuditsMerged({
          type,
          action: action || undefined,
          from: from || undefined,
          to: to || undefined,
          actor_id: actorId || undefined,
          limit,
          offset,
        });
        return { ...merged, last_archive: null };
      }
      const live = await api.listCollabAudits({
        type,
        action: action || undefined,
        from: from || undefined,
        to: to || undefined,
        actor_id: actorId || undefined,
        limit,
        offset,
      });
      return { ...live, last_archive: null };
    },
    [scope, type, action, from, to, actorId, limit, offset, rangeError],
  );
  const stats = useLoad(
    () =>
      rangeError
        ? Promise.resolve({
            total: 0,
            by_type: { notification: 0, filter_view: 0, export: 0, decision: 0 },
            top_actions: [],
            top_actors: [],
            retention_days: 0,
          })
        : api.getCollabAuditStats({
            from: from || undefined,
            to: to || undefined,
            actor_id: actorId || undefined,
            scope,
          }),
    [from, to, actorId, scope, rangeError],
  );
  const archiveRuns = useLoad(
    () =>
      scope === 'archive'
        ? api.listCollabArchiveRuns({
            limit: 10,
            offset: runsOffset,
            from: runsFrom || undefined,
            to: runsTo || undefined,
          })
        : Promise.resolve({ items: [], total: 0, limit: 10, offset: 0 }),
    [scope, runsOffset, runsFrom, runsTo],
  );
  const snapshots = useLoad(
    () =>
      api.listCollabSnapshots({
        days: snapshotDays,
        bucket: snapshotBucket,
      }),
    [snapshotDays, snapshotBucket],
  );
  const snapshotTrend = [...(snapshots.data?.items ?? [])].reverse();
  const snapshotCompare = snapshots.data?.comparison ?? null;
  const SERIES_FIELD: Record<
    'total' | 'notification' | 'filter_view' | 'export' | 'decision',
    { delta: string; total: string; label: string }
  > = {
    total: { delta: 'delta_total', total: 'total', label: '总数' },
    notification: {
      delta: 'delta_notification',
      total: 'notification_count',
      label: '通知',
    },
    filter_view: {
      delta: 'delta_filter_view',
      total: 'filter_view_count',
      label: '筛选视图',
    },
    export: { delta: 'delta_export', total: 'export_count', label: '导出' },
    decision: {
      delta: 'delta_decision',
      total: 'decision_count',
      label: '决策',
    },
  };
  const seriesField = SERIES_FIELD[snapshotSeries];
  const metricValue = (s: any) =>
    snapshotMetric === 'delta'
      ? s[seriesField.delta] ?? 0
      : s[seriesField.total] ?? 0;
  const maxMetric = Math.max(1, ...snapshotTrend.map(metricValue));
  useEffect(() => {
    setRunsOffset(0);
  }, [scope]);
  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  useEffect(() => {
    writeCollabState({ type, action, from, to, actor: actorId, offset, scope });
  }, [type, action, from, to, actorId, offset, scope]);

  const exportSnapshots = async () => {
    setExportingSnapshots(true);
    setOpError(null);
    setNotice(null);
    try {
      const blob = await api.exportCollabSnapshotsCsv(
        snapshotDays,
        snapshotBucket,
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'collab-snapshots.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setNotice('审计快照已导出 CSV。');
    } catch (err) {
      setOpError(err);
    } finally {
      setExportingSnapshots(false);
    }
  };

  const exportReport = async () => {
    setExportingReport(true);
    setOpError(null);
    setNotice(null);
    try {
      const blob = await api.exportCollabReportDocx(
        snapshotDays,
        snapshotBucket,
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'collab-audit-report.docx';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setNotice('协作审计报告已导出 Word。');
    } catch (err) {
      setOpError(err);
    } finally {
      setExportingReport(false);
    }
  };

  const exportFacets = async () => {
    setExportingFacet(true);
    setOpError(null);
    setNotice(null);
    try {
      const blob = await api.exportCollabSnapshotFacetCsv(
        snapshotDays,
        snapshotBucket,
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'collab-snapshot-facets.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setNotice('快照分面已导出 CSV。');
    } catch (err) {
      setOpError(err);
    } finally {
      setExportingFacet(false);
    }
  };

  const exportComparison = async () => {
    setExportingCompare(true);
    setOpError(null);
    setNotice(null);
    try {
      const blob = await api.exportCollabSnapshotComparisonCsv(
        snapshotDays,
        snapshotBucket,
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'collab-snapshot-comparison.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setNotice('快照环比已导出 CSV。');
    } catch (err) {
      setOpError(err);
    } finally {
      setExportingCompare(false);
    }
  };

  const exportAudits = async () => {
    setExporting(true);
    setOpError(null);
    setNotice(null);
    try {
      const filters = {
        type,
        action: action || undefined,
        from: from || undefined,
        to: to || undefined,
        actor_id: actorId || undefined,
      };
      const blob =
        scope === 'archive'
          ? await api.exportCollabArchiveCsv(filters)
          : scope === 'all'
            ? await api.exportCollabMergedCsv(filters)
            : await api.exportCollabAuditsCsv(filters);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download =
        scope === 'archive'
          ? 'collab-archive-audits.csv'
          : scope === 'all'
            ? 'collab-merged-audits.csv'
            : 'collab-audits.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setNotice(
        scope === 'archive'
          ? '归档审计已导出 CSV。'
          : scope === 'all'
            ? '合并审计已导出 CSV。'
            : '协作审计已导出 CSV。',
      );
      await stats.reload();
    } catch (err) {
      setOpError(err);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="协作审计"
        subtitle="通知与筛选视图的协作操作记录。"
        actions={
          <div className="row">
            <Button size="sm" onClick={() => void reload()}>
              刷新
            </Button>
            <Button
              size="sm"
              disabled={exporting || Boolean(rangeError)}
              onClick={() => void exportAudits()}
            >
              {exporting ? '导出中…' : '导出 CSV'}
            </Button>
          </div>
        }
      />
      <div className="stat-grid" style={{ marginBottom: 12 }}>
        <Stat label="审计总数" value={stats.data?.total ?? 0} tone="brand" />
        <Stat
          label="通知"
          value={stats.data?.by_type.notification ?? 0}
          tone="blue"
        />
        <Stat
          label="筛选视图"
          value={stats.data?.by_type.filter_view ?? 0}
          tone="amber"
        />
        <Stat label="导出" value={stats.data?.by_type.export ?? 0} tone="green" />
        <Stat
          label="决策"
          value={stats.data?.by_type.decision ?? 0}
          tone="blue"
        />
      </div>
      <Card
        title="对比看板"
        subtitle={`按快照新增量 · 最近 ${boardDays} 天`}
        actions={
          <div className="row">
            <Select
              value={boardDays}
              onChange={(e) => setBoardDays(Number(e.target.value))}
              style={{ maxWidth: 120 }}
            >
              <option value={7}>最近 7 天</option>
              <option value={30}>最近 30 天</option>
              <option value={90}>最近 90 天</option>
            </Select>
            <Button
              size="sm"
              disabled={!boardComparison?.current}
              onClick={() => {
                if (!boardComparison?.current) return;
                setType('all');
                setAction('');
                setFrom(boardComparison.current.start);
                setTo(boardComparison.current.end);
                setOffset(0);
                scrollToList();
              }}
            >
              查看明细
            </Button>
            <Button size="sm" disabled={board.loading} onClick={() => void board.reload()}>
              刷新
            </Button>
          </div>
        }
      >
        {boardComparison ? (
          <div className="stat-grid">
            {(
              [
                ['总数', 'delta_total'],
                ['通知', 'delta_notification'],
                ['筛选视图', 'delta_filter_view'],
                ['导出', 'delta_export'],
                ['决策', 'delta_decision'],
              ] as const
            ).map(([label, key]) => {
              const current = boardComparison.current[key];
              const change = boardComparison.change[key];
              const spark = boardSpark(key);
              return (
                <Stat
                  key={key}
                  label={label}
                  value={current}
                  hint={`环比 ${change > 0 ? `+${change}` : change}`}
                  tone={change > 0 ? 'brand' : change < 0 ? 'red' : 'gray'}
                  title="查看该类型明细"
                  spark={spark.values}
                  sparkLabels={spark.labels}
                  onSparkClick={(index) => {
                    const label = spark.labels[index] ?? '';
                    const [start, end] = label.split('~');
                    setType(BOARD_TYPE[key] ?? 'all');
                    setAction('');
                    setFrom((start ?? '').slice(0, 10));
                    setTo(((end ?? start) ?? '').slice(0, 10));
                    setOffset(0);
                    scrollToList();
                  }}
                  onClick={() => {
                    setType(BOARD_TYPE[key] ?? 'all');
                    setAction('');
                    setFrom(boardComparison.current.start);
                    setTo(boardComparison.current.end);
                    setOffset(0);
                    scrollToList();
                  }}
                />
              );
            })}
          </div>
        ) : board.loading ? (
          <Spinner />
        ) : (
          <p className="muted">暂无快照数据。</p>
        )}
        {boardComparison?.current ? (
          <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
            本周期 {boardComparison.current.start} ~{' '}
            {boardComparison.current.end}
            {boardComparison.previous
              ? ` · 上周期 ${boardComparison.previous.start} ~ ${boardComparison.previous.end}`
              : ' · 上周期无数据'}
          </p>
        ) : null}
      </Card>
      <Card
        id="collab-audit-list"
        title={
          data
            ? `${scope === 'archive' ? '归档' : scope === 'all' ? '全部' : '热表'} · 共 ${total} 条`
            : '协作审计'
        }
        subtitle={
          scope === 'all'
            ? '热表 + 归档合并结果'
            : scope === 'archive'
            ? '已从热表移出的协作审计'
            : stats.data?.retention_days
              ? `热表保留 ${stats.data.retention_days} 天，超期自动归档`
              : undefined
        }
      >
        <div className="row" style={{ marginBottom: 8 }}>
          <Select
            value={scope}
            onChange={(e) => {
              setScope(e.target.value as 'live' | 'archive' | 'all');
              setOffset(0);
            }}
            style={{ maxWidth: 120 }}
          >
            <option value="live">热表</option>
            <option value="archive">归档</option>
            <option value="all">全部</option>
          </Select>
          <Select
            value={type}
            onChange={(e) => {
              setType(
                e.target.value as
                  | 'all'
                  | 'notification'
                  | 'filter_view'
                  | 'export'
                  | 'decision',
              );
              setAction('');
              setOffset(0);
            }}
            style={{ maxWidth: 140 }}
          >
            <option value="all">全部类型</option>
            <option value="notification">通知</option>
            <option value="filter_view">筛选视图</option>
            <option value="export">导出</option>
            <option value="decision">决策</option>
          </Select>
          <Select
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setOffset(0);
            }}
            style={{ maxWidth: 200 }}
          >
            <option value="">全部操作</option>
            {ACTION_OPTIONS[type].map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <Select
            value={actorId}
            onChange={(e) => {
              setActorId(e.target.value);
              setOffset(0);
            }}
            style={{ maxWidth: 160 }}
          >
            <option value="">全部操作人</option>
            {(users.data?.items ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
          <Input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setOffset(0);
            }}
            style={{ maxWidth: 150 }}
          />
          <Input
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setOffset(0);
            }}
            style={{ maxWidth: 150 }}
          />
          <Button
            size="sm"
            onClick={() => {
              setType('all');
              setAction('');
              setFrom('');
              setTo('');
              setActorId('');
              setOffset(0);
            }}
          >
            清空筛选
          </Button>
          <Select
            value={selectedViewId}
            onChange={(e) => applyAuditView(e.target.value)}
            style={{ maxWidth: 180 }}
          >
            <option value="">选择已保存视图</option>
            {(auditViews.data?.items ?? []).map((view) => (
              <option key={view.id} value={view.id}>
                {view.name}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            disabled={savingView}
            onClick={() => void saveAuditView()}
          >
            {savingView ? '保存中…' : '保存当前筛选'}
          </Button>
          {selectedViewId ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={savingView}
              onClick={() => void renameAuditView()}
            >
              重命名
            </Button>
          ) : null}
          {selectedViewId ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={savingView}
              onClick={() => void deleteAuditView()}
            >
              删除视图
            </Button>
          ) : null}
          {rangeError ? (
            <span style={{ color: '#b42318' }}>{rangeError}</span>
          ) : null}
        </div>
        {scope === 'archive' && data?.last_archive ? (
          <p className="hint">
            最近归档 {data.last_archive.count} 条（
            {fmtDateTime(data.last_archive.created_at)}，保留{' '}
            {data.last_archive.days} 天）
          </p>
        ) : null}
        {opError ? <ErrorBox error={opError} /> : null}
        {notice ? <p className="hint">{notice}</p> : null}
        {loading ? (
          <Spinner />
        ) : error ? (
          <ErrorBox error={error} />
        ) : items.length === 0 ? (
          <Empty title="暂无协作审计" hint="通知和筛选视图操作会记录在这里。" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>时间</th><th>类型</th><th>操作</th><th>操作人</th>
                  <th>数量/对象</th><th>详情</th>
                  {scope !== 'live' ? <th>归档时间</th> : null}
                </tr>
              </thead>
              <tbody>
                {items.map((a) => {
                  const detail = a.detail ?? {};
                  const filters = detail.filters ?? {};
                  const isNotification = a.audit_type === 'notification';
                  const isExport = a.audit_type === 'export';
                  const isDecision = a.audit_type === 'decision';
                  const detailText = isExport
                    ? [
                        filters.type ? `类型 ${filters.type}` : '',
                        filters.action ? `操作 ${filters.action}` : '',
                        filters.from ? `从 ${filters.from}` : '',
                        filters.to ? `到 ${filters.to}` : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    : isNotification
                    ? [
                        detail.mode === 'all' ? '按筛选' : '按 ID',
                        filters.unread ? '仅未读' : '',
                        filters.kind ? `类型 ${filters.kind}` : '',
                        filters.from ? `从 ${filters.from}` : '',
                        filters.to ? `到 ${filters.to}` : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    : isDecision
                    ? [
                        detail.difference_id
                          ? `差异 ${detail.difference_id}`
                          : '',
                        detail.decision ? `决策 ${detail.decision}` : '',
                        detail.mode === 'batch'
                          ? `批量 ${detail.count ?? 0} 条`
                          : '',
                        detail.note ? `备注 ${detail.note}` : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    : [
                        detail.shared ? '全员' : '',
                        detail.shared_role
                          ? `角色 ${detail.shared_role}`
                          : '',
                        Array.isArray(detail.shared_user_ids) &&
                        detail.shared_user_ids.length
                          ? `指定 ${detail.shared_user_ids.length} 人`
                          : '',
                      ]
                        .filter(Boolean)
                        .join(' · ');
                  return (
                    <tr key={a.id}>
                      <td className="muted">{fmtDateTime(a.created_at)}</td>
                      <td>
                        <Badge tone={TYPE_TONE[a.audit_type] ?? 'gray'}>
                          {TYPE_LABEL[a.audit_type] ?? a.audit_type}
                        </Badge>
                      </td>
                      <td>{ACTION_LABEL[a.action] ?? a.action}</td>
                      <td>{a.actor_name || '系统'}</td>
                      <td>
                        {isExport
                          ? detail.rows ?? '—'
                          : isDecision
                            ? detail.mode === 'batch'
                              ? detail.count ?? 0
                              : detail.difference_id || '—'
                            : isNotification
                              ? detail.count ?? '—'
                              : detail.name || '—'}
                      </td>
                      <td className="muted">
                        <div className="row" style={{ gap: 6 }}>
                          <span>{detailText || '—'}</span>
                          <Button size="sm" onClick={() => setDetailItem(a)}>
                            查看
                          </Button>
                          {isDecision && a.engagement_id ? (
                            <Button
                              size="sm"
                              onClick={() => {
                                window.location.hash = `#/engagements/${a.engagement_id}?review=${a.object_id ?? ''}`;
                              }}
                            >
                              查看复核
                            </Button>
                          ) : null}
                        </div>
                      </td>
                      {scope !== 'live' ? (
                        <td className="muted">
                          {a.archived_at ? fmtDateTime(a.archived_at) : '—'}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="row" style={{ marginTop: 8 }}>
          <span className="muted">
            第 {total === 0 ? 0 : offset + 1}–{offset + items.length} 条 / 共 {total} 条
          </span>
          <Button
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - limit))}
          >
            上一页
          </Button>
          <Button
            size="sm"
            disabled={offset + items.length >= total}
            onClick={() => setOffset(offset + limit)}
          >
            下一页
          </Button>
        </div>
        {scope === 'archive' ? (
          <div style={{ marginTop: 16 }}>
            <div className="row" style={{ marginBottom: 6 }}>
              <strong>归档执行记录</strong>
              <Input
                type="date"
                value={runsFrom}
                onChange={(e) => {
                  setRunsFrom(e.target.value);
                  setRunsOffset(0);
                }}
                style={{ maxWidth: 150 }}
              />
              <Input
                type="date"
                value={runsTo}
                onChange={(e) => {
                  setRunsTo(e.target.value);
                  setRunsOffset(0);
                }}
                style={{ maxWidth: 150 }}
              />
              <Button
                size="sm"
                onClick={() => void archiveRuns.reload()}
              >
                刷新
              </Button>
            </div>
            {(archiveRuns.data?.items ?? []).length === 0 ? (
              <p className="muted">暂无归档执行记录。</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>时间</th><th>归档数量</th><th>保留天数</th></tr>
                  </thead>
                  <tbody>
                    {(archiveRuns.data?.items ?? []).map((r) => (
                      <tr key={r.id}>
                        <td className="muted">{fmtDateTime(r.created_at)}</td>
                        <td>{r.count}</td>
                        <td>{r.days} 天</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {(archiveRuns.data?.items ?? []).length > 0 ? (
              <div className="row" style={{ marginTop: 6 }}>
                <span className="muted">
                  第 {runsOffset + 1}–
                  {runsOffset + (archiveRuns.data?.items.length ?? 0)} 条 / 共{' '}
                  {archiveRuns.data?.total ?? 0} 条
                </span>
                <Button
                  size="sm"
                  disabled={runsOffset === 0}
                  onClick={() => setRunsOffset(Math.max(0, runsOffset - 10))}
                >
                  上一页
                </Button>
                <Button
                  size="sm"
                  disabled={
                    runsOffset + (archiveRuns.data?.items.length ?? 0) >=
                    (archiveRuns.data?.total ?? 0)
                  }
                  onClick={() => setRunsOffset(runsOffset + 10)}
                >
                  下一页
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </Card>

      <div style={{ marginTop: 16 }}>
        <div className="row" style={{ marginBottom: 6 }}>
          <strong>审计快照</strong>
          <Select
            value={snapshotDays}
            onChange={(e) => setSnapshotDays(Number(e.target.value))}
            style={{ maxWidth: 140 }}
          >
            <option value={30}>最近 30 天</option>
            <option value={90}>最近 90 天</option>
            <option value={180}>最近 180 天</option>
            <option value={365}>最近 365 天</option>
          </Select>
          <Select
            value={snapshotBucket}
            onChange={(e) =>
              setSnapshotBucket(e.target.value as 'day' | 'week' | 'month')
            }
            style={{ maxWidth: 120 }}
          >
            <option value="day">按日</option>
            <option value="week">按周</option>
            <option value="month">按月</option>
          </Select>
          <Select
            value={snapshotSeries}
            onChange={(e) =>
              setSnapshotSeries(
                e.target.value as
                  | 'total'
                  | 'notification'
                  | 'filter_view'
                  | 'export'
                  | 'decision',
              )
            }
            style={{ maxWidth: 120 }}
          >
            <option value="total">总数</option>
            <option value="notification">通知</option>
            <option value="filter_view">筛选视图</option>
            <option value="export">导出</option>
            <option value="decision">决策</option>
          </Select>
          <Select
            value={snapshotMetric}
            onChange={(e) =>
              setSnapshotMetric(e.target.value as 'delta' | 'total')
            }
            style={{ maxWidth: 120 }}
          >
            <option value="delta">新增</option>
            <option value="total">累计</option>
          </Select>
          <Button size="sm" onClick={() => void snapshots.reload()}>
            刷新
          </Button>
          <Button
            size="sm"
            disabled={exportingSnapshots}
            onClick={() => void exportSnapshots()}
          >
            {exportingSnapshots ? '导出中…' : '导出快照 CSV'}
          </Button>
          <Button
            size="sm"
            disabled={exportingCompare}
            onClick={() => void exportComparison()}
          >
            {exportingCompare ? '导出中…' : '导出环比 CSV'}
          </Button>
          <Button
            size="sm"
            disabled={exportingFacet}
            onClick={() => void exportFacets()}
          >
            {exportingFacet ? '导出中…' : '导出分面 CSV'}
          </Button>
          <Button
            size="sm"
            disabled={exportingReport}
            onClick={() => void exportReport()}
          >
            {exportingReport ? '生成中…' : '导出审计报告 Word'}
          </Button>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>
          累计口径包含已归档的协作审计；日期按组织时区划分。
        </p>
        {snapshotCompare ? (
          <div style={{ marginBottom: 8 }}>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>新增对比</th>
                    <th>本周期</th>
                    <th>上周期</th>
                    <th>环比</th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ['总数', 'delta_total'],
                      ['通知', 'delta_notification'],
                      ['筛选视图', 'delta_filter_view'],
                      ['导出', 'delta_export'],
                      ['决策', 'delta_decision'],
                    ] as const
                  ).map(([label, key]) => {
                    const change = snapshotCompare.change[key];
                    return (
                      <tr key={key}>
                        <td>{label}</td>
                        <td>{snapshotCompare.current[key]}</td>
                        <td>{snapshotCompare.previous?.[key] ?? 0}</td>
                        <td>
                          {change > 0 ? `+${change}` : change}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
              本周期 {snapshotCompare.current.start} ~ {snapshotCompare.current.end}
              {snapshotCompare.previous
                ? ` · 上周期 ${snapshotCompare.previous.start} ~ ${snapshotCompare.previous.end}`
                : ' · 上周期无数据'}
            </p>
          </div>
        ) : null}
        {(snapshots.data?.items ?? []).length === 0 ? (
          <p className="muted">暂无审计快照。</p>
        ) : (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                gap: 4,
                height: 100,
                padding: '4px 0',
                marginBottom: 8,
              }}
            >
              {snapshotTrend.map((s) => (
                <div
                  key={s.snapshot_date}
                  title={`${s.period_start} ~ ${s.period_end} ${
                    snapshotMetric === 'delta' ? '新增' : '累计'
                  } ${seriesField.label} ${metricValue(s)}`}
                  style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    height: '100%',
                  }}
                >
                  <div
                    style={{
                      width: '100%',
                      minHeight: 2,
                      height: `${Math.max(
                        2,
                        Math.round((metricValue(s) / maxMetric) * 100),
                      )}%`,
                      background: 'var(--brand)',
                      borderRadius: 3,
                    }}
                  />
                  <span style={{ fontSize: 9, marginTop: 2 }}>
                    {snapshotBucket === 'month'
                      ? s.period_start.slice(0, 7)
                      : s.period_start.slice(5)}
                  </span>
                </div>
              ))}
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>日期</th><th>总数</th><th>新增</th><th>通知</th>
                    <th>筛选视图</th><th>导出</th><th>决策</th>
                  </tr>
                </thead>
                <tbody>
                  {(snapshots.data?.items ?? []).slice(0, 10).map((s) => (
                    <tr key={s.snapshot_date}>
                      <td className="mono">
                        {s.period_start === s.period_end
                          ? s.period_start
                          : `${s.period_start} ~ ${s.period_end}`}
                      </td>
                      <td>{s.total}</td>
                      <td>+{s.delta_total}</td>
                      <td>{s.notification_count}</td>
                      <td>{s.filter_view_count}</td>
                      <td>{s.export_count}</td>
                      <td>{s.decision_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      <Modal
        open={Boolean(detailItem)}
        onClose={() => setDetailItem(null)}
        title="协作审计详情"
        subtitle={
          detailItem
            ? `${TYPE_LABEL[detailItem.audit_type] ?? detailItem.audit_type} · ${
                ACTION_LABEL[detailItem.action] ?? detailItem.action
              }`
            : undefined
        }
        wide
        footer={
          <Button onClick={() => setDetailItem(null)}>关闭</Button>
        }
      >
        {detailItem ? (
          <div className="form-grid">
            <div>
              <div className="muted small">审计 ID</div>
              <div className="mono small">{detailItem.id}</div>
            </div>
            <div>
              <div className="muted small">对象 ID</div>
              <div className="mono small">{detailItem.object_id || '—'}</div>
            </div>
            <div>
              <div className="muted small">操作人</div>
              <div>{detailItem.actor_name || '系统'}</div>
            </div>
            <div>
              <div className="muted small">时间</div>
              <div>{fmtDateTime(detailItem.created_at)}</div>
            </div>
            {detailItem.archived_at ? (
              <div>
                <div className="muted small">归档时间</div>
                <div>{fmtDateTime(detailItem.archived_at)}</div>
              </div>
            ) : null}
            <div>
              <div className="muted small">请求 ID</div>
              <div className="mono small">{detailItem.request_id || '—'}</div>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <div className="muted small">详情</div>
              <pre
                className="mono small"
                style={{
                  margin: 0,
                  padding: 8,
                  background: 'var(--surface-2)',
                  borderRadius: 6,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
                {JSON.stringify(detailItem.detail ?? {}, null, 2)}
              </pre>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
