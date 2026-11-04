import { lazy, Suspense, useState } from 'react';
import { api } from '../../api';
import { DependencyGraph } from '../../components/DependencyGraph';
const MarkdownView = lazy(() =>
  import('../../components/MarkdownView').then((m) => ({ default: m.MarkdownView })),
);
import { useDebouncedValue, useLoad, usePaged } from '../../hooks';
import type { Deliverable, DeliverableShare, EngagementDetail, ShareView } from '../../types';
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
  Textarea,
} from '../../ui';
import {
  deliverableTypeLabel,
  fmtDateTime,
  shareChannelLabel,
} from '../../utils';

export function ReportsTab({
  engagementId,
  detail,
  onChanged,
}: {
  engagementId: string;
  detail: EngagementDetail;
  onChanged: () => void;
}) {
  const [docSearch, setDocSearch] = useState('');
  const docQuery = useDebouncedValue(docSearch, 300);
  const deliverables = usePaged(
    (limit, offset) => api.listDeliverables(engagementId, { limit, offset, q: docQuery }),
    [engagementId, docQuery],
  );
  const checks = useLoad(
    () => api.consistencyChecks(engagementId),
    [engagementId],
  );
  const stakeholders = useLoad(
    () => api.listStakeholders(engagementId),
    [engagementId],
  );
  const shares = useLoad(
    () => api.listShares(engagementId),
    [engagementId],
  );
  const dependencies = useLoad(
    () => api.listDependencies(engagementId),
    [engagementId],
  );

  const [preview, setPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pdfNotice, setPdfNotice] = useState<string | null>(null);
  const [pdfBusyId, setPdfBusyId] = useState<string | null>(null);
  const [generating, setGenerating] = useState<string | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [modal, setModal] = useState<{ title: string; text: string } | null>(null);
  const [sourceMode, setSourceMode] = useState(false);

  const [shareTarget, setShareTarget] = useState<Deliverable | null>(null);
  const [shareForm, setShareForm] = useState({
    shared_to: '',
    channel: 'email',
    note: '',
  });
  const [shareError, setShareError] = useState<unknown>(null);
  const [sharing, setSharing] = useState(false);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [shareDays, setShareDays] = useState('30');
  const [history, setHistory] = useState<{
    id: string;
    title: string;
    items: DeliverableShare[];
  } | null>(null);
  const [viewLog, setViewLog] = useState<{
    title: string;
    items: ShareView[];
    summary: { views: number; docx: number; pdf: number };
  } | null>(null);

  const loadPreview = async () => {
    setPreviewLoading(true);
    setError(null);
    try {
      setPreview(await api.preview(engagementId));
    } catch (err) {
      setError(err);
    } finally {
      setPreviewLoading(false);
    }
  };

  const generate = async (type: 'diagnosis_report' | 'one_pager') => {
    setGenerating(type);
    setError(null);
    try {
      const res = await api.generate(engagementId, type);
      const md = await api.deliverableMarkdown(res.id);
      setModal({ title: `${res.title} v${res.version}`, text: md });
      await deliverables.reload();
      await checks.reload();
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setGenerating(null);
    }
  };

  const viewDeliverable = async (d: Deliverable) => {
    try {
      const text = await api.deliverableMarkdown(d.id);
      setModal({ title: `${d.title} v${d.version}`, text });
    } catch (err) {
      setError(err);
    }
  };

  const changeStatus = async (d: Deliverable, status: string) => {
    if (status === 'approved' && d.is_stale) {
      setError(
        new Error('复核内容已变更，请重新生成报告后再审批或外发'),
      );
      return;
    }
    try {
      await api.setDeliverableStatus(d.id, status);
      await api.refreshGates(engagementId);
      await deliverables.reload();
      await checks.reload();
      onChanged();
    } catch (err) {
      setError(err);
    }
  };

  const regenerateStale = async (d: Deliverable) => {
    if (!d.review_id) return;
    setRegeneratingId(d.id);
    setError(null);
    try {
      await api.generateReconcileDocument(d.review_id);
      await deliverables.reload();
      await checks.reload();
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setRegeneratingId(null);
    }
  };

  const downloadDocx = async (d: Deliverable) => {
    try {
      const blob = await api.exportDocx(d.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${d.title} v${d.version}.docx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (err) {
      setError(err);
    }
  };

  const downloadPdf = async (d: Deliverable) => {
    setError(null);
    setPdfNotice(`「${d.title}」PDF 后台生成中…`);
    setPdfBusyId(d.id);
    try {
      const created = await api.createPdfJob(d.id);
      const jobId = created.item.id;
      let job = created.item;
      for (let i = 0; i < 120; i += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 600));
        job = (await api.getPdfJob(jobId)).item;
        if (job.status === 'done' || job.status === 'failed') break;
      }
      if (job.status !== 'done') {
        throw new Error(job.error ?? 'PDF 生成超时');
      }
      const blob = await api.downloadPdfJob(jobId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${d.title} v${d.version}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      setPdfNotice(`「${d.title}」PDF 已生成。`);
    } catch (err) {
      setError(err);
      setPdfNotice(null);
    } finally {
      setPdfBusyId(null);
    }
  };

  const printDeliverable = (d: Deliverable) => {
    window.open(api.exportHtmlUrl(d.id), '_blank', 'noopener');
  };

  const openShare = (d: Deliverable) => {
    setShareError(null);
    setShareLink(null);
    setShareDays('30');
    setShareForm({
      shared_to: stakeholders.data?.items[0]?.id ?? '',
      channel: 'email',
      note: '',
    });
    setShareTarget(d);
  };

  const submitShare = async () => {
    if (!shareTarget) return;
    setSharing(true);
    setShareError(null);
    try {
      if (!shareForm.shared_to) throw new Error('请选择外发对象');
      const res = await api.createShare(shareTarget.id, {
        shared_to: shareForm.shared_to,
        channel: shareForm.channel,
        note: shareForm.note || undefined,
        expires_in_days: Number(shareDays) || 30,
      });
      if (res.item.token) {
        setShareLink(
          `${window.location.origin}${window.location.pathname}#/share/${res.item.token}`,
        );
      }
      await deliverables.reload();
      await shares.reload();
      await checks.reload();
      onChanged();
    } catch (err) {
      setShareError(err);
    } finally {
      setSharing(false);
    }
  };

  const refreshHistory = async (id: string) => {
    const full = await api.getDeliverable(id);
    setHistory((prev) => (prev ? { ...prev, items: full.shares } : prev));
  };

  const openHistory = async (d: Deliverable) => {
    try {
      const full = await api.getDeliverable(d.id);
      setHistory({ id: d.id, title: `${d.title} v${d.version}`, items: full.shares });
    } catch (err) {
      setError(err);
    }
  };

  const openViews = async (s: DeliverableShare) => {
    try {
      const res = await api.listShareViews(s.id);
      setViewLog({
        title: s.shared_to_name ?? '分享访问',
        items: res.items,
        summary: res.summary,
      });
    } catch (err) {
      setError(err);
    }
  };

  const rotateShare = async (s: DeliverableShare) => {
    if (!window.confirm('轮换后旧链接立即失效，确认继续？')) return;
    try {
      await api.rotateShare(s.id, 30);
      if (history) await refreshHistory(history.id);
    } catch (err) {
      setError(err);
    }
  };

  const revokeShare = async (s: DeliverableShare) => {
    if (!window.confirm('撤销后该链接立即不可访问，确认继续？')) return;
    try {
      await api.revokeShare(s.id);
      if (history) await refreshHistory(history.id);
    } catch (err) {
      setError(err);
    }
  };

  const removeShare = async (id: string) => {
    if (!window.confirm('删除这条外发记录？')) return;
    try {
      await api.deleteShare(id);
      await shares.reload();
      await deliverables.reload();
      setHistory(null);
    } catch (err) {
      setError(err);
    }
  };

  const summary = checks.data?.summary;
  const issues = checks.data?.checks.filter((c) => c.outcome !== 'pass') ?? [];
  const shareable = (d: Deliverable) =>
    d.status === 'approved' || d.status === 'shared';

  return (
    <div className="tab-body">
      <Card
        title="生成交付物"
        subtitle="生成前会跑 14 项一致性校验；有 block 时接口返回 422，不写库。"
      >
        {error ? <ErrorBox error={error} /> : null}
        <div className="generate-bar">
          <Button
            variant="primary"
            disabled={!!generating || checks.data?.blocked}
            onClick={() => void generate('diagnosis_report')}
          >
            {generating === 'diagnosis_report' ? '生成中…' : '生成诊断报告'}
          </Button>
          <Button
            disabled={!!generating || checks.data?.blocked}
            onClick={() => void generate('one_pager')}
          >
            {generating === 'one_pager' ? '生成中…' : '生成一页纸简报'}
          </Button>
          {checks.data?.blocked && (
            <Badge tone="red">有 block，生成被拦截</Badge>
          )}
        </div>

        {checks.loading && <Spinner label="校验中…" />}
        {checks.error ? <ErrorBox error={checks.error} onRetry={() => void checks.reload()} /> : null}
        {summary && (
          <>
            <div className="check-summary">
              <span className="check-pill check-pass">{summary.pass} pass</span>
              <span className="check-pill check-warn">{summary.warn} warn</span>
              <span className="check-pill check-block">{summary.block} block</span>
            </div>
            {issues.length === 0 ? (
              <Notice tone="green">14 项校验全部通过，可以生成。</Notice>
            ) : (
              <div className="issue-list">
                {issues.map((c) => (
                  <div key={c.code} className="issue-row">
                    <Badge tone={c.outcome === 'block' ? 'red' : 'amber'}>
                      {c.outcome === 'block' ? 'block' : 'warn'}
                    </Badge>
                    <strong>{c.code}</strong>
                    <span>{c.title}</span>
                    <span className="muted">{c.message}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Card>

      <Card
        title="机会点依赖图"
        subtitle="与报告 §8.1 使用同一组依赖数据；报告里同时输出 Mermaid 源码，支持 Mermaid 的工具可直接渲染。"
      >
        {dependencies.loading && <Spinner />}
        {dependencies.error ? (
          <ErrorBox error={dependencies.error} onRetry={() => void dependencies.reload()} />
        ) : null}
        {dependencies.data && (
          <DependencyGraph
            opportunities={detail.opportunities}
            dependencies={dependencies.data.items}
          />
        )}
      </Card>

      <Card
        title="报告预览"
        subtitle="直接渲染当前数据库快照；不会写交付物。"
        actions={
          <>
            {preview && (
              <Button size="sm" variant="ghost" onClick={() => setSourceMode((v) => !v)}>
                {sourceMode ? '渲染视图' : '源码'}
              </Button>
            )}
            <Button size="sm" onClick={() => void loadPreview()} disabled={previewLoading}>
              {previewLoading ? '加载中…' : preview ? '刷新预览' : '加载预览'}
            </Button>
          </>
        }
      >
        {!preview && !previewLoading && (
          <Empty
            title="还没有加载预览"
            hint={`模板 ${detail.template?.template_key ?? 'logistics_diagnosis'} v${detail.template?.version ?? '2.2.0'}`}
            action={<Button onClick={() => void loadPreview()}>加载报告预览</Button>}
          />
        )}
        {previewLoading && <Spinner />}
        {preview && <MarkdownPane text={preview} source={sourceMode} />}
      </Card>

      <Card
        title="交付物版本"
        subtitle="同一类型每次生成版本号 +1；外发前需先批准；可导出 Word 或打印为 PDF。"
        actions={
          <>
            <Input
              placeholder="搜索标题/类型"
              value={docSearch}
              onChange={(e) => setDocSearch(e.target.value)}
            />
            <Button size="sm" onClick={() => void deliverables.reload()}>
              刷新
            </Button>
          </>
        }
      >
        {deliverables.loading && <Spinner />}
        {deliverables.error ? (
          <ErrorBox error={deliverables.error} onRetry={() => void deliverables.reload()} />
        ) : null}
        {pdfNotice ? <Notice tone="blue">{pdfNotice}</Notice> : null}
        {!deliverables.loading && deliverables.items.length === 0 && (
          <Empty title="还没有交付物" hint="先点上方「生成诊断报告」。" />
        )}
        {deliverables.items.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>类型</th>
                  <th>标题</th>
                  <th>版本</th>
                  <th>状态</th>
                  <th>外发</th>
                  <th>字符数</th>
                  <th>生成时间</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {deliverables.items.map((d) => (
                  <tr key={d.id}>
                    <td>{deliverableTypeLabel(d.type)}</td>
                    <td>{d.title}</td>
                    <td className="mono">v{d.version}</td>
                    <td>
                      <select
                        className="inline-select"
                        value={d.status}
                        onChange={(e) => void changeStatus(d, e.target.value)}
                      >
                        <option value="draft">草稿</option>
                        <option value="in_review">审核中</option>
                        <option value="approved">已批准</option>
                        <option value="shared">已外发</option>
                        <option value="archived">已归档</option>
                      </select>
                      {d.is_stale ? (
                        <Badge tone="amber">已过期</Badge>
                      ) : null}
                    </td>
                    <td>
                      {d.share_count ? (
                        <Badge tone="blue">{d.share_count} 次</Badge>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>{d.chars ?? '—'}</td>
                    <td className="muted">{fmtDateTime(d.created_at)}</td>
                    <td className="actions-cell">
                      <Button size="sm" variant="ghost" onClick={() => void viewDeliverable(d)}>
                        查看
                      </Button>
                      {d.is_stale && d.review_id ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={regeneratingId === d.id}
                          onClick={() => void regenerateStale(d)}
                        >
                          {regeneratingId === d.id ? '生成中…' : '重新生成'}
                        </Button>
                      ) : null}
                      <Button size="sm" variant="ghost" onClick={() => void downloadDocx(d)}>
                        Word
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pdfBusyId === d.id}
                        onClick={() => void downloadPdf(d)}
                      >
                        {pdfBusyId === d.id ? 'PDF…' : 'PDF'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => printDeliverable(d)}>
                        打印
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!shareable(d) || !stakeholders.data?.items.length}
                        title={
                          !shareable(d)
                            ? '先批准交付物，再外发'
                            : !stakeholders.data?.items.length
                              ? '先录入干系人'
                              : '记录一次外发'
                        }
                        onClick={() => openShare(d)}
                      >
                        外发
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void openHistory(d)}>
                        记录
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {deliverables.hasMore ? (
          <div className="form-actions">
            <Button
              size="sm"
              disabled={deliverables.loadingMore}
              onClick={() => void deliverables.loadMore()}
            >
              {deliverables.loadingMore
                ? '加载中…'
                : `加载更多（已显示 ${deliverables.items.length} / ${deliverables.total}）`}
            </Button>
          </div>
        ) : null}
      </Card>

      <Card
        title="外发记录"
        subtitle="交付物以电子文档人工提供；每次外发留痕，客户侧不需要登录。"
        actions={
          <Button size="sm" onClick={() => void shares.reload()}>
            刷新
          </Button>
        }
      >
        {shares.loading && <Spinner />}
        {shares.error ? (
          <ErrorBox error={shares.error} onRetry={() => void shares.reload()} />
        ) : null}
        {shares.data && shares.data.items.length === 0 && (
          <Empty
            title="还没有外发记录"
            hint="把交付物状态改为「已批准」后，点「外发」选择对象和渠道。"
          />
        )}
        {shares.data && shares.data.items.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>交付物</th>
                  <th>对象</th>
                  <th>渠道</th>
                  <th>链接</th>
                  <th>访问</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shares.data.items.map((s) => (
                  <tr key={s.id}>
                    <td className="muted">{fmtDateTime(s.shared_at)}</td>
                    <td>
                      {s.deliverable_title}
                      {s.deliverable_version ? (
                        <span className="mono"> v{s.deliverable_version}</span>
                      ) : null}
                    </td>
                    <td>
                      {s.shared_to_name}
                      {s.shared_to_title ? (
                        <span className="muted"> · {s.shared_to_title}</span>
                      ) : null}
                    </td>
                    <td>{shareChannelLabel(s.channel)}</td>
                    <td className="muted">{s.note || '—'}</td>
                    <td className="actions-cell">
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => void removeShare(s.id)}
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
        open={!!modal}
        title={modal?.title ?? ''}
        onClose={() => setModal(null)}
        wide
        footer={
          <>
            <Button variant="ghost" onClick={() => setSourceMode((v) => !v)}>
              {sourceMode ? '查看渲染' : '查看源码'}
            </Button>
            <Button
              onClick={() => {
                if (modal) void navigator.clipboard?.writeText(modal.text);
              }}
            >
              复制 Markdown
            </Button>
            <Button variant="primary" onClick={() => setModal(null)}>
              关闭
            </Button>
          </>
        }
      >
        {modal && <MarkdownPane text={modal.text} tall source={sourceMode} />}
      </Modal>

      <Modal
        open={!!shareTarget}
        title={`外发：${shareTarget?.title ?? ''} v${shareTarget?.version ?? ''}`}
        subtitle="外发后交付物状态自动变为「已外发」，并留下记录。"
        onClose={() => setShareTarget(null)}
        footer={
          shareLink ? (
            <Button variant="primary" onClick={() => setShareTarget(null)}>完成</Button>
          ) : (
            <>
              <Button onClick={() => setShareTarget(null)}>取消</Button>
              <Button variant="primary" disabled={sharing} onClick={() => void submitShare()}>
                {sharing ? '记录中…' : '确认外发'}
              </Button>
            </>
          )
        }
      >
        {shareError ? <ErrorBox error={shareError} /> : null}
        {shareLink ? (
          <Notice tone="green">
            <div className="share-link-box">
              <strong>只读分享链接已生成</strong>
              <code>{shareLink}</code>
              <div className="inline-actions">
                <Button
                  size="sm"
                  onClick={() => void navigator.clipboard.writeText(shareLink)}
                >
                  复制链接
                </Button>
                <Button
                  size="sm"
                  onClick={() => window.open(shareLink, '_blank', 'noopener')}
                >
                  预览
                </Button>
              </div>
              <p className="hint-line">
                链接 {shareDays} 天内有效；客户无需登录即可查看并下载 Word/PDF。
                撤销或轮换链接可在「记录」中操作。
              </p>
            </div>
          </Notice>
        ) : (
        <div className="form-grid">
          <Field label="外发对象" required>
            <Select
              value={shareForm.shared_to}
              onChange={(e) => setShareForm({ ...shareForm, shared_to: e.target.value })}
            >
              <option value="">请选择干系人</option>
              {(stakeholders.data?.items ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.title ? ` · ${s.title}` : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="渠道">
            <Select
              value={shareForm.channel}
              onChange={(e) => setShareForm({ ...shareForm, channel: e.target.value })}
            >
              <option value="email">邮件</option>
              <option value="wechat">企业微信</option>
              <option value="meeting">会议</option>
              <option value="print">打印</option>
            </Select>
          </Field>
          <Field label="链接有效期（天）">
            <Input
              type="number"
              min={1}
              max={365}
              value={shareDays}
              onChange={(e) => setShareDays(e.target.value)}
            />
          </Field>
          <Field label="备注" className="span-2">
            <Textarea
              rows={3}
              value={shareForm.note}
              onChange={(e) => setShareForm({ ...shareForm, note: e.target.value })}
              placeholder="如：发给张总，附一句本期建议先做 OP-01 + OP-03。"
            />
          </Field>
        </div>
        )}
      </Modal>

      <Modal
        open={!!history}
        title={`外发记录 · ${history?.title ?? ''}`}
        onClose={() => setHistory(null)}
        wide
        footer={<Button onClick={() => setHistory(null)}>关闭</Button>}
      >
        {!history || history.items.length === 0 ? (
          <Empty title="这份交付物还没有外发记录" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>对象</th>
                  <th>渠道</th>
                  <th>链接</th>
                  <th>访问</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {history.items.map((s) => (
                  <tr key={s.id}>
                    <td className="muted">{fmtDateTime(s.shared_at)}</td>
                    <td>
                      {s.shared_to_name}
                      {s.shared_to_title ? (
                        <span className="muted"> · {s.shared_to_title}</span>
                      ) : null}
                    </td>
                    <td>{shareChannelLabel(s.channel)}</td>
                    <td>
                      {s.revoked_at ? (
                        <Badge tone="red">已撤销</Badge>
                      ) : s.token ? (
                        <>
                          <Badge tone="green">有效</Badge>
                          {s.expires_at ? (
                            <div className="muted small">至 {fmtDateTime(s.expires_at)}</div>
                          ) : null}
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>{s.view_count ?? 0}</td>
                    <td className="actions-cell">
                      {s.token && !s.revoked_at ? (
                        <>
                          <Button
                            size="sm"
                            onClick={() =>
                              void navigator.clipboard.writeText(
                                `${window.location.origin}${window.location.pathname}#/share/${s.token}`,
                              )
                            }
                          >
                            复制
                          </Button>
                          <Button size="sm" onClick={() => void openViews(s)}>明细</Button>
                          <Button size="sm" onClick={() => void rotateShare(s)}>轮换</Button>
                          <Button size="sm" variant="danger" onClick={() => void revokeShare(s)}>
                            撤销
                          </Button>
                        </>
                      ) : null}
                      <Button size="sm" variant="danger" onClick={() => void removeShare(s.id)}>
                        删除
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>

      <Modal
        open={!!viewLog}
        title={`访问明细 · ${viewLog?.title ?? ''}`}
        subtitle={
          viewLog
            ? `浏览 ${viewLog.summary.views} · Word ${viewLog.summary.docx} · PDF ${viewLog.summary.pdf}`
            : ''
        }
        onClose={() => setViewLog(null)}
        wide
        footer={<Button onClick={() => setViewLog(null)}>关闭</Button>}
      >
        {!viewLog || viewLog.items.length === 0 ? (
          <Empty title="还没有访问记录" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>时间</th><th>类型</th><th>IP</th><th>User-Agent</th><th>来源</th></tr>
              </thead>
              <tbody>
                {viewLog.items.map((v) => (
                  <tr key={v.id}>
                    <td className="muted nowrap">{fmtDateTime(v.viewed_at)}</td>
                    <td>
                      <Badge tone={v.kind === 'view' ? 'blue' : 'green'}>
                        {v.kind === 'view' ? '浏览' : v.kind === 'docx' ? 'Word' : 'PDF'}
                      </Badge>
                    </td>
                    <td className="mono muted">{v.ip ?? '—'}</td>
                    <td className="muted small">{v.user_agent || '—'}</td>
                    <td className="muted small">{v.referer || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </div>
  );
}

function MarkdownPane({
  text,
  tall,
  source,
}: {
  text: string;
  tall?: boolean;
  source?: boolean;
}) {
  if (source) {
    return <pre className={`markdown-view ${tall ? 'markdown-tall' : ''}`}>{text}</pre>;
  }
  return (
    <div className={tall ? 'markdown-scroll markdown-tall' : 'markdown-scroll'}>
      <Suspense fallback={<Spinner label="渲染中…" />}>
        <MarkdownView markdown={text} />
      </Suspense>
    </div>
  );
}
