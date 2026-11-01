import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { useLoad } from '../../hooks';
import type {
  DeliveryIssue,
  DeliveryOverview,
  DeliveryPlan,
  DeliveryTask,
  GoLiveItem,
  Training,
  UatCase,
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
  Notice,
  Select,
  Spinner,
  Stat,
  Textarea,
} from '../../ui';
import { fmtDate, fmtDateTime } from '../../utils';

const PLAN_STATUS: Record<string, string> = {
  draft: '草稿',
  active: '执行中',
  completed: '已完成',
  on_hold: '暂停',
  cancelled: '已取消',
};

const TASK_STATUS: Record<string, string> = {
  todo: '待开始',
  doing: '进行中',
  done: '已完成',
  blocked: '受阻',
};

const UAT_STATUS: Record<string, string> = {
  pending: '待执行',
  passed: '通过',
  failed: '失败',
  blocked: '阻塞',
  skipped: '跳过',
};

const GO_LIVE_STATUS: Record<string, string> = {
  pending: '待检查',
  passed: '通过',
  failed: '未通过',
  waived: '豁免',
};

const TRAINING_STATUS: Record<string, string> = {
  planned: '计划中',
  done: '已完成',
  cancelled: '已取消',
};

const ISSUE_STATUS: Record<string, string> = {
  open: '待处理',
  in_progress: '处理中',
  resolved: '已解决',
  closed: '已关闭',
  rejected: '已拒绝',
};

const APPROVAL_STATUS: Record<string, string> = {
  not_required: '无需审批',
  pending: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
};

const toneOf = (status: string) =>
  ['passed', 'done', 'completed', 'closed', 'approved', 'resolved'].includes(status)
    ? 'green'
    : ['failed', 'rejected', 'blocked'].includes(status)
      ? 'red'
      : ['doing', 'in_progress', 'active', 'pending', 'planned', 'on_hold'].includes(status)
        ? 'amber'
        : 'gray';

type DeliveryDocKind = 'plan' | 'uat' | 'go_live' | 'training';

const DOC_LABEL: Record<DeliveryDocKind, string> = {
  plan: '实施计划',
  uat: 'UAT 报告',
  go_live: '上线检查表',
  training: '培训材料',
};

export function DeliveryTab({
  engagementId,
  onChanged,
  onGoReports,
}: {
  engagementId: string;
  onChanged: () => void;
  onGoReports: () => void;
}) {
  const { data, error, loading, reload } = useLoad(
    async () => {
      const [o, u] = await Promise.all([api.deliveryOverview(engagementId), api.listUsers()]);
      return { overview: o, users: u.items };
    },
    [engagementId],
  );
  const g4 = useLoad(() => api.g4Checks(engagementId), [engagementId]);
  const [docType, setDocType] = useState<DeliveryDocKind>('plan');
  const [docNotice, setDocNotice] = useState<string | null>(null);
  const [docBusy, setDocBusy] = useState(false);
  const [docError, setDocError] = useState<unknown>(null);

  const generateDoc = async () => {
    setDocBusy(true);
    setDocError(null);
    try {
      const res = await api.generateDeliveryDocument(engagementId, docType);
      setDocNotice(`已生成《${res.item.title}》v${res.item.version}`);
    } catch (err) {
      setDocError(err);
    } finally {
      setDocBusy(false);
    }
  };

  const downloadDoc = async () => {
    setDocBusy(true);
    setDocError(null);
    try {
      const blob = await api.exportDeliveryDocx(engagementId, docType);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${DOC_LABEL[docType]}.docx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setDocError(err);
    } finally {
      setDocBusy(false);
    }
  };

  const after = async () => {
    await reload();
    g4.reload();
    onChanged();
  };

  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorBox error={error} onRetry={() => void reload()} />;
  if (!data) return null;

  const { overview, users } = data;
  const plan = overview.activePlan;

  return (
    <div className="tab-body">
      <Card
        title="G4 交付门禁"
        subtitle="实施计划 → 任务/里程碑 → UAT 验收 → 上线检查 → 培训 → 问题/变更。"
        actions={
          <Button size="sm" disabled={g4.loading} onClick={() => void g4.reload()}>
            刷新校验
          </Button>
        }
      >
        {g4.loading ? <Spinner label="校验中…" /> : null}
        {g4.error ? <ErrorBox error={g4.error} onRetry={() => void g4.reload()} /> : null}
        {g4.data ? (
          <>
            <div className="check-summary">
              <span className="check-pill check-pass">{g4.data.summary.pass} pass</span>
              <span className="check-pill check-warn">{g4.data.summary.warn} warn</span>
              <span className="check-pill check-block">{g4.data.summary.block} block</span>
            </div>
            <div className="check-list">
              {g4.data.checks.map((c) => (
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

      <Card
        title="交付文档"
        subtitle="实施计划 / UAT 报告 / 上线检查表 / 培训材料，生成后可在报告页导出 Word。"
        actions={
          <div className="generate-bar">
            <Select value={docType} onChange={(e) => setDocType(e.target.value as DeliveryDocKind)}>
              {Object.entries(DOC_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
            <Button size="sm" variant="primary" disabled={docBusy} onClick={() => void generateDoc()}>
              生成文档
            </Button>
            <Button size="sm" disabled={docBusy} onClick={() => void downloadDoc()}>
              导出 Word
            </Button>
          </div>
        }
      >
        {docError ? <ErrorBox error={docError} /> : null}
        {docNotice ? (
          <div className="notice notice-green">
            {docNotice}{' '}
            <button className="link-btn" onClick={onGoReports}>去报告页查看 →</button>
          </div>
        ) : (
          <p className="hint-line">
            文档按项目内对应类型自动版本化；UAT 报告或上线检查表需在「确认与签收」完成客户签收后，G4-11 才放行。
          </p>
        )}
      </Card>

      {!plan ? (
        <CreatePlanForm
          engagementId={engagementId}
          users={users}
          onCreated={() => void after()}
        />
      ) : (
        <PlanSection
          plan={plan}
          tasks={overview.tasks}
          users={users}
          overview={overview}
          onChanged={after}
        />
      )}

      <UatSection
        engagementId={engagementId}
        cases={overview.uat}
        criteria={overview.criteria}
        users={users}
        onChanged={after}
      />

      <GoLiveSection
        engagementId={engagementId}
        items={overview.goLive}
        users={users}
        onChanged={after}
      />

      <TrainingSection
        engagementId={engagementId}
        trainings={overview.trainings}
        users={users}
        onChanged={after}
      />

      <IssueSection
        engagementId={engagementId}
        issues={overview.issues}
        users={users}
        onChanged={after}
      />
    </div>
  );
}

function useOps(onChanged: () => Promise<void> | void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const runOp = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, runOp, setError };
}

function CreatePlanForm({
  engagementId,
  users,
  onCreated,
}: {
  engagementId: string;
  users: User[];
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    name: '一期实施计划',
    start_date: '',
    end_date: '',
    status: 'active',
    owner: '',
    notes: '',
  });
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (!form.name.trim() || !form.start_date || !form.end_date) {
        throw new Error('计划名称、开始与结束日期必填');
      }
      await api.createDeliveryPlan(engagementId, {
        ...form,
        owner: form.owner || undefined,
      });
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="创建实施计划" subtitle="先把范围、周期和负责人定下来，再拆任务与里程碑。">
      {error ? <ErrorBox error={error} /> : null}
      <div className="form-grid">
        <Field label="计划名称" required className="span-2">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="开始日期" required>
          <Input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
        </Field>
        <Field label="结束日期" required>
          <Input type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} />
        </Field>
        <Field label="状态">
          <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            {Object.entries(PLAN_STATUS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </Select>
        </Field>
        <Field label="负责人">
          <Select value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })}>
            <option value="">未指定</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="说明" className="span-2">
          <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
      </div>
      <div className="form-actions">
        <Button variant="primary" disabled={saving} onClick={() => void save()}>
          {saving ? '创建中…' : '创建计划'}
        </Button>
      </div>
    </Card>
  );
}

function PlanSection({
  plan,
  tasks,
  users,
  overview,
  onChanged,
}: {
  plan: DeliveryPlan;
  tasks: DeliveryTask[];
  users: User[];
  overview: DeliveryOverview;
  onChanged: () => Promise<void> | void;
}) {
  const { busy, error, runOp } = useOps(onChanged);
  const [basic, setBasic] = useState({
    name: plan.name,
    start_date: plan.start_date,
    end_date: plan.end_date,
    status: plan.status,
    owner: plan.owner ?? '',
    notes: plan.notes ?? '',
  });
  const [task, setTask] = useState({
    phase: '',
    name: '',
    owner: '',
    start_date: '',
    end_date: '',
    status: 'todo',
    is_milestone: false,
  });

  useEffect(() => {
    setBasic({
      name: plan.name,
      start_date: plan.start_date,
      end_date: plan.end_date,
      status: plan.status,
      owner: plan.owner ?? '',
      notes: plan.notes ?? '',
    });
  }, [plan]);

  const done = tasks.filter((t) => t.status === 'done').length;
  const uatPass = overview.uat.filter((u) => u.status === 'passed').length;

  const saveBasic = () =>
    runOp(() =>
      api.updateDeliveryPlan(plan.id, {
        ...basic,
        status: basic.status as DeliveryPlan['status'],
        owner: basic.owner || null,
      }),
    );

  const addTask = () =>
    runOp(async () => {
      if (!task.phase.trim() || !task.name.trim()) throw new Error('阶段与任务名称必填');
      await api.createDeliveryTask(plan.id, {
        ...task,
        owner: task.owner || undefined,
        start_date: task.start_date || undefined,
        end_date: task.end_date || undefined,
        sort_order: tasks.length + 1,
      });
      setTask({ phase: '', name: '', owner: '', start_date: '', end_date: '', status: 'todo', is_milestone: false });
    });

  return (
    <>
      <Card
        title={`实施计划 v${plan.version} · ${plan.name}`}
        subtitle={`${plan.start_date} → ${plan.end_date}`}
        actions={<Badge tone={toneOf(plan.status)}>{PLAN_STATUS[plan.status] ?? plan.status}</Badge>}
      >
        {error ? <ErrorBox error={error} /> : null}
        <div className="stat-grid">
          <Stat label="任务" value={tasks.length} hint={`${done} 个已完成`} />
          <Stat label="里程碑" value={tasks.filter((t) => t.is_milestone).length} tone="blue" />
          <Stat label="UAT 通过" value={`${uatPass}/${overview.uat.length}`} tone="green" />
          <Stat
            label="遗留问题"
            value={overview.issues.filter((i) => !['closed', 'rejected', 'resolved'].includes(i.status)).length}
            tone="amber"
          />
        </div>
        <div className="form-grid">
          <Field label="计划名称" className="span-2">
            <Input value={basic.name} onChange={(e) => setBasic({ ...basic, name: e.target.value })} />
          </Field>
          <Field label="开始日期">
            <Input type="date" value={basic.start_date} onChange={(e) => setBasic({ ...basic, start_date: e.target.value })} />
          </Field>
          <Field label="结束日期">
            <Input type="date" value={basic.end_date} onChange={(e) => setBasic({ ...basic, end_date: e.target.value })} />
          </Field>
          <Field label="状态">
            <Select value={basic.status} onChange={(e) => setBasic({ ...basic, status: e.target.value as DeliveryPlan['status'] })}>
              {Object.entries(PLAN_STATUS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </Field>
          <Field label="负责人">
            <Select value={basic.owner} onChange={(e) => setBasic({ ...basic, owner: e.target.value })}>
              <option value="">未指定</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="说明" className="span-2">
            <Textarea rows={2} value={basic.notes} onChange={(e) => setBasic({ ...basic, notes: e.target.value })} />
          </Field>
        </div>
        <div className="form-actions">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void saveBasic()}>
            保存计划
          </Button>
        </div>
      </Card>

      <Card title="任务与里程碑" subtitle="每个任务必须有负责人与起止日期；上线节点标记为里程碑。">
        {tasks.length === 0 ? (
          <Empty title="还没有任务" hint="至少拆出准备、实施、上线三个阶段。" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>阶段</th><th>任务</th><th>负责人</th><th>起止</th><th>状态</th><th>进度</th><th />
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => (
                  <tr key={t.id}>
                    <td className="muted">{t.phase}</td>
                    <td>
                      <strong>{t.name}</strong>
                      {t.is_milestone ? <Badge tone="blue">里程碑</Badge> : null}
                    </td>
                    <td>{t.owner_name || '—'}</td>
                    <td className="muted">{t.start_date || '—'} → {t.end_date || '—'}</td>
                    <td>
                      <Select
                        value={t.status}
                        disabled={busy}
                        onChange={(e) =>
                          void runOp(() =>
                            api.updateDeliveryTask(t.id, {
                              status: e.target.value,
                              progress: e.target.value === 'done' ? 100 : t.progress,
                            }),
                          )
                        }
                      >
                        {Object.entries(TASK_STATUS).map(([k, v]) => (
                          <option key={k} value={k}>{v}</option>
                        ))}
                      </Select>
                    </td>
                    <td>{t.progress}%</td>
                    <td className="actions-cell">
                      <Button size="sm" variant="danger" disabled={busy} onClick={() => void runOp(() => api.deleteDeliveryTask(t.id))}>
                        删除
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="form-grid">
          <Field label="阶段"><Input placeholder="准备 / 实施 / 上线" value={task.phase} onChange={(e) => setTask({ ...task, phase: e.target.value })} /></Field>
          <Field label="任务名称"><Input value={task.name} onChange={(e) => setTask({ ...task, name: e.target.value })} /></Field>
          <Field label="负责人">
            <Select value={task.owner} onChange={(e) => setTask({ ...task, owner: e.target.value })}>
              <option value="">未指定</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
          </Field>
          <Field label="状态">
            <Select value={task.status} onChange={(e) => setTask({ ...task, status: e.target.value })}>
              {Object.entries(TASK_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="开始日期"><Input type="date" value={task.start_date} onChange={(e) => setTask({ ...task, start_date: e.target.value })} /></Field>
          <Field label="结束日期"><Input type="date" value={task.end_date} onChange={(e) => setTask({ ...task, end_date: e.target.value })} /></Field>
          <Field label="里程碑">
            <Select value={task.is_milestone ? 'yes' : 'no'} onChange={(e) => setTask({ ...task, is_milestone: e.target.value === 'yes' })}>
              <option value="no">否</option>
              <option value="yes">是</option>
            </Select>
          </Field>
        </div>
        <div className="form-actions">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void addTask()}>添加任务</Button>
        </div>
      </Card>
    </>
  );
}

function UatSection({
  engagementId,
  cases,
  criteria,
  users,
  onChanged,
}: {
  engagementId: string;
  cases: UatCase[];
  criteria: DeliveryOverview['criteria'];
  users: User[];
  onChanged: () => Promise<void> | void;
}) {
  const { busy, error, runOp } = useOps(onChanged);
  const [form, setForm] = useState({
    acceptance_id: '',
    scenario: '',
    steps: '',
    expected: '',
    actual: '',
    status: 'pending',
    owner: '',
  });

  const covered = useMemo(
    () => new Set(cases.map((c) => c.acceptance_id).filter(Boolean)),
    [cases],
  );
  const missing = criteria.filter((c) => !covered.has(c.id));

  const add = () =>
    runOp(async () => {
      if (!form.scenario.trim() || !form.steps.trim() || !form.expected.trim()) {
        throw new Error('场景、步骤、预期结果必填');
      }
      await api.createUatCase(engagementId, {
        ...form,
        acceptance_id: form.acceptance_id || undefined,
        owner: form.owner || undefined,
        actual: form.actual || undefined,
      });
      setForm({ acceptance_id: '', scenario: '', steps: '', expected: '', actual: '', status: 'pending', owner: '' });
    });

  return (
    <Card
      title="UAT 验收"
      subtitle="用例必须覆盖全部验收标准；全部通过后 G4 才放行。"
      actions={<Badge tone={missing.length ? 'amber' : 'green'}>{cases.length} 条用例</Badge>}
    >
      {error ? <ErrorBox error={error} /> : null}
      {criteria.length === 0 ? (
        <Notice tone="amber">还没有方案验收标准；先在「方案设计」里补验收标准，再建 UAT 用例。</Notice>
      ) : missing.length ? (
        <Notice tone="amber">
          还有 {missing.length} 项验收标准没有对应用例：{missing.map((c) => c.metric).join('、')}
        </Notice>
      ) : (
        <Notice tone="green">全部 {criteria.length} 项验收标准均已被 UAT 用例覆盖。</Notice>
      )}
      {cases.length === 0 ? (
        <Empty title="还没有 UAT 用例" hint="按验收标准逐条建用例。" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>编号</th><th>场景</th><th>验收标准</th><th>预期</th><th>实际</th><th>状态</th><th /></tr>
            </thead>
            <tbody>
              {cases.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{c.code}</td>
                  <td><strong>{c.scenario}</strong></td>
                  <td className="muted">{c.acceptance_metric || '—'}</td>
                  <td className="muted">{c.expected}</td>
                  <td className="muted">{c.actual || '—'}</td>
                  <td>
                    <Select
                      value={c.status}
                      disabled={busy}
                      onChange={(e) => void runOp(() => api.updateUatCase(c.id, { status: e.target.value }))}
                    >
                      {Object.entries(UAT_STATUS).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </Select>
                  </td>
                  <td className="actions-cell">
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => void runOp(() => api.deleteUatCase(c.id))}>
                      删除
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="form-grid">
        <Field label="对应验收标准">
          <Select value={form.acceptance_id} onChange={(e) => setForm({ ...form, acceptance_id: e.target.value })}>
            <option value="">不关联</option>
            {criteria.map((c) => (
              <option key={c.id} value={c.id}>{c.metric} · {c.target}</option>
            ))}
          </Select>
        </Field>
        <Field label="场景"><Input value={form.scenario} onChange={(e) => setForm({ ...form, scenario: e.target.value })} /></Field>
        <Field label="执行步骤" className="span-2"><Textarea rows={2} value={form.steps} onChange={(e) => setForm({ ...form, steps: e.target.value })} /></Field>
        <Field label="预期结果" className="span-2"><Input value={form.expected} onChange={(e) => setForm({ ...form, expected: e.target.value })} /></Field>
        <Field label="实际结果"><Input value={form.actual} onChange={(e) => setForm({ ...form, actual: e.target.value })} /></Field>
        <Field label="状态">
          <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            {Object.entries(UAT_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="执行人">
          <Select value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })}>
            <option value="">未指定</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
        </Field>
      </div>
      <div className="form-actions">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void add()}>添加 UAT 用例</Button>
      </div>
    </Card>
  );
}

function GoLiveSection({
  engagementId,
  items,
  users,
  onChanged,
}: {
  engagementId: string;
  items: GoLiveItem[];
  users: User[];
  onChanged: () => Promise<void> | void;
}) {
  const { busy, error, runOp } = useOps(onChanged);
  const [form, setForm] = useState({ category: '', item: '', blocking: 'yes', status: 'pending', owner: '', evidence: '' });

  const add = () =>
    runOp(async () => {
      if (!form.category.trim() || !form.item.trim()) throw new Error('分类与检查项必填');
      await api.createGoLiveItem(engagementId, {
        category: form.category,
        item: form.item,
        blocking: form.blocking === 'yes',
        status: form.status,
        owner: form.owner || undefined,
        evidence: form.evidence || undefined,
        sort_order: items.length + 1,
      });
      setForm({ category: '', item: '', blocking: 'yes', status: 'pending', owner: '', evidence: '' });
    });

  return (
    <Card title="上线检查" subtitle="阻断项全部通过（或豁免）后才能上线。">
      {error ? <ErrorBox error={error} /> : null}
      {items.length === 0 ? (
        <Empty title="还没有检查项" hint="覆盖技术、数据、权限、运维、业务确认。" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>分类</th><th>检查项</th><th>阻断</th><th>负责人</th><th>证据</th><th>状态</th><th /></tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td className="muted">{i.category}</td>
                  <td><strong>{i.item}</strong></td>
                  <td>{i.blocking ? <Badge tone="red">是</Badge> : <Badge tone="gray">否</Badge>}</td>
                  <td>{i.owner_name || '—'}</td>
                  <td className="muted">{i.evidence || '—'}</td>
                  <td>
                    <Select
                      value={i.status}
                      disabled={busy}
                      onChange={(e) => void runOp(() => api.updateGoLiveItem(i.id, { status: e.target.value }))}
                    >
                      {Object.entries(GO_LIVE_STATUS).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </Select>
                  </td>
                  <td className="actions-cell">
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => void runOp(() => api.deleteGoLiveItem(i.id))}>
                      删除
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="form-grid">
        <Field label="分类"><Input placeholder="技术 / 数据 / 权限 / 运维" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></Field>
        <Field label="检查项"><Input value={form.item} onChange={(e) => setForm({ ...form, item: e.target.value })} /></Field>
        <Field label="阻断项">
          <Select value={form.blocking} onChange={(e) => setForm({ ...form, blocking: e.target.value })}>
            <option value="yes">是</option>
            <option value="no">否</option>
          </Select>
        </Field>
        <Field label="状态">
          <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            {Object.entries(GO_LIVE_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="负责人">
          <Select value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })}>
            <option value="">未指定</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
        </Field>
        <Field label="证据"><Input value={form.evidence} onChange={(e) => setForm({ ...form, evidence: e.target.value })} /></Field>
      </div>
      <div className="form-actions">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void add()}>添加检查项</Button>
      </div>
    </Card>
  );
}

function TrainingSection({
  engagementId,
  trainings,
  users,
  onChanged,
}: {
  engagementId: string;
  trainings: Training[];
  users: User[];
  onChanged: () => Promise<void> | void;
}) {
  const { busy, error, runOp } = useOps(onChanged);
  const [form, setForm] = useState({
    title: '', audience: '', mode: 'onsite', trainer: '',
    scheduled_at: '', attendees: '', materials: '', status: 'planned', feedback: '',
  });

  const add = () =>
    runOp(async () => {
      if (!form.title.trim()) throw new Error('培训主题必填');
      await api.createTraining(engagementId, {
        ...form,
        trainer: form.trainer || undefined,
        scheduled_at: form.scheduled_at || undefined,
        attendees: form.attendees ? Number(form.attendees) : undefined,
      });
      setForm({ title: '', audience: '', mode: 'onsite', trainer: '', scheduled_at: '', attendees: '', materials: '', status: 'planned', feedback: '' });
    });

  return (
    <Card title="培训" subtitle="至少完成一场培训（含操作手册与反馈）。">
      {error ? <ErrorBox error={error} /> : null}
      {trainings.length === 0 ? (
        <Empty title="还没有培训" hint="上线前完成关键用户与管理员培训。" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>主题</th><th>对象</th><th>形式</th><th>讲师</th><th>日期</th><th>人数</th><th>状态</th><th /></tr>
            </thead>
            <tbody>
              {trainings.map((t) => (
                <tr key={t.id}>
                  <td><strong>{t.title}</strong></td>
                  <td className="muted">{t.audience || '—'}</td>
                  <td className="muted">{t.mode}</td>
                  <td>{t.trainer_name || '—'}</td>
                  <td className="muted">{t.scheduled_at ? fmtDate(t.scheduled_at) : '—'}</td>
                  <td>{t.attendees ?? '—'}</td>
                  <td>
                    <Select
                      value={t.status}
                      disabled={busy}
                      onChange={(e) => void runOp(() => api.updateTraining(t.id, { status: e.target.value }))}
                    >
                      {Object.entries(TRAINING_STATUS).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </Select>
                  </td>
                  <td className="actions-cell">
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => void runOp(() => api.deleteTraining(t.id))}>
                      删除
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="form-grid">
        <Field label="主题"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
        <Field label="对象"><Input value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })} /></Field>
        <Field label="形式">
          <Select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
            <option value="onsite">现场</option>
            <option value="video">视频</option>
            <option value="online">在线</option>
          </Select>
        </Field>
        <Field label="讲师">
          <Select value={form.trainer} onChange={(e) => setForm({ ...form, trainer: e.target.value })}>
            <option value="">未指定</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
        </Field>
        <Field label="日期"><Input type="date" value={form.scheduled_at} onChange={(e) => setForm({ ...form, scheduled_at: e.target.value })} /></Field>
        <Field label="人数"><Input type="number" value={form.attendees} onChange={(e) => setForm({ ...form, attendees: e.target.value })} /></Field>
        <Field label="材料"><Input value={form.materials} onChange={(e) => setForm({ ...form, materials: e.target.value })} /></Field>
        <Field label="状态">
          <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            {Object.entries(TRAINING_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
      </div>
      <div className="form-actions">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void add()}>添加培训</Button>
      </div>
    </Card>
  );
}

function IssueSection({
  engagementId,
  issues,
  users,
  onChanged,
}: {
  engagementId: string;
  issues: DeliveryIssue[];
  users: User[];
  onChanged: () => Promise<void> | void;
}) {
  const { busy, error, runOp } = useOps(onChanged);
  const [form, setForm] = useState({
    kind: 'issue', title: '', description: '', severity: 'P2', status: 'open',
    owner: '', due_date: '', resolution: '', impact: '', approval_status: 'not_required',
  });

  const add = () =>
    runOp(async () => {
      if (!form.title.trim()) throw new Error('标题必填');
      await api.createDeliveryIssue(engagementId, {
        ...form,
        owner: form.owner || undefined,
        due_date: form.due_date || undefined,
        resolution: form.resolution || undefined,
        impact: form.impact || undefined,
      });
      setForm({ kind: 'issue', title: '', description: '', severity: 'P2', status: 'open', owner: '', due_date: '', resolution: '', impact: '', approval_status: 'not_required' });
    });

  const approve = (i: DeliveryIssue, status: 'approved' | 'rejected') =>
    runOp(() =>
      api.updateDeliveryIssue(i.id, {
        approval_status: status,
        approved_by: users[0]?.id,
      }),
    );

  return (
    <Card
      title="问题与变更"
      subtitle="P0/P1 未关闭会阻断 G4；变更请求必须完成审批。"
      actions={<Badge tone="gray">{issues.length} 条</Badge>}
    >
      {error ? <ErrorBox error={error} /> : null}
      {issues.length === 0 ? (
        <Empty title="还没有问题或变更" hint="问题与变更都要留痕，避免口头承诺。" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>编号</th><th>类型</th><th>标题</th><th>级别</th><th>负责人</th><th>状态</th><th>审批</th><th /></tr>
            </thead>
            <tbody>
              {issues.map((i) => (
                <tr key={i.id}>
                  <td className="mono">{i.code}</td>
                  <td><Badge tone={i.kind === 'change' ? 'blue' : 'gray'}>{i.kind === 'change' ? '变更' : '问题'}</Badge></td>
                  <td>
                    <strong>{i.title}</strong>
                    <div className="muted small">{i.impact || i.description || ''}</div>
                  </td>
                  <td><Badge tone={i.severity === 'P0' || i.severity === 'P1' ? 'red' : 'gray'}>{i.severity}</Badge></td>
                  <td>{i.owner_name || '—'}</td>
                  <td>
                    <Select
                      value={i.status}
                      disabled={busy}
                      onChange={(e) => void runOp(() => api.updateDeliveryIssue(i.id, { status: e.target.value }))}
                    >
                      {Object.entries(ISSUE_STATUS).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </Select>
                  </td>
                  <td>
                    {i.kind === 'change' ? (
                      i.approval_status === 'pending' ? (
                        <div className="inline-actions">
                          <Button size="sm" disabled={busy} onClick={() => void approve(i, 'approved')}>批准</Button>
                          <Button size="sm" variant="danger" disabled={busy} onClick={() => void approve(i, 'rejected')}>拒绝</Button>
                        </div>
                      ) : (
                        <Badge tone={toneOf(i.approval_status)}>
                          {APPROVAL_STATUS[i.approval_status] ?? i.approval_status}
                        </Badge>
                      )
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="actions-cell">
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => void runOp(() => api.deleteDeliveryIssue(i.id))}>
                      删除
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="form-grid">
        <Field label="类型">
          <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            <option value="issue">问题</option>
            <option value="change">变更</option>
          </Select>
        </Field>
        <Field label="标题"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
        <Field label="级别">
          <Select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>
            {['P0', 'P1', 'P2', 'P3'].map((p) => <option key={p} value={p}>{p}</option>)}
          </Select>
        </Field>
        <Field label="负责人">
          <Select value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })}>
            <option value="">未指定</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
        </Field>
        <Field label="状态">
          <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            {Object.entries(ISSUE_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="截止日期"><Input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></Field>
        <Field label="描述" className="span-2"><Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        {form.kind === 'change' ? (
          <>
            <Field label="变更影响" className="span-2"><Textarea rows={2} value={form.impact} onChange={(e) => setForm({ ...form, impact: e.target.value })} /></Field>
            <Field label="审批状态">
              <Select value={form.approval_status} onChange={(e) => setForm({ ...form, approval_status: e.target.value })}>
                {Object.entries(APPROVAL_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
          </>
        ) : null}
      </div>
      <div className="form-actions">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void add()}>
          {form.kind === 'change' ? '登记变更' : '登记问题'}
        </Button>
      </div>
    </Card>
  );
}
