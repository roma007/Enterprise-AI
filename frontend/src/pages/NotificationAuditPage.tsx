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
  PageHeader,
  Select,
  Spinner,
} from '../ui';
import { fmtDateTime } from '../utils';

const ACTION_LABEL: Record<string, string> = {
  'DELETE copilot-notification': '删除',
  'RESTORE copilot-notification': '恢复',
  'PURGE copilot-notification': '彻底删除',
};

const ACTION_TONE: Record<string, 'red' | 'blue' | 'gray'> = {
  'DELETE copilot-notification': 'red',
  'RESTORE copilot-notification': 'blue',
  'PURGE copilot-notification': 'gray',
};

const AUDIT_KEYS = {
  action: 'notif_audit_action',
  from: 'notif_audit_from',
  to: 'notif_audit_to',
  offset: 'notif_audit_offset',
  actor: 'notif_audit_actor',
} as const;

interface AuditUrlState {
  action: string;
  from: string;
  to: string;
  offset: number;
  actor: string;
}

function readAuditState(): AuditUrlState {
  if (typeof window === 'undefined') {
    return { action: '', from: '', to: '', offset: 0, actor: '' };
  }
  const params = new URLSearchParams(window.location.search);
  const rawOffset = Number(params.get(AUDIT_KEYS.offset) ?? '0');
  return {
    action: params.get(AUDIT_KEYS.action) ?? '',
    from: params.get(AUDIT_KEYS.from) ?? '',
    to: params.get(AUDIT_KEYS.to) ?? '',
    offset:
      Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0,
    actor: params.get(AUDIT_KEYS.actor) ?? '',
  };
}

function writeAuditState(state: AuditUrlState) {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  const entries: Array<[string, string]> = [
    [AUDIT_KEYS.action, state.action],
    [AUDIT_KEYS.from, state.from],
    [AUDIT_KEYS.to, state.to],
    [AUDIT_KEYS.offset, state.offset > 0 ? String(state.offset) : ''],
    [AUDIT_KEYS.actor, state.actor],
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

export function NotificationAuditPage() {
  const initial = useMemo(() => readAuditState(), []);
  const [limit] = useState(20);
  const [offset, setOffset] = useState(initial.offset);
  const [action, setAction] = useState(initial.action);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [actorId, setActorId] = useState(initial.actor);
  const [exporting, setExporting] = useState(false);
  const [opError, setOpError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const users = useLoad(() => api.listUsers(), []);
  const rangeError =
    from && to && from > to ? '开始日期不能晚于结束日期' : '';
  const { data, error, loading, reload } = useLoad(
    () =>
      rangeError
        ? Promise.resolve({ items: [], total: 0, limit, offset })
        : api.listNotificationAudits({
            action: action || undefined,
            from: from || undefined,
            to: to || undefined,
            actor_id: actorId || undefined,
            limit,
            offset,
          }),
    [action, from, to, actorId, limit, offset, rangeError],
  );
  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  useEffect(() => {
    writeAuditState({ action, from, to, offset, actor: actorId });
  }, [action, from, to, offset, actorId]);

  const exportAudits = async () => {
    setExporting(true);
    setOpError(null);
    setNotice(null);
    try {
      const blob = await api.exportNotificationAuditsCsv({
        action: action || undefined,
        from: from || undefined,
        to: to || undefined,
        actor_id: actorId || undefined,
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'notification-audits.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setNotice('通知审计已导出 CSV。');
    } catch (err) {
      setOpError(err);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="通知审计"
        subtitle="通知删除、恢复与彻底删除记录。"
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
      <Card title={data ? `共 ${total} 条` : '通知审计'}>
        <div className="row" style={{ marginBottom: 8 }}>
          <Select
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setOffset(0);
            }}
            style={{ maxWidth: 180 }}
          >
            <option value="">全部操作</option>
            <option value="DELETE copilot-notification">删除</option>
            <option value="RESTORE copilot-notification">恢复</option>
            <option value="PURGE copilot-notification">彻底删除</option>
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
              setAction('');
              setFrom('');
              setTo('');
              setActorId('');
              setOffset(0);
            }}
          >
            清空筛选
          </Button>
          {rangeError ? (
            <span style={{ color: '#b42318' }}>{rangeError}</span>
          ) : null}
        </div>
        {opError ? <ErrorBox error={opError} /> : null}
        {notice ? <p className="hint">{notice}</p> : null}
        {loading ? (
          <Spinner />
        ) : error ? (
          <ErrorBox error={error} />
        ) : items.length === 0 ? (
          <Empty title="暂无通知审计" hint="删除、恢复或彻底删除通知后会记录在这里。" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>时间</th><th>操作</th><th>操作人</th><th>数量</th>
                  <th>模式</th><th>详情</th>
                </tr>
              </thead>
              <tbody>
                {items.map((a) => {
                  const detail = a.detail ?? {};
                  const filters = detail.filters ?? {};
                  const filterText = [
                    filters.unread ? '仅未读' : '',
                    filters.kind ? `类型 ${filters.kind}` : '',
                    filters.from ? `从 ${filters.from}` : '',
                    filters.to ? `到 ${filters.to}` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <tr key={a.id}>
                      <td className="muted">{fmtDateTime(a.created_at)}</td>
                      <td>
                        <Badge tone={ACTION_TONE[a.action] ?? 'gray'}>
                          {ACTION_LABEL[a.action] ?? a.action}
                        </Badge>
                      </td>
                      <td>{a.actor_name || '系统'}</td>
                      <td>{detail.count ?? '—'}</td>
                      <td>{detail.mode === 'all' ? '按筛选' : '按 ID'}</td>
                      <td className="muted">
                        {filterText || (Array.isArray(detail.ids) ? `${detail.ids.length} 个 ID` : '—')}
                      </td>
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
      </Card>
    </div>
  );
}
