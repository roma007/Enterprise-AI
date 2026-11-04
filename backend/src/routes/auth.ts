import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { one, query, withTransaction } from '../db';
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
  org_slug: z.string().trim().max(40).optional(),
});

const registerBody = z.object({
  org_name: z.string().trim().min(2, '组织名称至少 2 个字'),
  org_slug: z.string().trim().max(40).optional(),
  name: z.string().trim().min(1, '姓名必填'),
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

    const guard = await loginAllowed(key);
    if (!guard.allowed) {
      return reply
        .code(429)
        .header('retry-after', String(guard.retryAfter))
        .send({
          error: 'LOGIN_RATE_LIMITED',
          message: '登录失败次数过多，请稍后再试',
        });
    }

    const orgSlug = body.org_slug?.trim().toLowerCase() || null;
    const matches = await query<any>(
      `SELECT u.id, u.org_id, u.name, u.email, u.status, u.password_hash,
              u.is_platform_admin,
              o.name AS org_name, o.slug AS org_slug,
              o.plan, o.trial_ends_at, o.plan_expires_at,
              COALESCE(m.role, 'consultant') AS role
         FROM users u
         JOIN organizations o ON o.id = u.org_id
         LEFT JOIN memberships m ON m.user_id = u.id AND m.org_id = u.org_id
        WHERE lower(u.email) = lower($1)
          AND u.status = 'active' AND o.status = 'active'
          AND ($2::text IS NULL OR o.slug = $2)
        ORDER BY u.created_at`,
      [body.email, orgSlug],
    );

    if (matches.length > 1 && !orgSlug) {
      return reply.code(400).send({
        error: 'ORG_REQUIRED',
        message: '该邮箱属于多个组织，请填写组织标识',
      });
    }

    const user = matches[0];
    if (!user || !verifyPassword(body.password, user.password_hash)) {
      await recordLoginFailure(key);
      return reply.code(401).send({
        error: 'INVALID_CREDENTIALS',
        message: '邮箱或密码不正确',
      });
    }

    await clearLoginFailures(key);

    const trialEnds = user.trial_ends_at ? new Date(user.trial_ends_at).getTime() : null;
    if (
      user.plan === 'trial' &&
      trialEnds !== null &&
      trialEnds <= Date.now() &&
      !user.is_platform_admin
    ) {
      return reply.code(403).send({
        error: 'TRIAL_EXPIRED',
        message: '试用已到期，请联系平台升级套餐',
      });
    }
    const planEnds = user.plan_expires_at ? new Date(user.plan_expires_at).getTime() : null;
    if (
      !['trial', 'free'].includes(user.plan) &&
      planEnds !== null &&
      planEnds <= Date.now() &&
      !user.is_platform_admin
    ) {
      return reply.code(403).send({
        error: 'SUBSCRIPTION_EXPIRED',
        message: '订阅已到期，请续费后继续使用',
      });
    }

    await one(`UPDATE users SET last_login_at = now() WHERE id = $1 RETURNING id`, [user.id]);

    const jti = randomUUID();
    const token = signToken({
      id: user.id,
      org_id: user.org_id,
      role: user.role,
      name: user.name,
      email: user.email,
      org_slug: user.org_slug,
      jti,
      platform_admin: Boolean(user.is_platform_admin),
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
        org_slug: user.org_slug,
        role: user.role,
        platform_admin: Boolean(user.is_platform_admin),
      },
    };
  });

  app.post('/api/auth/register', async (req, reply) => {
    const body = registerBody.parse(req.body);
    assertPasswordPolicy(body.password, body.email);

    const requested = body.org_slug?.trim().toLowerCase();
    const slug = requested || `vendor-${randomUUID().slice(0, 8)}`;
    if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(slug)) {
      return reply.code(422).send({
        error: 'INVALID_ORG_SLUG',
        message: '组织标识需为 3–32 位小写字母、数字或连字符，且不能以连字符开头/结尾',
      });
    }
    const exists = await one(`SELECT 1 FROM organizations WHERE lower(slug) = lower($1)`, [slug]);
    if (exists) {
      return reply.code(409).send({ error: 'ORG_SLUG_EXISTS', message: '组织标识已被占用' });
    }

    const created = await withTransaction(async (client) => {
      const org = await client.query<{ id: string }>(
        `INSERT INTO organizations
           (name, slug, plan, status, industry_focus, trial_ends_at, billing_email)
         VALUES ($1,$2,'trial','active','{}', now() + interval '14 days', $3)
         RETURNING id`,
        [body.org_name, slug, body.email.toLowerCase()],
      );
      const orgId = org.rows[0].id;
      const user = await client.query<{ id: string }>(
        `INSERT INTO users (org_id, name, email, status, password_hash)
         VALUES ($1,$2,$3,'active',$4) RETURNING id`,
        [orgId, body.name, body.email.toLowerCase(), hashPassword(body.password)],
      );
      const userId = user.rows[0].id;
      await client.query(
        `INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,'admin')`,
        [userId, orgId],
      );
      await rememberPassword(userId, hashPassword(body.password), client);
      return { orgId, userId };
    });

    const jti = randomUUID();
    const token = signToken({
      id: created.userId,
      org_id: created.orgId,
      org_slug: slug,
      role: 'admin',
      name: body.name,
      email: body.email.toLowerCase(),
      jti,
    });
    await createSession({
      jti,
      userId: created.userId,
      orgId: created.orgId,
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] ?? '').slice(0, 500),
      expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString(),
    });

    return reply.code(201).send({
      token,
      user: {
        id: created.userId,
        name: body.name,
        email: body.email.toLowerCase(),
        org_id: created.orgId,
        org_name: body.org_name,
        org_slug: slug,
        role: 'admin',
        platform_admin: false,
      },
    });
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
    const guard = await loginAllowed(key);
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
      await recordLoginFailure(key);
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
    await clearLoginFailures(key);
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
      `SELECT u.id, u.name, u.email, u.org_id, o.name AS org_name, o.slug AS org_slug,
              u.is_platform_admin, COALESCE(m.role, 'consultant') AS role
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
    return { user: { ...user, platform_admin: Boolean(user.is_platform_admin) } };
  });

  app.post('/api/auth/logout', async (req) => {
    const auth = (req as any).authUser;
    if (auth?.jti) await revokeSession(auth.jti);
    return { ok: true };
  });
}
