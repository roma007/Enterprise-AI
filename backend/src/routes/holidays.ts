import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, query } from '../db';
import { httpError } from '../services/s1';
import { requestOrg } from '../services/tenant';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
const uuid = z.uuid();

function assertMaintainer(req: any) {
  const auth = req.authUser;
  if (!auth || !['admin', 'director'].includes(auth.role)) {
    throw httpError(403, 'FORBIDDEN', '仅管理员/总监可维护节假日');
  }
  return auth;
}

export async function holidayRoutes(app: FastifyInstance) {
  app.get('/api/holidays', async (req) => {
    const org = await requestOrg(req);
    const year = z.coerce
      .number()
      .int()
      .min(2000)
      .max(2100)
      .optional()
      .parse((req.query as any)?.year);
    const effective = String((req.query as any)?.effective ?? '') === '1';
    let region: string | null = null;
    if (effective) {
      const orgRow = await one<{ settings: any }>(
        `SELECT settings FROM organizations WHERE id = $1`,
        [org],
      );
      region = String(orgRow?.settings?.region || 'CN').toUpperCase();
    }
    const items = await query(
      `SELECT id, org_id, region, date::text AS date, name, active
         FROM holiday_calendar
        WHERE active
          AND (org_id IS NULL OR org_id = $1)
          AND ($2::int IS NULL OR EXTRACT(YEAR FROM date)::int = $2)
          AND ($3::text IS NULL OR region = $3 OR region = 'ALL')
        ORDER BY date`,
      [org, year ?? null, region],
    );
    return { items };
  });

  app.post('/api/holidays', async (req, reply) => {
    const auth = assertMaintainer(req);
    const org = await requestOrg(req);
    const body = z
      .object({
        date: dateStr,
        name: z.string().trim().min(1).max(100),
        region: z.string().trim().min(2).max(20).default('CN'),
        org_id: uuid.nullable().optional(),
      })
      .parse(req.body ?? {});

    // 平台管理员可写平台级（org_id=null）或指定组织；普通管理员只写本组织。
    const orgId = auth.platform_admin
      ? body.org_id === undefined
        ? org
        : body.org_id
      : org;

    const row = await one(
      `INSERT INTO holiday_calendar (org_id, region, date, name, created_by)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, org_id, region, date::text AS date, name, active`,
      [orgId, body.region.toUpperCase(), body.date, body.name, auth.sub],
    );
    return reply.code(201).send({ item: row });
  });

  app.delete('/api/holidays/:id', async (req) => {
    const auth = assertMaintainer(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const row = await one(
      `DELETE FROM holiday_calendar
        WHERE id = $1 AND (org_id IS NOT NULL OR $2::boolean)
        RETURNING id`,
      [id, Boolean(auth.platform_admin)],
    );
    if (!row) throw httpError(404, 'NOT_FOUND', '节假日不存在');
    return { ok: true };
  });
}
