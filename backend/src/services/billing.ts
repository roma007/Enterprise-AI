import { randomUUID } from 'node:crypto';
import { one, query, withTransaction } from '../db';
import { getPlan } from './plans';
import { httpError } from './s1';

export type BillingCycle = 'monthly' | 'yearly';
export type PaymentProviderName = 'manual' | 'mock' | 'callback';
export type InvoiceStatus = 'pending' | 'paid' | 'void' | 'overdue';

export interface Invoice {
  id: string;
  org_id: string;
  invoice_no: string;
  plan: string;
  cycle: BillingCycle;
  amount: number;
  currency: string;
  status: InvoiceStatus;
  period_start: string | Date;
  period_end: string | Date;
  due_at: string | Date;
  paid_at: string | Date | null;
  provider: string;
  external_id: string | null;
  created_by: string | null;
  created_at: string | Date;
  org_name?: string;
  org_slug?: string;
}

export function paymentProvider(): PaymentProviderName {
  const value = (process.env.PAYMENT_PROVIDER ?? 'manual').trim().toLowerCase();
  if (value === 'mock' || value === 'callback') return value;
  return 'manual';
}

function addMonths(base: Date, months: number): Date {
  const d = new Date(base.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

function invoiceNo(): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `INV-${day}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

export interface CheckoutInput {
  plan?: string;
  cycle?: BillingCycle;
  actorUserId?: string | null;
}

export interface CheckoutResult {
  invoice: Invoice;
  provider: PaymentProviderName;
  mock: boolean;
  reused: boolean;
}

/** 创建续费/升级账单；企业版与免费版需联系商务，不走自助结算。 */
export async function createCheckout(orgId: string, input: CheckoutInput): Promise<CheckoutResult> {
  const org = await one<{
    id: string;
    plan: string;
    status: string;
    plan_expires_at: string | Date | null;
  }>(
    `SELECT id, plan, status, plan_expires_at FROM organizations WHERE id = $1`,
    [orgId],
  );
  if (!org) throw httpError(404, 'NOT_FOUND', '组织不存在');
  if (org.status !== 'active') throw httpError(403, 'ORG_SUSPENDED', '组织已暂停，无法续费');

  const planCode = input.plan ?? (org.plan === 'trial' ? 'pro' : org.plan);
  const plan = await getPlan(planCode);
  if (!plan) throw httpError(422, 'INVALID_PLAN', `套餐不存在：${planCode}`);
  if (!['pro', 'enterprise'].includes(plan.code) || plan.price_monthly <= 0) {
    throw httpError(422, 'PLAN_NOT_SELF_SERVICE', '该套餐不支持自助续费，请联系商务');
  }

  const cycle: BillingCycle = input.cycle === 'yearly' ? 'yearly' : 'monthly';
  const existing = await one<Invoice>(
    `SELECT * FROM tenant_invoices
      WHERE org_id = $1 AND status = 'pending' AND plan = $2 AND cycle = $3
      ORDER BY created_at DESC LIMIT 1`,
    [orgId, plan.code, cycle],
  );
  if (existing) {
    return { invoice: existing, provider: paymentProvider(), mock: paymentProvider() === 'mock', reused: true };
  }

  const now = new Date();
  const currentExpiry = org.plan_expires_at ? new Date(org.plan_expires_at) : null;
  const periodStart = currentExpiry && currentExpiry.getTime() > now.getTime() ? currentExpiry : now;
  const periodEnd = addMonths(periodStart, cycle === 'monthly' ? 1 : 12);
  const dueAt = new Date(now.getTime() + 7 * 86400000);
  const amount = cycle === 'monthly' ? Number(plan.price_monthly) : Number(plan.price_yearly);
  const provider = paymentProvider();

  const invoice = await one<Invoice>(
    `INSERT INTO tenant_invoices
       (org_id, invoice_no, plan, cycle, amount, currency, status,
        period_start, period_end, due_at, provider, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      orgId,
      invoiceNo(),
      plan.code,
      cycle,
      amount,
      plan.currency,
      periodStart.toISOString(),
      periodEnd.toISOString(),
      dueAt.toISOString(),
      provider,
      input.actorUserId ?? null,
    ],
  );
  if (!invoice) throw httpError(500, 'INVOICE_CREATE_FAILED', '账单创建失败');
  return { invoice, provider, mock: provider === 'mock', reused: false };
}

export async function listInvoices(orgId: string, limit = 20): Promise<Invoice[]> {
  return query<Invoice>(
    `SELECT * FROM tenant_invoices WHERE org_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [orgId, Math.min(Math.max(limit, 1), 100)],
  );
}

export async function listAllInvoices(limit = 50): Promise<Invoice[]> {
  return query<Invoice>(
    `SELECT i.*, o.name AS org_name, o.slug AS org_slug
       FROM tenant_invoices i
       JOIN organizations o ON o.id = i.org_id
      ORDER BY i.created_at DESC
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200)],
  );
}

export async function getInvoice(invoiceId: string): Promise<Invoice | null> {
  return one<Invoice>(`SELECT * FROM tenant_invoices WHERE id = $1`, [invoiceId]);
}

/**
 * 标记账单已支付并延长订阅周期。
 * - 已支付幂等返回；
 * - 已作废拒绝；
 * - 订阅从当前到期日与账单结束日中较晚者继续，避免缩短周期。
 */
export async function markInvoicePaid(
  invoiceId: string,
  options: { provider?: string; externalId?: string | null } = {},
): Promise<Invoice> {
  return withTransaction(async (client) => {
    const found = await client.query<Invoice>(
      `SELECT * FROM tenant_invoices WHERE id = $1 FOR UPDATE`,
      [invoiceId],
    );
    const invoice = found.rows[0];
    if (!invoice) throw httpError(404, 'NOT_FOUND', '账单不存在');
    if (invoice.status === 'paid') return invoice;
    if (invoice.status === 'void') throw httpError(422, 'INVOICE_VOID', '账单已作废');

    const updated = await client.query<Invoice>(
      `UPDATE tenant_invoices
          SET status = 'paid', paid_at = now(),
              provider = COALESCE($2, provider),
              external_id = COALESCE($3, external_id)
        WHERE id = $1
        RETURNING *`,
      [invoiceId, options.provider ?? null, options.externalId ?? null],
    );

    await client.query(
      `UPDATE organizations
          SET plan = $2,
              plan_started_at = COALESCE(plan_started_at, $3),
              plan_expires_at = GREATEST(COALESCE(plan_expires_at, now()), $4),
              trial_ends_at = CASE WHEN $2 = 'trial' THEN trial_ends_at ELSE NULL END,
              billing_cycle = $5
        WHERE id = $1`,
      [
        invoice.org_id,
        invoice.plan,
        invoice.period_start,
        invoice.period_end,
        invoice.cycle,
      ],
    );

    return updated.rows[0];
  });
}

export async function voidInvoice(invoiceId: string): Promise<Invoice> {
  const row = await one<Invoice>(
    `UPDATE tenant_invoices
        SET status = 'void'
      WHERE id = $1 AND status IN ('pending', 'overdue')
      RETURNING *`,
    [invoiceId],
  );
  if (row) return row;
  const existing = await getInvoice(invoiceId);
  if (!existing) throw httpError(404, 'NOT_FOUND', '账单不存在');
  throw httpError(422, 'INVOICE_NOT_VOIDABLE', '只有待支付或逾期账单可作废');
}

export async function markOverdueInvoices(): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE tenant_invoices
        SET status = 'overdue'
      WHERE status = 'pending' AND due_at < now() - interval '3 days'
      RETURNING id`,
  );
  return rows.length;
}

/**
 * 为开启自动续费且 7 天内到期的付费租户生成续费账单。
 * manual/mock 模式下只生成账单，不自动扣款；接真实网关后在此调用扣款。
 */
export async function createRenewalInvoices(): Promise<Invoice[]> {
  const candidates = await query<{
    id: string;
    plan: string;
    plan_expires_at: string | Date;
    billing_cycle: BillingCycle;
  }>(
    `SELECT o.id, o.plan, o.plan_expires_at, o.billing_cycle
       FROM organizations o
      WHERE o.status = 'active'
        AND o.auto_renew = true
        AND o.plan IN ('pro', 'enterprise')
        AND o.plan_expires_at IS NOT NULL
        AND o.plan_expires_at BETWEEN now() AND now() + interval '7 days'
        AND NOT EXISTS (
          SELECT 1 FROM tenant_invoices i
           WHERE i.org_id = o.id
             AND i.status IN ('pending', 'overdue')
             AND i.plan = o.plan
        )`,
  );

  const created: Invoice[] = [];
  for (const org of candidates) {
    const plan = await getPlan(org.plan);
    if (!plan || plan.price_monthly <= 0) continue;
    const cycle = org.billing_cycle === 'yearly' ? 'yearly' : 'monthly';
    const periodStart = new Date(org.plan_expires_at);
    const periodEnd = addMonths(periodStart, cycle === 'monthly' ? 1 : 12);
    const amount = cycle === 'monthly' ? Number(plan.price_monthly) : Number(plan.price_yearly);
    const invoice = await one<Invoice>(
      `INSERT INTO tenant_invoices
         (org_id, invoice_no, plan, cycle, amount, currency, status,
          period_start, period_end, due_at, provider)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8, now() + interval '7 days', $9)
       RETURNING *`,
      [
        org.id,
        invoiceNo(),
        plan.code,
        cycle,
        amount,
        plan.currency,
        periodStart.toISOString(),
        periodEnd.toISOString(),
        paymentProvider(),
      ],
    );
    if (invoice) created.push(invoice);
  }
  return created;
}
