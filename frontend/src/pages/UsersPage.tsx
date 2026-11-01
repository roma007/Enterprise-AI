import { useState } from 'react';
import { api } from '../api';
import { useLoad } from '../hooks';
import type { AdminUser } from '../types';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Stat,
} from '../ui';
import { fmtDate, fmtDateTime } from '../utils';

const ROLE_LABEL: Record<string, string> = {
  admin: '管理员',
  director: '总监',
  pm: '项目经理',
  consultant: '顾问',
  tech_lead: '技术负责人',
};

const STATUS_LABEL: Record<string, string> = {
  active: '启用',
  disabled: '已禁用',
};

export function UsersPage() {
  const { data, error, loading, reload } = useLoad(() => api.listAdminUsers(), []);
  const [createOpen, setCreateOpen] = useState(false);
  const [editUser, setEditUser] = useState<AdminUser | null>(null);
  const [resetUser, setResetUser] = useState<AdminUser | null>(null);
  const [formError, setFormError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [create, setCreate] = useState({
    name: '',
    email: '',
    role: 'consultant',
    password: '',
  });
  const [edit, setEdit] = useState({ name: '', role: 'consultant', status: 'active' });
  const [newPassword, setNewPassword] = useState('');

  const items = data?.items ?? [];
  const active = items.filter((u) => u.status === 'active').length;
  const admins = items.filter((u) => u.role === 'admin' && u.status === 'active').length;

  const openEdit = (u: AdminUser) => {
    setFormError(null);
    setEdit({ name: u.name, role: u.role, status: u.status });
    setEditUser(u);
  };

  const submitCreate = async () => {
    setSaving(true);
    setFormError(null);
    setNotice(null);
    try {
      if (!create.name.trim() || !create.email.trim()) throw new Error('姓名和邮箱必填');
      await api.createAdminUser({
        name: create.name.trim(),
        email: create.email.trim(),
        role: create.role,
        password: create.password,
      });
      setCreateOpen(false);
      setCreate({ name: '', email: '', role: 'consultant', password: '' });
      setNotice('用户已创建。');
      await reload();
    } catch (err) {
      setFormError(err);
    } finally {
      setSaving(false);
    }
  };

  const submitEdit = async () => {
    if (!editUser) return;
    setSaving(true);
    setFormError(null);
    setNotice(null);
    try {
      await api.updateAdminUser(editUser.id, {
        name: edit.name.trim(),
        role: edit.role,
        status: edit.status,
      });
      setEditUser(null);
      setNotice('用户信息已更新。');
      await reload();
    } catch (err) {
      setFormError(err);
    } finally {
      setSaving(false);
    }
  };

  const submitReset = async () => {
    if (!resetUser) return;
    setSaving(true);
    setFormError(null);
    setNotice(null);
    try {
      const res = await api.resetAdminPassword(resetUser.id, newPassword);
      setResetUser(null);
      setNewPassword('');
      setNotice(`密码已重置，已撤销 ${res.revoked} 个会话。`);
      await reload();
    } catch (err) {
      setFormError(err);
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (u: AdminUser) => {
    if (u.status === 'active' && !window.confirm(`禁用「${u.name}」后其所有会话立即失效，确认继续？`)) {
      return;
    }
    setFormError(null);
    setNotice(null);
    try {
      await api.updateAdminUser(u.id, {
        status: u.status === 'active' ? 'disabled' : 'active',
      });
      setNotice(u.status === 'active' ? '用户已禁用。' : '用户已启用。');
      await reload();
    } catch (err) {
      setFormError(err);
    }
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="组织管理"
        title="用户管理"
        subtitle="管理员/总监可创建账号、调整角色、重置密码、禁用用户。"
        actions={
          <>
            <Button onClick={() => void reload()} disabled={loading}>刷新</Button>
            <Button variant="primary" onClick={() => { setFormError(null); setCreateOpen(true); }}>
              + 新建用户
            </Button>
          </>
        }
      />

      {loading && !data ? <Spinner /> : null}
      {error && !data ? <ErrorBox error={error} onRetry={() => void reload()} /> : null}
      {formError ? <ErrorBox error={formError} /> : null}
      {notice ? <div className="notice notice-green">{notice}</div> : null}

      {data ? (
        <>
          <div className="stat-grid">
            <Stat label="用户总数" value={items.length} tone="brand" />
            <Stat label="启用" value={active} tone="green" />
            <Stat label="管理员" value={admins} tone="blue" />
            <Stat label="已禁用" value={items.length - active} tone="amber" />
          </div>

          <Card title="组织用户" subtitle="角色决定操作权限；禁用会立即撤销该用户全部会话。">
            {items.length === 0 ? (
              <Empty title="还没有用户" />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>姓名</th><th>邮箱</th><th>角色</th><th>状态</th>
                      <th>最近登录</th><th>活跃会话</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((u) => (
                      <tr key={u.id}>
                        <td><strong>{u.name}</strong></td>
                        <td className="muted">{u.email}</td>
                        <td><Badge tone={u.role === 'admin' ? 'blue' : 'gray'}>{ROLE_LABEL[u.role] ?? u.role}</Badge></td>
                        <td><Badge tone={u.status === 'active' ? 'green' : 'red'}>{STATUS_LABEL[u.status] ?? u.status}</Badge></td>
                        <td className="muted">{u.last_login_at ? fmtDateTime(u.last_login_at) : '—'}</td>
                        <td>{u.active_sessions}</td>
                        <td className="actions-cell">
                          <Button size="sm" onClick={() => openEdit(u)}>编辑</Button>
                          <Button
                            size="sm"
                            onClick={() => { setFormError(null); setNewPassword(''); setResetUser(u); }}
                          >
                            重置密码
                          </Button>
                          <Button
                            size="sm"
                            variant={u.status === 'active' ? 'danger' : 'secondary'}
                            onClick={() => void toggleStatus(u)}
                          >
                            {u.status === 'active' ? '禁用' : '启用'}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      ) : null}

      <Modal
        open={createOpen}
        title="新建用户"
        subtitle="密码至少 8 位；首次登录后建议重置。"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button onClick={() => setCreateOpen(false)}>取消</Button>
            <Button variant="primary" disabled={saving} onClick={() => void submitCreate()}>
              {saving ? '创建中…' : '创建用户'}
            </Button>
          </>
        }
      >
        <div className="form-grid">
          <Field label="姓名" required><Input value={create.name} onChange={(e) => setCreate({ ...create, name: e.target.value })} /></Field>
          <Field label="邮箱" required><Input type="email" value={create.email} onChange={(e) => setCreate({ ...create, email: e.target.value })} /></Field>
          <Field label="角色">
            <Select value={create.role} onChange={(e) => setCreate({ ...create, role: e.target.value })}>
              {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="初始密码" required hint="至少 10 位，含 3 类字符"><Input type="password" value={create.password} onChange={(e) => setCreate({ ...create, password: e.target.value })} /></Field>
        </div>
      </Modal>

      <Modal
        open={!!editUser}
        title={`编辑用户 · ${editUser?.name ?? ''}`}
        onClose={() => setEditUser(null)}
        footer={
          <>
            <Button onClick={() => setEditUser(null)}>取消</Button>
            <Button variant="primary" disabled={saving} onClick={() => void submitEdit()}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </>
        }
      >
        <div className="form-grid">
          <Field label="姓名"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="角色">
            <Select value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })}>
              {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="状态">
            <Select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>
              {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
        </div>
      </Modal>

      <Modal
        open={!!resetUser}
        title={`重置密码 · ${resetUser?.name ?? ''}`}
        subtitle="重置后该用户所有会话立即失效，需要用新密码重新登录。"
        onClose={() => setResetUser(null)}
        footer={
          <>
            <Button onClick={() => setResetUser(null)}>取消</Button>
            <Button variant="primary" disabled={saving} onClick={() => void submitReset()}>
              {saving ? '重置中…' : '确认重置'}
            </Button>
          </>
        }
      >
        <Field label="新密码" required>
          <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="至少 10 位，含 3 类字符" />
        </Field>
      </Modal>
    </div>
  );
}
