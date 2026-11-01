import { useState } from 'react';
import { api } from '../api';
import { clearAuth } from '../auth';
import { useLoad } from '../hooks';
import type { UserSession } from '../types';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Field,
  Input,
  Notice,
  PageHeader,
  Spinner,
  Stat,
} from '../ui';
import { fmtDateTime } from '../utils';

const statusOf = (s: UserSession) => {
  if (s.revoked_at) return { label: '已撤销', tone: 'red' as const };
  if (!s.active) return { label: '已过期', tone: 'gray' as const };
  if (s.current) return { label: '当前会话', tone: 'green' as const };
  return { label: '活跃', tone: 'blue' as const };
};

export function SessionsPage() {
  const { data, error, loading, reload } = useLoad(() => api.listMySessions(), []);
  const [busy, setBusy] = useState(false);
  const [opError, setOpError] = useState<unknown>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwError, setPwError] = useState<unknown>(null);
  const [pwNotice, setPwNotice] = useState<string | null>(null);
  const [pwBusy, setPwBusy] = useState(false);

  const items = data?.items ?? [];
  const active = items.filter((s) => s.active);

  const revoke = async (s: UserSession) => {
    if (!window.confirm('撤销该会话后，对应设备需要重新登录。确认继续？')) return;
    setBusy(true);
    setOpError(null);
    try {
      await api.revokeMySession(s.id);
      await reload();
    } catch (err) {
      setOpError(err);
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async () => {
    setPwError(null);
    setPwNotice(null);
    if (newPassword.length < 10) {
      setPwError(new Error('新密码至少 10 位'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwError(new Error('两次输入的新密码不一致'));
      return;
    }
    setPwBusy(true);
    try {
      const res = await api.changePassword(currentPassword, newPassword);
      setPwNotice(`密码已修改，已撤销其他 ${res.revoked_others} 个会话。`);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      await reload();
    } catch (err) {
      setPwError(err);
    } finally {
      setPwBusy(false);
    }
  };

  const logoutAll = async () => {
    if (!window.confirm('将退出所有设备（包括当前会话），确认继续？')) return;
    setBusy(true);
    setOpError(null);
    try {
      await api.logoutAll();
      clearAuth();
      window.location.hash = '#/login';
      window.location.reload();
    } catch (err) {
      setOpError(err);
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="账号安全"
        title="登录会话"
        subtitle="每台设备一个会话；撤销后对应 token 立即失效，最长有效期 8 小时。"
        actions={
          <>
            <Button onClick={() => void reload()} disabled={loading}>刷新</Button>
            <Button variant="danger" disabled={busy} onClick={() => void logoutAll()}>
              全部退出
            </Button>
          </>
        }
      />

      {loading && !data ? <Spinner /> : null}
      {error && !data ? <ErrorBox error={error} onRetry={() => void reload()} /> : null}
      {opError ? <ErrorBox error={opError} /> : null}

      {data ? (
        <>
          <div className="stat-grid">
            <Stat label="会话总数" value={items.length} hint="最近 50 条" tone="brand" />
            <Stat label="活跃会话" value={active.length} tone="green" />
            <Stat
              label="当前会话"
              value={items.find((s) => s.current) ? 1 : 0}
              tone="blue"
            />
          </div>

          <Card
            title="设备与会话"
            subtitle="撤销当前会话会立即退出；过期会话不可恢复。"
          >
            {items.length === 0 ? (
              <Empty title="没有会话记录" hint="重新登录后会生成新会话。" />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>状态</th><th>登录时间</th><th>最近活动</th><th>到期</th>
                      <th>IP</th><th>设备</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((s) => {
                      const status = statusOf(s);
                      return (
                        <tr key={s.id}>
                          <td><Badge tone={status.tone}>{status.label}</Badge></td>
                          <td className="muted nowrap">{fmtDateTime(s.created_at)}</td>
                          <td className="muted nowrap">{fmtDateTime(s.last_seen_at)}</td>
                          <td className="muted nowrap">{fmtDateTime(s.expires_at)}</td>
                          <td className="mono muted">{s.ip ?? '—'}</td>
                          <td className="muted small">{s.user_agent || '—'}</td>
                          <td className="actions-cell">
                            <Button
                              size="sm"
                              variant="danger"
                              disabled={busy || !s.active || s.current}
                              onClick={() => void revoke(s)}
                            >
                              {s.current ? '当前会话' : '撤销'}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card
            title="修改密码"
            subtitle="修改后保留当前会话，撤销其他设备；下次登录使用新密码。"
          >
            {pwError ? <ErrorBox error={pwError} /> : null}
            {pwNotice ? <Notice tone="green">{pwNotice}</Notice> : null}
            <div className="form-grid">
              <Field label="当前密码" required>
                <Input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                />
              </Field>
              <Field label="新密码" required hint="至少 10 位，含大小写/数字/符号中的 3 类">
                <Input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </Field>
              <Field label="确认新密码" required>
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </Field>
            </div>
            <div className="form-actions">
              <Button
                variant="primary"
                disabled={pwBusy || !currentPassword || !newPassword}
                onClick={() => void changePassword()}
              >
                {pwBusy ? '修改中…' : '修改密码'}
              </Button>
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}
