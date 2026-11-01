import { useMemo, useState } from 'react';
import { api } from '../../api';
import { useForm, useLoad } from '../../hooks';
import type {
  Confirmation,
  Deliverable,
  OpportunityRow,
  PainPoint,
  ProcessModel,
  Stakeholder,
} from '../../types';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Field,
  Modal,
  Notice,
  Select,
  Spinner,
  Textarea,
} from '../../ui';
import { fmtDateTime } from '../../utils';

type ObjectType = 'deliverable' | 'opportunity' | 'pain_point' | 'flowchart';

const OBJECT_LABEL: Record<ObjectType, string> = {
  deliverable: '交付物',
  opportunity: '机会点',
  pain_point: '痛点',
  flowchart: '流程图',
};

const METHOD_LABEL: Record<string, string> = {
  meeting: '会议',
  email: '邮件',
  wechat: '企业微信',
  signature: '签字',
};

const OBJECT_TONE: Record<ObjectType, 'brand' | 'blue' | 'amber' | 'gray'> = {
  deliverable: 'brand',
  opportunity: 'blue',
  pain_point: 'amber',
  flowchart: 'gray',
};

interface Bundle {
  confirmations: Confirmation[];
  stakeholders: Stakeholder[];
  deliverables: Deliverable[];
  opportunities: OpportunityRow[];
  pains: PainPoint[];
  process: ProcessModel;
}

export function ConfirmationsTab({
  engagementId,
  onChanged,
}: {
  engagementId: string;
  onChanged: () => void;
}) {
  const { data, error, loading, reload } = useLoad<Bundle>(async () => {
    const [c, s, d, o, p, m] = await Promise.all([
      api.listConfirmations(engagementId),
      api.listStakeholders(engagementId),
      api.listDeliverables(engagementId),
      api.listOpportunities(engagementId),
      api.listPains(engagementId),
      api.getProcessModel(engagementId),
    ]);
    return {
      confirmations: c.items,
      stakeholders: s.items,
      deliverables: d.items,
      opportunities: o.items,
      pains: p.items,
      process: m,
    };
  }, [engagementId]);

  const [open, setOpen] = useState(false);
  const [formError, setFormError] = useState<unknown>(null);
  const form = useForm({
    object_type: 'deliverable' as ObjectType,
    object_id: '',
    confirmed_by: '',
    method: 'meeting',
    evidence: '',
  });

  const confirmations = data?.confirmations ?? [];
  const stakeholders = data?.stakeholders ?? [];

  const optionsFor = (type: ObjectType): Array<{ id: string; label: string }> => {
    if (!data) return [];
    if (type === 'deliverable') {
      return data.deliverables.map((d) => ({ id: d.id, label: `${d.title} v${d.version}` }));
    }
    if (type === 'opportunity') {
      return data.opportunities.map((o) => ({ id: o.id, label: `${o.code} ${o.title}` }));
    }
    if (type === 'pain_point') {
      return data.pains.map((p) => ({ id: p.id, label: `${p.code} ${p.description}` }));
    }
    return data.process.item
      ? [{ id: data.process.item.id, label: `业务流程 v${data.process.item.version}` }]
      : [];
  };

  const counts = useMemo(() => {
    const base: Record<ObjectType, number> = {
      deliverable: 0,
      opportunity: 0,
      pain_point: 0,
      flowchart: 0,
    };
    for (const c of confirmations) base[c.object_type] += 1;
    return base;
  }, [confirmations]);

  const openCreate = () => {
    const type: ObjectType = 'deliverable';
    const options = optionsFor(type);
    setFormError(null);
    form.setValues({
      object_type: type,
      object_id: options[0]?.id ?? '',
      confirmed_by: stakeholders[0]?.id ?? '',
      method: 'meeting',
      evidence: '',
    });
    setOpen(true);
  };

  const save = async () => {
    setFormError(null);
    try {
      if (!form.values.object_id) throw new Error('请选择确认对象');
      if (!form.values.confirmed_by) throw new Error('请选择确认人');
      await api.createConfirmation(engagementId, {
        object_type: form.values.object_type,
        object_id: form.values.object_id,
        confirmed_by: form.values.confirmed_by,
        method: form.values.method,
        evidence: form.values.evidence.trim() || undefined,
      });
      setOpen(false);
      await reload();
      onChanged();
    } catch (err) {
      setFormError(err);
    }
  };

  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorBox error={error} onRetry={() => void reload()} />;

  const objectOptions = optionsFor(form.values.object_type);

  return (
    <div className="tab-body">
      <Card
        title="客户确认与签收"
        subtitle="客户对报告、流程图、机会点、痛点的确认留痕；不等同于系统内审批。"
        actions={
          <>
            <Button size="sm" onClick={() => void reload()}>
              刷新
            </Button>
            <Button variant="primary" size="sm" onClick={openCreate}>
              + 新增确认
            </Button>
          </>
        }
      >
        <div className="inline-stats">
          <span>
            共 <strong>{confirmations.length}</strong> 条
          </span>
          {(Object.keys(OBJECT_LABEL) as ObjectType[]).map((t) => (
            <span key={t}>
              {OBJECT_LABEL[t]} <strong>{counts[t]}</strong>
            </span>
          ))}
          {confirmations.length === 0 && <Badge tone="amber">还没有客户确认记录</Badge>}
        </div>

        {confirmations.length === 0 ? (
          <Empty
            title="还没有客户确认"
            hint="把报告/流程图发给客户后，在这里记录谁、用什么方式、确认了什么。"
            action={
              <Button variant="primary" onClick={openCreate}>
                新增第一条确认
              </Button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>对象</th>
                  <th>确认人</th>
                  <th>方式</th>
                  <th>证据 / 备注</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {confirmations.map((c) => (
                  <tr key={c.id}>
                    <td className="muted">{fmtDateTime(c.confirmed_at)}</td>
                    <td>
                      <Badge tone={OBJECT_TONE[c.object_type]}>
                        {OBJECT_LABEL[c.object_type]}
                      </Badge>
                      <span className="confirm-object">{c.object_label || '对象已删除'}</span>
                    </td>
                    <td>
                      {c.confirmed_by_name}
                      {c.confirmed_by_title ? (
                        <span className="muted"> · {c.confirmed_by_title}</span>
                      ) : null}
                    </td>
                    <td>{METHOD_LABEL[c.method] ?? c.method}</td>
                    <td className="muted">{c.evidence || '—'}</td>
                    <td className="actions-cell">
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={async () => {
                          if (!window.confirm('删除这条确认记录？')) return;
                          await api.deleteConfirmation(c.id);
                          await reload();
                          onChanged();
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

      <Notice tone="blue">
        确认记录是“客户看过并认可”的证据，不会替代 G1–G5 的自动校验。对外交付时建议同时保留邮件/会议纪要。
      </Notice>

      <Modal
        open={open}
        title="新增客户确认"
        subtitle="选择确认对象、确认人和方式；证据可以是会议纪要、邮件主题或签字件说明。"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>取消</Button>
            <Button variant="primary" onClick={() => void save()}>
              保存确认
            </Button>
          </>
        }
      >
        {formError ? <ErrorBox error={formError} /> : null}
        <div className="form-grid">
          <Field label="对象类型" required>
            <Select
              value={form.values.object_type}
              onChange={(e) => {
                const type = e.target.value as ObjectType;
                const options = optionsFor(type);
                form.setValues({
                  ...form.values,
                  object_type: type,
                  object_id: options[0]?.id ?? '',
                });
              }}
            >
              {(Object.keys(OBJECT_LABEL) as ObjectType[]).map((t) => (
                <option key={t} value={t}>
                  {OBJECT_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="确认对象" required>
            <Select
              value={form.values.object_id}
              onChange={(e) => form.set('object_id', e.target.value)}
            >
              <option value="">请选择</option>
              {objectOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="确认人" required>
            <Select
              value={form.values.confirmed_by}
              onChange={(e) => form.set('confirmed_by', e.target.value)}
            >
              <option value="">请选择干系人</option>
              {stakeholders.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.title ? ` · ${s.title}` : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="确认方式">
            <Select
              value={form.values.method}
              onChange={(e) => form.set('method', e.target.value)}
            >
              <option value="meeting">会议</option>
              <option value="email">邮件</option>
              <option value="wechat">企业微信</option>
              <option value="signature">签字</option>
            </Select>
          </Field>
          <Field label="证据 / 备注" className="span-2">
            <Textarea
              rows={3}
              value={form.values.evidence}
              onChange={(e) => form.set('evidence', e.target.value)}
              placeholder="如：2026-11-02 客户周会，李强确认一期范围；邮件主题《宏远诊断报告 v2 确认》。"
            />
          </Field>
        </div>
        {objectOptions.length === 0 && (
          <Notice tone="amber">
            当前类型还没有可选对象。先录入对应的交付物、机会点、痛点或流程图。
          </Notice>
        )}
        <p className="hint-line">
          确认人必须属于该项目客户；后端会校验对象与项目、确认人与客户的归属。
        </p>
      </Modal>
    </div>
  );
}
