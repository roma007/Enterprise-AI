import { useState } from 'react';
import { api } from '../api';
import { useDebouncedValue, useForm, useLoad, usePaged } from '../hooks';
import type { Client, EngagementSummary } from '../types';
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
} from '../ui';
import {
  engagementStatusLabel,
  fmtDate,
  stageLabel,
  stageTone,
} from '../utils';

export function Dashboard({ onOpen }: { onOpen: (id: string) => void }) {
  const [search, setSearch] = useState('');
  const dq = useDebouncedValue(search, 300);
  const projects = usePaged(
    (limit, offset) => api.listEngagements({ limit, offset, q: dq }),
    [dq],
    100,
  );
  const clientLoad = useLoad(() => api.listClients({ limit: 500 }), []);
  const engagements = projects.items;
  const clients = clientLoad.data?.items ?? [];
  const loading = projects.loading;
  const error = projects.error ?? clientLoad.error;
  const reload = async () => {
    await Promise.all([projects.reload(), clientLoad.reload()]);
  };

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [formError, setFormError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const form = useForm({
    clientId: '',
    clientName: '',
    annualRevenue: '',
    projectName: '',
    startDate: '',
    endDate: '',
    region: '',
  });

  const totalOpps = engagements.reduce((a, e) => a + e.opportunity_count, 0);
  const totalDeliverables = engagements.reduce((a, e) => a + e.deliverable_count, 0);
  const activeCount = engagements.filter((e) => e.status === 'active').length;

  const openCreate = () => {
    setMode(clients.length ? 'existing' : 'new');
    setFormError(null);
    form.setValues({
      clientId: clients[0]?.id ?? '',
      clientName: '',
      annualRevenue: '',
      projectName: '',
      startDate: '',
      endDate: '',
      region: '',
    });
    setOpen(true);
  };

  const submit = async () => {
    setSubmitting(true);
    setFormError(null);
    try {
      let clientId = form.values.clientId;
      if (mode === 'new') {
        if (!form.values.clientName.trim()) throw new Error('请填写客户名称');
        const c = await api.createClient({
          name: form.values.clientName.trim(),
          annual_revenue: form.values.annualRevenue
            ? Number(form.values.annualRevenue)
            : undefined,
          region: form.values.region || undefined,
        });
        clientId = c.item.id;
      }
      if (!clientId) throw new Error('请选择客户');
      if (!form.values.projectName.trim()) throw new Error('请填写项目名称');
      const e = await api.createEngagement({
        client_id: clientId,
        name: form.values.projectName.trim(),
        start_date: form.values.startDate || undefined,
        target_end_date: form.values.endDate || undefined,
      });
      setOpen(false);
      onOpen(e.item.id);
    } catch (err) {
      setFormError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="S1 · 诊断调研"
        title="项目列表"
        subtitle="以 AI 机会点为主线，从诊断数据生成客户能拍板的报告。"
        actions={
          <>
            <Input
              placeholder="搜索项目或客户"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Button onClick={() => void reload()}>刷新</Button>
            <Button variant="primary" onClick={openCreate}>
              + 新建项目
            </Button>
          </>
        }
      />

      {loading && <Spinner />}
      {error ? <ErrorBox error={error} onRetry={() => void reload()} /> : null}

      {!loading && !error && (
        <>
          <div className="stat-grid">
            <Stat
              label="项目总数"
              value={projects.total}
              hint={`已加载 ${engagements.length} 个 · ${activeCount} 个进行中`}
            />
            <Stat label="机会点" value={totalOpps} hint="跨项目累计" tone="brand" />
            <Stat label="交付物" value={totalDeliverables} hint="已生成版本" tone="blue" />
            <Stat
              label="客户"
              value={clientLoad.data?.total ?? clients.length}
              hint="供应商视角"
              tone="green"
            />
          </div>

          {engagements.length === 0 ? (
            <Card>
              <Empty
                title="还没有项目"
                hint="先建一个客户和诊断项目，系统会自动初始化 G0–G5 门禁。"
                action={
                  <Button variant="primary" onClick={openCreate}>
                    新建第一个项目
                  </Button>
                }
              />
            </Card>
          ) : (
            <>
            <div className="project-grid">
              {engagements.map((e) => (
                <button key={e.id} className="project-card" onClick={() => onOpen(e.id)}>
                  <div className="project-top">
                    <Badge tone={stageTone(e.stage)}>{stageLabel(e.stage)}</Badge>
                    <Badge tone={e.status === 'active' ? 'green' : 'gray'}>
                      {engagementStatusLabel(e.status)}
                    </Badge>
                  </div>
                  <h3>{e.client_name}</h3>
                  <p className="project-name">{e.name}</p>
                  <div className="project-meta">
                    <span>机会点 {e.opportunity_count}</span>
                    <span>痛点 {e.pain_point_count}</span>
                    <span>交付物 {e.deliverable_count}</span>
                  </div>
                  <div className="project-foot">
                    {fmtDate(e.start_date)} → {fmtDate(e.target_end_date)}
                  </div>
                </button>
              ))}
            </div>
            {projects.hasMore ? (
              <div className="form-actions">
                <Button
                  size="sm"
                  disabled={projects.loadingMore}
                  onClick={() => void projects.loadMore()}
                >
                  {projects.loadingMore
                    ? '加载中…'
                    : `加载更多（已显示 ${engagements.length} / ${projects.total}）`}
                </Button>
              </div>
            ) : null}
            </>
          )}
        </>
      )}

      <Modal
        open={open}
        title="新建诊断项目"
        subtitle="客户与项目建好后，门禁和录入清单会自动就绪。"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>取消</Button>
            <Button variant="primary" disabled={submitting} onClick={() => void submit()}>
              {submitting ? '创建中…' : '创建项目'}
            </Button>
          </>
        }
      >
        {formError ? <ErrorBox error={formError} /> : null}

        <div className="segmented">
          <button
            className={mode === 'existing' ? 'seg-active' : ''}
            onClick={() => setMode('existing')}
            disabled={!clients.length}
          >
            选择已有客户
          </button>
          <button
            className={mode === 'new' ? 'seg-active' : ''}
            onClick={() => setMode('new')}
          >
            新建客户
          </button>
        </div>

        {mode === 'existing' ? (
          <Field label="客户" required>
            <Select
              value={form.values.clientId}
              onChange={(e) => form.set('clientId', e.target.value)}
            >
              <option value="">请选择</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.region ? ` · ${c.region}` : ''}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <div className="form-grid">
            <Field label="客户名称" required>
              <Input
                value={form.values.clientName}
                onChange={(e) => form.set('clientName', e.target.value)}
                placeholder="如：宏远国际物流"
              />
            </Field>
            <Field label="年营收（万元）">
              <Input
                type="number"
                value={form.values.annualRevenue}
                onChange={(e) => form.set('annualRevenue', e.target.value)}
                placeholder="如：4800"
              />
            </Field>
            <Field label="区域">
              <Input
                value={form.values.region}
                onChange={(e) => form.set('region', e.target.value)}
                placeholder="如：宁波"
              />
            </Field>
          </div>
        )}

        <div className="form-grid">
          <Field label="项目名称" required className="span-2">
            <Input
              value={form.values.projectName}
              onChange={(e) => form.set('projectName', e.target.value)}
              placeholder="如：宏远物流 AI 化诊断"
            />
          </Field>
          <Field label="开始日期">
            <Input
              type="date"
              value={form.values.startDate}
              onChange={(e) => form.set('startDate', e.target.value)}
            />
          </Field>
          <Field label="目标结束">
            <Input
              type="date"
              value={form.values.endDate}
              onChange={(e) => form.set('endDate', e.target.value)}
            />
          </Field>
        </div>

        <p className="hint-line">
          创建后会自动生成 G0–G5 门禁和 G1 标准清单；G1 的量化项会随录入数据自动刷新。
        </p>
      </Modal>
    </div>
  );
}
