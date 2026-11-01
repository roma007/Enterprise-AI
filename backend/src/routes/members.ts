import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, query } from '../db';
import { httpError } from '../services/s1';

const uuid = z.uuid();
const roleEnum = z.enum(['manager', 'member', 'viewer']);

const addBody = z.object({
  user_id: uuid,
  role: roleEnum.default('member'),
});

const patchBody = z.object({
  role: roleEnum,
});

async function canManageProject(req: any, engagementId: string): Promise<boolean> {
  const auth = req.authUser;
  if (!auth) return true; // 匿名开发模式
  if (['admin', 'director', 'pm'].includes(auth.role)) return true;
  const member = await one<{ role: string }>(
    `SELECT role FROM engagement_members WHERE engagement_id = $1 AND user_id = $2`,
    [engagementId, auth.sub],
  );
  return member?.role === 'manager';
}

async function assertCanManage(req: any, engagementId: string) {
  if (!(await canManageProject(req, engagementId))) {
    throw httpError(403, 'PROJECT_FORBIDDEN', '只有项目负责人或项目经理可以管理成员');
  }
}

async function managerCount(engagementId: string): Promise<number> {
  const row = await one<{ count: number }>(
    `SELECT count(*)::int AS count FROM engagement_members
      WHERE engagement_id = $1 AND role = 'manager'`,
    [engagementId],
  );
  return row?.count ?? 0;
}

export async function memberRoutes(app: FastifyInstance) {
  app.get('/api/engagements/:id/members', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const items = await query(
      `SELECT m.*, u.name, u.email, u.status,
              CASE m.role WHEN 'manager' THEN 0 WHEN 'member' THEN 1 ELSE 2 END AS sort
         FROM engagement_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.engagement_id = $1
        ORDER BY sort, u.name`,
      [id],
    );
    return { items, canManage: await canManageProject(req, id) };
  });

  app.post('/api/engagements/:id/members', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = addBody.parse(req.body);
    await assertCanManage(req, id);

    const user = await one(
      `SELECT u.id FROM users u
         JOIN engagements e ON e.org_id = u.org_id
        WHERE u.id = $1 AND e.id = $2 AND u.status = 'active'`,
      [body.user_id, id],
    );
    if (!user) throw httpError(422, 'USER_NOT_IN_ORG', '成员不属于该项目所在组织');

    const authUser = (req as any).authUser;
    const row = await one(
      `INSERT INTO engagement_members (engagement_id, user_id, role, added_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (engagement_id, user_id)
       DO UPDATE SET role = EXCLUDED.role, updated_at = now()
       RETURNING *`,
      [id, body.user_id, body.role, authUser?.sub ?? null],
    );
    return reply.code(201).send({ item: row });
  });

  app.patch('/api/engagement-members/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = patchBody.parse(req.body);
    const existing = await one<any>(`SELECT * FROM engagement_members WHERE id = $1`, [id]);
    if (!existing) throw httpError(404, 'NOT_FOUND', '成员记录不存在');
    await assertCanManage(req, existing.engagement_id);

    if (
      existing.role === 'manager' &&
      body.role !== 'manager' &&
      (await managerCount(existing.engagement_id)) <= 1
    ) {
      throw httpError(422, 'LAST_MANAGER', '项目至少保留一名负责人');
    }

    const row = await one(
      `UPDATE engagement_members SET role = $2, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, body.role],
    );
    return { item: row };
  });

  app.delete('/api/engagement-members/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const existing = await one<any>(`SELECT * FROM engagement_members WHERE id = $1`, [id]);
    if (!existing) throw httpError(404, 'NOT_FOUND', '成员记录不存在');
    await assertCanManage(req, existing.engagement_id);

    if (existing.role === 'manager' && (await managerCount(existing.engagement_id)) <= 1) {
      throw httpError(422, 'LAST_MANAGER', '项目至少保留一名负责人');
    }

    await one(`DELETE FROM engagement_members WHERE id = $1 RETURNING id`, [id]);
    return { ok: true };
  });
}
