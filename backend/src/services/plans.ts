import { one, query } from '../db';
import { httpError } from './s1';

export const PLAN_CODES = ['trial', 'free', 'pro', 'enterprise'] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export interface Plan {
  code: string;
  name: string;
  description: string;
  price_monthly: number;
  price_yearly: number;
  currency: string;
  max_users: number;
  max_clients: number;
  max_engagements: number;
  max_pdf_jobs_month: number;
}

export type QuotaResource = 'users' | 'clients' | 'engagements' | 'pdf_jobs_month';
export type PlanStatus = 'trialing' | 'trial_expired' | 'active' | 'expired' | 'suspended';

const QUOTA_META: Record<QuotaResource, { column: keyof Plan; label: string }> = {
  users: { column: 'max_users', label: '用户' },
  clients: { column: 'max_clients', label: '客户' },
  engagements: { column: 'max_engagements', label: '项目' },
  pdf_jobs_month: { column: 'max_pdf_jobs_month', label: '本月 PDF 任务' },
};

const PLAN_COLUMNS = `code, name, description, price_monthly, price_yearly, currency,
  max_users, max_clients, max_engagements, max_pdf_jobs_month`;

export async function listPlans(): Promise<Plan[]> {
  return query<Plan>(
    `SELECT ${PLAN_COLUMNS} FROM tenant_plans WHERE active ORDER BY sort_order, code`,
  );
}

export async function getPlan(code: string): Promise<Plan | null> {
  return one<Plan>(`SELECT ${PLAN_COLUMNS} FROM tenant_plans WHERE code = $1 AND active`, [code]);
}

export async function usageFor(orgId: string): Promise<Record<QuotaResource, number>> {
  const row = await one<{
    users: number;
    clients: number;
    engagements: number;
    pdf_jobs_month: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM users
         WHERE org_id = $1 AND status = 'active') AS users,
       (SELECT count(*)::int FROM clients
         WHERE org_id = $1 AND deleted_at IS NULL) AS clients,
       (SELECT count(*)::int FROM engagements
         WHERE org_id = $1 AND deleted_at IS NULL) AS engagements,
       (SELECT count(*)::int FROM pdf_jobs j
          JOIN deliverables d ON d.id = j.deliverable_id
          JOIN engagements e ON e.id = d.engagement_id
         WHERE e.org_id = $1 AND j.created_at >= date_trunc('month', now())) AS pdf_jobs_month`,
    [orgId],
  );
  return {
    users: row?.users ?? 0,
    clients: row?.clients ?? 0,
    engagements: row?.engagements ?? 0,
    pdf_jobs_month: row?.pdf_jobs_month ?? 0,
  };
}

export interface OrgBilling {
  id: string;
  name: string;
  slug: string;
  plan: string;
  plan_name: string;
  plan_status: PlanStatus;
  status: string;
  trial_ends_at: string | null;
  days_left: number | null;
  plan_started_at: string | null;
  plan_expires_at: string | null;
  renewal_days_left: number | null;
  auto_renew: boolean;
  billing_cycle: 'monthly' | 'yearly';
  billing_email: string | null;
  limits: Record<QuotaResource, number>;
  usage: Record<QuotaResource, number>;
  price: { currency: string; monthly: number; yearly: number };
}

export async function orgBilling(orgId: string): Promise<OrgBilling> {
  const org = await one<{
    id: string;
    name: string;
    slug: string;
    plan: string;
    status: string;
    trial_ends_at: string | Date | null;
    plan_started_at: string | Date | null;
    plan_expires_at: string | Date | null;
    auto_renew: boolean;
    billing_cycle: 'monthly' | 'yearly';
    billing_email: string | null;
  }>(
    `SELECT id, name, slug, plan, status, trial_ends_at,
            plan_started_at, plan_expires_at, auto_renew, billing_cycle, billing_email
       FROM organizations WHERE id = $1`,
    [orgId],
  );
  if (!org) throw httpError(404, 'NOT_FOUND', '组织不存在');

  const [plan, usage] = await Promise.all([getPlan(org.plan), usageFor(orgId)]);
  const trialEnds = org.trial_ends_at ? new Date(org.trial_ends_at).getTime() : null;
  const daysLeft =
    trialEnds === null ? null : Math.max(0, Math.ceil((trialEnds - Date.now()) / 86400000));
  const planEnds = org.plan_expires_at ? new Date(org.plan_expires_at).getTime() : null;
  const renewalDaysLeft =
    planEnds === null ? null : Math.max(0, Math.ceil((planEnds - Date.now()) / 86400000));

  let planStatus: PlanStatus;
  if (org.status !== 'active') planStatus = 'suspended';
  else if (org.plan === 'trial') {
    planStatus = trialEnds !== null && trialEnds <= Date.now() ? 'trial_expired' : 'trialing';
  } else if (planEnds !== null && planEnds <= Date.now()) {
    planStatus = 'expired';
  } else planStatus = 'active';

  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    plan: org.plan,
    plan_name: plan?.name ?? org.plan,
    plan_status: planStatus,
    status: org.status,
    trial_ends_at:
      org.trial_ends_at === null ? null : new Date(org.trial_ends_at).toISOString(),
    days_left: daysLeft,
    plan_started_at:
      org.plan_started_at === null ? null : new Date(org.plan_started_at).toISOString(),
    plan_expires_at:
      org.plan_expires_at === null ? null : new Date(org.plan_expires_at).toISOString(),
    renewal_days_left: renewalDaysLeft,
    auto_renew: Boolean(org.auto_renew),
    billing_cycle: org.billing_cycle === 'yearly' ? 'yearly' : 'monthly',
    billing_email: org.billing_email,
    limits: {
      users: Number(plan?.max_users ?? 0),
      clients: Number(plan?.max_clients ?? 0),
      engagements: Number(plan?.max_engagements ?? 0),
      pdf_jobs_month: Number(plan?.max_pdf_jobs_month ?? 0),
    },
    usage,
    price: {
      currency: plan?.currency ?? 'CNY',
      monthly: Number(plan?.price_monthly ?? 0),
      yearly: Number(plan?.price_yearly ?? 0),
    },
  };
}

/**
 * 创建资源前检查试用期与套餐配额。
 * 平台管理员所属组织通常为付费套餐；试用租户到期后拒绝写操作。
 */
export async function assertQuota(orgId: string, resource: QuotaResource): Promise<void> {
  const org = await one<{
    plan: string;
    status: string;
    trial_ends_at: string | Date | null;
    plan_expires_at: string | Date | null;
  }>(
    `SELECT plan, status, trial_ends_at, plan_expires_at
       FROM organizations WHERE id = $1`,
    [orgId],
  );
  if (!org) throw httpError(404, 'NOT_FOUND', '组织不存在');
  if (org.status !== 'active') {
    throw httpError(403, 'ORG_SUSPENDED', '组织已暂停，请联系平台管理员');
  }

  const trialEnds = org.trial_ends_at ? new Date(org.trial_ends_at).getTime() : null;
  if (org.plan === 'trial' && trialEnds !== null && trialEnds <= Date.now()) {
    throw httpError(403, 'TRIAL_EXPIRED', '试用已到期，请联系平台升级套餐');
  }
  const planEnds = org.plan_expires_at ? new Date(org.plan_expires_at).getTime() : null;
  if (
    !['trial', 'free'].includes(org.plan) &&
    planEnds !== null &&
    planEnds <= Date.now()
  ) {
    throw httpError(403, 'SUBSCRIPTION_EXPIRED', '订阅已到期，请续费后继续使用');
  }

  const plan = await getPlan(org.plan);
  if (!plan) return; // 未知套餐不阻断，避免误锁租户

  const meta = QUOTA_META[resource];
  const limit = Number(plan[meta.column]);
  if (!Number.isFinite(limit) || limit < 0) return;

  const usage = await usageFor(orgId);
  const used = usage[resource];
  if (used >= limit) {
    throw httpError(
      403,
      'QUOTA_EXCEEDED',
      `当前套餐的${meta.label}配额为 ${limit}，已达到上限（已用 ${used}）`,
      { resource, limit, used, plan: org.plan },
    );
  }
}
