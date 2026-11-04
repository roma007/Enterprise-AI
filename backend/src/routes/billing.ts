import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { httpError } from '../services/s1';
import { requestOrg } from '../services/tenant';
import { orgBilling } from '../services/plans';
import {
  createCheckout,
  listAllInvoices,
  listInvoices,
  markInvoicePaid,
  paymentProvider,
  voidInvoice,
  type BillingCycle,
} from '../services/billing';

const uuid = z.uuid();
const cycleEnum = z.enum(['monthly', 'yearly']);

function assertBillingAdmin(req: any) {
  const auth = req.authUser;
  if (!auth) throw httpError(401, 'UNAUTHORIZED', '请先登录');
  if (!['admin', 'director'].includes(auth.role)) {
    throw httpError(403, 'FORBIDDEN', '仅管理员/总监可操作续费与账单');
  }
  return auth;
}

function assertPlatformAdmin(req: any) {
  const auth = req.authUser;
  if (!auth?.platform_admin) {
    throw httpError(403, 'PLATFORM_FORBIDDEN', '需要平台管理员权限');
  }
  return auth;
}

function verifyCallbackSignature(
  invoiceId: string,
  status: string,
  externalId: string | null,
  provided: string,
): boolean {
  const secret = (process.env.BILLING_WEBHOOK_SECRET ?? '').trim();
  if (!secret) return false;
  const expected = createHmac('sha256', secret)
    .update(`${invoiceId}:${status}:${externalId ?? ''}`)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function billingRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------ 租户账单
  app.get('/api/org/billing/invoices', async (req) => {
    const auth = (req as any).authUser;
    if (!auth) throw httpError(401, 'UNAUTHORIZED', '请先登录');
    const org = await requestOrg(req);
    const limit = Number((req.query as any)?.limit ?? 20);
    return { items: await listInvoices(org, Number.isFinite(limit) ? limit : 20) };
  });

  app.post('/api/org/billing/checkout', async (req, reply) => {
    const auth = assertBillingAdmin(req);
    const org = await requestOrg(req);
    const body = z
      .object({
        plan: z.enum(['pro', 'enterprise']).optional(),
        cycle: cycleEnum.default('monthly'),
      })
      .parse(req.body ?? {});
    const result = await createCheckout(org, {
      plan: body.plan,
      cycle: body.cycle as BillingCycle,
      actorUserId: auth.sub,
    });
    return reply.code(201).send({
      item: result.invoice,
      provider: result.provider,
      mock: result.mock,
      reused: result.reused,
    });
  });

  app.post('/api/org/billing/invoices/:id/pay', async (req) => {
    const auth = assertBillingAdmin(req);
    const org = await requestOrg(req);
    if (paymentProvider() !== 'mock') {
      throw httpError(403, 'MOCK_PAY_DISABLED', '当前支付模式不允许模拟支付');
    }
    const { id } = z.object({ id: uuid }).parse(req.params);
    const invoice = await markInvoicePaid(id, { provider: 'mock' });
    if (invoice.org_id !== org) throw httpError(404, 'NOT_FOUND', '账单不存在');
    return { item: invoice, billing: await orgBilling(org) };
  });

  // ------------------------------------------------------------ 平台账单
  app.get('/api/platform/invoices', async (req) => {
    assertPlatformAdmin(req);
    const limit = Number((req.query as any)?.limit ?? 50);
    return { items: await listAllInvoices(Number.isFinite(limit) ? limit : 50) };
  });

  app.post('/api/platform/invoices/:id/mark-paid', async (req) => {
    assertPlatformAdmin(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({ external_id: z.string().trim().max(200).nullable().optional() })
      .parse(req.body ?? {});
    const invoice = await markInvoicePaid(id, {
      provider: 'manual',
      externalId: body.external_id ?? null,
    });
    return { item: invoice };
  });

  app.post('/api/platform/invoices/:id/void', async (req) => {
    assertPlatformAdmin(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    return { item: await voidInvoice(id) };
  });

  // ------------------------------------------------------------ 支付回调
  app.post('/api/billing/callback', async (req, reply) => {
    const secret = (process.env.BILLING_WEBHOOK_SECRET ?? '').trim();
    if (!secret) {
      return reply.code(503).send({
        error: 'BILLING_CALLBACK_DISABLED',
        message: '未配置 BILLING_WEBHOOK_SECRET',
      });
    }
    const body = z
      .object({
        invoice_id: uuid,
        status: z.enum(['paid', 'void']),
        external_id: z.string().trim().max(200).nullable().optional(),
      })
      .parse(req.body ?? {});
    const signature = String(req.headers['x-billing-signature'] ?? '');
    if (!verifyCallbackSignature(body.invoice_id, body.status, body.external_id ?? null, signature)) {
      return reply.code(401).send({ error: 'INVALID_SIGNATURE', message: '支付回调签名不正确' });
    }

    if (body.status === 'paid') {
      const invoice = await markInvoicePaid(body.invoice_id, {
        provider: 'callback',
        externalId: body.external_id ?? null,
      });
      return { ok: true, item: invoice };
    }
    return { ok: true, item: await voidInvoice(body.invoice_id) };
  });
}
