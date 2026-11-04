import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, query, withTransaction } from '../db';
import { httpError } from '../services/s1';
import { requestOrg } from '../services/tenant';
import { revokeSessionsByOrg } from '../services/sessions';
import { getPlan, listPlans, orgBilling } from '../services/plans';
import {
  isValidTimezone,
  resolveOrgTimezone,
  retimeCollabSnapshots,
} from '../services/collab_audit_snapshot';

const uuid = z.uuid();
const statusEnum = z.enum(['active', 'suspended']);
const planEnum = z.enum(['trial', 'free', 'pro', 'enterprise']);

const TENANT_FIELDS = `o.id, o.name, o.slug, o.plan, o.status, o.settings, o.created_at,
  o.trial_ends_at, o.plan_started_at, o.plan_expires_at, o.auto_renew, o.billing_cycle,
  o.billing_email,
  p.name AS plan_name,
  CASE WHEN o.trial_ends_at IS NULL THEN NULL
       ELSE GREATEST(0, CEIL(EXTRACT(EPOCH FROM (o.trial_ends_at - now())) / 86400))::int
  END AS trial_days_left,
  CASE WHEN o.plan_expires_at IS NULL THEN NULL
       ELSE GREATEST(0, CEIL(EXTRACT(EPOCH FROM (o.plan_expires_at - now())) / 86400))::int
  END AS renewal_days_left,
  (SELECT count(*)::int FROM users u WHERE u.org_id = o.id AND u.status = 'active') AS user_count,
  (SELECT count(*)::int FROM clients c WHERE c.org_id = o.id AND c.deleted_at IS NULL) AS client_count,
  (SELECT count(*)::int FROM engagements e WHERE e.org_id = o.id AND e.deleted_at IS NULL) AS engagement_count`;

function assertPlatformAdmin(req: any) {
  const auth = req.authUser;
  if (!auth?.platform_admin) {
    throw httpError(403, 'PLATFORM_FORBIDDEN', '需要平台管理员权限');
  }
  return auth;
}

async function revokeOrgSessions(orgId: string) {
  await revokeSessionsByOrg(orgId);
}

export async function platformRoutes(app: FastifyInstance) {
  app.get('/api/platform/tenants', async (req) => {
    assertPlatformAdmin(req);
    const items = await query(
      `SELECT ${TENANT_FIELDS}
         FROM organizations o
         LEFT JOIN tenant_plans p ON p.code = o.plan
        ORDER BY o.created_at`,
    );
    return { items };
  });

  app.get('/api/platform/plans', async (req) => {
    assertPlatformAdmin(req);
    return { items: await listPlans() };
  });

  app.patch('/api/platform/tenants/:id', async (req) => {
    const auth = assertPlatformAdmin(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        name: z.string().trim().min(1).optional(),
        status: statusEnum.optional(),
        plan: planEnum.optional(),
        trial_ends_at: z
          .string()
          .refine((v) => !Number.isNaN(Date.parse(v)), '日期格式不正确')
          .nullable()
          .optional(),
        plan_expires_at: z
          .string()
          .refine((v) => !Number.isNaN(Date.parse(v)), '日期格式不正确')
          .nullable()
          .optional(),
        auto_renew: z.boolean().optional(),
        billing_cycle: z.enum(['monthly', 'yearly']).optional(),
        billing_email: z.email().nullable().optional(),
        settings: z.record(z.string(), z.any()).optional(),
      })
      .parse(req.body ?? {});
    if (id === auth.org_id && body.status === 'suspended') {
      throw httpError(422, 'CANNOT_SUSPEND_SELF', '不能暂停平台管理员所属组织');
    }

    const data: Record<string, any> = { ...body };
    if (body.plan) {
      const plan = await getPlan(body.plan);
      if (!plan) throw httpError(422, 'INVALID_PLAN', `套餐不存在：${body.plan}`);
      if (body.plan === 'trial' && body.trial_ends_at === undefined) {
        data.trial_ends_at = new Date(Date.now() + 14 * 86400000).toISOString();
      }
    }

    const keys = Object.keys(data).filter((k) => data[k] !== undefined);
    if (!keys.length) throw httpError(400, 'EMPTY_UPDATE', '没有可更新字段');
    const values = keys.map((k) => data[k]);
    values.push(id);
    const updated = await one<{ id: string }>(
      `UPDATE organizations
          SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}
        WHERE id = $${values.length}
        RETURNING id`,
      values,
    );
    if (!updated) throw httpError(404, 'NOT_FOUND', '租户不存在');
    if (body.status === 'suspended') await revokeOrgSessions(id);
    const row = await one(
      `SELECT ${TENANT_FIELDS}
         FROM organizations o
         LEFT JOIN tenant_plans p ON p.code = o.plan
        WHERE o.id = $1`,
      [id],
    );
    return { item: row };
  });

  app.get('/api/platform/tenants/:id/impact', async (req) => {
    assertPlatformAdmin(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const org = await one(`SELECT id, name, slug FROM organizations WHERE id = $1`, [id]);
    if (!org) throw httpError(404, 'NOT_FOUND', '租户不存在');
    const counts = await one<any>(
      `SELECT
         (SELECT count(*)::int FROM users WHERE org_id = $1) AS users,
         (SELECT count(*)::int FROM clients WHERE org_id = $1 AND deleted_at IS NULL) AS clients,
         (SELECT count(*)::int FROM engagements WHERE org_id = $1 AND deleted_at IS NULL) AS engagements,
         (SELECT count(*)::int FROM deliverables d JOIN engagements e ON e.id = d.engagement_id WHERE e.org_id = $1 AND d.deleted_at IS NULL) AS deliverables,
         (SELECT count(*)::int FROM knowledge_items WHERE org_id = $1) AS knowledge_items,
         (SELECT count(*)::int FROM audit_logs WHERE org_id = $1) AS audit_logs`,
      [id],
    );
    return { item: org, counts };
  });

  app.get('/api/platform/tenants/:id/export', async (req, reply) => {
    assertPlatformAdmin(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const org = await one<any>(`SELECT * FROM organizations WHERE id = $1`, [id]);
    if (!org) throw httpError(404, 'NOT_FOUND', '租户不存在');

    const [users, clients, engagements, opportunities, deliverables, knowledge] = await Promise.all([
      query(`SELECT id, name, email, status, created_at, last_login_at FROM users WHERE org_id = $1 ORDER BY created_at`, [id]),
      query(`SELECT * FROM clients WHERE org_id = $1 AND deleted_at IS NULL ORDER BY created_at`, [id]),
      query(`SELECT * FROM engagements WHERE org_id = $1 AND deleted_at IS NULL ORDER BY created_at`, [id]),
      query(
        `SELECT o.* FROM opportunities o JOIN engagements e ON e.id = o.engagement_id
          WHERE e.org_id = $1 ORDER BY o.code`,
        [id],
      ),
      query(
        `SELECT d.id, d.type, d.title, d.version, d.status, d.content, d.created_at
           FROM deliverables d JOIN engagements e ON e.id = d.engagement_id
          WHERE e.org_id = $1 AND d.deleted_at IS NULL ORDER BY d.created_at`,
        [id],
      ),
      query(`SELECT * FROM knowledge_items WHERE org_id = $1 ORDER BY created_at`, [id]),
    ]);

    const payload = {
      exported_at: new Date().toISOString(),
      organization: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        plan: org.plan,
        status: org.status,
        settings: org.settings,
        created_at: org.created_at,
      },
      users,
      clients,
      engagements,
      opportunities,
      deliverables,
      knowledge_items: knowledge,
    };
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="tenant-${org.slug}.json"; filename*=UTF-8''${encodeURIComponent(`租户-${org.slug}.json`)}`,
      )
      .send(payload);
  });

  app.delete('/api/platform/tenants/:id', async (req) => {
    const auth = assertPlatformAdmin(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const confirm = String((req.query as any)?.confirm ?? '');
    const org = await one<{ id: string; slug: string }>(
      `SELECT id, slug FROM organizations WHERE id = $1`,
      [id],
    );
    if (!org) throw httpError(404, 'NOT_FOUND', '租户不存在');
    if (id === auth.org_id) {
      throw httpError(422, 'CANNOT_DELETE_SELF', '不能删除平台管理员所属组织');
    }
    if (confirm !== org.slug) {
      throw httpError(422, 'DELETE_CONFIRM_REQUIRED', '请输入组织标识确认删除');
    }

    await withTransaction(async (client) => {
      await client.query(`DELETE FROM audit_logs WHERE org_id = $1`, [id]);
      await client.query(`DELETE FROM audit_logs_archive WHERE org_id = $1`, [id]);
      await client.query(`DELETE FROM share_views_archive WHERE org_id = $1`, [id]);
      await client.query(`DELETE FROM copilot_eval_syncs WHERE org_id = $1`, [id]);
      await client.query(`DELETE FROM organizations WHERE id = $1`, [id]);
    });
    return { ok: true, deleted: org.slug };
  });

  app.get('/api/org', async (req) => {
    const org = await requestOrg(req);
    const item = await one(
      `SELECT ${TENANT_FIELDS}
         FROM organizations o
         LEFT JOIN tenant_plans p ON p.code = o.plan
        WHERE o.id = $1`,
      [org],
    );
    if (!item) throw httpError(404, 'NOT_FOUND', '组织不存在');
    return { item };
  });

  app.get('/api/org/billing', async (req) => {
    const org = await requestOrg(req);
    return { item: await orgBilling(org) };
  });

  app.patch('/api/org', async (req) => {
    const auth = (req as any).authUser;
    if (!auth) throw httpError(401, 'UNAUTHORIZED', '请先登录');
    if (!['admin', 'director'].includes(auth.role)) {
      throw httpError(403, 'FORBIDDEN', '仅管理员/总监可修改组织设置');
    }
    const org = await requestOrg(req);
    const body = z
      .object({
        name: z.string().trim().min(1).optional(),
        billing_email: z.email().nullable().optional(),
        auto_renew: z.boolean().optional(),
        settings: z.record(z.string(), z.any()).optional(),
      })
      .parse(req.body ?? {});
    const timezone = body.settings?.timezone;
    if (timezone !== undefined) {
      if (typeof timezone !== 'string' || !timezone.trim()) {
        throw httpError(422, 'INVALID_TIMEZONE', '时区不能为空');
      }
      if (!isValidTimezone(timezone.trim())) {
        throw httpError(422, 'INVALID_TIMEZONE', '无效的时区');
      }
    }
    const keys = Object.keys(body).filter((k) => (body as any)[k] !== undefined);
    if (!keys.length) throw httpError(400, 'EMPTY_UPDATE', '没有可更新字段');
    const values = keys.map((k) => (body as any)[k]);
    values.push(org);
    const row = await one(
      `UPDATE organizations
          SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}
        WHERE id = $${values.length}
        RETURNING id, name, slug, plan, status, settings, created_at, trial_ends_at, billing_email`,
      values,
    );
    return { item: row };
  });

  app.post('/api/org/snapshots/retime', async (req) => {
    const auth = (req as any).authUser;
    if (!auth) throw httpError(401, 'UNAUTHORIZED', '请先登录');
    if (!['admin', 'director'].includes(auth.role)) {
      throw httpError(403, 'FORBIDDEN', '仅管理员/总监可重算快照日期');
    }
    const org = await requestOrg(req);
    const timezone = await resolveOrgTimezone(org);
    const updated = await retimeCollabSnapshots(org);
    try {
      await query(
        `INSERT INTO audit_logs
           (org_id, user_id, action, object_type, status_code, detail)
         VALUES ($1,$2,'RETIME copilot-collab-snapshots',
                 'collab_audit_snapshot',200,$3::jsonb)`,
        [org, auth.sub, JSON.stringify({ updated, timezone })],
      );
    } catch {
      // 审计失败不影响重算结果
    }
    return { ok: true, updated, timezone };
  });
}