import { useEffect, useState } from 'react';
import { api } from '../api';
import { getStoredUser } from '../auth';
import { useLoad } from '../hooks';
import type { Invoice, OrgBilling } from '../types';
import {
  Badge,
  Button,
  Card,
  ErrorBox,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  Stat,
} from '../ui';
import { fmtDate } from '../utils';

const STATUS_LABEL: Record<OrgBilling['plan_status'], string> = {
  trialing: '试用中',
  trial_expired: '试用已到期',
  active: '正常',
  expired: '订阅已到期',
  suspended: '已暂停',
};

const STATUS_TONE: Record<OrgBilling['plan_status'], 'green' | 'amber' | 'red' | 'gray'> = {
  trialing: 'amber',
  trial_expired: 'red',
  active: 'green',
  expired: 'red',
  suspended: 'red',
};

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

function UsageRow({ label, used, limit }: { label: string; used: number; limit: number }) {
  const width = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div className="usage-row">
      <div className="usage-head">
        <span>{label}</span>
        <span className="muted">{limit > 0 ? `${used} / ${limit}` : `${used} / 不限`}</span>
      </div>
      <div className="progress">
        <span style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

const money = (value: number) => `¥${value.toLocaleString('zh-CN')}`;

const TIMEZONE_OPTIONS = [
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Taipei',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Asia/Bangkok',
  'UTC',
  'Europe/London',
  'Europe/Paris',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Australia/Sydney',
  'Pacific/Kiritimati',
];

export function OrgPage() {
  const { data, error, loading, reload } = useLoad(async () => {
    const [orgRes, billingRes, invoiceRes, holidayRes] = await Promise.all([
      api.getOrg(),
      api.getOrgBilling(),
      api.listOrgInvoices(),
      api.listHolidays(),
    ]);
    return {
      org: orgRes.item,
      billing: billingRes.item,
      invoices: invoiceRes.items,
      holidays: holidayRes.items,
    };
  }, []);
  const [name, setName] = useState('');
  const [billingEmail, setBillingEmail] = useState('');
  const [autoRenew, setAutoRenew] = useState(false);
  const [cycle, setCycle] = useState<'monthly' | 'yearly'>('monthly');
  const [saving, setSaving] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [holidayDate, setHolidayDate] = useState('');
  const [holidayName, setHolidayName] = useState('');
  const [holidayRegion, setHolidayRegion] = useState('CN');
  const [slaRegion, setSlaRegion] = useState('CN');
  const [timezone, setTimezone] = useState('Asia/Shanghai');
  const [holidayBusy, setHolidayBusy] = useState(false);
  const [retimeBusy, setRetimeBusy] = useState(false);
  const [opError, setOpError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (data?.org) {
      setName(data.org.name);
      setBillingEmail(data.org.billing_email ?? '');
    }
    if (data?.billing) {
      setAutoRenew(data.billing.auto_renew);
      setCycle(data.billing.billing_cycle);
    }
    if (data?.org) {
      const region = data.org.settings?.region;
      if (typeof region === 'string' && region.trim()) setSlaRegion(region);
      const tz = data.org.settings?.timezone;
      if (typeof tz === 'string' && tz.trim()) setTimezone(tz);
    }
  }, [data]);

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setOpError(null);
    setNotice(null);
    try {
      await api.updateOrg({
        name: name.trim(),
        billing_email: billingEmail.trim() || null,
        auto_renew: autoRenew,
      });
      setNotice('组织设置已更新。');
      await reload();
    } catch (err) {
      setOpError(err);
    } finally {
      setSaving(false);
    }
  };

  const checkout = async () => {
    if (billing.plan === 'enterprise') return;
    setCheckingOut(true);
    setOpError(null);
    setNotice(null);
    try {
      // 自助续费只支持专业版；试用/免费升级到专业版，企业版联系商务
      const res = await api.createCheckout({ plan: 'pro', cycle });
      setNotice(
        res.reused
          ? `已有待支付账单 ${res.item.invoice_no}（${money(res.item.amount)}）。`
          : `账单 ${res.item.invoice_no} 已创建，金额 ${money(res.item.amount)}。` +
            (res.mock ? ' 可在下方账单中模拟支付。' : ' 请等待平台确认收款。'),
      );
      await reload();
    } catch (err) {
      setOpError(err);
    } finally {
      setCheckingOut(false);
    }
  };

  const saveRegion = async () => {
    setHolidayBusy(true);
    setOpError(null);
    setNotice(null);
    try {
      await api.updateOrg({
        settings: {
          ...(data?.org.settings ?? {}),
          region: slaRegion.trim().toUpperCase() || 'CN',
          timezone: timezone.trim() || 'Asia/Shanghai',
        },
      });
      setNotice('SLA 地区已更新。');
      await reload();
    } catch (err) {
      setOpError(err);
    } finally {
      setHolidayBusy(false);
    }
  };

  const retimeSnapshots = async () => {
    if (!window.confirm('按当前时区重算历史快照日期？同一天只保留最新一条。')) return;
    setRetimeBusy(true);
    setOpError(null);
    setNotice(null);
    try {
      const res = await api.retimeOrgSnapshots();
      setNotice(`已按 ${res.timezone} 重算 ${res.updated} 条快照日期。`);
    } catch (err) {
      setOpError(err);
    } finally {
      setRetimeBusy(false);
    }
  };

  const addHoliday = async () => {
    if (!holidayDate || !holidayName.trim()) return;
    setHolidayBusy(true);
    setOpError(null);
    setNotice(null);
    try {
      await api.createHoliday({
        date: holidayDate,
        name: holidayName.trim(),
        region: holidayRegion.trim() || 'CN',
      });
      setHolidayDate('');
      setHolidayName('');
      setNotice('节假日已添加。');
      await reload();
    } catch (err) {
      setOpError(err);
    } finally {
      setHolidayBusy(false);
    }
  };

  const removeHoliday = async (id: string) => {
    setHolidayBusy(true);
    setOpError(null);
    setNotice(null);
    try {
      await api.deleteHoliday(id);
      setNotice('节假日已删除。');
      await reload();
    } catch (err) {
      setOpError(err);
    } finally {
      setHolidayBusy(false);
    }
  };

  const payMock = async (invoice: Invoice) => {
    setPayingId(invoice.id);
    setOpError(null);
    setNotice(null);
    try {
      await api.payMockInvoice(invoice.id);
      setNotice(`账单 ${invoice.invoice_no} 已支付，订阅已延长。`);
      await reload();
    } catch (err) {
      setOpError(err);
    } finally {
      setPayingId(null);
    }
  };

  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorBox error={error} onRetry={() => void reload()} />;
  if (!data) return null;

  const org = data.org;
  const billing = data.billing;
  const invoices = data.invoices;
  const holidays = data.holidays;
  const isPlatformAdmin = Boolean(getStoredUser()?.platform_admin);
  const priceText =
    billing.price.monthly > 0
      ? `${money(billing.price.monthly)} / 月`
      : billing.plan === 'enterprise'
        ? '定制报价'
        : '免费';
  const expiryText =
    billing.plan === 'trial'
      ? billing.trial_ends_at
        ? fmtDate(billing.trial_ends_at)
        : '不限'
      : billing.plan_expires_at
        ? fmtDate(billing.plan_expires_at)
        : '不限';
  const remainingText =
    billing.plan === 'trial'
      ? billing.days_left === null
        ? '不限'
        : `${billing.days_left} 天`
      : billing.renewal_days_left === null
        ? '不限'
        : `${billing.renewal_days_left} 天`;

  return (
    <div className="page">
      <PageHeader
        eyebrow="租户设置"
        title="组织设置"
        subtitle="当前供应商租户的基本信息、套餐、用量与账单；组织标识用于登录区分，创建后不可修改。"
        actions={<Button onClick={() => void reload()} disabled={loading}>刷新</Button>}
      />

      {opError ? <ErrorBox error={opError} /> : null}
      {notice ? <div className="notice notice-green">{notice}</div> : null}

      <div className="stat-grid">
        <Stat label="用户" value={org.user_count} tone="brand" />
        <Stat label="客户" value={org.client_count} tone="green" />
        <Stat label="项目" value={org.engagement_count} tone="blue" />
        <Stat label="套餐" value={billing.plan_name} tone="amber" />
      </div>

      <Card
        title={org.name}
        subtitle={`组织标识：${org.slug} · 创建于 ${fmtDate(org.created_at)}`}
        actions={
          <Badge tone={org.status === 'active' ? 'green' : 'red'}>
            {org.status === 'active' ? '正常' : '已暂停'}
          </Badge>
        }
      >
        <div className="form-grid">
          <Field label="组织名称" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="组织标识" hint="登录时用于区分租户；不可修改">
            <Input value={org.slug} disabled />
          </Field>
          <Field label="套餐">
            <Input value={billing.plan_name} disabled />
          </Field>
          <Field label="账单邮箱" hint="用于续费提醒与发票联系">
            <Input
              type="email"
              value={billingEmail}
              placeholder="billing@example.com"
              onChange={(e) => setBillingEmail(e.target.value)}
            />
          </Field>
        </div>
        <div className="form-actions">
          <Button
            variant="primary"
            disabled={
              saving ||
              (name.trim() === org.name &&
                billingEmail.trim() === (org.billing_email ?? '') &&
                autoRenew === billing.auto_renew)
            }
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存组织设置'}
          </Button>
        </div>
        <p className="hint-line">
          暂停/恢复租户由平台管理员操作；暂停后该组织全部会话立即失效。
        </p>
      </Card>

      <Card
        title="套餐与用量"
        subtitle="试用或订阅到期后无法登录；需要升级或延长请联系平台管理员。"
        actions={<Badge tone={STATUS_TONE[billing.plan_status]}>{STATUS_LABEL[billing.plan_status]}</Badge>}
      >
        {billing.plan_status === 'trial_expired' ? (
          <div className="notice notice-red">
            试用已到期，当前无法登录。请在下方生成续费账单或联系平台管理员延长试用。
          </div>
        ) : null}
        {billing.plan_status === 'expired' ? (
          <div className="notice notice-red">
            订阅已到期，当前无法登录。请生成续费账单并完成支付。
          </div>
        ) : null}
        {billing.plan_status === 'suspended' ? (
          <div className="notice notice-red">组织已暂停，全部会话已失效。</div>
        ) : null}

        <div className="stat-grid">
          <Stat label="当前套餐" value={billing.plan_name} tone="brand" />
          <Stat label="套餐状态" value={STATUS_LABEL[billing.plan_status]} tone={STATUS_TONE[billing.plan_status]} />
          <Stat label="到期日" value={expiryText} tone="gray" />
          <Stat label="剩余" value={remainingText} tone={billing.plan_status === 'expired' ? 'red' : 'amber'} />
        </div>

        <div className="usage-list">
          <UsageRow label="用户" used={billing.usage.users} limit={billing.limits.users} />
          <UsageRow label="客户" used={billing.usage.clients} limit={billing.limits.clients} />
          <UsageRow label="项目" used={billing.usage.engagements} limit={billing.limits.engagements} />
          <UsageRow
            label="本月 PDF 任务"
            used={billing.usage.pdf_jobs_month}
            limit={billing.limits.pdf_jobs_month}
          />
        </div>

        <label className="checkbox-line">
          <input
            type="checkbox"
            checked={autoRenew}
            onChange={(e) => setAutoRenew(e.target.checked)}
          />
          到期前 7 天自动生成续费账单（不会自动扣款，仍需确认支付）
        </label>

        <p className="hint-line">
          {billing.price.yearly > 0
            ? `年付 ${money(billing.price.yearly)}，约 ${money(Math.round(billing.price.yearly / 12))} / 月。`
            : '企业版按实际团队规模与交付范围报价，请联系商务。'}
        </p>
      </Card>

      <Card
        title="工作日与节假日"
        subtitle="SLA 默认跳过周末；这里维护的节假日也会跳过。仅管理员/总监可维护。"
      >
        <div className="form-grid">
          <Field label="SLA 地区">
            <Input
              value={slaRegion}
              onChange={(e) => setSlaRegion(e.target.value)}
              placeholder="CN"
            />
          </Field>
          <Field label="时区">
            <Select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            >
              {!TIMEZONE_OPTIONS.includes(timezone) ? (
                <option value={timezone}>{timezone}</option>
              ) : null}
              {TIMEZONE_OPTIONS.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="地区/时区操作">
            <div className="row">
              <Button
                variant="primary"
                disabled={holidayBusy || !slaRegion.trim() || !timezone.trim()}
                onClick={() => void saveRegion()}
              >
                {holidayBusy ? '处理中…' : '保存设置'}
              </Button>
              <Button
                size="sm"
                disabled={retimeBusy}
                onClick={() => void retimeSnapshots()}
              >
                {retimeBusy ? '重算中…' : '重算快照日期'}
              </Button>
            </div>
          </Field>
        </div>
        <p className="muted" style={{ marginTop: -4 }}>
          只有该地区（或 `ALL`）的节假日会参与 SLA 计算；默认 `CN`。
        </p>
        <div className="form-grid">
          <Field label="日期">
            <Input type="date" value={holidayDate} onChange={(e) => setHolidayDate(e.target.value)} />
          </Field>
          <Field label="名称">
            <Input value={holidayName} onChange={(e) => setHolidayName(e.target.value)} placeholder="如：国庆节" />
          </Field>
          <Field label="地区">
            <Input value={holidayRegion} onChange={(e) => setHolidayRegion(e.target.value)} placeholder="CN" />
          </Field>
          <Field label="操作">
            <Button
              variant="primary"
              disabled={holidayBusy || !holidayDate || !holidayName.trim()}
              onClick={() => void addHoliday()}
            >
              {holidayBusy ? '处理中…' : '添加节假日'}
            </Button>
          </Field>
        </div>
        {holidays.length === 0 ? (
          <p className="muted">还没有配置节假日；SLA 目前只跳过周末。</p>
        ) : (
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table>
              <thead>
                <tr><th>日期</th><th>名称</th><th>地区</th><th>来源</th><th /></tr>
              </thead>
              <tbody>
                {holidays.map((h) => (
                  <tr key={h.id}>
                    <td className="mono">{fmtDate(h.date)}</td>
                    <td>{h.name}</td>
                    <td>{h.region}</td>
                    <td>
                      <Badge tone={h.org_id ? 'blue' : 'gray'}>
                        {h.org_id ? '组织' : '平台'}
                      </Badge>
                    </td>
                    <td className="actions-cell">
                      {h.org_id || isPlatformAdmin ? (
                        <Button size="sm" variant="danger" disabled={holidayBusy} onClick={() => void removeHoliday(h.id)}>
                          删除
                        </Button>
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

      <Card
        title="续费与账单"
        subtitle="专业版支持自助生成账单；企业版请联系商务报价。"
        actions={
          <Badge tone="blue">
            {billing.billing_cycle === 'yearly' ? '年付' : '月付'} · {priceText}
          </Badge>
        }
      >
        <div className="form-grid">
          <Field label="账单周期">
            <Select value={cycle} onChange={(e) => setCycle(e.target.value as 'monthly' | 'yearly')}>
              <option value="monthly">月付</option>
              <option value="yearly">年付（约 10 个月价格）</option>
            </Select>
          </Field>
        </div>
        <div className="form-actions">
          <Button
            variant="primary"
            disabled={checkingOut || billing.plan === 'enterprise'}
            onClick={() => void checkout()}
          >
            {billing.plan === 'enterprise'
              ? '联系商务续费'
              : checkingOut
                ? '生成中…'
                : billing.plan === 'trial' || billing.plan === 'free'
                  ? '升级并生成账单'
                  : '生成续费账单'}
          </Button>
        </div>

        {invoices.length === 0 ? (
          <p className="muted">暂无账单。</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>账单号</th><th>套餐</th><th>周期</th><th>金额</th>
                  <th>状态</th><th>服务期</th><th>支付方式</th><th />
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td className="mono">{invoice.invoice_no}</td>
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
                    <td className="muted">{invoice.provider}</td>
                    <td className="actions-cell">
                      {invoice.provider === 'mock' && ['pending', 'overdue'].includes(invoice.status) ? (
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={payingId === invoice.id}
                          onClick={() => void payMock(invoice)}
                        >
                          {payingId === invoice.id ? '支付中…' : '模拟支付'}
                        </Button>
                      ) : invoice.status === 'paid' ? (
                        <span className="muted">{invoice.paid_at ? fmtDate(invoice.paid_at) : '已支付'}</span>
                      ) : (
                        <span className="muted">等待确认</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
