import { useEffect, useState } from 'react';
import { api } from '../api';
import { useDebouncedValue, usePaged } from '../hooks';
import { getStoredUser } from '../auth';
import type { KnowledgeItem } from '../types';
import { fmtDate } from '../utils';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Stat,
  Textarea,
} from '../ui';

const CATEGORY_LABEL: Record<string, string> = {
  opportunity: '机会点',
  pattern: '模式',
  template: '模板',
  lesson: '经验',
  case: '案例',
};

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  published: '已发布',
  archived: '已归档',
};

const INDUSTRY_OPTIONS = [
  { value: 'logistics', label: '物流' },
  { value: 'manufacturing', label: '制造' },
  { value: 'retail', label: '零售' },
  { value: 'general', label: '通用' },
];

const emptyForm = () => ({
  industry: 'logistics',
  category: 'pattern',
  title: '',
  summary: '',
  content: '',
  tags: '',
  source: '',
  status: 'published',
  expires_at: '',
});

const today = () => new Date().toISOString().slice(0, 10);

const expiryState = (item: { expires_at: string | null }) => {
  if (!item.expires_at) return null;
  const t = today();
  if (item.expires_at < t) return 'expired';
  const end = new Date(`${item.expires_at}T00:00:00`).getTime();
  const start = new Date(`${t}T00:00:00`).getTime();
  return end - start <= 30 * 24 * 3600 * 1000 ? 'expiring' : null;
};

type FormState = ReturnType<typeof emptyForm>;

export function KnowledgePage() {
  const role = getStoredUser()?.role;
  const canReview = !role || ['admin', 'director', 'pm'].includes(role);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [industry, setIndustry] = useState('');
  const [expiry, setExpiry] = useState('');
  const dq = useDebouncedValue(q, 300);
  const paged = usePaged(
    (limit, offset) =>
      api.listKnowledge({
        q: dq,
        category,
        industry,
        expiring: expiry === 'expiring' ? '1' : undefined,
        expired: expiry === 'expired' ? '1' : undefined,
        limit: String(limit),
        offset: String(offset),
      }),
    [dq, category, industry, expiry],
  );
  const { error, loading, reload, loadMore, loadingMore, hasMore } = paged;

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<KnowledgeItem | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formError, setFormError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [viewing, setViewing] = useState<KnowledgeItem | null>(null);

  useEffect(() => {
    if (viewing) {
      const fresh = paged.items.find((i) => i.id === viewing.id);
      if (fresh) setViewing(fresh);
    }
  }, [paged.items]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = paged.items;

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm());
    setFormError(null);
    setOpen(true);
  };

  const openEdit = (item: KnowledgeItem) => {
    setEditing(item);
    setForm({
      industry: item.industry,
      category: item.category,
      title: item.title,
      summary: item.summary,
      content: item.content,
      tags: item.tags.join(', '),
      source: item.source ?? '',
      status: item.status,
      expires_at: item.expires_at ?? '',
    });
    setFormError(null);
    setOpen(true);
  };

  const save = async () => {
    setSaving(true);
    setFormError(null);
    try {
      if (!form.title.trim() || !form.summary.trim() || !form.content.trim()) {
        throw new Error('标题、摘要、正文必填');
      }
      const payload = {
        ...form,
        tags: form.tags
          .split(/[,，\s]+/)
          .map((t) => t.trim())
          .filter(Boolean),
        source: form.source || undefined,
        expires_at: form.expires_at || null,
      };
      if (editing) {
        await api.updateKnowledge(editing.id, payload);
      } else {
        await api.createKnowledge(payload);
      }
      setOpen(false);
      await reload();
    } catch (err) {
      setFormError(err);
    } finally {
      setSaving(false);
    }
  };

  const review = async (item: KnowledgeItem, decision: 'approve' | 'reject') => {
    if (decision === 'reject' && !window.confirm(`退回知识条目「${item.title}」？`)) return;
    try {
      await api.reviewKnowledge(
        item.id,
        decision,
        decision === 'approve' ? '审批通过' : '退回修改',
      );
      await reload();
    } catch (err) {
      window.alert((err as Error).message ?? '操作失败');
    }
  };

  const remove = async (item: KnowledgeItem) => {
    if (!window.confirm(`删除知识条目「${item.title}」？`)) return;
    await api.deleteKnowledge(item.id);
    if (viewing?.id === item.id) setViewing(null);
    await reload();
  };

  const categoryCount = (c: string) => items.filter((i) => i.category === c).length;

  return (
    <div className="page">
      <PageHeader
        eyebrow="R6 · 知识库"
        title="知识库"
        subtitle="机会点库、交付模式、模板与项目复盘；支持按行业、分类、标签与全文检索。"
        actions={
          <>
            <Button onClick={() => void reload()}>刷新</Button>
            <Button variant="primary" onClick={openCreate}>+ 新增知识</Button>
          </>
        }
      />

      {loading && items.length === 0 ? <Spinner /> : null}
      {error && items.length === 0 ? <ErrorBox error={error} onRetry={() => void reload()} /> : null}

      <>
          <div className="stat-grid">
            <Stat label="知识条目" value={paged.total} hint="当前筛选结果" tone="brand" />
            <Stat label="机会点" value={categoryCount('opportunity')} tone="blue" />
            <Stat label="模式/模板" value={categoryCount('pattern') + categoryCount('template')} tone="green" />
            <Stat label="经验/案例" value={categoryCount('lesson') + categoryCount('case')} tone="amber" />
          </div>

          <Card
            title="知识条目"
            subtitle="内容用于 AI 助手检索与相似项目推荐，不自动改写客户结论。"
            actions={
              <div className="filter-bar">
                <Input placeholder="搜索标题、摘要、正文" value={q} onChange={(e) => setQ(e.target.value)} />
                <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="">全部分类</option>
                  {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </Select>
                <Select value={industry} onChange={(e) => setIndustry(e.target.value)}>
                  <option value="">全部行业</option>
                  {INDUSTRY_OPTIONS.map((i) => (
                    <option key={i.value} value={i.value}>{i.label}</option>
                  ))}
                </Select>
                <Select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                  <option value="">全部有效期</option>
                  <option value="expiring">30 天内到期</option>
                  <option value="expired">已过期</option>
                </Select>
              </div>
            }
          >
            {items.length === 0 ? (
              <Empty title="没有匹配的知识条目" hint="换个关键词，或新增一条项目复盘。" />
            ) : (
              <div className="knowledge-list">
                {items.map((item) => (
                  <article key={item.id} className="knowledge-card">
                    <div className="knowledge-card-top">
                      <Badge tone={item.category === 'opportunity' ? 'blue' : item.category === 'template' ? 'green' : 'gray'}>
                        {CATEGORY_LABEL[item.category] ?? item.category}
                      </Badge>
                      <span className="muted small">{INDUSTRY_OPTIONS.find((i) => i.value === item.industry)?.label ?? item.industry}</span>
                      {item.status !== 'published' ? (
                        <Badge tone="amber">{STATUS_LABEL[item.status] ?? item.status}</Badge>
                      ) : null}
                      {expiryState(item) === 'expired' ? (
                        <Badge tone="red">已过期</Badge>
                      ) : expiryState(item) === 'expiring' ? (
                        <Badge tone="amber">30 天内到期</Badge>
                      ) : null}
                    </div>
                    <h3>{item.title}</h3>
                    <p>{item.summary}</p>
                    <div className="tag-row">
                      {item.tags.map((t) => (
                        <span key={t} className="tag">#{t}</span>
                      ))}
                    </div>
                    <div className="knowledge-card-foot">
                      <span className="muted small">{item.source || '内部知识库'}</span>
                      <div className="inline-actions">
                        {canReview ? (
                          item.status === 'draft' ? (
                            <Button size="sm" variant="primary" onClick={() => void review(item, 'approve')}>
                              通过发布
                            </Button>
                          ) : (
                            <Button size="sm" onClick={() => void review(item, 'reject')}>退回</Button>
                          )
                        ) : null}
                        <Button size="sm" onClick={() => setViewing(item)}>查看</Button>
                        <Button size="sm" onClick={() => openEdit(item)}>编辑</Button>
                        <Button size="sm" variant="danger" onClick={() => void remove(item)}>删除</Button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
            {hasMore ? (
              <div className="form-actions">
                <Button size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore ? '加载中…' : `加载更多（已显示 ${items.length} / ${paged.total}）`}
                </Button>
              </div>
            ) : null}
          </Card>
      </>

      <Modal
        open={open}
        title={editing ? '编辑知识条目' : '新增知识条目'}
        subtitle="写清适用场景与前置条件，避免把个案当通用结论。"
        onClose={() => setOpen(false)}
        wide
        footer={
          <>
            <Button onClick={() => setOpen(false)}>取消</Button>
            <Button variant="primary" disabled={saving} onClick={() => void save()}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </>
        }
      >
        {formError ? <ErrorBox error={formError} /> : null}
        <div className="form-grid">
          <Field label="标题" required className="span-2">
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field label="行业">
            <Select value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value })}>
              {INDUSTRY_OPTIONS.map((i) => (
                <option key={i.value} value={i.value}>{i.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="分类">
            <Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </Field>
          <Field label="摘要" required className="span-2">
            <Textarea rows={2} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} />
          </Field>
          <Field label="正文" required className="span-2">
            <Textarea
              rows={10}
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
              placeholder="适用场景、做法、前置条件、失败教训"
            />
          </Field>
          <Field label="标签" hint="用逗号或空格分隔">
            <Input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="OCR, 单证, 复核" />
          </Field>
          <Field label="来源">
            <Input value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} placeholder="项目复盘 / 行业案例" />
          </Field>
          <Field label="状态">
            <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              {Object.entries(STATUS_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </Field>
          <Field label="有效期" hint="到期后提示复核；不自动删除">
            <Input type="date" value={form.expires_at} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} />
          </Field>
        </div>
      </Modal>

      <Modal
        open={!!viewing}
        title={viewing?.title ?? ''}
        subtitle={viewing ? `${CATEGORY_LABEL[viewing.category] ?? viewing.category} · ${viewing.source ?? '内部知识库'}` : ''}
        onClose={() => setViewing(null)}
        wide
        footer={<Button onClick={() => setViewing(null)}>关闭</Button>}
      >
        {viewing ? (
          <div className="preview">
            <div className="tag-row">
              {viewing.tags.map((t) => <span key={t} className="tag">#{t}</span>)}
            </div>
            <p><strong>{viewing.summary}</strong></p>
            {viewing.expires_at ? (
              <p className="muted small">有效期至 {fmtDate(viewing.expires_at)}{viewing.reviewed_at ? ` · 审批于 ${fmtDate(viewing.reviewed_at)}` : ''}</p>
            ) : null}
            <pre className="preview-text">{viewing.content}</pre>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
