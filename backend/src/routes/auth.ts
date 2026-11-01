import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { one, query } from '../db';
import { hashPassword, signToken, TOKEN_TTL_SECONDS, verifyPassword } from '../services/auth';
import {
  clearLoginFailures,
  loginAllowed,
  loginKey,
  recordLoginFailure,
} from '../services/login_guard';
import {
  cleanupUserSessions,
  createSession,
  listSessions,
  revokeAllForUser,
  revokeOtherSessions,
  revokeOwnSessionById,
  revokeSession,
  touchSession,
} from '../services/sessions';
import { requestOrg } from '../services/tenant';
import { assertPasswordPolicy, passwordReused, rememberPassword } from '../services/password_policy';

const loginBody = z.object({
  email: z.email(),
  password: z.string().min(1),
});

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/auth/config', async () => ({
    required: process.env.AUTH_REQUIRED === 'true',
  }));

  app.post('/api/auth/login', async (req, reply) => {
    const body = loginBody.parse(req.body);
    const key = loginKey(req.ip, body.email);

    const guard = loginAllowed(key);
    if (!guard.allowed) {
      return reply
        .code(429)
        .header('retry-after', String(guard.retryAfter))
        .send({
          error: 'LOGIN_RATE_LIMITED',
          message: '登录失败次数过多，请稍后再试',
        });
    }

    const user = await one<any>(
      `SELECT u.id, u.org_id, u.name, u.email, u.status, u.password_hash,
              o.name AS org_name, COALESCE(m.role, 'consultant') AS role
         FROM users u
         JOIN organizations o ON o.id = u.org_id
         LEFT JOIN memberships m ON m.user_id = u.id AND m.org_id = u.org_id
        WHERE lower(u.email) = lower($1) AND u.status = 'active'
        ORDER BY u.created_at
        LIMIT 1`,
      [body.email],
    );

    if (!user || !verifyPassword(body.password, user.password_hash)) {
      recordLoginFailure(key);
      return reply.code(401).send({
        error: 'INVALID_CREDENTIALS',
        message: '邮箱或密码不正确',
      });
    }

    clearLoginFailures(key);
    await one(`UPDATE users SET last_login_at = now() WHERE id = $1 RETURNING id`, [user.id]);

    const jti = randomUUID();
    const token = signToken({
      id: user.id,
      org_id: user.org_id,
      role: user.role,
      name: user.name,
      email: user.email,
      jti,
    });
    await createSession({
      jti,
      userId: user.id,
      orgId: user.org_id,
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] ?? '').slice(0, 500),
      expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString(),
    });

    return {
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        org_id: user.org_id,
        org_name: user.org_name,
        role: user.role,
      },
    };
  });

  app.post('/api/user-sessions/cleanup', async (req, reply) => {
    const body = z
      .object({
        before: z.string().refine((v) => !Number.isNaN(Date.parse(v)), '日期格式不正确'),
        dry_run: z.boolean().default(true),
        confirm: z.string().optional(),
        batch_size: z.coerce.number().int().min(1).max(1000).default(1000),
      })
      .parse(req.body ?? {});
    if (!body.dry_run && body.confirm !== 'CLEANUP') {
      throw Object.assign(new Error('执行清理需要 confirm=CLEANUP'), {
        statusCode: 422,
        code: 'CLEANUP_CONFIRM_REQUIRED',
      });
    }
    return cleanupUserSessions({
      before: new Date(body.before).toISOString(),
      orgId: await requestOrg(req),
      batchSize: body.batch_size,
      dryRun: body.dry_run,
    });
  });

  app.post('/api/auth/change-password', async (req, reply) => {
    const auth = (req as any).authUser;
    if (!auth) return reply.code(401).send({ error: 'UNAUTHORIZED', message: '请先登录' });
    const body = z
      .object({
        old_password: z.string().min(1),
        new_password: z.string().min(1),
      })
      .parse(req.body ?? {});

    const key = `change-password:${auth.sub}:${req.ip ?? 'unknown'}`;
    const guard = loginAllowed(key);
    if (!guard.allowed) {
      return reply
        .code(429)
        .header('retry-after', String(guard.retryAfter))
        .send({ error: 'PASSWORD_RATE_LIMITED', message: '尝试次数过多，请稍后再试' });
    }

    const user = await one<{ password_hash: string | null }>(
      `SELECT password_hash FROM users WHERE id = $1 AND org_id = $2 AND status = 'active'`,
      [auth.sub, auth.org_id],
    );
    if (!user || !verifyPassword(body.old_password, user.password_hash)) {
      recordLoginFailure(key);
      return reply.code(401).send({
        error: 'INVALID_OLD_PASSWORD',
        message: '原密码不正确',
      });
    }
    if (body.old_password === body.new_password) {
      return reply.code(422).send({
        error: 'SAME_PASSWORD',
        message: '新密码不能与原密码相同',
      });
    }
    assertPasswordPolicy(body.new_password, auth.email);
    if (await passwordReused(auth.sub, body.new_password)) {
      return reply.code(422).send({
        error: 'PASSWORD_REUSED',
        message: '新密码不能与最近 5 次密码相同',
      });
    }

    const passwordHash = hashPassword(body.new_password);
    await one(
      `UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING id`,
      [auth.sub, passwordHash],
    );
    await rememberPassword(auth.sub, passwordHash);
    clearLoginFailures(key);
    const revoked = await revokeOtherSessions(auth.sub, auth.org_id, auth.jti);
    return { ok: true, revoked_others: revoked };
  });

  app.get('/api/auth/sessions', async (req, reply) => {
    const auth = (req as any).authUser;
    if (!auth) return reply.code(401).send({ error: 'UNAUTHORIZED', message: '请先登录' });
    return {
      items: await listSessions(auth.sub, auth.org_id, auth.jti),
    };
  });

  app.delete('/api/auth/sessions/:id', async (req, reply) => {
    const auth = (req as any).authUser;
    if (!auth) return reply.code(401).send({ error: 'UNAUTHORIZED', message: '请先登录' });
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const ok = await revokeOwnSessionById(id, auth.sub, auth.org_id);
    if (!ok) return reply.code(404).send({ error: 'NOT_FOUND', message: '会话不存在或已失效' });
    return { ok: true };
  });

  app.post('/api/auth/logout-all', async (req, reply) => {
    const auth = (req as any).authUser;
    if (!auth) return reply.code(401).send({ error: 'UNAUTHORIZED', message: '请先登录' });
    const revoked = await revokeAllForUser(auth.sub, auth.org_id);
    return { ok: true, revoked };
  });

  app.get('/api/users/:id/sessions', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const org = await requestOrg(req);
    const target = await one(`SELECT id FROM users WHERE id = $1 AND org_id = $2`, [id, org]);
    if (!target) return reply.code(404).send({ error: 'NOT_FOUND', message: '用户不存在' });
    return { items: await listSessions(id, org) };
  });

  app.post('/api/users/:id/revoke-sessions', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const org = await requestOrg(req);
    const target = await one(`SELECT id FROM users WHERE id = $1 AND org_id = $2`, [id, org]);
    if (!target) return reply.code(404).send({ error: 'NOT_FOUND', message: '用户不存在' });
    const revoked = await revokeAllForUser(id, org);
    return { ok: true, revoked };
  });

  app.get('/api/me', async (req, reply) => {
    const auth = (req as any).authUser;
    if (!auth) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: '请先登录' });
    }

    const user = await one<any>(
      `SELECT u.id, u.name, u.email, u.org_id, o.name AS org_name,
              COALESCE(m.role, 'consultant') AS role
         FROM users u
         JOIN organizations o ON o.id = u.org_id
         LEFT JOIN memberships m ON m.user_id = u.id AND m.org_id = u.org_id
        WHERE u.id = $1 AND u.status = 'active'`,
      [auth.sub],
    );
    if (!user) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: '账号不可用' });
    }
    await touchSession(auth.jti);
    return { user };
  });

  app.post('/api/auth/logout', async (req) => {
    const auth = (req as any).authUser;
    if (auth?.jti) await revokeSession(auth.jti);
    return { ok: true };
  });
}
