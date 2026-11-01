import { useState } from 'react';
import { api } from '../../api';
import { useLoad } from '../../hooks';
import type { EngagementDetail, User, ValueOverview } from '../../types';
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
import { fmtDate } from '../../utils';

const CONFIDENCE_LABEL: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

const RISK_STATUS: Record<string, string> = {
  open: '待处理',
  mitigating: '缓解中',
  closed: '已关闭',
};

const PROBABILITY_LABEL: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

const nowPeriod = () => new Date().toISOString().slice(0, 7);

const fmtNum = (v: number | null | undefined) =>
  v == null ? '—' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 });

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
  return { busy, error, runOp };
}

type ValueDocKind = 'value' | 'renewal';

const VALUE_DOC_LABEL: Record<ValueDocKind, string> = {
  value: '价值实现报告',
  renewal: '续约与二期建议',
};

export function ValueTab({
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
      const [o, u] = await Promise.all([api.valueOverview(engagementId), api.listUsers()]);
      return { overview: o, users: u.items };
    },
    [engagementId],
  );
  const g5 = useLoad(() => api.g5Checks(engagementId), [engagementId]);
  const [docType, setDocType] = useState<ValueDocKind>('value');
  const [docNotice, setDocNotice] = useState<string | null>(null);
  const [docBusy, setDocBusy] = useState(false);
  const [docError, setDocError] = useState<unknown>(null);

  const generateDoc = async () => {
    setDocBusy(true);
    setDocError(null);
    try {
      const res = await api.generateValueDocument(engagementId, docType);
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
      const blob = await api.exportValueDocx(engagementId, docType);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${VALUE_DOC_LABEL[docType]}.docx`;
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
    g5.reload();
    onChanged();
  };

  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorBox error={error} onRetry={() => void reload()} />;
  if (!data) return null;

  const { overview, users } = data;

  return (
    <div className="tab-body">
      <Card
        title="G5 价值实现门禁"
        subtitle="指标目标 → 周期快照 → 价值记录 → 使用数据 → 续约/二期。"
        actions={
          <Button size="sm" disabled={g5.loading} onClick={() => void g5.reload()}>
            刷新校验
          </Button>
        }
      >
        {g5.loading ? <Spinner label="校验中…" /> : null}
        {g5.error ? <ErrorBox error={g5.error} onRetry={() => void g5.reload()} /> : null}
        {g5.data ? (
          <>
            <div className="check-summary">
              <span className="check-pill check-pass">{g5.data.summary.pass} pass</span>
              <span className="check-pill check-warn">{g5.data.summary.warn} warn</span>
              <span className="check-pill check-block">{g5.data.summary.block} block</span>
            </div>
            <div className="check-list">
              {g5.data.checks.map((c) => (
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
        title="价值文档"
        subtitle="价值实现报告 / 续约与二期建议，生成后可在报告页导出 Word。"
        actions={
          <div className="generate-bar">
            <Select value={docType} onChange={(e) => setDocType(e.target.value as ValueDocKind)}>
              {Object.entries(VALUE_DOC_LABEL).map(([k, v]) => (
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
            报告中的每个数字都会追到指标快照或价值记录；偏差超过 10% 会单独列出。
          </p>
        )}
      </Card>

      <Card title="价值看板" subtitle="指标、快照与价值记录汇总；金额类指标按万元累计。">
        <div className="stat-grid">
          <Stat label="指标目标" value={overview.totals.targets} hint="按机会点" />
          <Stat label="周期快照" value={overview.totals.snapshots} tone="blue" />
          <Stat label="价值记录" value={overview.totals.values} tone="green" />
          <Stat label="实现价值" value={`${fmtNum(overview.totals.realizedValue)} 万`} tone="green" />
          <Stat label="活跃用户" value={overview.totals.activeUsers} tone="amber" />
          <Stat label="未关闭风险" value={overview.totals.openRisks} tone="amber" />
        </div>
      </Card>

      <TargetSection
        engagementId={engagementId}
        detail={detail}
        overview={overview}
        users={users}
        onChanged={after}
      />

      <SnapshotSection overview={overview} onChanged={after} />

      <ValueRecordSection
        engagementId={engagementId}
        detail={detail}
        overview={overview}
        users={users}
        onChanged={after}
      />

      <UsageSection engagementId={engagementId} overview={overview} onChanged={after} />

      <RenewalSection
        engagementId={engagementId}
        overview={overview}
        users={users}
        onChanged={after}
      />
    </div>
  );
}

function TargetSection({
  engagementId,
  detail,
  overview,
  users,
  onChanged,
}: {
  engagementId: string;
  detail: EngagementDetail;
  overview: ValueOverview;
  users: User[];
  onChanged: () => Promise<void> | void;
}) {
  const { busy, error, runOp } = useOps(onChanged);
  const opportunities = detail.opportunities;
  const [form, setForm] = useState({
    opportunity_id: opportunities[0]?.id ?? '',
    metric_id: overview.metrics[0]?.id ?? '',
    baseline: '',
    target: '',
    target_date: '',
    owner: '',
    note: '',
  });
  const metric = overview.metrics.find((m) => m.id === form.metric_id);

  const add = () =>
    runOp(async () => {
      if (!form.opportunity_id || !form.metric_id) throw new Error('机会点与指标必填');
      await api.createMetricTarget(engagementId, {
        opportunity_id: form.opportunity_id,
        metric_id: form.metric_id,
        baseline: form.baseline ? Number(form.baseline) : undefined,
        target: form.target ? Number(form.target) : undefined,
        target_date: form.target_date || undefined,
        owner: form.owner || undefined,
        note: form.note || undefined,
      });
      setForm({ ...form, baseline: '', target: '', target_date: '', note: '' });
    });

  return (
    <Card
      title="指标目标"
      subtitle="每个承诺收益都要有指标、基线、目标值和目标日期。"
      actions={<Badge tone="gray">{overview.targets.length} 个目标</Badge>}
    >
      {error ? <ErrorBox error={error} /> : null}
      {overview.targets.length === 0 ? (
        <Empty title="还没有指标目标" hint="从价值假设里挑指标，先定基线和目标。" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>机会点</th><th>指标</th><th>基线</th><th>目标</th><th>目标日期</th>
                <th>快照/价值</th><th>负责人</th><th />
              </tr>
            </thead>
            <tbody>
              {overview.targets.map((t) => (
                <tr key={t.id}>
                  <td><span className="mono">{t.opportunity_code}</span> {t.opportunity_title}</td>
                  <td><strong>{t.metric_name}</strong> <span className="muted">{t.unit}</span></td>
                  <td>{fmtNum(t.baseline)}</td>
                  <td>{fmtNum(t.target)}</td>
                  <td className="muted">{t.target_date ?? '—'}</td>
                  <td>{t.snapshot_count ?? 0} / {t.value_count ?? 0}</td>
                  <td>{t.owner_name || '—'}</td>
                  <td className="actions-cell">
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => void runOp(() => api.deleteMetricTarget(t.id))}>
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
        <Field label="机会点">
          <Select value={form.opportunity_id} onChange={(e) => setForm({ ...form, opportunity_id: e.target.value })}>
            {opportunities.map((o) => (
              <option key={o.id} value={o.id}>{o.code} · {o.title}</option>
            ))}
          </Select>
        </Field>
        <Field label="指标">
          <Select value={form.metric_id} onChange={(e) => setForm({ ...form, metric_id: e.target.value })}>
            {overview.metrics.map((m) => (
              <option key={m.id} value={m.id}>{m.name}（{m.unit || '无单位'}）</option>
            ))}
          </Select>
        </Field>
        <Field label={`基线${metric?.unit ? `（${metric.unit}）` : ''}`}>
          <Input type="number" value={form.baseline} onChange={(e) => setForm({ ...form, baseline: e.target.value })} />
        </Field>
        <Field label={`目标值${metric?.unit ? `（${metric.unit}）` : ''}`}>
          <Input type="number" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} />
        </Field>
        <Field label="目标日期">
          <Input type="date" value={form.target_date} onChange={(e) => setForm({ ...form, target_date: e.target.value })} />
        </Field>
        <Field label="负责人">
          <Select value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })}>
            <option value="">未指定</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
        </Field>
        <Field label="说明" className="span-2">
          <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </Field>
      </div>
      <div className="form-actions">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void add()}>添加指标目标</Button>
      </div>
    </Card>
  );
}

function SnapshotSection({
  overview,
  onChanged,
}: {
  overview: ValueOverview;
  onChanged: () => Promise<void> | void;
}) {
  const { busy, error, runOp } = useOps(onChanged);
  const [form, setForm] = useState({
    target_id: overview.targets[0]?.id ?? '',
    period: nowPeriod(),
    value: '',
    source: '',
    confidence: 'medium',
    note: '',
  });

  const add = () =>
    runOp(async () => {
      if (!form.target_id) throw new Error('请选择指标目标');
      if (!form.value) throw new Error('快照数值必填');
      if (!form.source.trim()) throw new Error('数据来源必填');
      await api.createSnapshot(form.target_id, {
        period: form.period,
        value: Number(form.value),
        source: form.source.trim(),
        confidence: form.confidence,
        note: form.note || undefined,
      });
      setForm({ ...form, value: '', source: '', note: '' });
    });

  return (
    <Card
      title="指标快照"
      subtitle={`每个目标每月至少一条快照；周期格式 YYYY-MM。`}
      actions={<Badge tone="gray">{overview.snapshots.length} 条</Badge>}
    >
      {error ? <ErrorBox error={error} /> : null}
      {overview.snapshots.length === 0 ? (
        <Empty title="还没有快照" hint="每月按同一口径记录实际值。" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>周期</th><th>指标</th><th>机会点</th><th>实际值</th><th>目标</th><th>来源</th><th>置信度</th><th /></tr>
            </thead>
            <tbody>
              {overview.snapshots.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.period}</td>
                  <td><strong>{s.metric_name}</strong> <span className="muted">{s.unit}</span></td>
                  <td className="muted">{s.opportunity_code}</td>
                  <td>{fmtNum(s.value)}</td>
                  <td>{fmtNum(s.target)}</td>
                  <td className="muted">{s.source}</td>
                  <td><Badge tone={s.confidence === 'high' ? 'green' : s.confidence === 'low' ? 'red' : 'amber'}>{CONFIDENCE_LABEL[s.confidence]}</Badge></td>
                  <td className="actions-cell">
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => void runOp(() => api.deleteSnapshot(s.id))}>
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
        <Field label="指标目标">
          <Select value={form.target_id} onChange={(e) => setForm({ ...form, target_id: e.target.value })}>
            <option value="">请选择</option>
            {overview.targets.map((t) => (
              <option key={t.id} value={t.id}>{t.opportunity_code} · {t.metric_name}</option>
            ))}
          </Select>
        </Field>
        <Field label="周期">
          <Input type="month" value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })} />
        </Field>
        <Field label="实际值">
          <Input type="number" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
        </Field>
        <Field label="置信度">
          <Select value={form.confidence} onChange={(e) => setForm({ ...form, confidence: e.target.value })}>
            {Object.entries(CONFIDENCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="数据来源" className="span-2">
          <Input placeholder="系统埋点 / 周报 / 财务确认" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} />
        </Field>
        <Field label="备注" className="span-2">
          <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </Field>
      </div>
      <div className="form-actions">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void add()}>记录快照</Button>
      </div>
    </Card>
  );
}

function ValueRecordSection({
  engagementId,
  detail,
  overview,
  users,
  onChanged,
}: {
  engagementId: string;
  detail: EngagementDetail;
  overview: ValueOverview;
  users: User[];
  onChanged: () => Promise<void> | void;
}) {
  const { busy, error, runOp } = useOps(onChanged);
  const [form, setForm] = useState({
    opportunity_id: detail.opportunities[0]?.id ?? '',
    target_id: '',
    metric_id: overview.metrics[0]?.id ?? '',
    period: nowPeriod(),
    realized_value: '',
    method: '',
    evidence: '',
    confidence: 'medium',
    variance_note: '',
    verified_by: users[0]?.id ?? '',
  });

  const pickTarget = (targetId: string) => {
    const t = overview.targets.find((x) => x.id === targetId);
    setForm({
      ...form,
      target_id: targetId,
      opportunity_id: t?.opportunity_id ?? form.opportunity_id,
      metric_id: t?.metric_id ?? form.metric_id,
    });
  };

  const add = () =>
    runOp(async () => {
      if (!form.opportunity_id || !form.metric_id) throw new Error('机会点与指标必填');
      if (!form.realized_value) throw new Error('实现值必填');
      if (!form.method.trim() || !form.evidence.trim()) throw new Error('归因方法与证据必填');
      if (!form.verified_by) throw new Error('请选择确认人');
      await api.createValueRecord(engagementId, {
        opportunity_id: form.opportunity_id,
        target_id: form.target_id || undefined,
        metric_id: form.metric_id,
        period: form.period,
        realized_value: Number(form.realized_value),
        method: form.method.trim(),
        evidence: form.evidence.trim(),
        confidence: form.confidence,
        variance_note: form.variance_note || undefined,
        verified_by: form.verified_by,
      });
      setForm({ ...form, realized_value: '', method: '', evidence: '', variance_note: '' });
    });

  return (
    <Card
      title="价值记录"
      subtitle="每条记录必须能追到归因方法、证据和确认人。"
      actions={<Badge tone="gray">{overview.values.length} 条</Badge>}
    >
      {error ? <ErrorBox error={error} /> : null}
      {overview.values.length === 0 ? (
        <Empty title="还没有价值记录" hint="按周期登记实际兑现的价值。" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>周期</th><th>机会点</th><th>指标</th><th>实现值</th><th>目标</th><th>方法/证据</th><th>置信度</th><th>确认人</th><th /></tr>
            </thead>
            <tbody>
              {overview.values.map((v) => (
                <tr key={v.id}>
                  <td className="mono">{v.period}</td>
                  <td className="muted">{v.opportunity_code}</td>
                  <td><strong>{v.metric_name}</strong> <span className="muted">{v.unit}</span></td>
                  <td>{fmtNum(v.realized_value)}</td>
                  <td>{fmtNum(v.target)}</td>
                  <td className="muted">
                    {v.method}
                    <div className="small">证据：{v.evidence}</div>
                  </td>
                  <td><Badge tone={v.confidence === 'high' ? 'green' : v.confidence === 'low' ? 'red' : 'amber'}>{CONFIDENCE_LABEL[v.confidence]}</Badge></td>
                  <td>{v.verified_by_name || '—'}</td>
                  <td className="actions-cell">
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => void runOp(() => api.deleteValueRecord(v.id))}>
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
        <Field label="关联目标（可选）" className="span-2">
          <Select value={form.target_id} onChange={(e) => pickTarget(e.target.value)}>
            <option value="">不关联</option>
            {overview.targets.map((t) => (
              <option key={t.id} value={t.id}>{t.opportunity_code} · {t.metric_name}</option>
            ))}
          </Select>
        </Field>
        <Field label="机会点">
          <Select value={form.opportunity_id} onChange={(e) => setForm({ ...form, opportunity_id: e.target.value })}>
            {detail.opportunities.map((o) => <option key={o.id} value={o.id}>{o.code} · {o.title}</option>)}
          </Select>
        </Field>
        <Field label="指标">
          <Select value={form.metric_id} onChange={(e) => setForm({ ...form, metric_id: e.target.value })}>
            {overview.metrics.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        </Field>
        <Field label="周期">
          <Input type="month" value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })} />
        </Field>
        <Field label="实现值"><Input type="number" value={form.realized_value} onChange={(e) => setForm({ ...form, realized_value: e.target.value })} /></Field>
        <Field label="归因方法" className="span-2">
          <Textarea rows={2} value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })} placeholder="如：上线前后各抽 100 单现场计时，取中位数" />
        </Field>
        <Field label="证据" className="span-2">
          <Input value={form.evidence} onChange={(e) => setForm({ ...form, evidence: e.target.value })} placeholder="数据来源 / 凭证编号" />
        </Field>
        <Field label="置信度">
          <Select value={form.confidence} onChange={(e) => setForm({ ...form, confidence: e.target.value })}>
            {Object.entries(CONFIDENCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="确认人">
          <Select value={form.verified_by} onChange={(e) => setForm({ ...form, verified_by: e.target.value })}>
            <option value="">请选择</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
        </Field>
        <Field label="差异说明（偏差 >10% 必填）" className="span-2">
          <Input value={form.variance_note} onChange={(e) => setForm({ ...form, variance_note: e.target.value })} />
        </Field>
      </div>
      <div className="form-actions">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void add()}>登记价值记录</Button>
      </div>
    </Card>
  );
}

function UsageSection({
  engagementId,
  overview,
  onChanged,
}: {
  engagementId: string;
  overview: ValueOverview;
  onChanged: () => Promise<void> | void;
}) {
  const { busy, error, runOp } = useOps(onChanged);
  const [form, setForm] = useState({
    period: nowPeriod(), active_users: '', volume: '', errors: '', source: '', note: '',
  });

  const add = () =>
    runOp(async () => {
      if (!form.source.trim()) throw new Error('数据来源必填');
      await api.createUsageRecord(engagementId, {
        period: form.period,
        active_users: form.active_users ? Number(form.active_users) : 0,
        volume: form.volume ? Number(form.volume) : 0,
        errors: form.errors ? Number(form.errors) : 0,
        source: form.source.trim(),
        note: form.note || undefined,
      });
      setForm({ ...form, active_users: '', volume: '', errors: '', source: '', note: '' });
    });

  return (
    <Card
      title="使用数据"
      subtitle="活跃用户、处理量、错误数；错误率超过 5% 会在 G5 提示。"
      actions={<Badge tone="gray">{overview.usage.length} 条</Badge>}
    >
      {error ? <ErrorBox error={error} /> : null}
      {overview.usage.length === 0 ? (
        <Empty title="还没有使用数据" hint="每月登记一次实际使用情况。" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>周期</th><th>方案版本</th><th>活跃用户</th><th>处理量</th><th>错误数</th><th>错误率</th><th>来源</th><th /></tr>
            </thead>
            <tbody>
              {overview.usage.map((u) => (
                <tr key={u.id}>
                  <td className="mono">{u.period}</td>
                  <td className="muted">{u.solution_version ? `v${u.solution_version}` : '—'}</td>
                  <td>{u.active_users}</td>
                  <td>{fmtNum(u.volume)}</td>
                  <td>{u.errors}</td>
                  <td>{u.volume > 0 ? `${((u.errors / u.volume) * 100).toFixed(2)}%` : '—'}</td>
                  <td className="muted">{u.source}</td>
                  <td className="actions-cell">
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => void runOp(() => api.deleteUsageRecord(u.id))}>
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
        <Field label="周期"><Input type="month" value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })} /></Field>
        <Field label="活跃用户"><Input type="number" value={form.active_users} onChange={(e) => setForm({ ...form, active_users: e.target.value })} /></Field>
        <Field label="处理量"><Input type="number" value={form.volume} onChange={(e) => setForm({ ...form, volume: e.target.value })} /></Field>
        <Field label="错误数"><Input type="number" value={form.errors} onChange={(e) => setForm({ ...form, errors: e.target.value })} /></Field>
        <Field label="来源"><Input value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} placeholder="系统埋点 / 运维周报" /></Field>
        <Field label="备注"><Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
      </div>
      <div className="form-actions">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void add()}>登记使用数据</Button>
      </div>
    </Card>
  );
}

function RenewalSection({
  engagementId,
  overview,
  users,
  onChanged,
}: {
  engagementId: string;
  overview: ValueOverview;
  users: User[];
  onChanged: () => Promise<void> | void;
}) {
  const { busy, error, runOp } = useOps(onChanged);
  const [form, setForm] = useState({
    kind: 'renewal', title: '', probability: 'medium', impact: '', action: '',
    owner: '', due_date: '', value_potential: '', status: 'open', note: '',
  });

  const add = () =>
    runOp(async () => {
      if (!form.title.trim()) throw new Error('风险标题必填');
      await api.createRenewalRisk(engagementId, {
        ...form,
        impact: form.impact || undefined,
        action: form.action || undefined,
        owner: form.owner || undefined,
        due_date: form.due_date || undefined,
        value_potential: form.value_potential ? Number(form.value_potential) : undefined,
        note: form.note || undefined,
      });
      setForm({ ...form, title: '', impact: '', action: '', due_date: '', value_potential: '', note: '' });
    });

  return (
    <Card
      title="续约与二期"
      subtitle="未关闭风险必须有应对动作、负责人和截止日期。"
      actions={<Badge tone="gray">{overview.risks.length} 条</Badge>}
    >
      {error ? <ErrorBox error={error} /> : null}
      {overview.risks.length === 0 ? (
        <Empty title="还没有续约/二期记录" hint="价值实现后，同步评估续约风险与二期机会。" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>类型</th><th>标题</th><th>概率</th><th>应对动作</th><th>负责人</th><th>截止</th><th>潜在价值</th><th>状态</th><th /></tr>
            </thead>
            <tbody>
              {overview.risks.map((r) => (
                <tr key={r.id}>
                  <td><Badge tone={r.kind === 'expansion' ? 'blue' : 'amber'}>{r.kind === 'expansion' ? '二期' : '续约'}</Badge></td>
                  <td>
                    <strong>{r.title}</strong>
                    <div className="muted small">{r.impact || ''}</div>
                  </td>
                  <td><Badge tone={r.probability === 'high' ? 'red' : r.probability === 'low' ? 'gray' : 'amber'}>{PROBABILITY_LABEL[r.probability]}</Badge></td>
                  <td className="muted">{r.action || '—'}</td>
                  <td>{r.owner_name || '—'}</td>
                  <td className="muted">{r.due_date ? fmtDate(r.due_date) : '—'}</td>
                  <td>{r.value_potential != null ? `${fmtNum(r.value_potential)} 万` : '—'}</td>
                  <td>
                    <Select
                      value={r.status}
                      disabled={busy}
                      onChange={(e) => void runOp(() => api.updateRenewalRisk(r.id, { status: e.target.value }))}
                    >
                      {Object.entries(RISK_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </Select>
                  </td>
                  <td className="actions-cell">
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => void runOp(() => api.deleteRenewalRisk(r.id))}>
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
            <option value="renewal">续约风险</option>
            <option value="expansion">二期机会</option>
          </Select>
        </Field>
        <Field label="标题"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
        <Field label="概率">
          <Select value={form.probability} onChange={(e) => setForm({ ...form, probability: e.target.value })}>
            {Object.entries(PROBABILITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="潜在价值（万元）"><Input type="number" value={form.value_potential} onChange={(e) => setForm({ ...form, value_potential: e.target.value })} /></Field>
        <Field label="影响" className="span-2"><Input value={form.impact} onChange={(e) => setForm({ ...form, impact: e.target.value })} /></Field>
        <Field label="应对动作" className="span-2"><Textarea rows={2} value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })} /></Field>
        <Field label="负责人">
          <Select value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })}>
            <option value="">未指定</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
        </Field>
        <Field label="截止日期"><Input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></Field>
        <Field label="状态">
          <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            {Object.entries(RISK_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
      </div>
      <div className="form-actions">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void add()}>添加记录</Button>
      </div>
    </Card>
  );
}
