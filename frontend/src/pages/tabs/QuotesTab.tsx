import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { useLoad } from '../../hooks';
import type { Quote, QuoteDetail, Solution } from '../../types';
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
import { fmtDate, fmtMoney } from '../../utils';

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  sent: '已发送',
  accepted: '已接受',
  rejected: '已拒绝',
  expired: '已过期',
};

const KIND_LABEL: Record<string, string> = {
  one_time: '一次性',
  annual_ops: '年运维',
};

const statusTone = (status: string) =>
  status === 'accepted'
    ? 'green'
    : status === 'rejected'
      ? 'red'
      : status === 'sent'
        ? 'blue'
        : 'gray';

export function QuotesTab({
  engagementId,
  onChanged,
  onGoReports,
}: {
  engagementId: string;
  onChanged: () => void;
  onGoReports: () => void;
}) {
  const { data, error, loading, reload } = useLoad(
    async () => {
      const [q, s] = await Promise.all([
        api.listQuotes(engagementId),
        api.listSolutions(engagementId),
      ]);
      return { quotes: q.items, solutions: s.items };
    },
    [engagementId],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);

  const quotes = data?.quotes ?? [];
  const solutions = data?.solutions ?? [];

  useEffect(() => {
    if (!selectedId && quotes.length) setSelectedId(quotes[0].id);
  }, [quotes, selectedId]);

  const create = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const res = await api.createQuote(engagementId, {
        currency: 'CNY',
        notes: '方案阶段报价',
      });
      await reload();
      setSelectedId(res.item.id);
      onChanged();
    } catch (err) {
      setCreateError(err);
    } finally {
      setCreating(false);
    }
  };

  const after = async () => {
    await reload();
    onChanged();
  };

  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorBox error={error} onRetry={() => void reload()} />;

  return (
    <div className="tab-body">
      <div className="opp-layout">
        <Card
          title="报价单"
          subtitle="项目级版本；金额单位万元。"
          className="opp-list-card"
          actions={
            <Button variant="primary" size="sm" disabled={creating} onClick={() => void create()}>
              {creating ? '创建中…' : '+ 新报价'}
            </Button>
          }
        >
          {createError ? <ErrorBox error={createError} /> : null}
          {quotes.length === 0 ? (
            <Empty title="还没有报价" hint="创建第一版报价，再添加一次性/年运维行。" />
          ) : (
            <div className="opp-list">
              {quotes.map((q) => (
                <button
                  key={q.id}
                  className={`opp-item ${selectedId === q.id ? 'opp-item-active' : ''}`}
                  onClick={() => setSelectedId(q.id)}
                >
                  <div className="opp-item-top">
                    <span className="mono">v{q.version}</span>
                    <Badge tone={statusTone(q.status)}>{STATUS_LABEL[q.status] ?? q.status}</Badge>
                  </div>
                  <strong>{q.currency} 报价</strong>
                  <div className="opp-item-meta">
                    <span>一次性 {fmtMoney(q.one_time ?? 0)}</span>
                    <span>年运维 {fmtMoney(q.annual_ops ?? 0)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>

        <div className="opp-editor">
          {selectedId ? (
            <QuoteEditor
              quoteId={selectedId}
              solutions={solutions}
              onChanged={after}
              onGoReports={onGoReports}
            />
          ) : (
            <Card>
              <Empty title="选择或创建一份报价" hint="报价行支持关联方案版本。" />
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function QuoteEditor({
  quoteId,
  solutions,
  onChanged,
  onGoReports,
}: {
  quoteId: string;
  solutions: Solution[];
  onChanged: () => Promise<void> | void;
  onGoReports: () => void;
}) {
  const { data, error, loading, reload } = useLoad<QuoteDetail>(
    () => api.getQuote(quoteId),
    [quoteId],
  );
  const [header, setHeader] = useState({
    currency: 'CNY',
    payment_terms: '',
    valid_until: '',
    status: 'draft',
    notes: '',
  });
  const [item, setItem] = useState({
    kind: 'one_time',
    description: '',
    solution_id: '',
    qty: '1',
    unit_price: '',
  });
  const [errorBox, setErrorBox] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const q = data.item;
    setHeader({
      currency: q.currency,
      payment_terms: q.payment_terms ?? '',
      valid_until: q.valid_until ? fmtDate(q.valid_until) : '',
      status: q.status,
      notes: q.notes ?? '',
    });
  }, [data]);

  const solutionLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of solutions) {
      m.set(s.id, `${s.opportunity_code ?? 'OP'} v${s.version}`);
    }
    return m;
  }, [solutions]);

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

  const q = data.item;

  const saveHeader = () =>
    run(() =>
      api.updateQuote(q.id, {
        currency: header.currency,
        payment_terms: header.payment_terms || null,
        valid_until: header.valid_until || null,
        status: header.status,
        notes: header.notes || null,
      }),
    );

  const addItem = () =>
    run(async () => {
      if (!item.description.trim()) throw new Error('报价行说明必填');
      if (!item.unit_price) throw new Error('单价必填');
      await api.createQuoteItem(q.id, {
        kind: item.kind,
        description: item.description.trim(),
        solution_id: item.solution_id || undefined,
        qty: Number(item.qty) || 1,
        unit_price: Number(item.unit_price),
      });
      setItem({ ...item, description: '', unit_price: '' });
    });

  const generate = async () => {
    setBusy(true);
    setErrorBox(null);
    setNotice(null);
    try {
      const res = await api.generateQuoteDocument(q.id);
      setNotice(`已生成交付物：${res.item.title} v${res.item.version}`);
      await after();
    } catch (err) {
      setErrorBox(err);
    } finally {
      setBusy(false);
    }
  };

  const exportWord = async () => {
    setBusy(true);
    setErrorBox(null);
    try {
      const blob = await api.exportQuoteDocx(q.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${q.engagement_name ?? '报价单'} v${q.version}.docx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (err) {
      setErrorBox(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="editor-stack">
      <Card
        title={`报价单 v${q.version}`}
        subtitle={`${q.currency} · ${STATUS_LABEL[q.status] ?? q.status}`}
        actions={
          <>
            <Button size="sm" disabled={busy} onClick={() => void exportWord()}>
              导出 Word
            </Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void generate()}>
              生成报价单
            </Button>
          </>
        }
      >
        {errorBox ? <ErrorBox error={errorBox} /> : null}
        {notice ? (
          <div className="notice notice-green">
            {notice}{' '}
            <button className="link-btn" onClick={onGoReports}>
              去报告页查看 →
            </button>
          </div>
        ) : null}

        <div className="stat-grid">
          <Stat label="一次性投入" value={fmtMoney(data.totals.oneTime)} hint="报价行合计" tone="brand" />
          <Stat label="年运维" value={fmtMoney(data.totals.annualOps)} hint="报价行合计" tone="blue" />
          <Stat label="报价行" value={data.items.length} hint="一次性 + 年运维" />
          <Stat label="有效期" value={header.valid_until ? fmtDate(header.valid_until) : '—'} tone="amber" />
        </div>

        <div className="form-grid">
          <Field label="币种">
            <Input value={header.currency} onChange={(e) => setHeader({ ...header, currency: e.target.value })} />
          </Field>
          <Field label="状态">
            <Select value={header.status} onChange={(e) => setHeader({ ...header, status: e.target.value })}>
              {Object.entries(STATUS_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </Field>
          <Field label="有效期">
            <Input type="date" value={header.valid_until} onChange={(e) => setHeader({ ...header, valid_until: e.target.value })} />
          </Field>
          <Field label="付款条款">
            <Input value={header.payment_terms} onChange={(e) => setHeader({ ...header, payment_terms: e.target.value })} placeholder="如：3:4:3" />
          </Field>
          <Field label="备注" className="span-2">
            <Textarea rows={2} value={header.notes} onChange={(e) => setHeader({ ...header, notes: e.target.value })} />
          </Field>
        </div>
        <div className="form-actions">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void saveHeader()}>
            保存报价头
          </Button>
        </div>
      </Card>

      <Card title="报价明细" subtitle="一次性投入与年运维分开；金额 = 数量 × 单价。">
        {data.items.length === 0 ? (
          <Empty title="还没有报价行" hint="添加一次性实施费和年运维。" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>类型</th><th>方案</th><th>说明</th><th>数量</th><th>单价</th><th>金额</th><th /></tr>
              </thead>
              <tbody>
                {data.items.map((i) => (
                  <tr key={i.id}>
                    <td><Badge tone={i.kind === 'one_time' ? 'brand' : 'blue'}>{KIND_LABEL[i.kind] ?? i.kind}</Badge></td>
                    <td className="mono">{i.solution_id ? solutionLabel.get(i.solution_id) ?? '—' : '—'}</td>
                    <td>{i.description}</td>
                    <td>{i.qty}</td>
                    <td>{fmtMoney(i.unit_price)}</td>
                    <td><strong>{fmtMoney(i.amount)}</strong></td>
                    <td className="actions-cell">
                      <Button size="sm" variant="danger" disabled={busy} onClick={() => void run(() => api.deleteQuoteItem(i.id))}>
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
          <Select value={item.kind} onChange={(e) => setItem({ ...item, kind: e.target.value })}>
            <option value="one_time">一次性</option>
            <option value="annual_ops">年运维</option>
          </Select>
          <Input placeholder="说明" value={item.description} onChange={(e) => setItem({ ...item, description: e.target.value })} />
          <Select value={item.solution_id} onChange={(e) => setItem({ ...item, solution_id: e.target.value })}>
            <option value="">不关联方案</option>
            {solutions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.opportunity_code} v{s.version}
              </option>
            ))}
          </Select>
          <Input type="number" placeholder="数量" value={item.qty} onChange={(e) => setItem({ ...item, qty: e.target.value })} />
          <Input type="number" step="0.1" placeholder="单价（万）" value={item.unit_price} onChange={(e) => setItem({ ...item, unit_price: e.target.value })} />
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void addItem()}>
            添加
          </Button>
        </div>
      </Card>
    </div>
  );
}
