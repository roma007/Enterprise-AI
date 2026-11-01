import { useState } from 'react';
import { api } from '../../api';
import { useLoad } from '../../hooks';
import type { EngagementMember, User } from '../../types';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Field,
  Notice,
  Select,
  Spinner,
  Stat,
} from '../../ui';
import { fmtDate } from '../../utils';

const ROLE_LABEL: Record<string, string> = {
  manager: '项目负责人',
  member: '项目成员',
  viewer: '只读成员',
};

const roleTone = (role: string) =>
  role === 'manager' ? 'green' : role === 'viewer' ? 'gray' : 'blue';

export function MembersTab({ engagementId }: { engagementId: string }) {
  const { data, error, loading, reload } = useLoad(
    async () => {
      const [m, u] = await Promise.all([
        api.listMembers(engagementId),
        api.listUsers(),
      ]);
      return { members: m.items, canManage: m.canManage, users: u.items };
    },
    [engagementId],
  );
  const [role, setRole] = useState('member');
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [opError, setOpError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const members = data?.members ?? [];
  const users: User[] = data?.users ?? [];
  const canManage = data?.canManage ?? false;
  const available = users.filter((u) => !members.some((m) => m.user_id === u.id));

  const run = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setOpError(null);
    setNotice(null);
    try {
      await fn();
      await reload();
      setNotice(message);
    } catch (err) {
      setOpError(err);
    } finally {
      setBusy(false);
    }
  };

  const add = () => {
    if (!userId) {
      setOpError(new Error('请选择要添加的成员'));
      return;
    }
    void run(async () => {
      await api.addMember(engagementId, { user_id: userId, role });
      setUserId('');
    }, '成员已添加。');
  };

  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorBox error={error} onRetry={() => void reload()} />;

  return (
    <div className="tab-body">
      <Card
        title="项目成员"
        subtitle="项目一旦配置成员，只有成员、管理员/总监可以访问；项目经理可管理成员。"
      >
        {opError ? <ErrorBox error={opError} /> : null}
        {notice ? <div className="notice notice-green">{notice}</div> : null}
        <div className="stat-grid">
          <Stat label="成员" value={members.length} hint="含负责人" tone="brand" />
          <Stat label="负责人" value={members.filter((m) => m.role === 'manager').length} tone="green" />
          <Stat label="只读" value={members.filter((m) => m.role === 'viewer').length} tone="amber" />
        </div>

        {!members.length ? (
          <Notice tone="blue">
            当前项目尚未配置成员，组织内成员都可以访问。添加第一名成员后，访问将收口到成员名单。
          </Notice>
        ) : null}

        {members.length === 0 ? (
          <Empty title="还没有项目成员" hint="把项目经理、顾问、客户成功加入项目。" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>姓名</th><th>邮箱</th><th>角色</th><th>加入时间</th><th /></tr>
              </thead>
              <tbody>
                {members.map((m: EngagementMember) => (
                  <tr key={m.id}>
                    <td><strong>{m.name}</strong></td>
                    <td className="muted">{m.email}</td>
                    <td>
                      {canManage ? (
                        <Select
                          value={m.role}
                          disabled={busy}
                          onChange={(e) =>
                            void run(
                              () => api.updateMember(m.id, { role: e.target.value }),
                              '成员角色已更新。',
                            )
                          }
                        >
                          {Object.entries(ROLE_LABEL).map(([k, v]) => (
                            <option key={k} value={k}>{v}</option>
                          ))}
                        </Select>
                      ) : (
                        <Badge tone={roleTone(m.role)}>{ROLE_LABEL[m.role] ?? m.role}</Badge>
                      )}
                    </td>
                    <td className="muted">{fmtDate(m.created_at)}</td>
                    <td className="actions-cell">
                      {canManage ? (
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busy}
                          onClick={() =>
                            void run(() => api.removeMember(m.id), '成员已移除。')
                          }
                        >
                          移除
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {canManage ? (
          <>
            <div className="form-grid">
              <Field label="添加成员">
                <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
                  <option value="">请选择用户</option>
                  {available.map((u) => (
                    <option key={u.id} value={u.id}>{u.name} · {u.email}</option>
                  ))}
                </Select>
              </Field>
              <Field label="角色">
                <Select value={role} onChange={(e) => setRole(e.target.value)}>
                  {Object.entries(ROLE_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="form-actions">
              <Button size="sm" variant="primary" disabled={busy} onClick={add}>
                添加成员
              </Button>
            </div>
            <p className="hint-line">
              负责人可写并管理成员；成员可写；只读成员只能查看。项目至少保留一名负责人。
            </p>
          </>
        ) : null}
      </Card>
    </div>
  );
}
