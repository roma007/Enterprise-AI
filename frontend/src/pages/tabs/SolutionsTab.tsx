import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { useLoad } from '../../hooks';
import type {
  AcceptanceCriterion,
  EngagementDetail,
  Solution,
  SolutionDetail,
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
  Notice,
  Select,
  Spinner,
  Stat,
  Textarea,
} from '../../ui';
import { fmtMoney } from '../../utils';
import {
  diffSolutionDetails,
  solutionDiffCsv,
  solutionDiffMarkdown,
  type NamedDiff,
  type SolutionDiff,
} from '../../solutionDiff';

const SOLUTION_STATUS: Record<string, string> = {
  draft: '草稿',
  in_review: '评审中',
  approved: '已批准',
  rejected: '已驳回',
  archived: '已归档',
};

const COMPONENT_TYPE: Record<string, string> = {
  build: '自研',
  buy: '采购',
  integrate: '集成',
  service: '服务',
};

const DIRECTION: Record<string, string> = {
  inbound: '入站',
  outbound: '出站',
  bidirectional: '双向',
};

const REVIEW_DECISION: Record<string, string> = {
  approved: '通过',
  rejected: '驳回',
  changes_requested: '需修改',
};

const ACCEPTANCE_STATUS: Record<string, string> = {
  pending: '待验证',
  met: '已达成',
  not_met: '未达成',
  waived: '豁免',
};

const statusTone = (status: string) =>
  status === 'approved'
    ? 'green'
    : status === 'rejected'
      ? 'red'
      : status === 'in_review'
        ? 'amber'
        : 'gray';

export function SolutionsTab({
  engagementId,
  detail,
  onChanged,
  onGoReports,
}: {
  engagementId: string;
  detail: EngagementDetail;
  onChanged: () => void;
  onGoReports: () => void;
}) {
  const { data, error, loading, reload } = useLoad(
    async () => {
      const [s, u] = await Promise.all([
        api.listSolutions(engagementId),
        api.listUsers(),
      ]);
      return { solutions: s.items, users: u.items };
    },
    [engagementId],
  );
  const g2 = useLoad(() => api.g2Checks(engagementId), [engagementId]);

  const reportable = detail.opportunities.filter(
    (o) => o.targetPhase === 'phase1' || o.targetPhase === 'phase2',
  );
  const [selectedOppId, setSelectedOppId] = useState<string | null>(
    reportable[0]?.id ?? detail.opportunities[0]?.id ?? null,
  );
  const [selectedSolutionId, setSelectedSolutionId] = useState<string | null>(null);

  const solutions = data?.solutions ?? [];
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareWith, setCompareWith] = useState('');
  const [compareDiff, setCompareDiff] = useState<SolutionDiff | null>(null);
  const [compareError, setCompareError] = useState<unknown>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const users = data?.users ?? [];
  const selectedOpp = detail.opportunities.find((o) => o.id === selectedOppId);
  const oppSolutions = useMemo(
    () =>
      solutions
        .filter((s) => s.opportunity_id === selectedOppId)
        .sort((a, b) => b.version - a.version),
    [solutions, selectedOppId],
  );

  useEffect(() => {
    setSelectedSolutionId(null);
  }, [selectedOppId]);

  useEffect(() => {
    if (!selectedSolutionId && oppSolutions.length) {
      setSelectedSolutionId(oppSolutions[0].id);
    }
  }, [oppSolutions, selectedSolutionId]);

  const activeSolutionId = selectedSolutionId ?? oppSolutions[0]?.id ?? '';
  useEffect(() => {
    if (!compareOpen || !activeSolutionId || !compareWith) return;
    let active = true;
    setCompareLoading(true);
    setCompareError(null);
    Promise.all([
      api.getSolution(activeSolutionId),
      api.getSolution(compareWith),
    ])
      .then(([before, after]) => {
        if (active) setCompareDiff(diffSolutionDetails(before, after));
      })
      .catch((err) => {
        if (active) setCompareError(err);
      })
      .finally(() => {
        if (active) setCompareLoading(false);
      });
    return () => {
      active = false;
    };
  }, [compareOpen, activeSolutionId, compareWith]);

  const afterChange = async () => {
    await reload();
    g2.reload();
    onChanged();
  };

  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorBox error={error} onRetry={() => void reload()} />;

  return (
    <div className="tab-body">
      <Card
        title="G2 方案门禁"
        subtitle="机会点覆盖 → 方案范围/组件/验收 → 报价 → 技术阻断 → 评审。"
        actions={
          <Button size="sm" onClick={() => void g2.reload()} disabled={g2.loading}>
            刷新校验
          </Button>
        }
      >
        {g2.loading ? <Spinner label="校验中…" /> : null}
        {g2.error ? <ErrorBox error={g2.error} onRetry={() => void g2.reload()} /> : null}
        {g2.data ? (
          <>
            <div className="check-summary">
              <span className="check-pill check-pass">{g2.data.summary.pass} pass</span>
              <span className="check-pill check-warn">{g2.data.summary.warn} warn</span>
              <span className="check-pill check-block">{g2.data.summary.block} block</span>
            </div>
            <div className="check-list">
              {g2.data.checks.map((c) => (
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
        <Card
          title="方案对象"
          subtitle="优先显示一期/二期机会点；每个机会点可有多版方案。"
          className="opp-list-card"
        >
          <div className="opp-list">
            {reportable.length === 0 && (
              <Empty title="没有进入路线的机会点" hint="先在建机会点时设置一期/二期。" />
            )}
            {reportable.map((o) => {
              const list = solutions.filter((s) => s.opportunity_id === o.id);
              const latest = list.sort((a, b) => b.version - a.version)[0];
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
                        {SOLUTION_STATUS[latest.status] ?? latest.status}
                      </Badge>
                    ) : (
                      <Badge tone="gray">未建方案</Badge>
                    )}
                  </div>
                  <strong>{o.title}</strong>
                  <div className="opp-item-meta">
                    <span>{list.length} 个版本</span>
                    <span>{o.targetPhase === 'phase1' ? '一期' : '二期'}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </Card>

        <div className="opp-editor">
          {!selectedOpp ? (
            <Card>
              <Empty title="选择一个机会点" hint="右侧创建并编辑方案。" />
            </Card>
          ) : oppSolutions.length === 0 ? (
            <CreateSolutionForm
              opportunityId={selectedOpp.id}
              opportunityLabel={`${selectedOpp.code} ${selectedOpp.title}`}
              onCreated={async (solution) => {
                await afterChange();
                setSelectedSolutionId(solution.id);
              }}
            />
          ) : (
            <div className="editor-stack">
              <Card
                title={`${selectedOpp.code} · ${selectedOpp.title}`}
                subtitle={`${oppSolutions.length} 个方案版本`}
                actions={
                  <div className="row">
                    <Select
                      value={selectedSolutionId ?? oppSolutions[0].id}
                      onChange={(e) => setSelectedSolutionId(e.target.value)}
                    >
                      {oppSolutions.map((s) => (
                        <option key={s.id} value={s.id}>
                          v{s.version} · {SOLUTION_STATUS[s.status] ?? s.status}
                        </option>
                      ))}
                    </Select>
                    {oppSolutions.length > 1 ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          const current = selectedSolutionId ?? oppSolutions[0].id;
                          const other = oppSolutions.find((s) => s.id !== current);
                          setCompareWith(other?.id ?? '');
                          setCompareDiff(null);
                          setCompareOpen(true);
                        }}
                      >
                        对比版本
                      </Button>
                    ) : null}
                  </div>
                }
              >
                <div className="inline-stats">
                  <span>版本 <strong>v{oppSolutions.find((s) => s.id === selectedSolutionId)?.version ?? oppSolutions[0].version}</strong></span>
                  <span className="muted">方案详情在下方编辑</span>
                </div>
              </Card>

              <SolutionEditor
                solutionId={selectedSolutionId ?? oppSolutions[0].id}
                users={users}
                onChanged={afterChange}
                onGoReports={onGoReports}
              />
            </div>
          )}
        </div>
      </div>

      <Modal
        open={compareOpen}
        title="版本对比"
        subtitle={
          compareDiff
            ? `v${compareDiff.versionBefore} → v${compareDiff.versionAfter}`
            : '选择两个方案版本查看差异'
        }
        onClose={() => setCompareOpen(false)}
        wide
        footer={
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={!compareDiff}
              onClick={() => {
                if (!compareDiff) return;
                const blob = new Blob([solutionDiffMarkdown(compareDiff)], {
                  type: 'text/markdown;charset=utf-8',
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `方案对比-v${compareDiff.versionBefore}-v${compareDiff.versionAfter}.md`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                window.setTimeout(() => URL.revokeObjectURL(url), 1500);
              }}
            >
              下载 Markdown
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!compareDiff}
              onClick={() => {
                if (!compareDiff) return;
                const blob = new Blob([solutionDiffCsv(compareDiff)], {
                  type: 'text/csv;charset=utf-8',
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `方案对比-v${compareDiff.versionBefore}-v${compareDiff.versionAfter}.csv`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                window.setTimeout(() => URL.revokeObjectURL(url), 1500);
              }}
            >
              下载 CSV
            </Button>
            <Button size="sm" onClick={() => setCompareOpen(false)}>
              关闭
            </Button>
          </>
        }
      >
        <Field label="对比基准">
          <Select
            value={compareWith}
            onChange={(e) => {
              setCompareDiff(null);
              setCompareWith(e.target.value);
            }}
          >
            {oppSolutions
              .filter((s) => s.id !== activeSolutionId)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  v{s.version} · {SOLUTION_STATUS[s.status] ?? s.status}
                </option>
              ))}
          </Select>
        </Field>
        {compareLoading ? <Spinner /> : null}
        {compareError ? <ErrorBox error={compareError} /> : null}
        {compareDiff ? (
          <div className="editor-stack">
            <p className="muted">
              共 <strong>{compareDiff.changedCount}</strong> 处变化；工作量{' '}
              {compareDiff.workloadBefore} → {compareDiff.workloadAfter} 人天。
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>字段</th>
                    <th>基准</th>
                    <th>对比</th>
                  </tr>
                </thead>
                <tbody>
                  {compareDiff.fields
                    .filter((field) => field.changed)
                    .map((field) => (
                      <tr key={field.key}>
                        <td>{field.label}</td>
                        <td className="muted">{field.before || '—'}</td>
                        <td>{field.after || '—'}</td>
                      </tr>
                    ))}
                  {compareDiff.fields.every((field) => !field.changed) ? (
                    <tr>
                      <td colSpan={3} className="muted">
                        概要字段无变化
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            {(
              [
                { label: '组件', items: compareDiff.components },
                { label: '集成', items: compareDiff.integrations },
                { label: '验收标准', items: compareDiff.acceptance },
              ] as Array<{ label: string; items: NamedDiff[] }>
            ).map(({ label, items }) => {
              const changed = items.filter((item) => item.status !== 'same');
              return (
                <div key={label}>
                  <h4>{label}</h4>
                  {changed.length ? (
                    <ul className="diff-list">
                      {changed.map((item) => (
                        <li key={item.name}>
                          <Badge
                            tone={
                              item.status === 'added'
                                ? 'green'
                                : item.status === 'removed'
                                  ? 'red'
                                  : 'amber'
                            }
                          >
                            {item.status === 'added'
                              ? '新增'
                              : item.status === 'removed'
                                ? '删除'
                                : '变更'}
                          </Badge>{' '}
                          <strong>{item.name}</strong>
                          <span className="muted small"> {item.detail}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted small">无变化</p>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function CreateSolutionForm({
  opportunityId,
  opportunityLabel,
  onCreated,
}: {
  opportunityId: string;
  opportunityLabel: string;
  onCreated: (solution: Solution) => Promise<void> | void;
}) {
  const [form, setForm] = useState({
    scope: '',
    approach: '',
    architecture: '',
    deployment: '',
    security: '',
    assumptions: '',
    exclusions: '',
  });
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (!form.scope.trim()) throw new Error('方案范围必填');
      const res = await api.createSolution(opportunityId, {
        scope: form.scope.trim(),
        approach: form.approach || undefined,
        architecture: form.architecture || undefined,
        deployment: form.deployment || undefined,
        security: form.security || undefined,
        assumptions: form.assumptions || undefined,
        exclusions: form.exclusions || undefined,
      });
      await onCreated(res.item);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title={`创建方案 · ${opportunityLabel}`}
      subtitle="先写清范围、做法、部署与边界；后续再补组件、集成、工作量、验收。"
    >
      {error ? <ErrorBox error={error} /> : null}
      <div className="form-grid">
        <Field label="方案范围" required className="span-2">
          <Textarea
            rows={3}
            value={form.scope}
            onChange={(e) => setForm({ ...form, scope: e.target.value })}
            placeholder="如：一期只覆盖托书结构化与单证核对，不覆盖调度派车。"
          />
        </Field>
        <Field label="技术路线" className="span-2">
          <Textarea rows={2} value={form.approach} onChange={(e) => setForm({ ...form, approach: e.target.value })} />
        </Field>
        <Field label="架构" className="span-2">
          <Textarea rows={2} value={form.architecture} onChange={(e) => setForm({ ...form, architecture: e.target.value })} />
        </Field>
        <Field label="部署方式">
          <Input value={form.deployment} onChange={(e) => setForm({ ...form, deployment: e.target.value })} placeholder="客户内网 / 云" />
        </Field>
        <Field label="安全要求">
          <Input value={form.security} onChange={(e) => setForm({ ...form, security: e.target.value })} placeholder="数据不出内网 / 脱敏" />
        </Field>
        <Field label="关键假设" className="span-2">
          <Textarea rows={2} value={form.assumptions} onChange={(e) => setForm({ ...form, assumptions: e.target.value })} />
        </Field>
        <Field label="不做 / 排除项" className="span-2">
          <Textarea rows={2} value={form.exclusions} onChange={(e) => setForm({ ...form, exclusions: e.target.value })} />
        </Field>
      </div>
      <div className="form-actions">
        <Button variant="primary" disabled={saving} onClick={() => void save()}>
          {saving ? '创建中…' : '创建方案 v1'}
        </Button>
      </div>
    </Card>
  );
}

function SolutionEditor({
  solutionId,
  users,
  onChanged,
  onGoReports,
}: {
  solutionId: string;
  users: User[];
  onChanged: () => Promise<void> | void;
  onGoReports: () => void;
}) {
  const { data, error, loading, reload } = useLoad<SolutionDetail>(
    () => api.getSolution(solutionId),
    [solutionId],
  );
  const [basic, setBasic] = useState({
    scope: '',
    approach: '',
    architecture: '',
    deployment: '',
    security: '',
    assumptions: '',
    exclusions: '',
    status: 'draft',
  });
  const [component, setComponent] = useState({
    name: '',
    type: 'build',
    description: '',
    effort_days: '0',
  });
  const [integration, setIntegration] = useState({
    system: '',
    direction: 'outbound',
    protocol: '',
    fields: '',
    frequency: '',
    owner: '',
    risk: '',
  });
  const [workload, setWorkload] = useState<Array<{ role: string; days: string; rate: string }>>([]);
  const [acceptance, setAcceptance] = useState({
    metric: '',
    baseline: '',
    target: '',
    method: '',
    owner: '',
    status: 'pending',
  });
  const [review, setReview] = useState({
    reviewer: '',
    decision: 'approved',
    comments: '',
  });
  const [errorBox, setErrorBox] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [docNotice, setDocNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const s = data.item;
    setBasic({
      scope: s.scope,
      approach: s.approach ?? '',
      architecture: s.architecture ?? '',
      deployment: s.deployment ?? '',
      security: s.security ?? '',
      assumptions: s.assumptions ?? '',
      exclusions: s.exclusions ?? '',
      status: s.status,
    });
    setWorkload(
      data.workload.map((w) => ({
        role: w.role,
        days: String(w.days),
        rate: String(w.rate),
      })),
    );
    setReview((r) => ({ ...r, reviewer: r.reviewer || users[0]?.id || '' }));
  }, [data, users]);

  const after = async () => {
    await reload();
    await onChanged();
  };

  const run = async (fn: () => Promise<unknown>) => {
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

  const s = data.item;
  const workloadTotal = workload.reduce(
    (a, w) => a + (Number(w.days) || 0) * (Number(w.rate) || 0),
    0,
  );

  const saveBasic = () =>
    run(() =>
      api.updateSolution(s.id, {
        ...basic,
        approach: basic.approach || null,
        architecture: basic.architecture || null,
        deployment: basic.deployment || null,
        security: basic.security || null,
        assumptions: basic.assumptions || null,
        exclusions: basic.exclusions || null,
      }),
    );

  const addComponent = () =>
    run(async () => {
      if (!component.name.trim()) throw new Error('组件名称必填');
      await api.createComponent(s.id, {
        name: component.name.trim(),
        type: component.type,
        description: component.description || undefined,
        effort_days: Number(component.effort_days) || 0,
      });
      setComponent({ name: '', type: 'build', description: '', effort_days: '0' });
    });

  const addIntegration = () =>
    run(async () => {
      if (!integration.system.trim()) throw new Error('系统名称必填');
      await api.createIntegration(s.id, {
        system: integration.system.trim(),
        direction: integration.direction,
        protocol: integration.protocol || undefined,
        fields: integration.fields || undefined,
        frequency: integration.frequency || undefined,
        owner: integration.owner || undefined,
        risk: integration.risk || undefined,
      });
      setIntegration({
        system: '', direction: 'outbound', protocol: '', fields: '',
        frequency: '', owner: '', risk: '',
      });
    });

  const saveWorkload = () =>
    run(() =>
      api.saveWorkload(
        s.id,
        workload
          .filter((w) => w.role.trim())
          .map((w) => ({
            role: w.role.trim(),
            days: Number(w.days) || 0,
            rate: Number(w.rate) || 0,
          })),
      ),
    );

  const addAcceptance = () =>
    run(async () => {
      if (!acceptance.metric.trim() || !acceptance.target.trim() || !acceptance.method.trim()) {
        throw new Error('指标、目标、验证方法必填');
      }
      await api.createAcceptance(s.id, {
        metric: acceptance.metric.trim(),
        baseline: acceptance.baseline || undefined,
        target: acceptance.target.trim(),
        method: acceptance.method.trim(),
        owner: acceptance.owner || undefined,
        status: acceptance.status,
      });
      setAcceptance({ metric: '', baseline: '', target: '', method: '', owner: '', status: 'pending' });
    });

  const generateDoc = async (type: 'proposal' | 'architecture' | 'prd' | 'acceptance') => {
    setBusy(true);
    setErrorBox(null);
    setDocNotice(null);
    try {
      const res = await api.generateSolutionDocument(s.id, type);
      setDocNotice(`已生成交付物：${res.item.title} v${res.item.version}`);
      await after();
    } catch (err) {
      setErrorBox(err);
    } finally {
      setBusy(false);
    }
  };

  const addReview = () =>
    run(async () => {
      if (!review.reviewer) throw new Error('请选择评审人');
      await api.createReview(s.id, {
        reviewer: review.reviewer,
        decision: review.decision,
        comments: review.comments || undefined,
      });
      setReview({ ...review, comments: '' });
    });

  return (
    <div className="editor-stack">
      <Card
        title={`方案 v${s.version}`}
        subtitle={`${s.opportunity_code} ${s.opportunity_title}`}
        actions={
          <Badge tone={statusTone(s.status)}>
            {SOLUTION_STATUS[s.status] ?? s.status}
          </Badge>
        }
      >
        {errorBox ? <ErrorBox error={errorBox} /> : null}
        <div className="stat-grid">
          <Stat label="组件" value={data.components.length} hint="自研/采购/集成" />
          <Stat label="集成" value={data.integrations.length} hint="接口与系统" tone="blue" />
          <Stat label="工作量成本" value={fmtMoney(data.workloadTotal)} hint="内部口径" tone="amber" />
          <Stat label="验收标准" value={data.acceptanceCriteria.length} hint="可测量" tone="green" />
        </div>

        <details className="disclosure" open>
          <summary>方案基本信息</summary>
          <div className="form-grid">
            <Field label="范围" required className="span-2">
              <Textarea rows={3} value={basic.scope} onChange={(e) => setBasic({ ...basic, scope: e.target.value })} />
            </Field>
            <Field label="技术路线" className="span-2">
              <Textarea rows={2} value={basic.approach} onChange={(e) => setBasic({ ...basic, approach: e.target.value })} />
            </Field>
            <Field label="架构" className="span-2">
              <Textarea rows={2} value={basic.architecture} onChange={(e) => setBasic({ ...basic, architecture: e.target.value })} />
            </Field>
            <Field label="部署">
              <Input value={basic.deployment} onChange={(e) => setBasic({ ...basic, deployment: e.target.value })} />
            </Field>
            <Field label="安全">
              <Input value={basic.security} onChange={(e) => setBasic({ ...basic, security: e.target.value })} />
            </Field>
            <Field label="关键假设" className="span-2">
              <Textarea rows={2} value={basic.assumptions} onChange={(e) => setBasic({ ...basic, assumptions: e.target.value })} />
            </Field>
            <Field label="排除项" className="span-2">
              <Textarea rows={2} value={basic.exclusions} onChange={(e) => setBasic({ ...basic, exclusions: e.target.value })} />
            </Field>
            <Field label="状态">
              <Select value={basic.status} onChange={(e) => setBasic({ ...basic, status: e.target.value })}>
                {Object.entries(SOLUTION_STATUS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="form-actions">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void saveBasic()}>
              保存方案基本信息
            </Button>
          </div>
        </details>
      </Card>

      <Card title="方案组件" subtitle="自研 / 采购 / 集成 / 服务；effort 汇总到工作量。">
        {data.components.length === 0 ? (
          <Empty title="还没有组件" hint="先拆出 OCR、规则引擎、前端等组件。" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>组件</th><th>类型</th><th>工作量（人天）</th><th>说明</th><th /></tr>
              </thead>
              <tbody>
                {data.components.map((c) => (
                  <tr key={c.id}>
                    <td><strong>{c.name}</strong></td>
                    <td>{COMPONENT_TYPE[c.type] ?? c.type}</td>
                    <td>{c.effort_days}</td>
                    <td className="muted">{c.description || '—'}</td>
                    <td className="actions-cell">
                      <Button size="sm" variant="danger" disabled={busy} onClick={() => void run(() => api.deleteComponent(c.id))}>
                        删除
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="inline-form">
          <Input placeholder="组件名称" value={component.name} onChange={(e) => setComponent({ ...component, name: e.target.value })} />
          <Select value={component.type} onChange={(e) => setComponent({ ...component, type: e.target.value })}>
            {Object.entries(COMPONENT_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <Input type="number" placeholder="人天" value={component.effort_days} onChange={(e) => setComponent({ ...component, effort_days: e.target.value })} />
          <Input placeholder="说明" value={component.description} onChange={(e) => setComponent({ ...component, description: e.target.value })} />
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void addComponent()}>添加</Button>
        </div>
      </Card>

      <Card title="集成清单" subtitle="系统、方向、协议、字段、频率、责任方与风险。">
        {data.integrations.length === 0 ? (
          <Empty title="还没有集成项" hint="例如 TMS 出站接口、财务系统 Excel 导入。" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>系统</th><th>方向</th><th>协议</th><th>字段</th><th>责任方</th><th>风险</th><th /></tr>
              </thead>
              <tbody>
                {data.integrations.map((i) => (
                  <tr key={i.id}>
                    <td><strong>{i.system}</strong></td>
                    <td>{DIRECTION[i.direction] ?? i.direction}</td>
                    <td>{i.protocol || '—'}</td>
                    <td className="muted">{i.fields || '—'}</td>
                    <td>{i.owner || '—'}</td>
                    <td className="muted">{i.risk || '—'}</td>
                    <td className="actions-cell">
                      <Button size="sm" variant="danger" disabled={busy} onClick={() => void run(() => api.deleteIntegration(i.id))}>
                        删除
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="inline-form">
          <Input placeholder="系统" value={integration.system} onChange={(e) => setIntegration({ ...integration, system: e.target.value })} />
          <Select value={integration.direction} onChange={(e) => setIntegration({ ...integration, direction: e.target.value })}>
            {Object.entries(DIRECTION).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <Input placeholder="协议" value={integration.protocol} onChange={(e) => setIntegration({ ...integration, protocol: e.target.value })} />
          <Input placeholder="字段" value={integration.fields} onChange={(e) => setIntegration({ ...integration, fields: e.target.value })} />
          <Input placeholder="责任方" value={integration.owner} onChange={(e) => setIntegration({ ...integration, owner: e.target.value })} />
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void addIntegration()}>添加</Button>
        </div>
      </Card>

      <Card title="工作量" subtitle="单位：万元/人天；成本 = 人天 × 单价。" actions={
        <Button size="sm" onClick={() => setWorkload((prev) => [...prev, { role: '', days: '0', rate: '0' }])}>
          + 一行
        </Button>
      }>
        {workload.length === 0 ? (
          <Empty title="还没有工作量" hint="按角色拆人天和内部单价。" />
        ) : (
          <div className="chain-editor">
            {workload.map((w, idx) => (
              <div key={idx} className="workload-row">
                <Input placeholder="角色" value={w.role} onChange={(e) => setWorkload((prev) => prev.map((x, i) => i === idx ? { ...x, role: e.target.value } : x))} />
                <Input type="number" placeholder="人天" value={w.days} onChange={(e) => setWorkload((prev) => prev.map((x, i) => i === idx ? { ...x, days: e.target.value } : x))} />
                <Input type="number" step="0.01" placeholder="万元/人天" value={w.rate} onChange={(e) => setWorkload((prev) => prev.map((x, i) => i === idx ? { ...x, rate: e.target.value } : x))} />
                <span className="muted">{fmtMoney((Number(w.days) || 0) * (Number(w.rate) || 0))}</span>
                <Button size="sm" variant="danger" onClick={() => setWorkload((prev) => prev.filter((_, i) => i !== idx))}>删</Button>
              </div>
            ))}
          </div>
        )}
        <div className="form-actions">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void saveWorkload()}>保存工作量</Button>
          <span className="muted">合计 <strong>{fmtMoney(workloadTotal)}</strong></span>
        </div>
      </Card>

      <Card title="验收标准" subtitle="基线 → 目标 → 验证方法；后续 POC 与上线都引用这里。">
        {data.acceptanceCriteria.length === 0 ? (
          <Empty title="还没有验收标准" hint="至少一条可测量的指标，G2 才有依据。" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>指标</th><th>基线</th><th>目标</th><th>方法</th><th>状态</th><th /></tr></thead>
              <tbody>
                {data.acceptanceCriteria.map((a: AcceptanceCriterion) => (
                  <tr key={a.id}>
                    <td><strong>{a.metric}</strong></td>
                    <td>{a.baseline || '—'}</td>
                    <td>{a.target}</td>
                    <td className="muted">{a.method}</td>
                    <td><Badge tone={a.status === 'met' ? 'green' : a.status === 'not_met' ? 'red' : 'gray'}>{ACCEPTANCE_STATUS[a.status] ?? a.status}</Badge></td>
                    <td className="actions-cell">
                      <Button size="sm" variant="danger" disabled={busy} onClick={() => void run(() => api.deleteAcceptance(a.id))}>删除</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="inline-form">
          <Input placeholder="指标" value={acceptance.metric} onChange={(e) => setAcceptance({ ...acceptance, metric: e.target.value })} />
          <Input placeholder="基线" value={acceptance.baseline} onChange={(e) => setAcceptance({ ...acceptance, baseline: e.target.value })} />
          <Input placeholder="目标" value={acceptance.target} onChange={(e) => setAcceptance({ ...acceptance, target: e.target.value })} />
          <Input placeholder="验证方法" value={acceptance.method} onChange={(e) => setAcceptance({ ...acceptance, method: e.target.value })} />
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void addAcceptance()}>添加</Button>
        </div>
      </Card>

      <Card title="方案评审" subtitle="评审通过后方案状态自动变为 approved。">
        {data.reviews.length === 0 ? (
          <Empty title="还没有评审记录" hint="至少一次评审，G2 才能放行。" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>时间</th><th>评审人</th><th>结论</th><th>意见</th></tr></thead>
              <tbody>
                {data.reviews.map((r) => (
                  <tr key={r.id}>
                    <td className="muted">{new Date(r.reviewed_at).toLocaleString()}</td>
                    <td>{r.reviewer_name || '—'}</td>
                    <td><Badge tone={r.decision === 'approved' ? 'green' : r.decision === 'rejected' ? 'red' : 'amber'}>{REVIEW_DECISION[r.decision] ?? r.decision}</Badge></td>
                    <td className="muted">{r.comments || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="form-grid">
          <Field label="评审人">
            <Select value={review.reviewer} onChange={(e) => setReview({ ...review, reviewer: e.target.value })}>
              <option value="">请选择</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
          </Field>
          <Field label="结论">
            <Select value={review.decision} onChange={(e) => setReview({ ...review, decision: e.target.value })}>
              {Object.entries(REVIEW_DECISION).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="意见" className="span-2">
            <Textarea rows={2} value={review.comments} onChange={(e) => setReview({ ...review, comments: e.target.value })} />
          </Field>
        </div>
        <div className="form-actions">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void addReview()}>提交评审</Button>
        </div>
      </Card>

      <Card
        title="生成方案文档"
        subtitle="结构化数据 → 模板 → 交付物；生成后可在报告页导出 Word / 打印。"
        actions={
          <div className="generate-bar">
            <Button size="sm" disabled={busy} onClick={() => void generateDoc('proposal')}>
              方案说明书
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void generateDoc('architecture')}>
              技术架构
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void generateDoc('prd')}>
              PRD 骨架
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void generateDoc('acceptance')}>
              验收标准
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
            生成的是可版本化的交付物；客户版方案书不包含内部工作量成本。
          </p>
        )}
      </Card>

      <Notice tone="blue">
        方案的内部工作量成本不会出现在客户版方案书里；对外报价用报价单的报价行。
      </Notice>
    </div>
  );
}
