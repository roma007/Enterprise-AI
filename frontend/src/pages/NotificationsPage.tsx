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

const KIND_LABEL: Record<string, string> = {
  copilot_batch_filter_view_shared: '视图共享',
  copilot_reconcile_report_stale: '报告过期',
};

const NOTIF_KEYS = {
  kind: 'notif_kind',
  unread: 'notif_unread',
  offset: 'notif_offset',
  from: 'notif_from',
  to: 'notif_to',
  view: 'notif_view',
} as const;

interface NotifUrlState {
  kind: string;
  unread: boolean;
  offset: number;
  from: string;
  to: string;
  view: 'inbox' | 'trash';
}

function readNotifState(): NotifUrlState {
  if (typeof window === 'undefined') {
    return { kind: '', unread: false, offset: 0, from: '', to: '', view: 'inbox' };
  }
  const params = new URLSearchParams(window.location.search);
  const rawOffset = Number(params.get(NOTIF_KEYS.offset) ?? '0');
  return {
    kind: params.get(NOTIF_KEYS.kind) ?? '',
    unread: params.get(NOTIF_KEYS.unread) === '1',
    offset:
      Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0,
    from: params.get(NOTIF_KEYS.from) ?? '',
    to: params.get(NOTIF_KEYS.to) ?? '',
    view: params.get(NOTIF_KEYS.view) === 'trash' ? 'trash' : 'inbox',
  };
}

function writeNotifState(state: NotifUrlState) {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  const entries: Array<[string, string]> = [
    [NOTIF_KEYS.kind, state.kind],
    [NOTIF_KEYS.unread, state.unread ? '1' : ''],
    [NOTIF_KEYS.offset, state.offset > 0 ? String(state.offset) : ''],
    [NOTIF_KEYS.from, state.from],
    [NOTIF_KEYS.to, state.to],
    [NOTIF_KEYS.view, state.view === 'trash' ? 'trash' : ''],
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

export function NotificationsPage() {
  const initial = useMemo(() => readNotifState(), []);
  const [limit] = useState(10);
  const [offset, setOffset] = useState(initial.offset);
  const [unreadOnly, setUnreadOnly] = useState(initial.unread);
  const [kind, setKind] = useState(initial.kind);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [view, setView] = useState<'inbox' | 'trash'>(initial.view);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectAll, setSelectAll] = useState(false);
  const rangeError =
    from && to && from > to ? '开始日期不能晚于结束日期' : '';
  const { data, error, loading, reload } = useLoad(
    () =>
      rangeError
        ? Promise.resolve({
            items: [],
            total: 0,
            unread_count: 0,
            kinds: [],
            trash_retention_days: 0,
            limit,
            offset,
          })
        : api.listNotifications({
            unread: view === 'inbox' ? unreadOnly : false,
            kind,
            from,
            to,
            trash: view === 'trash',
            limit,
            offset,
          }),
    [view, unreadOnly, kind, from, to, limit, offset, rangeError],
  );
  const [busy, setBusy] = useState(false);
  const [opError, setOpError] = useState<unknown>(null);

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = offset + items.length;
  const allPageSelected =
    !selectAll && items.length > 0 && items.every((n) => selected.has(n.id));
  const selectedCount = selectAll ? total : selected.size;

  useEffect(() => {
    writeNotifState({ kind, unread: unreadOnly, offset, from, to, view });
  }, [kind, unreadOnly, offset, from, to, view]);

  useEffect(() => {
    setSelected(new Set());
    setSelectAll(false);
  }, [view, kind, unreadOnly, from, to]);

  const toggleOne = (id: string) => {
    if (selectAll) {
      setSelectAll(false);
      setSelected(new Set(items.filter((n) => n.id !== id).map((n) => n.id)));
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const togglePage = () => {
    if (selectAll || allPageSelected) {
      setSelectAll(false);
      setSelected(new Set());
      return;
    }
    setSelected(new Set(items.map((n) => n.id)));
  };

  const clearFilters = () => {
    setKind('');
    setUnreadOnly(false);
    setFrom('');
    setTo('');
    setOffset(0);
    setSelected(new Set());
    setSelectAll(false);
  };

  const switchView = (next: 'inbox' | 'trash') => {
    setView(next);
    setOffset(0);
    setSelected(new Set());
    setSelectAll(false);
    if (next === 'trash') setUnreadOnly(false);
  };

  const markRead = async (id: string) => {
    setBusy(true);
    setOpError(null);
    try {
      await api.markNotificationRead(id);
      await reload();
      window.dispatchEvent(new Event('notifications-updated'));
    } catch (err) {
      setOpError(err);
    } finally {
      setBusy(false);
    }
  };

  const markAll = async () => {
    setBusy(true);
    setOpError(null);
    try {
      await api.markAllNotificationsRead();
      await reload();
      window.dispatchEvent(new Event('notifications-updated'));
    } catch (err) {
      setOpError(err);
    } finally {
      setBusy(false);
    }
  };

  const restoreSelected = async (ids: string[]) => {
    if (!ids.length) return;
    setBusy(true);
    setOpError(null);
    try {
      await api.restoreNotifications(ids);
      setSelected(new Set());
      await reload();
      window.dispatchEvent(new Event('notifications-updated'));
    } catch (err) {
      setOpError(err);
    } finally {
      setBusy(false);
    }
  };

  const purgeSelected = async () => {
    if (!selected.size) return;
    if (!window.confirm(`彻底删除选中的 ${selected.size} 条通知？`)) return;
    setBusy(true);
    setOpError(null);
    try {
      await api.purgeNotifications([...selected]);
      setSelected(new Set());
      await reload();
    } catch (err) {
      setOpError(err);
    } finally {
      setBusy(false);
    }
  };

  const deleteSelected = async () => {
    if (!selectedCount) return;
    if (!window.confirm(`删除选中的 ${selectedCount} 条通知？`)) return;
    setBusy(true);
    setOpError(null);
    try {
      if (selectAll) {
        await api.deleteNotifications({
          all: true,
          unread: unreadOnly,
          kind: kind || undefined,
          from: from || undefined,
          to: to || undefined,
        });
      } else {
        await api.deleteNotifications({ ids: [...selected] });
      }
      setSelected(new Set());
      setSelectAll(false);
      if (offset > 0) setOffset(0);
      else await reload();
      window.dispatchEvent(new Event('notifications-updated'));
    } catch (err) {
      setOpError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader title="通知" subtitle="共享、协作与系统提醒。" />
      <Card
        title={
          data
            ? `${view === 'trash' ? '回收站' : '收件箱'} · 共 ${data.total} 条${
                view === 'inbox'
                  ? ` · 未读 ${data.unread_count} 条`
                  : data.trash_retention_days
                    ? ` · 保留 ${data.trash_retention_days} 天`
                    : ''
              }`
            : '通知'
        }
      >
        <div className="row" style={{ marginBottom: 8 }}>
          <Select
            value={view}
            onChange={(e) => switchView(e.target.value as 'inbox' | 'trash')}
            style={{ maxWidth: 140 }}
          >
            <option value="inbox">收件箱</option>
            <option value="trash">回收站</option>
          </Select>
          <Select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setOffset(0);
            }}
            style={{ maxWidth: 160 }}
          >
            <option value="">全部类型</option>
            {(data?.kinds ?? []).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k] ?? k}
              </option>
            ))}
          </Select>
          {view === 'inbox' ? (
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={unreadOnly}
                onChange={(e) => {
                  setUnreadOnly(e.target.checked);
                  setOffset(0);
                }}
              />
              <span>只看未读</span>
            </label>
          ) : null}
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
          <Button size="sm" onClick={clearFilters}>
            清空筛选
          </Button>
          {rangeError ? (
            <span style={{ color: '#b42318' }}>{rangeError}</span>
          ) : null}
        </div>
        <div className="row" style={{ marginBottom: 8 }}>
          {view === 'inbox' ? (
            <>
              <Button
                size="sm"
                disabled={busy || Boolean(rangeError) || total === 0 || selectAll}
                onClick={() => {
                  setSelected(new Set());
                  setSelectAll(true);
                }}
              >
                全选筛选结果（{total}）
              </Button>
              {selectAll ? (
                <Button size="sm" onClick={() => setSelectAll(false)}>
                  取消全选
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="danger"
                disabled={busy || Boolean(rangeError) || selectedCount === 0}
                onClick={() => void deleteSelected()}
              >
                删除选中（{selectedCount}）
              </Button>
              <Button
                size="sm"
                disabled={busy || (data?.unread_count ?? 0) === 0}
                onClick={() => void markAll()}
              >
                全部标为已读
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                disabled={busy || selected.size === 0}
                onClick={() => void restoreSelected([...selected])}
              >
                恢复选中（{selected.size}）
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy || selected.size === 0}
                onClick={() => void purgeSelected()}
              >
                彻底删除（{selected.size}）
              </Button>
            </>
          )}
        </div>
        {opError ? <ErrorBox error={opError} /> : null}
        {loading ? (
          <Spinner />
        ) : error ? (
          <ErrorBox error={error} />
        ) : items.length === 0 ? (
          <Empty title="暂无通知" hint="共享筛选视图等协作动作会出现在这里。" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="全选当前页"
                      checked={selectAll || allPageSelected}
                      onChange={togglePage}
                    />
                  </th>
                  <th>时间</th>
                  <th>内容</th>
                  <th>来源</th>
                  <th>状态</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((n) => (
                  <tr key={n.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`选择通知 ${n.id}`}
                        checked={selectAll || selected.has(n.id)}
                        onChange={() => toggleOne(n.id)}
                      />
                    </td>
                    <td className="muted">{fmtDateTime(n.created_at)}</td>
                    <td>
                      <strong>{n.title}</strong>{' '}
                      <Badge tone="gray">{KIND_LABEL[n.kind] ?? n.kind}</Badge>
                      {n.body ? <div className="muted">{n.body}</div> : null}
                    </td>
                    <td>{n.actor_name || '系统'}</td>
                    <td>
                      {n.deleted_at ? (
                        <Badge tone="gray">回收站</Badge>
                      ) : (
                        <Badge tone={n.read_at ? 'gray' : 'blue'}>
                          {n.read_at ? '已读' : '未读'}
                        </Badge>
                      )}
                    </td>
                    <td className="actions-cell">
                      {n.link ? (
                        <a className="link-btn" href={n.link} style={{ marginRight: 8 }}>
                          查看
                        </a>
                      ) : null}
                      {n.deleted_at ? (
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => void restoreSelected([n.id])}
                        >
                          恢复
                        </Button>
                      ) : !n.read_at ? (
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => void markRead(n.id)}
                        >
                          标为已读
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {items.length > 0 ? (
          <div className="row" style={{ marginTop: 8 }}>
            <span className="muted">
              第 {pageStart}–{pageEnd} 条 / 共 {total} 条
            </span>
            <Button
              size="sm"
              disabled={busy || offset === 0}
              onClick={() => setOffset(Math.max(0, offset - limit))}
            >
              上一页
            </Button>
            <Button
              size="sm"
              disabled={busy || offset + items.length >= total}
              onClick={() => setOffset(offset + limit)}
            >
              下一页
            </Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
