import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, query, withTransaction } from '../db';
import { archiveAuditLogs } from '../services/audit_archive';
import { httpError } from '../services/s1';
import { requirePlatformAdmin } from '../services/permissions';
import { pdfStorageInfo } from '../services/pdf_cache';
import { cacheDriver, redisHealthy } from '../services/redis';
import { requestOrg } from '../services/tenant';
import { pageResult, parsePage } from '../services/pagination';
import { listTrash, restoreBatch, type TrashItem } from '../services/trash';

interface TrashBatch {
  batch: string;
  deleted_at: string;
  items: TrashItem[];
}

async function auditFilterStats(
  table: 'audit_logs' | 'audit_logs_archive',
  org: string,
  q: { action?: string; object_type?: string; q?: string },
) {
  const rows = await query<any>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE a.action LIKE 'DELETE%')::int AS deletes,
            count(*) FILTER (WHERE COALESCE(a.status_code, 0) >= 400)::int AS failures
       FROM ${table} a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.org_id = $1
        AND ($2::text IS NULL OR a.action ILIKE '%' || $2 || '%')
        AND ($3::text IS NULL OR a.object_type = $3)
        AND ($4::text IS NULL OR a.action ILIKE '%' || $4 || '%'
             OR a.object_type ILIKE '%' || $4 || '%'
             OR a.ip ILIKE '%' || $4 || '%'
             OR u.name ILIKE '%' || $4 || '%')`,
    [org, q.action ?? null, q.object_type ?? null, q.q ?? null],
  );
  return (
    rows[0] ?? {
      total: 0,
      deletes: 0,
      failures: 0,
    }
  );
}

export async function systemRoutes(app: FastifyInstance) {
  app.get('/api/system/storage', async (req) => {
    requirePlatformAdmin(req);
    return pdfStorageInfo();
  });

  app.get('/api/system/cache', async (req) => {
    requirePlatformAdmin(req);
    return {
      driver: cacheDriver(),
      healthy: await redisHealthy(),
    };
  });

  app.get('/api/system/db-context', async (req, reply) => {
    const auth = (req as any).authUser;
    if (!auth) return reply.code(401).send({ error: 'UNAUTHORIZED', message: '请先登录' });
    const row = await one<{ current_user: string; org_id: string | null; pid: number }>(
      `SELECT current_user, current_setting('app.org_id', true) AS org_id, pg_backend_pid() AS pid`,
    );
    const again = await one<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
    return {
      current_user: row?.current_user ?? null,
      org_id: row?.org_id ?? null,
      platform_admin: Boolean(auth.platform_admin),
      connection_reused: Boolean(row && again && row.pid === again.pid),
    };
  });

  app.get('/api/trash', async (req) => {
    const org = await requestOrg(req);
    const items = await listTrash(org);
    const batches = new Map<string, TrashBatch>();
    for (const item of items) {
      const batch = batches.get(item.batch) ?? {
        batch: item.batch,
        deleted_at: item.deleted_at,
        items: [],
      };
      batch.items.push(item);
      batches.set(item.batch, batch);
    }
    return { items: [...batches.values()] };
  });

  app.post('/api/trash/:batch/restore', async (req) => {
    const { batch } = z.object({ batch: z.uuid() }).parse(req.params);
    const org = await requestOrg(req);
    const restored = await withTransaction(async (client) =>
      restoreBatch(client, batch, org),
    );
    return { ok: true, restored };
  });

  app.get('/api/audit-logs/archive', async (req) => {
    const q = z
      .object({
        q: z.string().trim().optional(),
        action: z.string().trim().optional(),
        object_type: z.string().trim().optional(),
      })
      .parse(req.query);
    const page = parsePage(req.query, 100);
    const org = await requestOrg(req);

    const total = await one<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit_logs_archive a
        LEFT JOIN users u ON u.id = a.user_id
        WHERE a.org_id = $1
          AND ($2::text IS NULL OR a.action ILIKE '%' || $2 || '%')
          AND ($3::text IS NULL OR a.object_type = $3)
          AND ($4::text IS NULL OR a.action ILIKE '%' || $4 || '%'
               OR a.object_type ILIKE '%' || $4 || '%'
               OR a.ip ILIKE '%' || $4 || '%'
               OR u.name ILIKE '%' || $4 || '%')`,
      [org, q.action ?? null, q.object_type ?? null, q.q ?? null],
    );
    const rows = await query(
      `SELECT a.id, a.org_id, a.user_id, u.name AS user_name,
              a.action, a.object_type, a.object_id,
              a.status_code, a.request_id, a.ip, a.user_agent, a.detail,
              a.created_at, a.archived_at
         FROM audit_logs_archive a
         LEFT JOIN users u ON u.id = a.user_id
        WHERE a.org_id = $1
          AND ($2::text IS NULL OR a.action ILIKE '%' || $2 || '%')
          AND ($3::text IS NULL OR a.object_type = $3)
          AND ($4::text IS NULL OR a.action ILIKE '%' || $4 || '%'
               OR a.object_type ILIKE '%' || $4 || '%'
               OR a.ip ILIKE '%' || $4 || '%'
               OR u.name ILIKE '%' || $4 || '%')
        ORDER BY a.created_at DESC
        LIMIT $5 OFFSET $6`,
      [org, q.action ?? null, q.object_type ?? null, q.q ?? null, page.limit, page.offset],
    );
    const stats = await auditFilterStats('audit_logs_archive', org, q);
    return { ...pageResult(rows, total?.count ?? 0, page), stats };
  });

  app.post('/api/audit-logs/archive', async (req) => {
    const body = z
      .object({
        before: z.string().refine((v) => !Number.isNaN(Date.parse(v)), '日期格式不正确'),
        dry_run: z.boolean().default(true),
        confirm: z.string().optional(),
        batch_size: z.coerce.number().int().min(1).max(1000).default(1000),
      })
      .parse(req.body ?? {});

    if (!body.dry_run && body.confirm !== 'ARCHIVE') {
      throw httpError(422, 'ARCHIVE_CONFIRM_REQUIRED', '执行归档需要 confirm=ARCHIVE');
    }

    const result = await archiveAuditLogs({
      before: new Date(body.before).toISOString(),
      batchSize: body.batch_size,
      dryRun: body.dry_run,
    });
    const remaining = await one<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit_logs`,
    );
    return { ...result, remaining: remaining?.count ?? 0 };
  });

  app.get('/api/audit-logs/facets', async (req) => {
    const { scope } = z
      .object({ scope: z.enum(['live', 'archive']).default('live') })
      .parse(req.query ?? {});
    const org = await requestOrg(req);
    const table = scope === 'archive' ? 'audit_logs_archive' : 'audit_logs';
    const [actions, objectTypes] = await Promise.all([
      query<{ value: string }>(
        `SELECT DISTINCT action AS value
           FROM ${table}
          WHERE org_id = $1
          ORDER BY action
          LIMIT 300`,
        [org],
      ),
      query<{ value: string }>(
        `SELECT DISTINCT object_type AS value
           FROM ${table}
          WHERE org_id = $1 AND object_type IS NOT NULL
          ORDER BY object_type
          LIMIT 100`,
        [org],
      ),
    ]);
    return {
      actions: actions.map((row) => row.value),
      object_types: objectTypes.map((row) => row.value),
    };
  });

  app.get('/api/audit-logs', async (req) => {
    const q = z
      .object({
        q: z.string().trim().optional(),
        action: z.string().trim().optional(),
        object_type: z.string().trim().optional(),
      })
      .parse(req.query);
    const page = parsePage(req.query, 100);
    const org = await requestOrg(req);

    const total = await one<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit_logs a
        LEFT JOIN users u ON u.id = a.user_id
        WHERE a.org_id = $1
          AND ($2::text IS NULL OR a.action ILIKE '%' || $2 || '%')
          AND ($3::text IS NULL OR a.object_type = $3)
          AND ($4::text IS NULL OR a.action ILIKE '%' || $4 || '%'
               OR a.object_type ILIKE '%' || $4 || '%'
               OR a.ip ILIKE '%' || $4 || '%'
               OR u.name ILIKE '%' || $4 || '%')`,
      [org, q.action ?? null, q.object_type ?? null, q.q ?? null],
    );

    const rows = await query(
      `SELECT a.id, a.org_id, a.user_id, u.name AS user_name,
              a.action, a.object_type, a.object_id,
              a.status_code, a.request_id, a.ip, a.user_agent, a.detail, a.created_at
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.user_id
        WHERE a.org_id = $1
          AND ($2::text IS NULL OR a.action ILIKE '%' || $2 || '%')
          AND ($3::text IS NULL OR a.object_type = $3)
          AND ($4::text IS NULL OR a.action ILIKE '%' || $4 || '%'
               OR a.object_type ILIKE '%' || $4 || '%'
               OR a.ip ILIKE '%' || $4 || '%'
               OR u.name ILIKE '%' || $4 || '%')
        ORDER BY a.created_at DESC
        LIMIT $5 OFFSET $6`,
      [org, q.action ?? null, q.object_type ?? null, q.q ?? null, page.limit, page.offset],
    );
    const stats = await auditFilterStats('audit_logs', org, q);
    return { ...pageResult(rows, total?.count ?? 0, page), stats };
  });
}
