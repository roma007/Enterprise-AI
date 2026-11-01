import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { useLoad } from '../../hooks';
import type { EngagementDetail, PocDetail, PocExperiment, PocRun, User } from '../../types';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Field,
  Input,
  Select,
  Spinner,
  Stat,
  Textarea,
} from '../../ui';
import { fmtDate, fmtDateTime } from '../../utils';

const STATUS_LABEL: Record<string, string> = {
  planned: '计划中',
  running: '运行中',
  reviewing: '复盘中',
  passed: '已通过',
  failed: '未通过',
  cancelled: '已取消',
};

const DECISION_LABEL: Record<string, string> = {
  go: 'Go',
  no_go: 'No-Go',
  conditional: '有条件',
  pending: '待定',
};

const ACCESS_LABEL: Record<string, string> = {
  pending: '待申请',
  approved: '已批准',
  rejected: '已拒绝',
  not_required: '无需申请',
};

const statusTone = (status: string) =>
  status === 'passed'
    ? 'green'
    : status === 'failed'
      ? 'red'
      : status === 'reviewing'
        ? 'amber'
        : 'gray';

export function PocTab({
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
      const [e, u] = await Promise.all([
        api.listExperiments(engagementId),
        api.listUsers(),
      ]);
      return { experiments: e.items, users: u.items };
    },
    [engagementId],
  );
  const g3 = useLoad(() => api.g3Checks(engagementId), [engagementId]);

  const reportable = detail.opportunities.filter(
    (o) => o.targetPhase === 'phase1' || o.targetPhase === 'phase2',
  );
  const [selectedOppId, setSelectedOppId] = useState<string | null>(
    reportable[0]?.id ?? detail.opportunities[0]?.id ?? null,
  );
  const [selectedExperimentId, setSelectedExperimentId] = useState<string | null>(null);

  const experiments = data?.experiments ?? [];
  const users = data?.users ?? [];
  const selectedOpp = detail.opportunities.find((o) => o.id === selectedOppId);
  const oppExperiments = useMemo(
    () =>
      experiments
        .filter((e) => e.opportunity_id === selectedOppId)
        .sort((a, b) => b.version - a.version),
    [experiments, selectedOppId],
  );

  useEffect(() => {
    setSelectedExperimentId(null);
  }, [selectedOppId]);

  useEffect(() => {
    if (!selectedExperimentId && oppExperiments.length) {
      setSelectedExperimentId(oppExperiments[0].id);
    }
  }, [oppExperiments, selectedExperimentId]);

  const after = async () => {
    await reload();
    g3.reload();
    onChanged();
  };

  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorBox error={error} onRetry={() => void reload()} />;

  return (
    <div className="tab-body">
      <Card
        title="G3 验证门禁"
        subtitle="实验设计 → 可用样本 → 运行 → 人工复核 → 结论/证据 → 决策。"
        actions={
          <Button size="sm" disabled={g3.loading} onClick={() => void g3.reload()}>
            刷新校验
          </Button>
        }
      >
        {g3.loading ? <Spinner label="校验中…" /> : null}
        {g3.error ? <ErrorBox error={g3.error} onRetry={() => void g3.reload()} /> : null}
        {g3.data ? (
          <>
            <div className="check-summary">
              <span className="check-pill check-pass">{g3.data.summary.pass} pass</span>
              <span className="check-pill check-warn">{g3.data.summary.warn} warn</span>
              <span className="check-pill check-block">{g3.data.summary.block} block</span>
            </div>
            <div className="check-list">
              {g3.data.checks.map((c) => (
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
        <Card title="POC 实验对象" subtitle="按一期/二期机会点；每个机会点可有多个实验版本。" className="opp-list-card">
          <div className="opp-list">
            {reportable.map((o) => {
              const list = experiments
                .filter((e) => e.opportunity_id === o.id)
                .sort((a, b) => b.version - a.version);
              const latest = list[0];
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
                        {STATUS_LABEL[latest.status] ?? latest.status}
                      </Badge>
                    ) : (
                      <Badge tone="gray">未建实验</Badge>
                    )}
                  </div>
                  <strong>{o.title}</strong>
                  <div className="opp-item-meta">
                    <span>{list.length} 个版本</span>
                    {latest?.decision ? <span>{DECISION_LABEL[latest.decision] ?? latest.decision}</span> : null}
                  </div>
                </button>
              );
            })}
          </div>
        </Card>

        <div className="opp-editor">
          {!selectedOpp ? (
            <Card><Empty title="选择一个机会点" /></Card>
          ) : oppExperiments.length === 0 ? (
            <CreateExperimentForm
              opportunityId={selectedOpp.id}
              label={`${selectedOpp.code} ${selectedOpp.title}`}
              onCreated={async (e) => {
                await after();
                setSelectedExperimentId(e.id);
              }}
            />
          ) : (
            <div className="editor-stack">
              <Card
                title={`${selectedOpp.code} · ${selectedOpp.title}`}
                subtitle={`${oppExperiments.length} 个实验版本`}
                actions={
                  <Select
                    value={selectedExperimentId ?? oppExperiments[0].id}
                    onChange={(e) => setSelectedExperimentId(e.target.value)}
                  >
                    {oppExperiments.map((e) => (
                      <option key={e.id} value={e.id}>
                        v{e.version} · {STATUS_LABEL[e.status] ?? e.status}
                      </option>
                    ))}
                  </Select>
                }
              >
                <p className="hint-line">实验详情、样本、运行、复核与结论在下方。</p>
              </Card>
              <ExperimentEditor
                experimentId={selectedExperimentId ?? oppExperiments[0].id}
                users={users}
                onChanged={after}
                onGoReports={onGoReports}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CreateExperimentForm({
  opportunityId,
  label,
  onCreated,
}: {
  opportunityId: string;
  label: string;
  onCreated: (e: PocExperiment) => Promise<void> | void;
}) {
  const [form, setForm] = useState({
    hypothesis: '',
    method: '',
    sample_size: '100',
    success_metric: '',
    threshold: '',
    start_date: '',
    end_date: '',
  });
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (!form.hypothesis.trim() || !form.method.trim() || !form.success_metric.trim() || !form.threshold.trim()) {
        throw new Error('假设、方法、指标、阈值必填');
      }
      const res = await api.createExperiment(opportunityId, {
        hypothesis: form.hypothesis.trim(),
        method: form.method.trim(),
        sample_size: form.sample_size ? Number(form.sample_size) : undefined,
        success_metric: form.success_metric.trim(),
        threshold: form.threshold.trim(),
        start_date: form.start_date || undefined,
        end_date: form.end_date || undefined,
      });
      await onCreated(res.item);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title={`创建 POC 实验 · ${label}`} subtitle="先锁定假设、样本、方法和成功阈值，再开始跑。">
      {error ? <ErrorBox error={error} /> : null}
      <div className="form-grid">
        <Field label="假设" required className="span-2">
          <Textarea rows={3} value={form.hypothesis} onChange={(e) => setForm({ ...form, hypothesis: e.target.value })} />
        </Field>
        <Field label="方法" required className="span-2">
          <Textarea rows={2} value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })} />
        </Field>
        <Field label="样本量">
          <Input type="number" value={form.sample_size} onChange={(e) => setForm({ ...form, sample_size: e.target.value })} />
        </Field>
        <Field label="成功指标" required>
          <Input value={form.success_metric} onChange={(e) => setForm({ ...form, success_metric: e.target.value })} placeholder="如：托书字段准确率" />
        </Field>
        <Field label="成功阈值" required>
          <Input value={form.threshold} onChange={(e) => setForm({ ...form, threshold: e.target.value })} placeholder="如：≥95%" />
        </Field>
        <Field label="开始日期">
          <Input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
        </Field>
        <Field label="结束日期">
          <Input type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} />
        </Field>
      </div>
      <div className="form-actions">
        <Button variant="primary" disabled={saving} onClick={() => void save()}>
          {saving ? '创建中…' : '创建实验 v1'}
        </Button>
      </div>
    </Card>
  );
}

function ExperimentEditor({
  experimentId,
  users,
  onChanged,
  onGoReports,
}: {
  experimentId: string;
  users: User[];
  onChanged: () => Promise<void> | void;
  onGoReports: () => void;
}) {
  const { data, error, loading, reload } = useLoad<PocDetail>(
    () => api.getExperiment(experimentId),
    [experimentId],
  );
  const [basic, setBasic] = useState({
    hypothesis: '', method: '', sample_size: '', success_metric: '',
    threshold: '', start_date: '', end_date: '', status: 'planned',
  });
  const [dataset, setDataset] = useState({
    name: '', source: '', sample_count: '', fields: '', access_status: 'pending',
  });
  const [run, setRun] = useState({
    dataset_id: '', config: '', metrics: '{\n  "accuracy": 0.95\n}', issues: '',
  });
  const [review, setReview] = useState({
    run_id: '', reviewer: '', sample_count: '', accuracy: '', false_positive: '', notes: '',
  });
  const [conclusion, setConclusion] = useState({
    decision: 'go', evidence: '', conditions: '',
  });
  const [errorBox, setErrorBox] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [docNotice, setDocNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const e = data.item;
    setBasic({
      hypothesis: e.hypothesis, method: e.method,
      sample_size: e.sample_size != null ? String(e.sample_size) : '',
      success_metric: e.success_metric, threshold: e.threshold,
      start_date: e.start_date ? fmtDate(e.start_date) : '',
      end_date: e.end_date ? fmtDate(e.end_date) : '',
      status: e.status,
    });
    setReview((r) => ({
      ...r,
      run_id: r.run_id || data.runs[0]?.id || '',
      reviewer: r.reviewer || users[0]?.id || '',
    }));
    if (data.conclusion) {
      setConclusion({
        decision: data.conclusion.decision,
        evidence: data.conclusion.evidence,
        conditions: data.conclusion.conditions ?? '',
      });
    }
  }, [data, users]);

  const after = async () => {
    await reload();
    await onChanged();
  };
  const runOp = async (fn: () => Promise<unknown>) => {
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

  const e = data.item;

  const saveBasic = () =>
    runOp(() =>
      api.updateExperiment(e.id, {
        ...basic,
        sample_size: basic.sample_size ? Number(basic.sample_size) : null,
        start_date: basic.start_date || null,
        end_date: basic.end_date || null,
      }),
    );

  const addDataset = () =>
    runOp(async () => {
      if (!dataset.name.trim()) throw new Error('样本名称必填');
      await api.createDataset(e.id, {
        name: dataset.name.trim(),
        source: dataset.source || undefined,
        sample_count: dataset.sample_count ? Number(dataset.sample_count) : undefined,
        fields: dataset.fields || undefined,
        access_status: dataset.access_status,
      });
      setDataset({ name: '', source: '', sample_count: '', fields: '', access_status: 'pending' });
    });

  const addRun = () =>
    runOp(async () => {
      let metrics: Record<string, unknown> = {};
      try {
        metrics = JSON.parse(run.metrics || '{}');
      } catch {
        throw new Error('指标 JSON 格式不正确');
      }
      await api.createRun(e.id, {
        dataset_id: run.dataset_id || undefined,
        config: run.config || undefined,
        metrics,
        issues: run.issues || undefined,
      });
      setRun({ dataset_id: '', config: '', metrics: '{\n  "accuracy": 0.95\n}', issues: '' });
    });

  const addReview = () =>
    runOp(async () => {
      if (!review.run_id) throw new Error('请选择运行记录');
      if (!review.reviewer) throw new Error('请选择复核人');
      await api.createPocReview(review.run_id, {
        reviewer: review.reviewer,
        sample_count: review.sample_count ? Number(review.sample_count) : undefined,
        accuracy: review.accuracy ? Number(review.accuracy) : undefined,
        false_positive: review.false_positive ? Number(review.false_positive) : undefined,
        notes: review.notes || undefined,
      });
      setReview({ ...review, sample_count: '', accuracy: '', false_positive: '', notes: '' });
    });

  const generateReport = () =>
    runOp(async () => {
      const res = await api.generatePocDocument(e.id);
      setDocNotice(`已生成《${res.item.title}》v${res.item.version}`);
    });

  const downloadReport = () =>
    runOp(async () => {
      const blob = await api.exportPocDocx(e.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${e.opportunity_title} POC 验证报告 v${e.version}.docx`;
      a.click();
      URL.revokeObjectURL(url);
    });

  const saveConclusion = () =>
    runOp(async () => {
      if (!conclusion.evidence.trim()) throw new Error('结论证据必填');
      await api.saveConclusion(e.id, {
        decision: conclusion.decision,
        evidence: conclusion.evidence.trim(),
        conditions: conclusion.conditions || undefined,
        decided_by: users[0]?.id,
      });
    });

  return (
    <div className="editor-stack">
      <Card
        title={`实验 v${e.version}`}
        subtitle={`${e.opportunity_code} ${e.opportunity_title}`}
        actions={<Badge tone={statusTone(e.status)}>{STATUS_LABEL[e.status] ?? e.status}</Badge>}
      >
        {errorBox ? <ErrorBox error={errorBox} /> : null}
        <div className="stat-grid">
          <Stat label="样本" value={data.datasets.length} hint="可用/申请中" />
          <Stat label="运行" value={data.runs.length} hint="每次配置" tone="blue" />
          <Stat label="复核" value={data.reviews.length} hint="人工复核" tone="amber" />
          <Stat label="结论" value={data.conclusion ? DECISION_LABEL[data.conclusion.decision] ?? '—' : '—'} tone={data.conclusion?.decision === 'go' ? 'green' : 'gray'} />
        </div>
        <div className="form-grid">
          <Field label="假设" className="span-2">
            <Textarea rows={2} value={basic.hypothesis} onChange={(ev) => setBasic({ ...basic, hypothesis: ev.target.value })} />
          </Field>
          <Field label="方法" className="span-2">
            <Textarea rows={2} value={basic.method} onChange={(ev) => setBasic({ ...basic, method: ev.target.value })} />
          </Field>
          <Field label="指标"><Input value={basic.success_metric} onChange={(ev) => setBasic({ ...basic, success_metric: ev.target.value })} /></Field>
          <Field label="阈值"><Input value={basic.threshold} onChange={(ev) => setBasic({ ...basic, threshold: ev.target.value })} /></Field>
          <Field label="样本量"><Input type="number" value={basic.sample_size} onChange={(ev) => setBasic({ ...basic, sample_size: ev.target.value })} /></Field>
          <Field label="状态">
            <Select value={basic.status} onChange={(ev) => setBasic({ ...basic, status: ev.target.value })}>
              {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
        </div>
        <div className="form-actions">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void saveBasic()}>保存实验</Button>
        </div>
      </Card>

      <Card title="样本数据" subtitle="来源、数量、字段、访问状态。">
        {data.datasets.length === 0 ? <Empty title="还没有样本" hint="至少一份可用样本才能跑实验。" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>名称</th><th>来源</th><th>数量</th><th>访问</th><th /></tr></thead>
              <tbody>
                {data.datasets.map((d) => (
                  <tr key={d.id}>
                    <td><strong>{d.name}</strong></td>
                    <td className="muted">{d.source || '—'}</td>
                    <td>{d.sample_count ?? '—'}</td>
                    <td><Badge tone={d.access_status === 'approved' || d.access_status === 'not_required' ? 'green' : 'amber'}>{ACCESS_LABEL[d.access_status] ?? d.access_status}</Badge></td>
                    <td className="actions-cell"><Button size="sm" variant="danger" disabled={busy} onClick={() => void runOp(() => api.deleteDataset(d.id))}>删除</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="inline-form">
          <Input placeholder="样本名称" value={dataset.name} onChange={(ev) => setDataset({ ...dataset, name: ev.target.value })} />
          <Input placeholder="来源" value={dataset.source} onChange={(ev) => setDataset({ ...dataset, source: ev.target.value })} />
          <Input type="number" placeholder="数量" value={dataset.sample_count} onChange={(ev) => setDataset({ ...dataset, sample_count: ev.target.value })} />
          <Select value={dataset.access_status} onChange={(ev) => setDataset({ ...dataset, access_status: ev.target.value })}>
            {Object.entries(ACCESS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void addDataset()}>添加</Button>
        </div>
      </Card>

      <Card title="运行记录" subtitle="每次配置和指标；run_no 自动递增。">
        {data.runs.length === 0 ? <Empty title="还没有运行" hint="至少跑一次并记录指标。" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>#</th><th>样本</th><th>配置</th><th>指标</th><th>时间</th><th /></tr></thead>
              <tbody>
                {data.runs.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">#{r.run_no}</td>
                    <td>{r.dataset_name || '—'}</td>
                    <td className="muted">{r.config || '—'}</td>
                    <td className="mono muted">{JSON.stringify(r.metrics)}</td>
                    <td className="muted">{fmtDateTime(r.started_at)}</td>
                    <td className="actions-cell"><Button size="sm" variant="danger" disabled={busy} onClick={() => void runOp(() => api.deleteRun(r.id))}>删除</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="form-grid">
          <Field label="样本">
            <Select value={run.dataset_id} onChange={(ev) => setRun({ ...run, dataset_id: ev.target.value })}>
              <option value="">不指定</option>
              {data.datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          </Field>
          <Field label="配置">
            <Input value={run.config} onChange={(ev) => setRun({ ...run, config: ev.target.value })} placeholder="模型/规则版本" />
          </Field>
          <Field label="指标 JSON" className="span-2">
            <Textarea rows={3} className="mono" value={run.metrics} onChange={(ev) => setRun({ ...run, metrics: ev.target.value })} />
          </Field>
          <Field label="问题" className="span-2">
            <Input value={run.issues} onChange={(ev) => setRun({ ...run, issues: ev.target.value })} />
          </Field>
        </div>
        <div className="form-actions">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void addRun()}>记录一次运行</Button>
        </div>
      </Card>

      <Card title="人工复核" subtitle="复核人、样本量、准确率、误报数。">
        {data.reviews.length === 0 ? <Empty title="还没有复核" hint="运行记录需要人工复核，G3 才放行。" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>时间</th><th>复核人</th><th>样本</th><th>准确率</th><th>误报</th><th>备注</th></tr></thead>
              <tbody>
                {data.reviews.map((r) => (
                  <tr key={r.id}>
                    <td className="muted">{fmtDateTime(r.reviewed_at)}</td>
                    <td>{r.reviewer_name || '—'}</td>
                    <td>{r.sample_count ?? '—'}</td>
                    <td>{r.accuracy != null ? `${(Number(r.accuracy) * 100).toFixed(1)}%` : '—'}</td>
                    <td>{r.false_positive ?? '—'}</td>
                    <td className="muted">{r.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="form-grid">
          <Field label="运行记录">
            <Select value={review.run_id} onChange={(ev) => setReview({ ...review, run_id: ev.target.value })}>
              <option value="">请选择</option>
              {data.runs.map((r) => <option key={r.id} value={r.id}>#{r.run_no} {r.dataset_name || ''}</option>)}
            </Select>
          </Field>
          <Field label="复核人">
            <Select value={review.reviewer} onChange={(ev) => setReview({ ...review, reviewer: ev.target.value })}>
              <option value="">请选择</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
          </Field>
          <Field label="样本量"><Input type="number" value={review.sample_count} onChange={(ev) => setReview({ ...review, sample_count: ev.target.value })} /></Field>
          <Field label="准确率（0–1）"><Input type="number" step="0.01" value={review.accuracy} onChange={(ev) => setReview({ ...review, accuracy: ev.target.value })} /></Field>
          <Field label="误报数"><Input type="number" value={review.false_positive} onChange={(ev) => setReview({ ...review, false_positive: ev.target.value })} /></Field>
          <Field label="备注" className="span-2"><Input value={review.notes} onChange={(ev) => setReview({ ...review, notes: ev.target.value })} /></Field>
        </div>
        <div className="form-actions">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void addReview()}>提交复核</Button>
        </div>
      </Card>

      <Card title="结论与 Go / No-Go" subtitle="结论必须带证据；No-Go / 有条件时写后续条件。">
        <div className="form-grid">
          <Field label="决策">
            <Select value={conclusion.decision} onChange={(ev) => setConclusion({ ...conclusion, decision: ev.target.value })}>
              {Object.entries(DECISION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="证据" required className="span-2">
            <Textarea rows={3} value={conclusion.evidence} onChange={(ev) => setConclusion({ ...conclusion, evidence: ev.target.value })} placeholder="样本量、指标、阈值对比、失败案例" />
          </Field>
          <Field label="后续条件" className="span-2">
            <Textarea rows={2} value={conclusion.conditions} onChange={(ev) => setConclusion({ ...conclusion, conditions: ev.target.value })} />
          </Field>
        </div>
        <div className="form-actions">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void saveConclusion()}>保存结论</Button>
          {data.conclusion ? (
            <Badge tone={data.conclusion.decision === 'go' ? 'green' : data.conclusion.decision === 'no_go' ? 'red' : 'amber'}>
              当前：{DECISION_LABEL[data.conclusion.decision] ?? data.conclusion.decision}
            </Badge>
          ) : null}
        </div>
      </Card>

      <Card
        title="生成 POC 报告"
        subtitle="实验设计、样本、运行、复核、结论 → 版本化交付物；可导出 Word。"
        actions={
          <div className="generate-bar">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void generateReport()}>
              生成 POC 报告
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void downloadReport()}>
              导出 Word
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
            报告按项目内 poc_report 类型自动版本化；Word 导出为当前实验的最新快照。
          </p>
        )}
      </Card>
    </div>
  );
}
