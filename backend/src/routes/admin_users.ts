import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, query, withTransaction } from '../db';
import { hashPassword } from '../services/auth';
import { httpError } from '../services/s1';
import { revokeAllForUser } from '../services/sessions';
import { assertPasswordPolicy, passwordReused, rememberPassword } from '../services/password_policy';
import { requestOrg } from '../services/tenant';

const uuid = z.uuid();
const roleEnum = z.enum(['admin', 'director', 'pm', 'consultant', 'tech_lead']);
const statusEnum = z.enum(['active', 'disabled']);
const password = z.string().min(1);
const name = z.string().trim().min(1);
const email = z.email();

const createBody = z.object({
  name,
  email,
  role: roleEnum.default('consultant'),
  status: statusEnum.default('active'),
  password,
});

const patchBody = z.object({
  name: name.optional(),
  role: roleEnum.optional(),
  status: statusEnum.optional(),
});

const resetBody = z.object({ password });

async function loadUser(id: string, orgId: string) {
  return one<any>(
    `SELECT u.id, u.name, u.email, u.status, u.last_login_at, u.created_at,
            COALESCE(m.role, 'consultant') AS role,
            (SELECT count(*)::int FROM user_sessions s
              WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS active_sessions
       FROM users u
       LEFT JOIN memberships m ON m.user_id = u.id AND m.org_id = u.org_id
      WHERE u.id = $1 AND u.org_id = $2`,
    [id, orgId],
  );
}

async function assertNotLastAdmin(id: string, orgId: string) {
  const target = await one<{ role: string; status: string }>(
    `SELECT COALESCE(m.role,'consultant') AS role, u.status
       FROM users u LEFT JOIN memberships m ON m.user_id = u.id AND m.org_id = u.org_id
      WHERE u.id = $1 AND u.org_id = $2`,
    [id, orgId],
  );
  if (!target || target.role !== 'admin' || target.status !== 'active') return;
  const others = await one<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM users u JOIN memberships m ON m.user_id = u.id AND m.org_id = u.org_id
      WHERE u.org_id = $1 AND u.id <> $2 AND m.role = 'admin' AND u.status = 'active'`,
    [orgId, id],
  );
  if ((others?.count ?? 0) === 0) {
    throw httpError(422, 'LAST_ADMIN', '组织至少保留一名启用的管理员');
  }
}

export async function adminUserRoutes(app: FastifyInstance) {
  app.get('/api/admin/users', async (req) => {
    const org = await requestOrg(req);
    const items = await query(
      `SELECT u.id, u.name, u.email, u.status, u.last_login_at, u.created_at,
              COALESCE(m.role, 'consultant') AS role,
              (SELECT count(*)::int FROM user_sessions s
                WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS active_sessions
         FROM users u
         LEFT JOIN memberships m ON m.user_id = u.id AND m.org_id = u.org_id
        WHERE u.org_id = $1
        ORDER BY u.created_at`,
      [org],
    );
    return { items };
  });

  app.post('/api/admin/users', async (req, reply) => {
    const org = await requestOrg(req);
    const body = createBody.parse(req.body);
    assertPasswordPolicy(body.password, body.email);
    const exists = await one(
      `SELECT 1 FROM users WHERE org_id = $1 AND lower(email) = lower($2)`,
      [org, body.email],
    );
    if (exists) throw httpError(409, 'EMAIL_EXISTS', '该邮箱已存在');

    const item = await withTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO users (org_id, name, email, status, password_hash)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [org, body.name, body.email.toLowerCase(), body.status, hashPassword(body.password)],
      );
      const userId = inserted.rows[0].id;
      await client.query(
        `INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,$3)
         ON CONFLICT (user_id, org_id) DO UPDATE SET role = EXCLUDED.role`,
        [userId, org, body.role],
      );
      await rememberPassword(userId, hashPassword(body.password), client);
      return userId;
    });

    return reply.code(201).send({ item: await loadUser(item, org) });
  });

  app.patch('/api/admin/users/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const org = await requestOrg(req);
    const body = patchBody.parse(req.body);
    const target = await loadUser(id, org);
    if (!target) throw httpError(404, 'NOT_FOUND', '用户不存在');

    const auth = (req as any).authUser;
    if (auth?.sub === id && body.status === 'disabled') {
      throw httpError(422, 'CANNOT_DISABLE_SELF', '不能禁用当前登录账号');
    }
    if (
      (body.role && body.role !== 'admin') ||
      (body.status === 'disabled' && target.role === 'admin')
    ) {
      if (target.role === 'admin' && target.status === 'active') {
        await assertNotLastAdmin(id, org);
      }
    }

    await withTransaction(async (client) => {
      if (body.name !== undefined || body.status !== undefined) {
        const sets: string[] = [];
        const values: any[] = [];
        if (body.name !== undefined) {
          values.push(body.name);
          sets.push(`name = $${values.length}`);
        }
        if (body.status !== undefined) {
          values.push(body.status);
          sets.push(`status = $${values.length}`);
        }
        values.push(id);
        await client.query(
          `UPDATE users SET ${sets.join(', ')} WHERE id = $${values.length}`,
          values,
        );
      }
      if (body.role !== undefined) {
        await client.query(
          `INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,$3)
           ON CONFLICT (user_id, org_id) DO UPDATE SET role = EXCLUDED.role`,
          [id, org, body.role],
        );
      }
    });

    if (body.status === 'disabled') await revokeAllForUser(id, org);
    return { item: await loadUser(id, org) };
  });

  app.post('/api/admin/users/:id/reset-password', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const org = await requestOrg(req);
    const body = resetBody.parse(req.body);
    const target = await one<{ email: string }>(
      `SELECT email FROM users WHERE id = $1 AND org_id = $2`,
      [id, org],
    );
    if (!target) throw httpError(404, 'NOT_FOUND', '用户不存在');
    assertPasswordPolicy(body.password, target.email);
    if (await passwordReused(id, body.password)) {
      throw httpError(422, 'PASSWORD_REUSED', '新密码不能与最近 5 次密码相同');
    }
    const passwordHash = hashPassword(body.password);
    const row = await one(
      `UPDATE users SET password_hash = $3
        WHERE id = $1 AND org_id = $2 RETURNING id`,
      [id, org, passwordHash],
    );
    if (!row) throw httpError(404, 'NOT_FOUND', '用户不存在');
    await rememberPassword(id, passwordHash);
    const revoked = await revokeAllForUser(id, org);
    return { ok: true, revoked };
  });
}
