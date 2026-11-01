import { useEffect, useState } from 'react';
import { api } from '../../api';
import { useLoad } from '../../hooks';
import type { AiDraft, EngagementDetail, Interview } from '../../types';
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
  Textarea,
} from '../../ui';
import { fmtDateTime } from '../../utils';

const KIND_LABEL: Record<string, string> = {
  interview_summary: '访谈摘要',
  report_draft: '诊断报告草稿',
  solution_skeleton: '方案骨架',
  prd_skeleton: 'PRD 骨架',
  answer: '问答草稿',
};

const STATUS_LABEL: Record<string, string> = {
  draft: '待确认',
  confirmed: '已确认',
  rejected: '已拒绝',
};

const statusTone = (status: string) =>
  status === 'confirmed' ? 'green' : status === 'rejected' ? 'red' : 'amber';

export function AiTab({
  engagementId,
  detail,
  onChanged,
}: {
  engagementId: string;
  detail: EngagementDetail;
  onChanged: () => void;
}) {
  const { data, error, loading, reload } = useLoad(
    async () => {
      const [d, i, c] = await Promise.all([
        api.listAiDrafts(engagementId),
        api.listInterviews(engagementId),
        api.aiConfig(),
      ]);
      return { drafts: d.items, interviews: i.items, config: c };
    },
    [engagementId],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [opError, setOpError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [opportunityId, setOpportunityId] = useState(detail.opportunities[0]?.id ?? '');
  const [interviewId, setInterviewId] = useState('');
  const [question, setQuestion] = useState('');

  const drafts = data?.drafts ?? [];
  const interviews = data?.interviews ?? [];
  const config = data?.config;
  const selected = drafts.find((d) => d.id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedId && drafts.length) setSelectedId(drafts[0].id);
  }, [drafts, selectedId]);

  useEffect(() => {
    if (selected) {
      setTitle(selected.title);
      setContent(selected.content);
    }
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!interviewId && interviews.length) setInterviewId(interviews[0].id);
  }, [interviews, interviewId]);

  const run = async (fn: () => Promise<unknown>, message?: string) => {
    setBusy(true);
    setOpError(null);
    setNotice(null);
    try {
      await fn();
      await reload();
      if (message) setNotice(message);
      onChanged();
    } catch (err) {
      setOpError(err);
    } finally {
      setBusy(false);
    }
  };

  const generate = (kind: string) =>
    run(async () => {
      const payload: Record<string, unknown> = { kind };
      if (kind === 'interview_summary' && interviewId) payload.source_id = interviewId;
      if ((kind === 'solution_skeleton' || kind === 'prd_skeleton') && opportunityId) {
        payload.source_id = opportunityId;
      }
      if (kind === 'answer') {
        if (!question.trim()) throw new Error('请先输入问题');
        payload.prompt = question.trim();
      }
      const res = await api.createAiDraft(engagementId, payload);
      setSelectedId(res.item.id);
    }, '已生成草稿，请人工核对后确认或拒绝。');

  const save = () =>
    run(async () => {
      if (!selected) return;
      await api.updateAiDraft(selected.id, { title: title.trim(), content });
    }, '草稿已保存。');

  const confirm = () =>
    run(async () => {
      if (!selected) return;
      await api.confirmAiDraft(selected.id);
    }, '草稿已确认，可作为人工编辑的起点。');

  const reject = () =>
    run(async () => {
      if (!selected) return;
      await api.rejectAiDraft(selected.id);
    }, '草稿已拒绝。');

  const remove = async (draft: AiDraft) => {
    if (!window.confirm(`删除草稿「${draft.title}」？`)) return;
    setBusy(true);
    setOpError(null);
    try {
      await api.deleteAiDraft(draft.id);
      if (selectedId === draft.id) setSelectedId(null);
      await reload();
    } catch (err) {
      setOpError(err);
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorBox error={error} onRetry={() => void reload()} />;

  return (
    <div className="tab-body">
      <Card
        title="AI 助手"
        subtitle="按项目数据与知识库生成草稿；所有产出都需要人工确认，不替顾问下结论。"
        actions={
          <Badge tone={config?.configured ? 'green' : 'gray'}>
            {config?.configured ? config.model : 'rule-based-v1（未接大模型）'}
          </Badge>
        }
      >
        {opError ? <ErrorBox error={opError} /> : null}
        {notice ? <div className="notice notice-green">{notice}</div> : null}
        <div className="form-grid">
          <Field label="访谈对象（访谈摘要用）">
            <Select value={interviewId} onChange={(e) => setInterviewId(e.target.value)}>
              <option value="">最近一次访谈</option>
              {interviews.map((i: Interview) => (
                <option key={i.id} value={i.id}>
                  {i.stakeholder_name ?? '访谈'} · {i.date}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="机会点（方案/PRD 用）">
            <Select value={opportunityId} onChange={(e) => setOpportunityId(e.target.value)}>
              {detail.opportunities.map((o) => (
                <option key={o.id} value={o.id}>{o.code} · {o.title}</option>
              ))}
            </Select>
          </Field>
          <Field label="问题（问答草稿用）" className="span-2">
            <Input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="例如：托书识别怎么做 POC？"
            />
          </Field>
        </div>
        <div className="generate-bar">
          <Button size="sm" disabled={busy} onClick={() => void generate('interview_summary')}>访谈摘要</Button>
          <Button size="sm" disabled={busy} onClick={() => void generate('report_draft')}>诊断报告草稿</Button>
          <Button size="sm" disabled={busy} onClick={() => void generate('solution_skeleton')}>方案骨架</Button>
          <Button size="sm" disabled={busy} onClick={() => void generate('prd_skeleton')}>PRD 骨架</Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void generate('answer')}>问答草稿</Button>
        </div>
      </Card>

      <Card
        title="草稿列表"
        subtitle="草稿可编辑、确认或拒绝；确认记录会留痕。"
        actions={<Badge tone="gray">{drafts.length} 条</Badge>}
      >
        {drafts.length === 0 ? (
          <Empty title="还没有草稿" hint="先点上方任一生成按钮。" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>类型</th><th>标题</th><th>状态</th><th>创建人</th><th>时间</th><th /></tr>
              </thead>
              <tbody>
                {drafts.map((d) => (
                  <tr key={d.id} className={selectedId === d.id ? 'row-active' : ''}>
                    <td><Badge tone="blue">{KIND_LABEL[d.kind] ?? d.kind}</Badge></td>
                    <td><strong>{d.title}</strong></td>
                    <td><Badge tone={statusTone(d.status)}>{STATUS_LABEL[d.status] ?? d.status}</Badge></td>
                    <td>{d.created_by_name || '—'}</td>
                    <td className="muted">{fmtDateTime(d.created_at)}</td>
                    <td className="actions-cell">
                      <Button size="sm" onClick={() => setSelectedId(d.id)}>查看</Button>
                      <Button size="sm" variant="danger" disabled={busy} onClick={() => void remove(d)}>删除</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selected ? (
        <Card
          title={`编辑草稿 · ${KIND_LABEL[selected.kind] ?? selected.kind}`}
          subtitle={`模型：${selected.model}　｜　状态：${STATUS_LABEL[selected.status] ?? selected.status}${selected.confirmed_by_name ? `　｜　确认人：${selected.confirmed_by_name}` : ''}`}
          actions={<Badge tone={statusTone(selected.status)}>{STATUS_LABEL[selected.status] ?? selected.status}</Badge>}
        >
          <div className="form-grid">
            <Field label="标题" className="span-2">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field label="正文（Markdown）" className="span-2">
              <Textarea
                className="ai-draft-text"
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />
            </Field>
          </div>
          <div className="form-actions">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void save()}>保存修改</Button>
            <Button size="sm" disabled={busy || selected.status === 'confirmed'} onClick={() => void confirm()}>
              确认草稿
            </Button>
            <Button size="sm" variant="danger" disabled={busy || selected.status === 'rejected'} onClick={() => void reject()}>
              拒绝
            </Button>
          </div>
          <p className="hint-line">
            确认只代表“可进入人工编辑流程”，不等于客户确认或对外承诺；对外内容仍走交付物审批与外发。
          </p>
        </Card>
      ) : null}
    </div>
  );
}
