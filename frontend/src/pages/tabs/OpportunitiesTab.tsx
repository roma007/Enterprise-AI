import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { ImportModal } from '../../components/ImportModal';
import { useDebouncedValue, useLoad, usePaged } from '../../hooks';
import type {
  ChainStage,
  OpportunityDetail,
  OpportunityRow,
  PainPoint,
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
  Select,
  Spinner,
  Textarea,
} from '../../ui';
import {
  confidenceLabel,
  confidenceTone,
  fmtMoney,
  oppStageLabel,
  phaseLabel,
  priorityLabel,
  priorityTone,
  realizationModeLabel,
} from '../../utils';

interface SideBundle {
  pains: PainPoint[];
  users: User[];
}

export function OpportunitiesTab({
  engagementId,
  selectedId,
  onSelect,
  onChanged,
}: {
  engagementId: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChanged: () => void;
}) {
  const [search, setSearch] = useState('');
  const dq = useDebouncedValue(search, 300);
  const oppsPaged = usePaged(
    (limit, offset) => api.listOpportunities(engagementId, { limit, offset, q: dq }),
    [engagementId, dq],
  );
  const { data, error: sideError, loading: sideLoading, reload: reloadSide } = useLoad<SideBundle>(
    async () => {
      const [p, u] = await Promise.all([
        api.listPains(engagementId, { limit: 500 }),
        api.listUsers(),
      ]);
      return { pains: p.items, users: u.items };
    },
    [engagementId],
  );
  const loading = oppsPaged.loading || sideLoading;
  const error = oppsPaged.error ?? sideError;
  const reload = async () => {
    await Promise.all([oppsPaged.reload(), reloadSide()]);
  };

  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);
  const [form, setForm] = useState({
    title: '',
    value_score: '4',
    feasibility_score: '4',
    urgency: '1',
    score_rationale: '',
    data_status: 'ready',
    target_phase: 'phase1',
    has_tech_blocker: false,
    tech_blocker_note: '',
    stage: 'scored',
  });

  const opps = oppsPaged.items;
  const current = selectedId ?? opps[0]?.id ?? null;

  useEffect(() => {
    if (!selectedId && opps.length) onSelect(opps[0].id);
  }, [opps, selectedId, onSelect]);

  const afterChange = async () => {
    await reload();
    onChanged();
  };

  const create = async () => {
    setCreateError(null);
    try {
      const res = await api.createOpportunity(engagementId, {
        title: form.title.trim(),
        value_score: Number(form.value_score),
        feasibility_score: Number(form.feasibility_score),
        urgency: Number(form.urgency),
        score_rationale: form.score_rationale.trim(),
        data_status: form.data_status,
        target_phase: form.target_phase,
        has_tech_blocker: form.has_tech_blocker,
        tech_blocker_note: form.has_tech_blocker
          ? form.tech_blocker_note.trim() || undefined
          : undefined,
        stage: form.stage,
      });
      setCreateOpen(false);
      setForm({
        title: '',
        value_score: '4',
        feasibility_score: '4',
        urgency: '1',
        score_rationale: '',
        data_status: 'ready',
        target_phase: 'phase1',
        has_tech_blocker: false,
        tech_blocker_note: '',
        stage: 'scored',
      });
      await reload();
      onChanged();
      onSelect(res.item.id);
    } catch (err) {
      setCreateError(err);
    }
  };

  if (loading && opps.length === 0) return <Spinner />;
  if (error && opps.length === 0) return <ErrorBox error={error} onRetry={() => void reload()} />;

  return (
    <div className="tab-body">
      <div className="opp-layout">
        <Card
          title="机会点"
          subtitle={`${oppsPaged.total} 个；V × F × U 自动算分。`}
          actions={
            <>
              <Input
                placeholder="搜索编号/标题/描述"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <Button size="sm" onClick={() => setImportOpen(true)}>
                导入 CSV/Excel
              </Button>
              <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
                + 新建
              </Button>
            </>
          }
          className="opp-list-card"
        >
          {opps.length === 0 ? (
            <Empty title="还没有机会点" hint="至少 3 个机会点，G1 才会通过。" />
          ) : (
            <div className="opp-list">
              {opps.map((o) => (
                <button
                  key={o.id}
                  className={`opp-item ${current === o.id ? 'opp-item-active' : ''}`}
                  onClick={() => onSelect(o.id)}
                >
                  <div className="opp-item-top">
                    <span className="mono">{o.code}</span>
                    <Badge tone={priorityTone(o.priority_band)}>
                      {priorityLabel(o.priority_band)}
                    </Badge>
                  </div>
                  <strong>{o.title}</strong>
                  <div className="opp-item-meta">
                    <span>得分 {o.score}</span>
                    <span>{phaseLabel(o.target_phase)}</span>
                    <span>{oppStageLabel(o.stage)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
          {oppsPaged.hasMore ? (
            <div className="form-actions">
              <Button
                size="sm"
                disabled={oppsPaged.loadingMore}
                onClick={() => void oppsPaged.loadMore()}
              >
                {oppsPaged.loadingMore
                  ? '加载中…'
                  : `加载更多（已显示 ${opps.length} / ${oppsPaged.total}）`}
              </Button>
            </div>
          ) : null}
        </Card>

        <div className="opp-editor">
          {current ? (
            <OpportunityEditor
              opportunityId={current}
              pains={data?.pains ?? []}
              users={data?.users ?? []}
              onChanged={() => void afterChange()}
              onDeleted={() => {
                onSelect(null);
                void afterChange();
              }}
            />
          ) : (
            <Card>
              <Empty title="选择一个机会点" hint="右侧编辑基线、ROI、传导链和收益形态。" />
            </Card>
          )}
        </div>
      </div>

      <Modal
        open={createOpen}
        title="新建机会点"
        subtitle="评分 = 价值 × 可行性 × 紧迫度；≥20 优先，12–19 候选，<12 搁置。"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button onClick={() => setCreateOpen(false)}>取消</Button>
            <Button variant="primary" onClick={() => void create()}>
              创建
            </Button>
          </>
        }
      >
        {createError ? <ErrorBox error={createError} /> : null}
        <div className="form-grid">
          <Field label="机会点名称" required className="span-2">
            <Input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="如：订单/托书自动结构化录入"
            />
          </Field>
          <Field label="价值 V（1–5）">
            <Input
              type="number"
              min={1}
              max={5}
              value={form.value_score}
              onChange={(e) => setForm({ ...form, value_score: e.target.value })}
            />
          </Field>
          <Field label="可行性 F（1–5）">
            <Input
              type="number"
              min={1}
              max={5}
              value={form.feasibility_score}
              onChange={(e) => setForm({ ...form, feasibility_score: e.target.value })}
            />
          </Field>
          <Field label="紧迫度 U">
            <Select
              value={form.urgency}
              onChange={(e) => setForm({ ...form, urgency: e.target.value })}
            >
              <option value="0.8">0.8 不紧急</option>
              <option value="1">1.0 常规</option>
              <option value="1.2">1.2 紧急</option>
            </Select>
          </Field>
          <Field label="数据状态">
            <Select
              value={form.data_status}
              onChange={(e) => setForm({ ...form, data_status: e.target.value })}
            >
              <option value="ready">数据就绪</option>
              <option value="need_apply">需申请</option>
              <option value="need_build">需建设</option>
              <option value="unavailable">不可得</option>
            </Select>
          </Field>
          <Field label="目标期">
            <Select
              value={form.target_phase}
              onChange={(e) => setForm({ ...form, target_phase: e.target.value })}
            >
              <option value="phase1">一期</option>
              <option value="phase2">二期</option>
              <option value="watch">观望</option>
            </Select>
          </Field>
          <Field label="阶段">
            <Select
              value={form.stage}
              onChange={(e) => setForm({ ...form, stage: e.target.value })}
            >
              <option value="candidate">候选</option>
              <option value="scored">已评估</option>
              <option value="selected">已选</option>
              <option value="designed">方案设计</option>
            </Select>
          </Field>
          <Field label="评分理由" required className="span-2">
            <Textarea
              rows={3}
              value={form.score_rationale}
              onChange={(e) => setForm({ ...form, score_rationale: e.target.value })}
              placeholder="V / F / U 各为什么是这个分？数字与依据要能追溯。"
            />
          </Field>
          <label className="checkbox-line span-2">
            <input
              type="checkbox"
              checked={form.has_tech_blocker}
              onChange={(e) => setForm({ ...form, has_tech_blocker: e.target.checked })}
            />
            存在技术阻断
          </label>
          {form.has_tech_blocker && (
            <Field label="阻断说明" required className="span-2">
              <Input
                value={form.tech_blocker_note}
                onChange={(e) => setForm({ ...form, tech_blocker_note: e.target.value })}
                placeholder="不填会触发数据库 CHECK，接口返回 422"
              />
            </Field>
          )}
        </div>
      </Modal>

      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        engagementId={engagementId}
        kind="opportunities"
        onImported={async () => {
          await reload();
          onChanged();
        }}
      />
    </div>
  );
}

function OpportunityEditor({
  opportunityId,
  pains,
  users,
  onChanged,
  onDeleted,
}: {
  opportunityId: string;
  pains: PainPoint[];
  users: User[];
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const { data, error, loading, reload } = useLoad<OpportunityDetail>(
    () => api.getOpportunity(opportunityId),
    [opportunityId],
  );

  const [basic, setBasic] = useState({
    title: '',
    stage: 'scored',
    target_phase: 'phase1',
    data_status: 'ready',
    value_score: '4',
    feasibility_score: '4',
    urgency: '1',
    score_rationale: '',
    has_tech_blocker: false,
    tech_blocker_note: '',
  });
  const [roi, setRoi] = useState({
    benefit_type: 'efficiency',
    neutral_value: '',
    conservative_value: '',
    optimistic_value: '',
    one_time_cost: '',
    annual_cost: '',
    confidence: 'medium',
    assumptions_note: '',
  });
  const [chain, setChain] = useState<ChainForm[]>([]);
  const [baseline, setBaseline] = useState({
    metric: '',
    value: '',
    unit: '',
    source: '',
    confidence: 'medium',
  });
  const [confirm, setConfirm] = useState({
    mode: 'no_headcount_growth',
    note: '',
    confirmed_by: '',
  });
  const [selectedPains, setSelectedPains] = useState<Set<string>>(new Set());
  const [errorBox, setErrorBox] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    const o = data.item;
    setBasic({
      title: o.title,
      stage: o.stage,
      target_phase: o.target_phase ?? 'watch',
      data_status: o.data_status,
      value_score: String(o.value_score),
      feasibility_score: String(o.feasibility_score),
      urgency: String(o.urgency),
      score_rationale: o.score_rationale,
      has_tech_blocker: o.has_tech_blocker,
      tech_blocker_note: o.tech_blocker_note ?? '',
    });
    setRoi({
      benefit_type: data.roi?.benefit_type ?? 'efficiency',
      neutral_value: data.roi ? String(data.roi.neutral_value) : '',
      conservative_value: data.roi?.conservative_value != null ? String(data.roi.conservative_value) : '',
      optimistic_value: data.roi?.optimistic_value != null ? String(data.roi.optimistic_value) : '',
      one_time_cost: data.roi ? String(data.roi.one_time_cost) : '',
      annual_cost: data.roi ? String(data.roi.annual_cost) : '',
      confidence: data.roi?.confidence ?? 'medium',
      assumptions_note: data.roi?.assumptions_note ?? '',
    });
    setChain(data.chain.map(toChainForm));
    setConfirm({
      mode: data.roi?.realization_mode ?? 'no_headcount_growth',
      note: data.roi?.realization_note ?? '',
      confirmed_by: '',
    });
    setSelectedPains(new Set(data.painPoints.map((p) => p.id)));
  }, [data]);

  const after = async () => {
    await reload();
    onChanged();
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

  const product = useMemo(() => {
    const active = chain.filter((c) => !c.is_derived);
    if (!active.length) return null;
    return Number(
      active
        .reduce((acc, c) => acc * (Number(c.mult_base) || 0), 1)
        .toFixed(4),
    );
  }, [chain]);

  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorBox error={error} onRetry={() => void reload()} />;
  if (!data) return null;

  const o = data.item;
  const hasBaseline = data.baselines.length > 0;
  const hasChain = data.chain.length > 0;
  const confirmed = !!data.roi?.realization_confirmed_at;
  const factorMatch =
    data.roi?.realization_factor != null &&
    product != null &&
    Math.abs(data.roi.realization_factor - product) <= 0.005;

  const saveBasic = () =>
    run(() =>
      api.updateOpportunity(o.id, {
        title: basic.title,
        stage: basic.stage,
        target_phase: basic.target_phase,
        data_status: basic.data_status,
        value_score: Number(basic.value_score),
        feasibility_score: Number(basic.feasibility_score),
        urgency: Number(basic.urgency),
        score_rationale: basic.score_rationale,
        has_tech_blocker: basic.has_tech_blocker,
        tech_blocker_note: basic.has_tech_blocker
          ? basic.tech_blocker_note || undefined
          : null,
      }),
    );

  const saveRoi = () =>
    run(() =>
      api.saveRoi(o.id, {
        benefit_type: roi.benefit_type,
        neutral_value: Number(roi.neutral_value),
        conservative_value: roi.conservative_value ? Number(roi.conservative_value) : undefined,
        optimistic_value: roi.optimistic_value ? Number(roi.optimistic_value) : undefined,
        one_time_cost: roi.one_time_cost ? Number(roi.one_time_cost) : 0,
        annual_cost: roi.annual_cost ? Number(roi.annual_cost) : 0,
        confidence: roi.confidence,
        assumptions_note: roi.assumptions_note || undefined,
      }),
    );

  const saveChain = () =>
    run(() =>
      api.saveChain(
        o.id,
        chain.map((c) => ({
          stage: Number(c.stage),
          variable_key: c.variable_key,
          variable_label: c.variable_label,
          unit: c.unit || undefined,
          base_value: c.base_value ? Number(c.base_value) : undefined,
          low_value: c.low_value ? Number(c.low_value) : undefined,
          mult_base: Number(c.mult_base),
          mult_low: c.mult_low ? Number(c.mult_low) : undefined,
          shape: c.shape,
          controllable: c.controllable,
          owner_role: c.owner_role || undefined,
          is_derived: c.is_derived,
        })),
      ),
    );

  const addBaseline = () =>
    run(async () => {
      await api.createBaseline(o.id, {
        metric: baseline.metric.trim(),
        value: Number(baseline.value),
        unit: baseline.unit || undefined,
        source: baseline.source.trim(),
        confidence: baseline.confidence,
      });
      setBaseline({ metric: '', value: '', unit: '', source: '', confidence: 'medium' });
    });

  const confirmRoi = () =>
    run(() =>
      api.confirmRoi(o.id, {
        mode: confirm.mode,
        note: confirm.note.trim(),
        confirmed_by: confirm.confirmed_by,
      }),
    );

  const linkPains = () =>
    run(() => api.setOpportunityPains(o.id, [...selectedPains]));

  return (
    <div className="editor-stack">
      <Card
        title={
          <span className="title-with-code">
            <span className="mono">{o.code}</span> {o.title}
          </span>
        }
        subtitle={
          <span className="header-meta">
            <Badge tone={priorityTone(o.priority_band)}>{priorityLabel(o.priority_band)}</Badge>
            <span className="muted">得分 {o.score}</span>
            <span className="muted">{oppStageLabel(o.stage)}</span>
            <span className="muted">{phaseLabel(o.target_phase)}</span>
          </span>
        }
        actions={
          <Button
            size="sm"
            variant="danger"
            onClick={async () => {
              if (!window.confirm(`删除机会点 ${o.code}？其 ROI、基线、传导链会一并删除。`)) return;
              await api.deleteOpportunity(o.id);
              onDeleted();
            }}
          >
            删除
          </Button>
        }
      >
        <div className="readiness">
          <Readiness ok={hasBaseline} label="基线" />
          <Readiness ok={!!data.roi} label="ROI 卡" />
          <Readiness ok={hasChain} label="传导链" />
          <Readiness ok={confirmed} label="收益形态" />
          {product != null && (
            <span className="muted">
              链条乘积 <strong>{product}</strong>
              {data.roi?.realization_factor != null && (
                <Badge tone={factorMatch ? 'green' : 'red'}>
                  {factorMatch ? '与系数一致' : `系数 ${data.roi.realization_factor}`}
                </Badge>
              )}
            </span>
          )}
        </div>
        {errorBox ? <ErrorBox error={errorBox} /> : null}

        <details className="disclosure" open>
          <summary>基本信息与评分</summary>
          <div className="form-grid">
            <Field label="名称" className="span-2">
              <Input value={basic.title} onChange={(e) => setBasic({ ...basic, title: e.target.value })} />
            </Field>
            <Field label="阶段">
              <Select value={basic.stage} onChange={(e) => setBasic({ ...basic, stage: e.target.value })}>
                {[
                  ['candidate', '候选'], ['scored', '已评估'], ['selected', '已选'],
                  ['designed', '方案设计'], ['piloting', 'POC 中'], ['validated', '已验证'],
                  ['delivering', '交付中'], ['live', '已上线'], ['realized', '价值达成'],
                  ['closed', '关闭'], ['parked', '搁置'], ['killed', '终止'],
                ].map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
            </Field>
            <Field label="目标期">
              <Select
                value={basic.target_phase}
                onChange={(e) => setBasic({ ...basic, target_phase: e.target.value })}
              >
                <option value="phase1">一期</option>
                <option value="phase2">二期</option>
                <option value="watch">观望</option>
              </Select>
            </Field>
            <Field label="数据状态">
              <Select
                value={basic.data_status}
                onChange={(e) => setBasic({ ...basic, data_status: e.target.value })}
              >
                <option value="ready">就绪</option>
                <option value="need_apply">需申请</option>
                <option value="need_build">需建设</option>
                <option value="unavailable">不可得</option>
              </Select>
            </Field>
            <Field label="价值 V">
              <Input type="number" min={1} max={5} value={basic.value_score} onChange={(e) => setBasic({ ...basic, value_score: e.target.value })} />
            </Field>
            <Field label="可行性 F">
              <Input type="number" min={1} max={5} value={basic.feasibility_score} onChange={(e) => setBasic({ ...basic, feasibility_score: e.target.value })} />
            </Field>
            <Field label="紧迫度 U">
              <Select value={basic.urgency} onChange={(e) => setBasic({ ...basic, urgency: e.target.value })}>
                <option value="0.8">0.8</option>
                <option value="1">1.0</option>
                <option value="1.2">1.2</option>
              </Select>
            </Field>
            <Field label="评分理由" className="span-2">
              <Textarea rows={2} value={basic.score_rationale} onChange={(e) => setBasic({ ...basic, score_rationale: e.target.value })} />
            </Field>
            <label className="checkbox-line span-2">
              <input
                type="checkbox"
                checked={basic.has_tech_blocker}
                onChange={(e) => setBasic({ ...basic, has_tech_blocker: e.target.checked })}
              />
              存在技术阻断
            </label>
            {basic.has_tech_blocker && (
              <Field label="阻断说明" className="span-2">
                <Input value={basic.tech_blocker_note} onChange={(e) => setBasic({ ...basic, tech_blocker_note: e.target.value })} />
              </Field>
            )}
          </div>
          <div className="form-actions">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void saveBasic()}>
              保存基本信息
            </Button>
          </div>
        </details>
      </Card>

      <Card title="基线" subtitle="没有基线，ROI 置信度会被 R2 强制降为 low。">
        {data.baselines.length === 0 ? (
          <Empty title="还没有基线" hint="至少一条真实基线，C1 才允许进入方案设计。" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>指标</th>
                  <th>值</th>
                  <th>来源</th>
                  <th>置信度</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.baselines.map((b) => (
                  <tr key={b.id}>
                    <td>{b.metric}</td>
                    <td>
                      {b.value}
                      {b.unit || ''}
                    </td>
                    <td className="muted">{b.source}</td>
                    <td>
                      <Badge tone={confidenceTone(b.confidence)}>{confidenceLabel(b.confidence)}</Badge>
                    </td>
                    <td className="actions-cell">
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => void run(() => api.deleteBaseline(b.id))}
                      >
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
          <Input placeholder="指标" value={baseline.metric} onChange={(e) => setBaseline({ ...baseline, metric: e.target.value })} />
          <Input type="number" placeholder="值" value={baseline.value} onChange={(e) => setBaseline({ ...baseline, value: e.target.value })} />
          <Input placeholder="单位" value={baseline.unit} onChange={(e) => setBaseline({ ...baseline, unit: e.target.value })} />
          <Input placeholder="来源" value={baseline.source} onChange={(e) => setBaseline({ ...baseline, source: e.target.value })} />
          <Select value={baseline.confidence} onChange={(e) => setBaseline({ ...baseline, confidence: e.target.value })}>
            <option value="high">高</option>
            <option value="medium">中</option>
            <option value="low">低</option>
          </Select>
          <Button variant="primary" disabled={busy} onClick={() => void addBaseline()}>
            添加
          </Button>
        </div>
      </Card>

      <Card title="ROI 卡" subtitle="金额单位万元/年；可实现收益与回本由数据库生成列计算。">
        <div className="form-grid">
          <Field label="收益类型">
            <Select value={roi.benefit_type} onChange={(e) => setRoi({ ...roi, benefit_type: e.target.value })}>
              {Object.entries({ cost_reduction: '降本', efficiency: '提效', revenue: '增收', risk: '风险' }).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </Field>
          <Field label="理论年化收益（万）" required>
            <Input type="number" value={roi.neutral_value} onChange={(e) => setRoi({ ...roi, neutral_value: e.target.value })} />
          </Field>
          <Field label="一次性投入（万）">
            <Input type="number" value={roi.one_time_cost} onChange={(e) => setRoi({ ...roi, one_time_cost: e.target.value })} />
          </Field>
          <Field label="年运维（万）">
            <Input type="number" value={roi.annual_cost} onChange={(e) => setRoi({ ...roi, annual_cost: e.target.value })} />
          </Field>
          <Field label="置信度">
            <Select value={roi.confidence} onChange={(e) => setRoi({ ...roi, confidence: e.target.value })}>
              <option value="high">高</option>
              <option value="medium">中</option>
              <option value="low">低</option>
            </Select>
          </Field>
          <Field label="口径假设" className="span-2">
            <Input value={roi.assumptions_note} onChange={(e) => setRoi({ ...roi, assumptions_note: e.target.value })} />
          </Field>
        </div>
        <div className="form-actions">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void saveRoi()}>
            保存 ROI
          </Button>
          {data.roi && (
            <span className="muted">
              可实现 {fmtMoney(data.roi.realized_value)} · 回本{' '}
              {data.roi.payback_months ?? '—'} 个月 · 含运维{' '}
              {data.roi.payback_months_with_ops ?? '—'} 个月 · 置信度 {confidenceLabel(data.roi.confidence)}
            </span>
          )}
        </div>
      </Card>

      <Card
        title="传导链"
        subtitle="逐段连乘得出实现系数；派生变量放 90 以后，不参与乘法。"
        actions={
          <Button
            size="sm"
            onClick={() =>
              setChain((prev) => [
                ...prev,
                {
                  stage: String(
                    Math.max(0, ...prev.filter((c) => !c.is_derived).map((c) => Number(c.stage) || 0)) + 1,
                  ),
                  variable_key: '',
                  variable_label: '',
                  unit: '%',
                  base_value: '',
                  low_value: '',
                  mult_base: '0.9',
                  mult_low: '',
                  shape: 'linear',
                  controllable: true,
                  owner_role: '',
                  is_derived: false,
                },
              ])
            }
          >
            + 一段
          </Button>
        }
      >
        {chain.length === 0 ? (
          <Empty title="还没有传导链" hint="先建 ROI 卡，再加段；乘积会写回实现系数。" />
        ) : (
          <div className="chain-editor">
            {chain.map((c, idx) => (
              <div key={idx} className="chain-row">
                <Input
                  type="number"
                  title="段号"
                  value={c.stage}
                  onChange={(e) => setChain((prev) => prev.map((x, i) => (i === idx ? { ...x, stage: e.target.value } : x)))}
                />
                <Input placeholder="变量 key" value={c.variable_key} onChange={(e) => setChain((prev) => prev.map((x, i) => (i === idx ? { ...x, variable_key: e.target.value } : x)))} />
                <Input placeholder="变量名称" value={c.variable_label} onChange={(e) => setChain((prev) => prev.map((x, i) => (i === idx ? { ...x, variable_label: e.target.value } : x)))} />
                <Input placeholder="基准值" value={c.base_value} onChange={(e) => setChain((prev) => prev.map((x, i) => (i === idx ? { ...x, base_value: e.target.value } : x)))} />
                <Input type="number" step="0.01" placeholder="系数" value={c.mult_base} onChange={(e) => setChain((prev) => prev.map((x, i) => (i === idx ? { ...x, mult_base: e.target.value } : x)))} />
                <Input type="number" step="0.01" placeholder="悲观系数" value={c.mult_low} onChange={(e) => setChain((prev) => prev.map((x, i) => (i === idx ? { ...x, mult_low: e.target.value } : x)))} />
                <Select value={c.shape} onChange={(e) => setChain((prev) => prev.map((x, i) => (i === idx ? { ...x, shape: e.target.value as 'linear' | 'threshold' } : x)))}>
                  <option value="linear">线性</option>
                  <option value="threshold">阈值型</option>
                </Select>
                <label className="checkbox-line compact">
                  <input type="checkbox" checked={c.is_derived} onChange={(e) => setChain((prev) => prev.map((x, i) => (i === idx ? { ...x, is_derived: e.target.checked } : x)))} />
                  派生
                </label>
                <Button size="sm" variant="danger" onClick={() => setChain((prev) => prev.filter((_, i) => i !== idx))}>
                  删
                </Button>
              </div>
            ))}
          </div>
        )}
        <div className="form-actions">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void saveChain()}>
            保存传导链
          </Button>
          {product != null && <span className="muted">当前乘积 <strong>{product}</strong></span>}
        </div>
      </Card>

      <Card title="收益实现形态" subtitle="系数由链条乘积写回，不手填；理由至少 10 个字并署名。">
        {confirmed ? (
          <div className="confirmed-box">
            <Badge tone="green">已确认</Badge>
            <strong>{realizationModeLabel(data.roi?.realization_mode)}</strong>
            <span>系数 {data.roi?.realization_factor}</span>
            <span className="muted">{data.roi?.realization_confirmed_at ? new Date(data.roi.realization_confirmed_at).toLocaleString() : ''}</span>
            <p>{data.roi?.realization_note}</p>
          </div>
        ) : (
          <div className="form-grid">
            <Field label="实现形态">
              <Select value={confirm.mode} onChange={(e) => setConfirm({ ...confirm, mode: e.target.value })}>
                {Object.entries({ cut: '裁员兑现', no_headcount_growth: '不增人', redeploy: '转岗', revenue: '直接增收', cost_avoidance: '避免成本' }).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
            </Field>
            <Field label="确认人" required>
              <Select value={confirm.confirmed_by} onChange={(e) => setConfirm({ ...confirm, confirmed_by: e.target.value })}>
                <option value="">请选择</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="判断理由（≥10 字）" required className="span-2">
              <Textarea rows={3} value={confirm.note} onChange={(e) => setConfirm({ ...confirm, note: e.target.value })} placeholder="为什么这个收益按不增人/增收/裁员兑现？" />
            </Field>
          </div>
        )}
        {!confirmed && (
          <div className="form-actions">
            <Button size="sm" variant="primary" disabled={busy || !hasChain} onClick={() => void confirmRoi()}>
              确认收益形态
            </Button>
            {!hasChain && <span className="muted">先保存传导链才能确认。</span>}
          </div>
        )}
      </Card>

      <Card title="关联痛点" subtitle="R1：无来源或已归并的痛点不能关联。">
        {pains.length === 0 ? (
          <Empty title="还没有痛点" hint="先去痛点页录入。" />
        ) : (
          <div className="checkbox-grid">
            {pains.map((p) => (
              <label key={p.id} className="checkbox-line">
                <input
                  type="checkbox"
                  checked={selectedPains.has(p.id)}
                  onChange={(e) => {
                    setSelectedPains((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(p.id);
                      else next.delete(p.id);
                      return next;
                    });
                  }}
                />
                <span>
                  <span className="mono">{p.code}</span> {p.description}
                </span>
              </label>
            ))}
          </div>
        )}
        <div className="form-actions">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void linkPains()}>
            保存关联
          </Button>
        </div>
      </Card>
    </div>
  );
}

interface ChainForm {
  stage: string;
  variable_key: string;
  variable_label: string;
  unit: string;
  base_value: string;
  low_value: string;
  mult_base: string;
  mult_low: string;
  shape: 'linear' | 'threshold';
  controllable: boolean;
  owner_role: string;
  is_derived: boolean;
}

function toChainForm(c: ChainStage): ChainForm {
  return {
    stage: String(c.stage),
    variable_key: c.variable_key,
    variable_label: c.variable_label,
    unit: c.unit ?? '',
    base_value: c.base_value != null ? String(c.base_value) : '',
    low_value: c.low_value != null ? String(c.low_value) : '',
    mult_base: String(c.mult_base),
    mult_low: c.mult_low != null ? String(c.mult_low) : '',
    shape: c.shape,
    controllable: c.controllable,
    owner_role: c.owner_role ?? '',
    is_derived: c.is_derived,
  };
}

function Readiness({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`readiness-item ${ok ? 'ok' : ''}`}>
      <span className="readiness-dot" />
      {label}
    </span>
  );
}
