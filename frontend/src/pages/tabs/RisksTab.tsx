import { useMemo, useState } from 'react';
import { api } from '../../api';
import { DependencyGraph } from '../../components/DependencyGraph';
import { useForm, useLoad } from '../../hooks';
import type { Dependency, EngagementDetail, Limitation, Risk, User } from '../../types';
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
  dependencyTypeLabel,
  impactLabel,
  riskCategoryLabel,
} from '../../utils';

interface Bundle {
  limitations: Limitation[];
  risks: Risk[];
  dependencies: Dependency[];
  users: User[];
}

export function RisksTab({
  engagementId,
  detail,
  onChanged,
}: {
  engagementId: string;
  detail: EngagementDetail;
  onChanged: () => void;
}) {
  const { data, error, loading, reload } = useLoad<Bundle>(async () => {
    const [l, r, d, u] = await Promise.all([
      api.listLimitations(engagementId),
      api.listRisks(engagementId),
      api.listDependencies(engagementId),
      api.listUsers(),
    ]);
    return { limitations: l.items, risks: r.items, dependencies: d.items, users: u.items };
  }, [engagementId]);

  const [modal, setModal] = useState<'limitation' | 'risk' | 'dependency' | null>(null);
  const [formError, setFormError] = useState<unknown>(null);
  const [opError, setOpError] = useState<unknown>(null);
  const [opBusy, setOpBusy] = useState<string | null>(null);

  const lim = useForm({
    title: '',
    detail: '',
    impact_class: 'amount',
    affected_refs: '',
    severity: '2',
    source_type: 'manual',
  });
  const risk = useForm({
    title: '',
    category: 'org',
    probability: '3',
    impact: '3',
    mitigation: '',
    status: 'open',
    owner: '',
    due_date: '',
  });
  const dep = useForm({ from_id: '', to_id: '', type: 'requires', note: '' });

  const limitations = data?.limitations ?? [];
  const risks = data?.risks ?? [];
  const dependencies = data?.dependencies ?? [];
  const users = data?.users ?? [];
  const oppOptions = detail.opportunities;

  const grouped = useMemo(() => {
    const map: Record<string, Limitation[]> = { amount: [], scope: [], method: [], internal: [] };
    for (const l of limitations) (map[l.impactClass] ??= []).push(l);
    return map;
  }, [limitations]);

  const after = async () => {
    await reload();
    onChanged();
  };

  const patchRisk = async (riskId: string, patch: Record<string, unknown>) => {
    setOpError(null);
    setOpBusy(riskId);
    try {
      await api.updateRisk(riskId, patch);
      await after();
    } catch (err) {
      setOpError(err);
    } finally {
      setOpBusy(null);
    }
  };

  const save = async (kind: 'limitation' | 'risk' | 'dependency') => {
    setFormError(null);
    try {
      if (kind === 'limitation') {
        await api.createLimitation(engagementId, {
          title: lim.values.title.trim(),
          detail: lim.values.detail.trim(),
          impact_class: lim.values.impact_class,
          affected_refs: lim.values.affected_refs
            ? lim.values.affected_refs.split(/[,，]/).map((x) => x.trim()).filter(Boolean)
            : [],
          severity: Number(lim.values.severity),
          source_type: lim.values.source_type,
        });
        lim.reset();
      } else if (kind === 'risk') {
        await api.createRisk(engagementId, {
          title: risk.values.title.trim(),
          category: risk.values.category,
          probability: Number(risk.values.probability),
          impact: Number(risk.values.impact),
          mitigation: risk.values.mitigation || undefined,
          status: risk.values.status,
          owner: risk.values.owner || null,
          due_date: risk.values.due_date || null,
        });
        risk.reset();
      } else {
        if (!dep.values.from_id || !dep.values.to_id) throw new Error('请选择两个机会点');
        await api.createDependency(engagementId, {
          from_id: dep.values.from_id,
          to_id: dep.values.to_id,
          type: dep.values.type,
          note: dep.values.note || undefined,
        });
        dep.reset();
      }
      setModal(null);
      await after();
    } catch (err) {
      setFormError(err);
    }
  };

  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorBox error={error} onRetry={() => void reload()} />;

  return (
    <div className="tab-body">
      <Card
        title="局限"
        subtitle="按影响什么分流：金额紧跟 ROI、范围紧跟痛点、方法进附录、内部不进客户文档。"
        actions={
          <Button variant="primary" size="sm" onClick={() => setModal('limitation')}>
            + 添加局限
          </Button>
        }
      >
        {limitations.length === 0 ? (
          <Empty title="暂无局限" hint="低置信度基线必须进入局限，否则 C6 会 block。" />
        ) : (
          <div className="limitation-grid">
            {(['amount', 'scope', 'method', 'internal'] as const).map((kind) =>
              grouped[kind]?.length ? (
                <div key={kind} className="limitation-group">
                  <h4>{impactLabel(kind)}</h4>
                  {grouped[kind].map((l) => (
                    <div key={l.id} className="limitation-item">
                      <div className="limitation-head">
                        <strong>{l.title}</strong>
                        <Badge tone={kind === 'internal' ? 'gray' : 'blue'}>
                          {l.affectedRefs.join('、') || '全局'}
                        </Badge>
                      </div>
                      <p className="muted">{l.detail}</p>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          if (!window.confirm(`删除局限「${l.title}」？`)) return;
                          await api.deleteLimitation(l.id);
                          await after();
                        }}
                      >
                        删除
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null,
            )}
          </div>
        )}
      </Card>

      <Card
        title="风险登记册"
        subtitle="概率/影响 1–5；技术阻断、数据不可得、低置信度基线也会在报告里自动派生。"
        actions={
          <Button variant="primary" size="sm" onClick={() => setModal('risk')}>
            + 添加风险
          </Button>
        }
      >
        {opError ? <ErrorBox error={opError} /> : null}
        {risks.length === 0 ? (
          <Empty title="暂无显式风险" hint="报告仍会显示从机会点字段自动识别的风险。" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>风险</th>
                  <th>类型</th>
                  <th>概率</th>
                  <th>影响</th>
                  <th>负责人</th>
                  <th>截止</th>
                  <th>应对</th>
                  <th>状态</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {risks.map((r) => (
                  <tr key={r.id}>
                    <td>{r.title}</td>
                    <td>{riskCategoryLabel(r.category)}</td>
                    <td>{r.probability}</td>
                    <td>{r.impact}</td>
                    <td>
                      <Select
                        value={r.owner ?? ''}
                        disabled={opBusy === r.id}
                        onChange={(e) => void patchRisk(r.id, { owner: e.target.value || null })}
                      >
                        <option value="">不指定</option>
                        {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                      </Select>
                    </td>
                    <td>
                      <Input
                        type="date"
                        value={r.due_date ?? ''}
                        disabled={opBusy === r.id}
                        onChange={(e) => void patchRisk(r.id, { due_date: e.target.value || null })}
                      />
                    </td>
                    <td className="muted">{r.mitigation || '—'}</td>
                    <td>
                      <Badge tone={r.status === 'open' ? 'amber' : 'green'}>
                        {r.status === 'open' ? '开放' : r.status === 'mitigated' ? '已缓解' : '已关闭'}
                      </Badge>
                    </td>
                    <td className="actions-cell">
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={async () => {
                          if (!window.confirm(`删除风险「${r.title}」？`)) return;
                          await api.deleteRisk(r.id);
                          await after();
                        }}
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
      </Card>

      <Card
        title="机会点依赖"
        subtitle="requires 依赖不能成环；报告 §8.1 会生成同样的依赖图与明细表。"
        actions={
          <Button
            variant="primary"
            size="sm"
            disabled={oppOptions.length < 2}
            onClick={() => setModal('dependency')}
          >
            + 添加依赖
          </Button>
        }
      >
        {dependencies.length > 0 && (
          <DependencyGraph opportunities={oppOptions} dependencies={dependencies} />
        )}
        {dependencies.length === 0 ? (
          <Empty title="暂无依赖" hint="例如 OP-02 依赖 OP-03 的单证核对结果。" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>机会点</th>
                  <th>关系</th>
                  <th>关联机会点</th>
                  <th>说明</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {dependencies.map((d) => (
                  <tr key={d.id}>
                    <td className="mono">{d.from_code}</td>
                    <td>{dependencyTypeLabel(d.type)}</td>
                    <td className="mono">{d.to_code}</td>
                    <td className="muted">{d.note || '—'}</td>
                    <td className="actions-cell">
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={async () => {
                          await api.deleteDependency(d.id);
                          await after();
                        }}
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
      </Card>

      <Modal
        open={modal === 'limitation'}
        title="添加局限"
        onClose={() => setModal(null)}
        footer={
          <>
            <Button onClick={() => setModal(null)}>取消</Button>
            <Button variant="primary" onClick={() => void save('limitation')}>保存</Button>
          </>
        }
      >
        {formError ? <ErrorBox error={formError} /> : null}
        <div className="form-grid">
          <Field label="标题" required className="span-2">
            <Input value={lim.values.title} onChange={(e) => lim.set('title', e.target.value)} />
          </Field>
          <Field label="说明" required className="span-2">
            <Textarea rows={3} value={lim.values.detail} onChange={(e) => lim.set('detail', e.target.value)} />
          </Field>
          <Field label="影响分类">
            <Select value={lim.values.impact_class} onChange={(e) => lim.set('impact_class', e.target.value)}>
              <option value="amount">金额（紧跟 ROI）</option>
              <option value="scope">范围（紧跟痛点）</option>
              <option value="method">方法（附录）</option>
              <option value="internal">内部（不进客户文档）</option>
            </Select>
          </Field>
          <Field label="严重度 1–3">
            <Input type="number" min={1} max={3} value={lim.values.severity} onChange={(e) => lim.set('severity', e.target.value)} />
          </Field>
          <Field label="影响机会点（逗号分隔）">
            <Input value={lim.values.affected_refs} onChange={(e) => lim.set('affected_refs', e.target.value)} placeholder="如：OP-01,OP-03" />
          </Field>
          <Field label="来源类型">
            <Select value={lim.values.source_type} onChange={(e) => lim.set('source_type', e.target.value)}>
              <option value="manual">人工</option>
              <option value="baseline_low_confidence">低置信度基线</option>
              <option value="client_financial">客户财务</option>
              <option value="gate_gap">门禁缺口</option>
              <option value="benchmark_uncalibrated">对标未校准</option>
            </Select>
          </Field>
        </div>
      </Modal>

      <Modal
        open={modal === 'risk'}
        title="添加风险"
        onClose={() => setModal(null)}
        footer={
          <>
            <Button onClick={() => setModal(null)}>取消</Button>
            <Button variant="primary" onClick={() => void save('risk')}>保存</Button>
          </>
        }
      >
        {formError ? <ErrorBox error={formError} /> : null}
        <div className="form-grid">
          <Field label="风险" required className="span-2">
            <Input value={risk.values.title} onChange={(e) => risk.set('title', e.target.value)} />
          </Field>
          <Field label="类型">
            <Select value={risk.values.category} onChange={(e) => risk.set('category', e.target.value)}>
              <option value="data">数据</option>
              <option value="tech">技术</option>
              <option value="org">组织</option>
              <option value="commercial">商务</option>
              <option value="compliance">合规</option>
            </Select>
          </Field>
          <Field label="状态">
            <Select value={risk.values.status} onChange={(e) => risk.set('status', e.target.value)}>
              <option value="open">开放</option>
              <option value="mitigated">已缓解</option>
              <option value="closed">已关闭</option>
            </Select>
          </Field>
          <Field label="概率 1–5">
            <Input type="number" min={1} max={5} value={risk.values.probability} onChange={(e) => risk.set('probability', e.target.value)} />
          </Field>
          <Field label="影响 1–5">
            <Input type="number" min={1} max={5} value={risk.values.impact} onChange={(e) => risk.set('impact', e.target.value)} />
          </Field>
          <Field label="负责人">
            <Select value={risk.values.owner} onChange={(e) => risk.set('owner', e.target.value)}>
              <option value="">不指定</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
          </Field>
          <Field label="截止日期">
            <Input type="date" value={risk.values.due_date} onChange={(e) => risk.set('due_date', e.target.value)} />
          </Field>
          <Field label="应对" className="span-2">
            <Textarea rows={2} value={risk.values.mitigation} onChange={(e) => risk.set('mitigation', e.target.value)} />
          </Field>
        </div>
      </Modal>

      <Modal
        open={modal === 'dependency'}
        title="添加机会点依赖"
        onClose={() => setModal(null)}
        footer={
          <>
            <Button onClick={() => setModal(null)}>取消</Button>
            <Button variant="primary" onClick={() => void save('dependency')}>保存</Button>
          </>
        }
      >
        {formError ? <ErrorBox error={formError} /> : null}
        <div className="form-grid">
          <Field label="机会点" required>
            <Select value={dep.values.from_id} onChange={(e) => dep.set('from_id', e.target.value)}>
              <option value="">请选择</option>
              {oppOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.code} {o.title}</option>
              ))}
            </Select>
          </Field>
          <Field label="类型">
            <Select value={dep.values.type} onChange={(e) => dep.set('type', e.target.value)}>
              <option value="requires">依赖</option>
              <option value="blocks">阻断</option>
              <option value="enables">使能</option>
            </Select>
          </Field>
          <Field label="关联机会点" required>
            <Select value={dep.values.to_id} onChange={(e) => dep.set('to_id', e.target.value)}>
              <option value="">请选择</option>
              {oppOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.code} {o.title}</option>
              ))}
            </Select>
          </Field>
          <Field label="说明" className="span-2">
            <Input value={dep.values.note} onChange={(e) => dep.set('note', e.target.value)} />
          </Field>
        </div>
      </Modal>
    </div>
  );
}
