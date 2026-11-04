import { useEffect, useState } from 'react';
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
  Spinner,
  Stat,
} from '../ui';
import { fmtDate, fmtDateTime } from '../utils';

function statusTone(code: number | null) {
  if (code == null) return 'gray' as const;
  if (code >= 500) return 'red' as const;
  if (code >= 400) return 'amber' as const;
  return 'green' as const;
}

const PAGE_SIZE = 50;
const defaultBefore = () =>
  new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString().slice(0, 10);

export function AuditPage() {
  const role = getStoredUser()?.role;
  const canArchive = !role || ['admin', 'director'].includes(role);
  const [mode, setMode] = useState<'live' | 'archive'>('live');
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const dq = useDebouncedValue(search, 300);

  const { data, error, loading, reload } = useLoad(
    () =>
      mode === 'archive'
        ? api.listArchivedAuditLogs({ limit: PAGE_SIZE, offset, q: dq })
        : api.listAuditLogs({ limit: PAGE_SIZE, offset, q: dq }),
    [mode, offset, dq],
  );

  useEffect(() => {
    setOffset(0);
  }, [dq]);

  const [before, setBefore] = useState(defaultBefore);
  const [archiving, setArchiving] = useState(false);
  const [detailLog, setDetailLog] = useState<AuditLog | null>(null);
  const [archiveNotice, setArchiveNotice] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<unknown>(null);

  const items = data?.items ?? [];
  const total = data?.total ?? items.length;

  const deletes = items.filter((a) => a.action.startsWith('DELETE')).length;
  const failures = items.filter((a) => (a.status_code ?? 0) >= 400).length;

  const switchMode = (next: 'live' | 'archive') => {
    setMode(next);
    setOffset(0);
    setSearch('');
    setArchiveNotice(null);
    setArchiveError(null);
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
              <Input
                placeholder="搜索 action / 对象 / 用户"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            }
          >
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
