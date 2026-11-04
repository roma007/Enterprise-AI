import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { getStoredUser } from '../auth';
import { useDebouncedValue, useLoad } from '../hooks';
import type { AuditLog } from '../types';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Field,
  Input,
  Modal,
  Notice,
  PageHeader,
  Select,
  Spinner,
  Stat,
  UserMultiSelect,
} from '../ui';
import { fmtDate, fmtDateTime, namesPreview } from '../utils';

const AUDIT_KEYS = {
  mode: 'audit_mode',
  q: 'audit_q',
  action: 'audit_action',
  object: 'audit_object',
  status: 'audit_status',
  from: 'audit_from',
  to: 'audit_to',
  offset: 'audit_offset',
} as const;

interface AuditUrlState {
  mode: 'live' | 'archive';
  q: string;
  action: string;
  object: string;
  status: string;
  from: string;
  to: string;
  offset: number;
}

function readAuditState(): AuditUrlState {
  if (typeof window === 'undefined') {
    return {
      mode: 'live',
      q: '',
      action: '',
      object: '',
      status: '',
      from: '',
      to: '',
      offset: 0,
    };
  }
  const params = new URLSearchParams(window.location.search);
  const rawOffset = Number(params.get(AUDIT_KEYS.offset) ?? '0');
  return {
    mode: params.get(AUDIT_KEYS.mode) === 'archive' ? 'archive' : 'live',
    q: params.get(AUDIT_KEYS.q) ?? '',
    action: params.get(AUDIT_KEYS.action) ?? '',
    object: params.get(AUDIT_KEYS.object) ?? '',
    status: params.get(AUDIT_KEYS.status) ?? '',
    from: params.get(AUDIT_KEYS.from) ?? '',
    to: params.get(AUDIT_KEYS.to) ?? '',
    offset:
      Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0,
  };
}

function writeAuditState(state: AuditUrlState) {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  const entries: Array<[string, string]> = [
    [AUDIT_KEYS.mode, state.mode === 'archive' ? 'archive' : ''],
    [AUDIT_KEYS.q, state.q],
    [AUDIT_KEYS.action, state.action],
    [AUDIT_KEYS.object, state.object],
    [AUDIT_KEYS.status, state.status],
    [AUDIT_KEYS.from, state.from],
    [AUDIT_KEYS.to, state.to],
    [AUDIT_KEYS.offset, state.offset > 0 ? String(state.offset) : ''],
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

function statusTone(code: number | null) {
  if (code == null) return 'gray' as const;
  if (code >= 500) return 'red' as const;
  if (code >= 400) return 'amber' as const;
  return 'green' as const;
}

const ROLE_LABEL: Record<string, string> = {
  admin: '管理员',
  director: '总监',
  pm: '项目经理',
  consultant: '顾问',
  tech_lead: '技术负责人',
};

const EXPORT_COLUMN_OPTIONS = [
  { key: 'time', label: '时间' },
  { key: 'action', label: '操作' },
  { key: 'object_type', label: '对象类型' },
  { key: 'object_id', label: '对象 ID' },
  { key: 'status', label: '状态码' },
  { key: 'user', label: '操作人' },
  { key: 'request_id', label: '请求 ID' },
  { key: 'ip', label: 'IP' },
  { key: 'user_agent', label: 'User-Agent' },
  { key: 'detail', label: '详情' },
  { key: 'archived_at', label: '归档时间' },
] as const;

const EXPORT_COLUMNS_STORAGE = 'audit_export_columns';
const DEFAULT_EXPORT_COLUMNS = EXPORT_COLUMN_OPTIONS.map((item) => item.key);

function readExportColumns(): string[] {
  if (typeof window === 'undefined') return [...DEFAULT_EXPORT_COLUMNS];
  try {
    const raw = window.localStorage.getItem(EXPORT_COLUMNS_STORAGE);
    if (!raw) return [...DEFAULT_EXPORT_COLUMNS];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_EXPORT_COLUMNS];
    const valid = parsed.filter((key): key is string =>
      DEFAULT_EXPORT_COLUMNS.includes(key),
    );
    return valid.length ? valid : [...DEFAULT_EXPORT_COLUMNS];
  } catch {
    return [...DEFAULT_EXPORT_COLUMNS];
  }
}

const PAGE_SIZE = 50;
const defaultBefore = () =>
  new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString().slice(0, 10);

export function AuditPage() {
  const role = getStoredUser()?.role;
  const canArchive = !role || ['admin', 'director'].includes(role);
  const initial = useMemo(() => readAuditState(), []);
  const [mode, setMode] = useState<'live' | 'archive'>(initial.mode);
  const [offset, setOffset] = useState(initial.offset);
  const [search, setSearch] = useState(initial.q);
  const [actionFilter, setActionFilter] = useState(initial.action);
  const [objectTypeFilter, setObjectTypeFilter] = useState(initial.object);
  const [statusFilter, setStatusFilter] = useState(initial.status);
  const [fromFilter, setFromFilter] = useState(initial.from);
  const [toFilter, setToFilter] = useState(initial.to);
  const dq = useDebouncedValue(search, 300);
  const facets = useLoad(() => api.listAuditFacets(mode), [mode]);
  const auditViews = useLoad(() => api.listAuditFilterViews(), []);
  const [selectedViewId, setSelectedViewId] = useState('');
  const [importing, setImporting] = useState(false);
  const [viewNotice, setViewNotice] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [savingView, setSavingView] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [columnPicker, setColumnPicker] = useState(false);
  const [exportColumns, setExportColumns] = useState<string[]>(readExportColumns);
  const [viewError, setViewError] = useState<unknown>(null);
  const [shareMode, setShareMode] = useState<
    'none' | 'all' | 'role' | 'users'
  >('none');
  const [shareRole, setShareRole] = useState('consultant');
  const [shareUsers, setShareUsers] = useState<string[]>([]);
  const users = useLoad(() => api.listUsers(), []);
  const memberUsers = users.data?.items ?? [];
  const targetedMembers = memberUsers.filter((u) => shareUsers.includes(u.id));
  const roleMembers = memberUsers.filter((u) => u.role === shareRole);
  const selectedView = (auditViews.data?.items ?? []).find(
    (view) => view.id === selectedViewId,
  );
  const visibleExportColumns = exportColumns.filter(
    (key) => key !== 'archived_at' || mode === 'archive',
  );

  const { data, error, loading, reload } = useLoad(
    () =>
      mode === 'archive'
        ? api.listArchivedAuditLogs({
            limit: PAGE_SIZE,
            offset,
            q: dq,
            action: actionFilter || undefined,
            object_type: objectTypeFilter || undefined,
            status: statusFilter || undefined,
            from: fromFilter || undefined,
            to: toFilter || undefined,
          })
        : api.listAuditLogs({
            limit: PAGE_SIZE,
            offset,
            q: dq,
            action: actionFilter || undefined,
            object_type: objectTypeFilter || undefined,
            status: statusFilter || undefined,
            from: fromFilter || undefined,
            to: toFilter || undefined,
          }),
    [
      mode,
      offset,
      dq,
      actionFilter,
      objectTypeFilter,
      statusFilter,
      fromFilter,
      toFilter,
    ],
  );

  const filtersInitialized = useRef(false);
  useEffect(() => {
    if (!filtersInitialized.current) {
      filtersInitialized.current = true;
      return;
    }
    setOffset(0);
  }, [
    dq,
    actionFilter,
    objectTypeFilter,
    statusFilter,
    fromFilter,
    toFilter,
  ]);

  useEffect(() => {
    writeAuditState({
      mode,
      q: search,
      action: actionFilter,
      object: objectTypeFilter,
      status: statusFilter,
      from: fromFilter,
      to: toFilter,
      offset,
    });
  }, [
    mode,
    search,
    actionFilter,
    objectTypeFilter,
    statusFilter,
    fromFilter,
    toFilter,
    offset,
  ]);

  const [before, setBefore] = useState(defaultBefore);
  const [archiving, setArchiving] = useState(false);
  const [detailLog, setDetailLog] = useState<AuditLog | null>(null);
  const [archiveNotice, setArchiveNotice] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<unknown>(null);

  const items = data?.items ?? [];
  const total = data?.stats?.total ?? data?.total ?? items.length;
  const deletes = data?.stats?.deletes ?? 0;
  const failures = data?.stats?.failures ?? 0;

  const switchMode = (next: 'live' | 'archive') => {
    setMode(next);
    setOffset(0);
    setSearch('');
    setActionFilter('');
    setObjectTypeFilter('');
    setStatusFilter('');
    setFromFilter('');
    setToFilter('');
    setArchiveNotice(null);
    setArchiveError(null);
  };

  const currentViewPayload = (name: string) => ({
    name,
    mode,
    q: search || undefined,
    action: actionFilter || undefined,
    object_type: objectTypeFilter || undefined,
    status: statusFilter || undefined,
    from: fromFilter || undefined,
    to: toFilter || undefined,
    shared: shareMode === 'all',
    shared_role: shareMode === 'role' ? shareRole : null,
    shared_user_ids: shareMode === 'users' ? shareUsers : [],
    export_columns: exportColumns,
  });

  const saveCurrentView = async () => {
    const name = window.prompt('视图名称（同名会覆盖）')?.trim();
    if (!name) return;
    setSavingView(true);
    setViewError(null);
    try {
      const res = await api.saveAuditFilterView(currentViewPayload(name));
      setSelectedViewId(res.item.id);
      await auditViews.reload();
    } catch (err) {
      setViewError(err);
    } finally {
      setSavingView(false);
    }
  };

  const applySavedView = (id: string) => {
    setSelectedViewId(id);
    const view = (auditViews.data?.items ?? []).find((item) => item.id === id);
    if (!view) return;
    setMode(view.mode);
    setSearch(view.q ?? '');
    setActionFilter(view.action ?? '');
    setObjectTypeFilter(view.object_type ?? '');
    setStatusFilter(view.status ?? '');
    setFromFilter(view.from ?? '');
    setToFilter(view.to ?? '');
    setShareMode(
      view.shared
        ? 'all'
        : view.shared_role
          ? 'role'
          : (view.shared_user_ids?.length ?? 0) > 0
            ? 'users'
            : 'none',
    );
    if (view.shared_role) setShareRole(view.shared_role);
    setShareUsers(view.shared_user_ids ?? []);
    if (view.export_columns?.length) {
      const ordered = DEFAULT_EXPORT_COLUMNS.filter((key) =>
        view.export_columns.includes(key),
      );
      setExportColumns(ordered);
      window.localStorage.setItem(
        EXPORT_COLUMNS_STORAGE,
        JSON.stringify(ordered),
      );
    }
    setOffset(0);
    setArchiveNotice(null);
    setArchiveError(null);
  };

  const deepLinkApplied = useRef(false);
  useEffect(() => {
    if (deepLinkApplied.current) return;
    const id = new URLSearchParams(window.location.search).get('audit_view');
    if (!id) {
      deepLinkApplied.current = true;
      return;
    }
    const view = (auditViews.data?.items ?? []).find((item) => item.id === id);
    if (!view) return;
    deepLinkApplied.current = true;
    applySavedView(id);
    const params = new URLSearchParams(window.location.search);
    params.delete('audit_view');
    const qs = params.toString();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`,
    );
  }, [auditViews.data]);

  const exportViewsJson = async () => {
    setViewError(null);
    try {
      const blob = await api.exportAuditFilterViewsJson();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `审计视图-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (err) {
      setViewError(err);
    }
  };

  const importViewsJson = async (file: File) => {
    setImporting(true);
    setViewError(null);
    setViewNotice(null);
    try {
      const parsed = JSON.parse(await file.text());
      if (!Array.isArray(parsed?.views) || !parsed.views.length) {
        throw new Error('文件缺少 views 数组');
      }
      const preview = await api.previewAuditFilterViews({
        version: 1,
        views: parsed.views,
      });
      let mode: 'overwrite' | 'skip' = 'overwrite';
      if (preview.conflicts.length) {
        const overwrite = window.confirm(
          `共 ${preview.total} 个视图：新增 ${preview.new}，同名 ${preview.conflicts.length}。\n\n确定：覆盖同名视图\n取消：跳过同名视图`,
        );
        mode = overwrite ? 'overwrite' : 'skip';
      }
      const res = await api.importAuditFilterViews({
        version: 1,
        mode,
        views: parsed.views,
      });
      setViewNotice(
        `已导入 ${res.imported} 个视图${res.skipped ? `，跳过 ${res.skipped} 个` : ''}`,
      );
      await auditViews.reload();
    } catch (err) {
      setViewError(err);
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = '';
    }
  };

  const renameCurrentView = async () => {
    if (!selectedViewId) return;
    const name = window.prompt('新的视图名称', selectedView?.name ?? '')?.trim();
    if (!name) return;
    setSavingView(true);
    setViewError(null);
    try {
      await api.renameAuditFilterView(selectedViewId, name);
      await auditViews.reload();
    } catch (err) {
      setViewError(err);
    } finally {
      setSavingView(false);
    }
  };

  const deleteCurrentView = async () => {
    if (!selectedViewId) return;
    if (!window.confirm(`确认删除视图「${selectedView?.name ?? ''}」？`)) return;
    setSavingView(true);
    setViewError(null);
    try {
      await api.deleteAuditFilterView(selectedViewId);
      setSelectedViewId('');
      await auditViews.reload();
    } catch (err) {
      setViewError(err);
    } finally {
      setSavingView(false);
    }
  };

  const exportCsv = async () => {
    setExporting(true);
    setViewError(null);
    try {
      const blob = await api.exportAuditLogsCsv({
        scope: mode,
        q: search || undefined,
        action: actionFilter || undefined,
        object_type: objectTypeFilter || undefined,
        status: statusFilter || undefined,
        from: fromFilter || undefined,
        to: toFilter || undefined,
        columns: visibleExportColumns.join(','),
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `审计日志-${mode === 'archive' ? '归档' : '热表'}-${new Date()
        .toISOString()
        .slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (err) {
      setViewError(err);
    } finally {
      setExporting(false);
    }
  };

  const previewArchive = async () => {
    setArchiving(true);
    setArchiveError(null);
    setArchiveNotice(null);
    try {
      const res = await api.archiveAuditLogs({ before, dry_run: true });
      setArchiveNotice(`预演：早于 ${fmtDate(before)} 的记录可归档 ${res.candidates} 条。`);
    } catch (err) {
      setArchiveError(err);
    } finally {
      setArchiving(false);
    }
  };

  const runArchive = async () => {
    if (
      !window.confirm(
        `确认把早于 ${before} 的审计日志移入归档表？\n归档不删除记录，但会从热表移出。`,
      )
    ) {
      return;
    }
    setArchiving(true);
    setArchiveError(null);
    setArchiveNotice(null);
    try {
      const res = await api.archiveAuditLogs({
        before,
        dry_run: false,
        confirm: 'ARCHIVE',
      });
      setArchiveNotice(
        `已归档 ${res.moved} 条；热表剩余 ${res.remaining} 条。`,
      );
      await reload();
    } catch (err) {
      setArchiveError(err);
    } finally {
      setArchiving(false);
    }
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="R1 · 留痕"
        title="审计日志"
        subtitle="所有写操作（POST / PUT / PATCH / DELETE）自动留痕，不记录请求体。"
        actions={
          <>
            {canArchive ? (
              <div className="inline-actions">
                <Button
                  size="sm"
                  variant={mode === 'live' ? 'primary' : 'ghost'}
                  onClick={() => switchMode('live')}
                >
                  热表
                </Button>
                <Button
                  size="sm"
                  variant={mode === 'archive' ? 'primary' : 'ghost'}
                  onClick={() => switchMode('archive')}
                >
                  归档
                </Button>
              </div>
            ) : null}
            <Button onClick={() => void reload()} disabled={loading}>
              刷新
            </Button>
          </>
        }
      />

      {loading && !data ? <Spinner /> : null}
      {error && !data ? <ErrorBox error={error} onRetry={() => void reload()} /> : null}

      {data ? (
        <>
          <div className="stat-grid">
            <Stat
              label={mode === 'archive' ? '归档总数' : '审计总数'}
              value={total}
              hint={`本页 ${items.length} 条`}
              tone="brand"
            />
            <Stat label="删除操作" value={deletes} hint="含软删除/子资源删除" tone="amber" />
            <Stat label="失败请求" value={failures} hint="4xx / 5xx" tone="red" />
          </div>

          <Card
            title={mode === 'archive' ? '归档记录' : '操作记录'}
            subtitle={
              mode === 'archive'
                ? '只读归档表；执行归档需要管理员/总监权限。'
                : '按时间倒序；可按 action、对象类型或操作人过滤。'
            }
            actions={
              <div className="row">
                <Select
                  value={actionFilter}
                  onChange={(e) => setActionFilter(e.target.value)}
                  style={{ maxWidth: 180 }}
                >
                  <option value="">全部操作</option>
                  {(facets.data?.actions ?? []).map((action) => (
                    <option key={action} value={action}>
                      {action}
                    </option>
                  ))}
                </Select>
                <Select
                  value={objectTypeFilter}
                  onChange={(e) => setObjectTypeFilter(e.target.value)}
                  style={{ maxWidth: 160 }}
                >
                  <option value="">全部对象</option>
                  {(facets.data?.object_types ?? []).map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </Select>
                <Select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  style={{ maxWidth: 130 }}
                >
                  <option value="">全部状态</option>
                  <option value="2xx">2xx</option>
                  <option value="3xx">3xx</option>
                  <option value="4xx">4xx</option>
                  <option value="5xx">5xx</option>
                </Select>
                <Input
                  type="date"
                  value={fromFilter}
                  onChange={(e) => setFromFilter(e.target.value)}
                  style={{ maxWidth: 150 }}
                />
                <Input
                  type="date"
                  value={toFilter}
                  onChange={(e) => setToFilter(e.target.value)}
                  style={{ maxWidth: 150 }}
                />
                <Input
                  placeholder="搜索 action / 对象 / 用户"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={
                    !search &&
                    !actionFilter &&
                    !objectTypeFilter &&
                    !statusFilter &&
                    !fromFilter &&
                    !toFilter
                  }
                  onClick={() => {
                    setSearch('');
                    setActionFilter('');
                    setObjectTypeFilter('');
                    setStatusFilter('');
                    setFromFilter('');
                    setToFilter('');
                    setOffset(0);
                  }}
                >
                  清空筛选
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setColumnPicker(true)}
                >
                  列设置
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={exporting || visibleExportColumns.length === 0}
                  onClick={() => void exportCsv()}
                >
                  {exporting ? '导出中…' : '导出 CSV'}
                </Button>
                <Select
                  value={selectedViewId}
                  onChange={(e) => applySavedView(e.target.value)}
                  style={{ maxWidth: 180 }}
                >
                  <option value="">选择已保存视图</option>
                  {(auditViews.data?.items ?? []).map((view) => (
                    <option key={view.id} value={view.id}>
                      {view.name}
                      {view.mode === 'archive' ? '（归档）' : ''}
                      {view.shared
                        ? '（全员）'
                        : view.shared_role
                          ? `（角色：${ROLE_LABEL[view.shared_role] ?? view.shared_role}）`
                          : (view.shared_user_ids?.length ?? 0) > 0
                            ? `（指定 ${view.shared_user_ids!.length} 人）`
                            : ''}
                      {view.is_owner ? '' : ` · ${view.owner_name ?? '同事'}`}
                    </option>
                  ))}
                </Select>
                <Select
                  value={shareMode}
                  onChange={(e) =>
                    setShareMode(
                      e.target.value as 'none' | 'all' | 'role' | 'users',
                    )
                  }
                  style={{ maxWidth: 130 }}
                >
                  <option value="none">仅自己</option>
                  <option value="all">共享给全员</option>
                  <option value="role">按角色共享</option>
                  <option value="users">指定同事</option>
                </Select>
                {shareMode === 'role' ? (
                  <Select
                    value={shareRole}
                    onChange={(e) => setShareRole(e.target.value)}
                    style={{ maxWidth: 130 }}
                  >
                    {Object.entries(ROLE_LABEL).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                ) : null}
                {shareMode === 'role' ? (
                  <span className="muted small">
                    将共享给：
                    {roleMembers.length
                      ? namesPreview(roleMembers)
                      : '暂无成员'}
                  </span>
                ) : null}
                {shareMode === 'users' ? (
                  <span className="muted small">
                    已选：
                    {targetedMembers.length
                      ? namesPreview(targetedMembers)
                      : '未选择'}
                  </span>
                ) : null}
                {shareMode === 'users' ? (
                  <UserMultiSelect
                    users={memberUsers}
                    value={shareUsers}
                    onChange={setShareUsers}
                    roleOptions={Object.entries(ROLE_LABEL).map(
                      ([value, label]) => ({ value, label }),
                    )}
                  />
                ) : null}
                {shareMode !== 'none' ? (
                  <span className="muted small">保存后通知同事</span>
                ) : null}
                <Button
                  size="sm"
                  disabled={savingView}
                  onClick={() => void saveCurrentView()}
                >
                  {savingView ? '保存中…' : '保存当前筛选'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void exportViewsJson()}
                >
                  导出视图
                </Button>
                <input
                  ref={importInputRef}
                  type="file"
                  accept="application/json,.json"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void importViewsJson(file);
                  }}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={importing}
                  onClick={() => importInputRef.current?.click()}
                >
                  {importing ? '导入中…' : '导入视图'}
                </Button>
                {selectedView ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={savingView}
                    onClick={() => void renameCurrentView()}
                  >
                    重命名
                  </Button>
                ) : null}
                {selectedView ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={savingView}
                    onClick={() => void deleteCurrentView()}
                  >
                    删除视图
                  </Button>
                ) : null}
              </div>
            }
          >
            {viewNotice ? <Notice tone="green">{viewNotice}</Notice> : null}
            {viewError ? <ErrorBox error={viewError} /> : null}
            {items.length === 0 ? (
              <Empty
                title={mode === 'archive' ? '归档表为空' : '没有匹配的审计记录'}
                hint={mode === 'archive' ? '还没有执行过归档。' : '换个关键词，或先执行一次写操作。'}
              />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>操作</th>
                      <th>对象</th>
                      <th>状态</th>
                      <th>操作人</th>
                      <th>请求 ID</th>
                      {mode === 'archive' ? <th>归档时间</th> : null}
                      <th>IP</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((a: AuditLog) => (
                      <tr key={a.id}>
                        <td className="muted nowrap">{fmtDateTime(a.created_at)}</td>
                        <td>
                          <span className="mono audit-action">{a.action}</span>
                        </td>
                        <td>
                          {a.object_type ? (
                            <Badge tone="gray">{a.object_type}</Badge>
                          ) : (
                            <span className="muted">—</span>
                          )}
                          {a.object_id ? (
                            <span className="mono muted"> {a.object_id.slice(0, 8)}</span>
                          ) : null}
                        </td>
                        <td>
                          <Badge tone={statusTone(a.status_code)}>{a.status_code ?? '—'}</Badge>
                        </td>
                        <td>{a.user_name ?? (a.user_id ? a.user_id.slice(0, 8) : '匿名/开发模式')}</td>
                        <td className="mono muted small" title={a.request_id ?? ''}>
                          {a.request_id ? a.request_id.slice(0, 12) : '—'}
                        </td>
                        {mode === 'archive' ? (
                          <td className="muted nowrap">
                            {a.archived_at ? fmtDateTime(a.archived_at) : '—'}
                          </td>
                        ) : null}
                        <td className="mono muted">{a.ip ?? '—'}</td>
                        <td className="actions-cell">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDetailLog(a)}
                          >
                            查看
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <div className="form-actions pager">
            <span className="muted small">
              第 {Math.floor(offset / PAGE_SIZE) + 1} 页 · 共 {total} 条
            </span>
            <Button
              size="sm"
              disabled={offset === 0 || loading}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              上一页
            </Button>
            <Button
              size="sm"
              disabled={offset + items.length >= total || loading}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              下一页
            </Button>
          </div>

          {mode === 'live' && canArchive ? (
            <Card
              title="归档旧日志"
              subtitle="把早于指定日期的记录移入 audit_logs_archive；不物理删除，避免热表无限增长。"
            >
              {archiveError ? <ErrorBox error={archiveError} /> : null}
              {archiveNotice ? <Notice tone="green">{archiveNotice}</Notice> : null}
              <div className="inline-form">
                <Field label="归档早于此日期">
                  <Input
                    type="date"
                    value={before}
                    onChange={(e) => setBefore(e.target.value)}
                  />
                </Field>
                <Button size="sm" disabled={archiving} onClick={() => void previewArchive()}>
                  预演
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={archiving || !before}
                  onClick={() => void runArchive()}
                >
                  执行归档
                </Button>
              </div>
              <p className="hint-line">
                建议保留 180 天热数据；定时任务可执行
                <code>npm run audit:archive -- --days=180</code>。
              </p>
            </Card>
          ) : null}
        </>
      ) : null}

      <Modal
        open={columnPicker}
        title="导出列"
        subtitle="勾选需要写入 CSV 的列，设置保存在本机。"
        onClose={() => setColumnPicker(false)}
        footer={
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setExportColumns([...DEFAULT_EXPORT_COLUMNS]);
                window.localStorage.removeItem(EXPORT_COLUMNS_STORAGE);
              }}
            >
              恢复默认
            </Button>
            <Button size="sm" onClick={() => setColumnPicker(false)}>
              关闭
            </Button>
          </>
        }
      >
        <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
          {EXPORT_COLUMN_OPTIONS.map((option) => {
            const disabled =
              option.key === 'archived_at' && mode !== 'archive';
            const checked =
              exportColumns.includes(option.key) && !disabled;
            return (
              <label
                key={option.key}
                className="row"
                style={{ gap: 6, opacity: disabled ? 0.5 : 1 }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => {
                    const next = checked
                      ? exportColumns.filter((key) => key !== option.key)
                      : [...exportColumns, option.key];
                    if (!next.length) return;
                    const ordered = DEFAULT_EXPORT_COLUMNS.filter((key) =>
                      next.includes(key),
                    );
                    setExportColumns(ordered);
                    window.localStorage.setItem(
                      EXPORT_COLUMNS_STORAGE,
                      JSON.stringify(ordered),
                    );
                  }}
                />
                <span>{option.label}</span>
              </label>
            );
          })}
        </div>
        <p className="hint">
          至少保留一列；「归档时间」只在归档范围可用。
        </p>
      </Modal>

      <Modal
        open={Boolean(detailLog)}
        onClose={() => setDetailLog(null)}
        title="审计详情"
        subtitle={detailLog?.action}
        wide
        footer={<Button onClick={() => setDetailLog(null)}>关闭</Button>}
      >
  
      {detailLog ? (
          <div className="form-grid">
            <div>
              <div className="muted small">操作</div>
              <div className="mono">{detailLog.action}</div>
            </div>
            <div>
              <div className="muted small">状态码</div>
              <div>{detailLog.status_code ?? '—'}</div>
            </div>
            <div>
              <div className="muted small">对象类型</div>
              <div>{detailLog.object_type ?? '—'}</div>
            </div>
            <div>
              <div className="muted small">对象 ID</div>
              <div className="mono small">{detailLog.object_id ?? '—'}</div>
            </div>
            <div>
              <div className="muted small">操作人</div>
              <div>
                {detailLog.user_name ??
                  (detailLog.user_id
                    ? detailLog.user_id.slice(0, 8)
                    : '匿名/开发模式')}
              </div>
            </div>
            <div>
              <div className="muted small">时间</div>
              <div>{fmtDateTime(detailLog.created_at)}</div>
            </div>
            <div>
              <div className="muted small">请求 ID</div>
              <div className="mono small">{detailLog.request_id ?? '—'}</div>
            </div>
            <div>
              <div className="muted small">IP</div>
              <div className="mono small">{detailLog.ip ?? '—'}</div>
            </div>
            {detailLog.archived_at ? (
              <div>
                <div className="muted small">归档时间</div>
                <div>{fmtDateTime(detailLog.archived_at)}</div>
              </div>
            ) : null}
            <div style={{ gridColumn: '1 / -1' }}>
              <div className="muted small">User-Agent</div>
              <div className="mono small" style={{ wordBreak: 'break-all' }}>
                {detailLog.user_agent ?? '—'}
              </div>
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
                {JSON.stringify(detailLog.detail ?? {}, null, 2)}
              </pre>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
