import { useState } from 'react';
import { api } from '../api';
import { useLoad } from '../hooks';
import type { Invoice, OrganizationSummary } from '../types';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  PageHeader,
  Select,
  Spinner,
  Stat,
} from '../ui';
import { fmtDate } from '../utils';

const INVOICE_STATUS_LABEL: Record<Invoice['status'], string> = {
  pending: '待支付',
  paid: '已支付',
  void: '已作废',
  overdue: '已逾期',
};

const INVOICE_STATUS_TONE: Record<Invoice['status'], 'green' | 'amber' | 'red' | 'gray'> = {
  pending: 'amber',
  paid: 'green',
  void: 'gray',
  overdue: 'red',
};

const money = (value: number) => `¥${value.toLocaleString('zh-CN')}`;

export function PlatformTenantsPage() {
  const { data, error, loading, reload } = useLoad(async () => {
    const [tenantsRes, invoicesRes] = await Promise.all([
      api.listPlatformTenants(),
      api.listPlatformInvoices(),
    ]);
    return { tenants: tenantsRes.items, invoices: invoicesRes.items };
  }, []);
  const [busy, setBusy] = useState<string | null>(null);
  const [opError, setOpError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const items = data?.tenants ?? [];
  const invoices = data?.invoices ?? [];
  const active = items.filter((t) => t.status === 'active').length;

  const exportTenant = async (t: OrganizationSummary) => {
    setBusy(t.id);
    setOpError(null);
    setNotice(null);
    try {
      const blob = await api.exportPlatformTenant(t.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tenant-${t.slug}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setNotice(`已导出「${t.name}」数据。`);
    } catch (err) {
      setOpError(err);
    } finally {
      setBusy(null);
    }
  };

  const removeTenant = async (t: OrganizationSummary) => {
    const input = window.prompt(
      `删除「${t.name}」会清空该租户全部业务数据与审计记录，且不可恢复。\n请输入组织标识 ${t.slug} 确认：`,
    );
    if (!input) return;
    setBusy(t.id);
    setOpError(null);
    setNotice(null);
    try {
      await api.deletePlatformTenant(t.id, input);
      setNotice(`租户「${t.name}」已删除。`);
      await reload();
    } catch (err) {
      setOpError(err);
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (t: OrganizationSummary) => {
    const next = t.status === 'active' ? 'suspended' : 'active';
    if (
      next === 'suspended' &&
      !window.confirm(`暂停「${t.name}」后该租户全部会话立即失效，确认继续？`)
    ) {
      return;
    }
    setBusy(t.id);
    setOpError(null);
    setNotice(null);
    try {
      await api.updatePlatformTenant(t.id, { status: next });
      setNotice(next === 'suspended' ? '租户已暂停。' : '租户已恢复。');
      await reload();
    } catch (err) {
      setOpError(err);
    } finally {
      setBusy(null);
    }
  };

  const changePlan = async (t: OrganizationSummary, plan: string) => {
    if (plan === t.plan) return;
    setBusy(t.id);
    setOpError(null);
    setNotice(null);
    try {
      const payload: Record<string, unknown> = { plan };
      if (plan === 'trial') {
        payload.trial_ends_at = new Date(Date.now() + 14 * 86400000).toISOString();
      }
      await api.updatePlatformTenant(t.id, payload);
      setNotice(`「${t.name}」套餐已调整为 ${plan.toUpperCase()}。`);
      await reload();
    } catch (err) {
      setOpError(err);
    } finally {
      setBusy(null);
    }
  };

  const extendTrial = async (t: OrganizationSummary) => {
    setBusy(t.id);
    setOpError(null);
    setNotice(null);
    try {
      await api.updatePlatformTenant(t.id, {
        plan: 'trial',
        trial_ends_at: new Date(Date.now() + 14 * 86400000).toISOString(),
      });
      setNotice(`「${t.name}」试用期已延长 14 天。`);
      await reload();
    } catch (err) {
      setOpError(err);
    } finally {
      setBusy(null);
    }
  };

  const markPaid = async (invoice: Invoice) => {
    setBusy(invoice.id);
    setOpError(null);
    setNotice(null);
    try {
      await api.markPlatformInvoicePaid(invoice.id);
      setNotice(`账单 ${invoice.invoice_no} 已标记为已支付。`);
      await reload();
    } catch (err) {
      setOpError(err);
    } finally {
      setBusy(null);
    }
  };

  const voidInvoice = async (invoice: Invoice) => {
    if (!window.confirm(`作废账单 ${invoice.invoice_no}？作废后不可恢复。`)) return;
    setBusy(invoice.id);
    setOpError(null);
    setNotice(null);
    try {
      await api.voidPlatformInvoice(invoice.id);
      setNotice(`账单 ${invoice.invoice_no} 已作废。`);
      await reload();
    } catch (err) {
      setOpError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="平台运营"
        title="租户管理"
        subtitle="供应商租户列表；暂停后无法登录，现有会话立即失效。"
        actions={<Button onClick={() => void reload()} disabled={loading}>刷新</Button>}
      />

      {loading && !data ? <Spinner /> : null}
      {error && !data ? <ErrorBox error={error} onRetry={() => void reload()} /> : null}
      {opError ? <ErrorBox error={opError} /> : null}
      {notice ? <div className="notice notice-green">{notice}</div> : null}

      {data ? (
        <>
          <div className="stat-grid">
            <Stat label="租户总数" value={items.length} tone="brand" />
            <Stat label="正常" value={active} tone="green" />
            <Stat label="已暂停" value={items.length - active} tone="red" />
          </div>

          <Card title="供应商租户" subtitle="组织标识用于登录区分；平台管理员可暂停/恢复。">
            {items.length === 0 ? (
              <Empty title="还没有租户" />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>组织</th><th>标识</th><th>套餐</th><th>试用</th><th>状态</th>
                      <th>用户</th><th>客户</th><th>项目</th><th>创建</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((t) => (
                      <tr key={t.id}>
                        <td><strong>{t.name}</strong></td>
                        <td className="mono muted">{t.slug}</td>
                        <td>{t.plan_name ?? t.plan.toUpperCase()}</td>
                        <td className="muted">
                          {t.plan === 'trial'
                            ? t.trial_days_left == null
                              ? '不限'
                              : t.trial_days_left > 0
                                ? `${t.trial_days_left} 天`
                                : <Badge tone="red">已到期</Badge>
                            : '—'}
                        </td>
                        <td><Badge tone={t.status === 'active' ? 'green' : 'red'}>{t.status === 'active' ? '正常' : '已暂停'}</Badge></td>
                        <td>{t.user_count}</td>
                        <td>{t.client_count}</td>
                        <td>{t.engagement_count}</td>
                        <td className="muted">{fmtDate(t.created_at)}</td>
                        <td className="actions-cell">
                          <Select
                            value={t.plan}
                            disabled={busy === t.id}
                            style={{ width: 96 }}
                            onChange={(e) => void changePlan(t, e.target.value)}
                          >
                            <option value="trial">试用</option>
                            <option value="free">免费</option>
                            <option value="pro">专业</option>
                            <option value="enterprise">企业</option>
                          </Select>
                          {t.plan === 'trial' ? (
                            <Button size="sm" disabled={busy === t.id} onClick={() => void extendTrial(t)}>
                              延长试用
                            </Button>
                          ) : null}
                          <Button size="sm" disabled={busy === t.id} onClick={() => void exportTenant(t)}>
                            导出
                          </Button>
                          <Button
                            size="sm"
                            variant={t.status === 'active' ? 'danger' : 'primary'}
                            disabled={busy === t.id}
                            onClick={() => void toggle(t)}
                          >
                            {t.status === 'active' ? '暂停' : '恢复'}
                          </Button>
                          <Button size="sm" variant="danger" disabled={busy === t.id} onClick={() => void removeTenant(t)}>
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
            title="最近账单"
            subtitle="线下确认收款后可标记已支付；作废后不可恢复。"
          >
            {invoices.length === 0 ? (
              <Empty title="暂无账单" />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>账单号</th><th>组织</th><th>套餐</th><th>周期</th><th>金额</th>
                      <th>状态</th><th>服务期</th><th>创建</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((invoice) => (
                      <tr key={invoice.id}>
                        <td className="mono">{invoice.invoice_no}</td>
                        <td>{invoice.org_name ?? invoice.org_id}</td>
                        <td>{invoice.plan.toUpperCase()}</td>
                        <td>{invoice.cycle === 'yearly' ? '年付' : '月付'}</td>
                        <td>{money(invoice.amount)}</td>
                        <td>
                          <Badge tone={INVOICE_STATUS_TONE[invoice.status]}>
                            {INVOICE_STATUS_LABEL[invoice.status]}
                          </Badge>
                        </td>
                        <td className="muted">
                          {fmtDate(invoice.period_start)} → {fmtDate(invoice.period_end)}
                        </td>
                        <td className="muted">{fmtDate(invoice.created_at)}</td>
                        <td className="actions-cell">
                          {['pending', 'overdue'].includes(invoice.status) ? (
                            <>
                              <Button
                                size="sm"
                                variant="primary"
                                disabled={busy === invoice.id}
                                onClick={() => void markPaid(invoice)}
                              >
                                标记已支付
                              </Button>
                              <Button
                                size="sm"
                                variant="danger"
                                disabled={busy === invoice.id}
                                onClick={() => void voidInvoice(invoice)}
                              >
                                作废
                              </Button>
                            </>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}
