import { useState } from 'react';
import { api } from '../../api';
import { useForm, useLoad } from '../../hooks';
import type { Interview, Stakeholder } from '../../types';
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
  attitudeLabel,
  fmtDate,
  modeLabel,
  roleLabel,
} from '../../utils';

interface Bundle {
  stakeholders: Stakeholder[];
  interviews: Interview[];
}

export function PeopleTab({
  engagementId,
  onChanged,
}: {
  engagementId: string;
  onChanged: () => void;
}) {
  const { data, error, loading, reload } = useLoad<Bundle>(async () => {
    const [s, i] = await Promise.all([
      api.listStakeholders(engagementId),
      api.listInterviews(engagementId),
    ]);
    return { stakeholders: s.items, interviews: i.items };
  }, [engagementId]);

  const [stakeholderOpen, setStakeholderOpen] = useState(false);
  const [interviewOpen, setInterviewOpen] = useState(false);
  const [formError, setFormError] = useState<unknown>(null);

  const sf = useForm({
    name: '',
    title: '',
    department: '',
    role_type: 'business_owner',
    influence: '3',
    attitude: 'neutral',
    concerns: '',
    is_key: false,
    notes: '',
  });

  const inf = useForm({
    stakeholder_id: '',
    date: new Date().toISOString().slice(0, 10),
    duration_min: '45',
    mode: 'onsite',
    ai_summary: '',
    status: 'draft',
  });

  const stakeholders = data?.stakeholders ?? [];
  const interviews = data?.interviews ?? [];

  const saveStakeholder = async () => {
    setFormError(null);
    try {
      await api.createStakeholder(engagementId, {
        name: sf.values.name.trim(),
        title: sf.values.title || undefined,
        department: sf.values.department || undefined,
        role_type: sf.values.role_type,
        influence: Number(sf.values.influence),
        attitude: sf.values.attitude,
        concerns: sf.values.concerns
          ? sf.values.concerns.split(/[,，]/).map((x) => x.trim()).filter(Boolean)
          : [],
        is_key: sf.values.is_key,
        notes: sf.values.notes || undefined,
      });
      setStakeholderOpen(false);
      sf.reset();
      await reload();
      onChanged();
    } catch (err) {
      setFormError(err);
    }
  };

  const saveInterview = async () => {
    setFormError(null);
    try {
      if (!inf.values.stakeholder_id) throw new Error('请选择访谈对象');
      await api.createInterview(engagementId, {
        stakeholder_id: inf.values.stakeholder_id,
        date: inf.values.date,
        duration_min: inf.values.duration_min ? Number(inf.values.duration_min) : undefined,
        mode: inf.values.mode,
        ai_summary: inf.values.ai_summary || undefined,
        status: inf.values.status,
      });
      setInterviewOpen(false);
      inf.reset();
      await reload();
      onChanged();
    } catch (err) {
      setFormError(err);
    }
  };

  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorBox error={error} onRetry={() => void reload()} />;

  return (
    <div className="tab-body">
      <Card
        title="干系人"
        subtitle="决策人、项目负责人、业务负责人、IT/数据与一线，态度和影响力决定推进策略。"
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setFormError(null);
              setStakeholderOpen(true);
            }}
          >
            + 添加干系人
          </Button>
        }
      >
        {stakeholders.length === 0 ? (
          <Empty title="还没有干系人" hint="先录入关键人，访谈和确认才有对象。" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>姓名</th>
                  <th>职务 / 部门</th>
                  <th>角色</th>
                  <th>影响力</th>
                  <th>态度</th>
                  <th>关注点</th>
                  <th>关键人</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {stakeholders.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <strong>{s.name}</strong>
                    </td>
                    <td>
                      {s.title || '—'}
                      {s.department ? <span className="muted"> · {s.department}</span> : null}
                    </td>
                    <td>{roleLabel(s.role_type)}</td>
                    <td>{s.influence} / 5</td>
                    <td>
                      <Badge
                        tone={
                          s.attitude === 'blocker'
                            ? 'red'
                            : s.attitude === 'skeptic'
                              ? 'amber'
                              : s.attitude === 'champion' || s.attitude === 'supporter'
                                ? 'green'
                                : 'gray'
                        }
                      >
                        {attitudeLabel(s.attitude)}
                      </Badge>
                    </td>
                    <td className="muted">{s.concerns.join('、') || '—'}</td>
                    <td>{s.is_key ? <Badge tone="brand">关键</Badge> : '—'}</td>
                    <td className="actions-cell">
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={async () => {
                          if (!window.confirm(`删除干系人 ${s.name}？其访谈也会一并删除。`)) return;
                          await api.deleteStakeholder(s.id);
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

      <Card
        title="访谈"
        subtitle="手打纪要 + AI 摘要；不做录音转写（已确认的产品边界）。"
        actions={
          <Button
            variant="primary"
            size="sm"
            disabled={!stakeholders.length}
            onClick={() => {
              setFormError(null);
              inf.set('stakeholder_id', stakeholders[0]?.id ?? '');
              setInterviewOpen(true);
            }}
          >
            + 添加访谈
          </Button>
        }
      >
        {interviews.length === 0 ? (
          <Empty
            title="还没有访谈"
            hint={stakeholders.length ? '访谈 ≥5 人是 G1 的硬要求。' : '先添加干系人。'}
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>日期</th>
                  <th>对象</th>
                  <th>时长</th>
                  <th>方式</th>
                  <th>状态</th>
                  <th>摘要</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {interviews.map((i) => (
                  <tr key={i.id}>
                    <td>{fmtDate(i.date)}</td>
                    <td>{i.stakeholder_name ?? '—'}</td>
                    <td>{i.duration_min ? `${i.duration_min} 分钟` : '—'}</td>
                    <td>{modeLabel(i.mode)}</td>
                    <td>
                      <Badge tone={i.status === 'confirmed' ? 'green' : 'gray'}>
                        {i.status === 'confirmed' ? '已确认' : '草稿'}
                      </Badge>
                    </td>
                    <td className="muted clamp">{i.ai_summary || i.transcript || '—'}</td>
                    <td className="actions-cell">
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={async () => {
                          if (!window.confirm('删除这条访谈？')) return;
                          await api.deleteInterview(i.id);
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
        <p className="hint-line">
          访谈 {interviews.length} 场，合计{' '}
          {interviews.reduce((a, i) => a + (i.duration_min ?? 0), 0)} 分钟；G1 要求 ≥5 场。
        </p>
      </Card>

      <Modal
        open={stakeholderOpen}
        title="添加干系人"
        onClose={() => setStakeholderOpen(false)}
        footer={
          <>
            <Button onClick={() => setStakeholderOpen(false)}>取消</Button>
            <Button variant="primary" onClick={() => void saveStakeholder()}>
              保存
            </Button>
          </>
        }
      >
        {formError ? <ErrorBox error={formError} /> : null}
        <div className="form-grid">
          <Field label="姓名" required>
            <Input value={sf.values.name} onChange={(e) => sf.set('name', e.target.value)} />
          </Field>
          <Field label="职务">
            <Input value={sf.values.title} onChange={(e) => sf.set('title', e.target.value)} />
          </Field>
          <Field label="部门">
            <Input
              value={sf.values.department}
              onChange={(e) => sf.set('department', e.target.value)}
            />
          </Field>
          <Field label="角色" required>
            <Select
              value={sf.values.role_type}
              onChange={(e) => sf.set('role_type', e.target.value)}
            >
              <option value="decision_maker">决策人</option>
              <option value="project_owner">项目负责人</option>
              <option value="business_owner">业务负责人</option>
              <option value="it_data">IT/数据</option>
              <option value="frontline">一线</option>
            </Select>
          </Field>
          <Field label="影响力（1–5）">
            <Input
              type="number"
              min={1}
              max={5}
              value={sf.values.influence}
              onChange={(e) => sf.set('influence', e.target.value)}
            />
          </Field>
          <Field label="态度">
            <Select
              value={sf.values.attitude}
              onChange={(e) => sf.set('attitude', e.target.value)}
            >
              <option value="champion">拥护</option>
              <option value="supporter">支持</option>
              <option value="neutral">中立</option>
              <option value="skeptic">疑虑</option>
              <option value="blocker">抵触</option>
            </Select>
          </Field>
          <Field label="关注点（逗号分隔）" className="span-2">
            <Input
              value={sf.values.concerns}
              onChange={(e) => sf.set('concerns', e.target.value)}
              placeholder="如：投入产出,落地速度"
            />
          </Field>
          <Field label="备注" className="span-2">
            <Textarea
              rows={2}
              value={sf.values.notes}
              onChange={(e) => sf.set('notes', e.target.value)}
            />
          </Field>
          <label className="checkbox-line span-2">
            <input
              type="checkbox"
              checked={sf.values.is_key}
              onChange={(e) => sf.set('is_key', e.target.checked)}
            />
            关键人（影响项目推进）
          </label>
        </div>
      </Modal>

      <Modal
        open={interviewOpen}
        title="添加访谈"
        onClose={() => setInterviewOpen(false)}
        footer={
          <>
            <Button onClick={() => setInterviewOpen(false)}>取消</Button>
            <Button variant="primary" onClick={() => void saveInterview()}>
              保存
            </Button>
          </>
        }
      >
        {formError ? <ErrorBox error={formError} /> : null}
        <div className="form-grid">
          <Field label="访谈对象" required>
            <Select
              value={inf.values.stakeholder_id}
              onChange={(e) => inf.set('stakeholder_id', e.target.value)}
            >
              {stakeholders.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {roleLabel(s.role_type)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="日期" required>
            <Input
              type="date"
              value={inf.values.date}
              onChange={(e) => inf.set('date', e.target.value)}
            />
          </Field>
          <Field label="时长（分钟）">
            <Input
              type="number"
              value={inf.values.duration_min}
              onChange={(e) => inf.set('duration_min', e.target.value)}
            />
          </Field>
          <Field label="方式">
            <Select value={inf.values.mode} onChange={(e) => inf.set('mode', e.target.value)}>
              <option value="onsite">现场</option>
              <option value="video">视频</option>
              <option value="phone">电话</option>
            </Select>
          </Field>
          <Field label="状态">
            <Select value={inf.values.status} onChange={(e) => inf.set('status', e.target.value)}>
              <option value="draft">草稿</option>
              <option value="confirmed">已确认</option>
            </Select>
          </Field>
          <Field label="AI 摘要 / 手打纪要" className="span-2">
            <Textarea
              rows={4}
              value={inf.values.ai_summary}
              onChange={(e) => inf.set('ai_summary', e.target.value)}
              placeholder="用客户原话记录关键发现，数字和来源要能追溯。"
            />
          </Field>
        </div>
      </Modal>
    </div>
  );
}
