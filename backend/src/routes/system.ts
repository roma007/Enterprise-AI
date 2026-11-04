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

type AuditStatus = '2xx' | '3xx' | '4xx' | '5xx';

const AUDIT_EXPORT_COLUMNS: Record<string, string> = {
  time: '时间',
  action: '操作',
  object_type: '对象类型',
  object_id: '对象 ID',
  status: '状态码',
  user: '操作人',
  request_id: '请求 ID',
  ip: 'IP',
  user_agent: 'User-Agent',
  detail: '详情',
  archived_at: '归档时间',
};

function normalizeAuditExportColumns(input?: string[]): string[] {
  const columns = Array.from(new Set(input ?? []));
  const bad = columns.filter(
    (key) => !Object.keys(AUDIT_EXPORT_COLUMNS).includes(key),
  );
  if (bad.length) {
    throw httpError(
      400,
      'INVALID_EXPORT_COLUMNS',
      `导出列不合法：${bad.join(', ')}`,
    );
  }
  return columns;
}

interface AuditQuery {
  q?: string;
  action?: string;
  object_type?: string;
  status?: AuditStatus;
  from?: string;
  to?: string;
}

/** 列表、统计、归档查询共用同一组筛选条件。 */
function auditFilter(org: string, q: AuditQuery) {
  const where = `a.org_id = $1
        AND ($2::text IS NULL OR a.action ILIKE '%' || $2 || '%')
        AND ($3::text IS NULL OR a.object_type = $3)
        AND ($4::text IS NULL OR a.action ILIKE '%' || $4 || '%'
             OR a.object_type ILIKE '%' || $4 || '%'
             OR a.ip ILIKE '%' || $4 || '%'
             OR u.name ILIKE '%' || $4 || '%')
        AND ($5::text IS NULL
             OR ($5::text = '2xx' AND a.status_code >= 200 AND a.status_code < 300)
             OR ($5::text = '3xx' AND a.status_code >= 300 AND a.status_code < 400)
             OR ($5::text = '4xx' AND a.status_code >= 400 AND a.status_code < 500)
             OR ($5::text = '5xx' AND a.status_code >= 500 AND a.status_code < 600))
        AND ($6::date IS NULL OR a.created_at >= $6::date)
        AND ($7::date IS NULL OR a.created_at < ($7::date + interval '1 day'))`;
  return {
    where,
    params: [
      org,
      q.action ?? null,
      q.object_type ?? null,
      q.q ?? null,
      q.status ?? null,
      q.from ?? null,
      q.to ?? null,
    ],
  };
}

const AUDIT_STATS_SQL = `SELECT count(*)::int AS total,
       count(*) FILTER (WHERE a.action LIKE 'DELETE%')::int AS deletes,
       count(*) FILTER (WHERE COALESCE(a.status_code, 0) >= 400)::int AS failures`;

async function auditViewRecipients(
  client: any,
  orgId: string,
  view: { shared?: boolean; shared_role?: string | null },
  shareIds: string[],
): Promise<Set<string>> {
  const ids = new Set<string>(shareIds);
  if (view.shared) {
    const rows = await client.query(
      `SELECT id FROM users WHERE org_id = $1 AND status = 'active'`,
      [orgId],
    );
    for (const row of rows.rows) ids.add(row.id as string);
  } else if (view.shared_role) {
    const rows = await client.query(
      `SELECT u.id
         FROM users u
         JOIN memberships m ON m.user_id = u.id AND m.org_id = u.org_id
        WHERE u.org_id = $1 AND u.status = 'active' AND m.role = $2`,
      [orgId, view.shared_role],
    );
    for (const row of rows.rows) ids.add(row.id as string);
  }
  return ids;
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
        status: z.enum(['2xx', '3xx', '4xx', '5xx']).optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(req.query);
    if (q.from && q.to && q.from > q.to) {
      throw httpError(400, 'INVALID_DATE_RANGE', '开始日期不能晚于结束日期');
    }
    const page = parsePage(req.query, 100);
    const org = await requestOrg(req);
    const { where, params } = auditFilter(org, q);

    const [statsRows, rows] = await Promise.all([
      query<any>(
        `${AUDIT_STATS_SQL}
           FROM audit_logs_archive a
           LEFT JOIN users u ON u.id = a.user_id
          WHERE ${where}`,
        params,
      ),
      query(
        `SELECT a.id, a.org_id, a.user_id, u.name AS user_name,
                a.action, a.object_type, a.object_id,
                a.status_code, a.request_id, a.ip, a.user_agent, a.detail,
                a.created_at, a.archived_at
           FROM audit_logs_archive a
           LEFT JOIN users u ON u.id = a.user_id
          WHERE ${where}
          ORDER BY a.created_at DESC
          LIMIT $8 OFFSET $9`,
        [...params, page.limit, page.offset],
      ),
    ]);
    const stats = statsRows[0] ?? { total: 0, deletes: 0, failures: 0 };
    return { ...pageResult(rows, stats.total, page), stats };
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
        status: z.enum(['2xx', '3xx', '4xx', '5xx']).optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(req.query);
    if (q.from && q.to && q.from > q.to) {
      throw httpError(400, 'INVALID_DATE_RANGE', '开始日期不能晚于结束日期');
    }
    const page = parsePage(req.query, 100);
    const org = await requestOrg(req);
    const { where, params } = auditFilter(org, q);

    const [statsRows, rows] = await Promise.all([
      query<any>(
        `${AUDIT_STATS_SQL}
           FROM audit_logs a
           LEFT JOIN users u ON u.id = a.user_id
          WHERE ${where}`,
        params,
      ),
      query(
        `SELECT a.id, a.org_id, a.user_id, u.name AS user_name,
                a.action, a.object_type, a.object_id,
                a.status_code, a.request_id, a.ip, a.user_agent, a.detail, a.created_at
           FROM audit_logs a
           LEFT JOIN users u ON u.id = a.user_id
          WHERE ${where}
          ORDER BY a.created_at DESC
          LIMIT $8 OFFSET $9`,
        [...params, page.limit, page.offset],
      ),
    ]);
    const stats = statsRows[0] ?? { total: 0, deletes: 0, failures: 0 };
    return { ...pageResult(rows, stats.total, page), stats };
  });

  /** 导出当前筛选的审计日志（最多 5000 条）。 */
  app.get('/api/audit-logs/export.csv', async (req, reply) => {
    const auth = (req as any).authUser;
    const q = z
      .object({
        scope: z.enum(['live', 'archive']).default('live'),
        q: z.string().trim().optional(),
        action: z.string().trim().optional(),
        object_type: z.string().trim().optional(),
        status: z.enum(['2xx', '3xx', '4xx', '5xx']).optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        columns: z.string().trim().optional(),
      })
      .parse(req.query);
    if (q.from && q.to && q.from > q.to) {
      throw httpError(400, 'INVALID_DATE_RANGE', '开始日期不能晚于结束日期');
    }

    const allowedColumns = Object.keys(AUDIT_EXPORT_COLUMNS).filter(
      (key) => key !== 'archived_at' || q.scope === 'archive',
    );
    const defaultColumns = allowedColumns;
    const requested = q.columns
      ? Array.from(
          new Set(
            q.columns
              .split(',')
              .map((key) => key.trim())
              .filter(Boolean),
          ),
        )
      : defaultColumns;
    const unknown = requested.filter((key) => !allowedColumns.includes(key));
    if (!requested.length || unknown.length) {
      throw httpError(
        400,
        'INVALID_COLUMNS',
        `导出列不合法：${(unknown.length ? unknown : ['(空)']).join(', ')}`,
      );
    }
    // 固定按元数据顺序输出，避免前端传参顺序影响 CSV 列序
    const columns = allowedColumns.filter((key) => requested.includes(key));

    const org = await requestOrg(req);
    const { where, params } = auditFilter(org, q);
    const table = q.scope === 'archive' ? 'audit_logs_archive' : 'audit_logs';
    const rows = await query<any>(
      `SELECT a.created_at, a.action, a.object_type, a.object_id,
              a.status_code, u.name AS user_name, a.user_id,
              a.request_id, a.ip, a.user_agent, a.detail,
              ${q.scope === 'archive' ? 'a.archived_at' : 'NULL::timestamptz AS archived_at'}
         FROM ${table} a
         LEFT JOIN users u ON u.id = a.user_id
        WHERE ${where}
        ORDER BY a.created_at DESC
        LIMIT 5000`,
      params,
    );

    const cell = (value: unknown) => {
      let text =
        value == null
          ? ''
          : typeof value === 'string'
            ? value
            : JSON.stringify(value);
      // 防止 Excel/Sheets 把单元格当公式执行
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const valueFor = (row: any, key: string) => {
      switch (key) {
        case 'time':
          return row.created_at ? new Date(row.created_at).toISOString() : '';
        case 'action':
          return row.action;
        case 'object_type':
          return row.object_type;
        case 'object_id':
          return row.object_id;
        case 'status':
          return row.status_code;
        case 'user':
          return row.user_name ?? row.user_id;
        case 'request_id':
          return row.request_id;
        case 'ip':
          return row.ip;
        case 'user_agent':
          return row.user_agent;
        case 'detail':
          return row.detail;
        case 'archived_at':
          return row.archived_at
            ? new Date(row.archived_at).toISOString()
            : '';
        default:
          return '';
      }
    };
    const header = columns.map((key) => AUDIT_EXPORT_COLUMNS[key]);
    const lines = [header.map(cell).join(',')];
    for (const row of rows) {
      lines.push(columns.map((key) => cell(valueFor(row, key))).join(','));
    }

    if (auth?.sub && auth.org_id) {
      try {
        await query(
          `INSERT INTO audit_logs
             (org_id, user_id, action, object_type, status_code, ip, user_agent, detail)
           VALUES ($1,$2,'EXPORT audit-logs','audit_log',200,$3,$4,$5::jsonb)`,
          [
            auth.org_id,
            auth.sub,
            req.ip ?? null,
            req.headers['user-agent'] ?? null,
            JSON.stringify({
              scope: q.scope,
              q: q.q ?? null,
              action: q.action ?? null,
              object_type: q.object_type ?? null,
              status: q.status ?? null,
              from: q.from ?? null,
              to: q.to ?? null,
              columns,
              exported: rows.length,
            }),
          ],
        );
      } catch (err) {
        req.log?.warn?.({ err }, 'audit export log failed');
      }
    }

    const filename = `audit-logs-${q.scope}-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send(`\uFEFF${lines.join('\r\n')}`);
  });

  const auditViewBody = z.object({
    name: z.string().trim().min(1).max(80),
    mode: z.enum(['live', 'archive']).default('live'),
    q: z.string().trim().max(200).optional(),
    action: z.string().trim().max(200).optional(),
    object_type: z.string().trim().max(120).optional(),
    status: z.enum(['2xx', '3xx', '4xx', '5xx']).optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    shared: z.boolean().optional(),
    shared_role: z
      .enum(['admin', 'director', 'pm', 'consultant', 'tech_lead'])
      .nullable()
      .optional(),
    shared_user_ids: z.array(z.uuid()).max(50).optional(),
    export_columns: z.array(z.string()).max(20).optional(),
  });

  const AUDIT_VIEW_COLUMNS = `v.id, v.name, v.mode, v.q, v.action,
              v.object_type, v.status,
              v.from_date::text AS "from", v.to_date::text AS "to",
              v.export_columns,
              v.shared, v.shared_role, (v.user_id = $1) AS is_owner,
              u.name AS owner_name,
              v.created_at, v.updated_at`;

  const auditViewRow = (id: string) =>
    `SELECT v.id, v.name, v.mode, v.q, v.action,
            v.object_type, v.status,
            v.from_date::text AS "from", v.to_date::text AS "to",
            v.export_columns,
            v.shared, v.shared_role, true AS is_owner,
            (SELECT name FROM users WHERE id = v.user_id) AS owner_name,
            v.created_at, v.updated_at,
            COALESCE((
              SELECT json_agg(s.user_id)
                FROM audit_filter_view_shares s
               WHERE s.view_id = v.id
            ), '[]'::json) AS shared_user_ids
       FROM audit_filter_views v
      WHERE v.id = $1`;

  /** 当前用户可见的审计日志筛选视图（自己的 + 共享的）。 */
  app.get('/api/audit-filter-views', async (req) => {
    const auth = (req as any).authUser;
    if (!auth?.sub) throw httpError(401, 'UNAUTHORIZED', '请先登录');
    const items = await query(
      `SELECT ${AUDIT_VIEW_COLUMNS},
              COALESCE((
                SELECT json_agg(s.user_id)
                  FROM audit_filter_view_shares s
                 WHERE s.view_id = v.id
              ), '[]'::json) AS shared_user_ids
         FROM audit_filter_views v
         LEFT JOIN users u ON u.id = v.user_id
        WHERE v.user_id = $1
           OR v.shared
           OR v.shared_role = $2
           OR EXISTS (
             SELECT 1 FROM audit_filter_view_shares s
              WHERE s.view_id = v.id AND s.user_id = $1
           )
        ORDER BY v.name`,
      [auth.sub, auth.role ?? ''],
    );
    return { items };
  });

  app.post('/api/audit-filter-views', async (req, reply) => {
    const auth = (req as any).authUser;
    if (!auth?.sub || !auth.org_id) {
      throw httpError(401, 'UNAUTHORIZED', '请先登录');
    }
    const body = auditViewBody.parse(req.body ?? {});
    if (body.from && body.to && body.from > body.to) {
      throw httpError(400, 'INVALID_DATE_RANGE', '开始日期不能晚于结束日期');
    }
    const exportColumns = normalizeAuditExportColumns(body.export_columns);
    const shareIds = Array.from(new Set(body.shared_user_ids ?? []));
    const result = await withTransaction(async (client) => {
      if (shareIds.length) {
        const found = await client.query(
          `SELECT id FROM users WHERE org_id = $1 AND id = ANY($2::uuid[])`,
          [auth.org_id, shareIds],
        );
        if (found.rows.length !== shareIds.length) {
          throw httpError(422, 'INVALID_SHARED_USERS', '共享对象不属于当前组织');
        }
      }
      const existing = await client.query<any>(
        `SELECT id, shared, shared_role
           FROM audit_filter_views
          WHERE user_id = $1 AND name = $2`,
        [auth.sub, body.name],
      );
      let oldRecipients = new Set<string>();
      let oldShareIds: string[] = [];
      if (existing.rows[0]) {
        const existingShares = await client.query(
          `SELECT user_id FROM audit_filter_view_shares WHERE view_id = $1`,
          [existing.rows[0].id],
        );
        oldShareIds = existingShares.rows.map((row: any) => row.user_id as string);
        oldRecipients = await auditViewRecipients(
          client,
          auth.org_id,
          existing.rows[0],
          oldShareIds,
        );
      }
      const effectiveShareIds =
        body.shared_user_ids === undefined ? oldShareIds : shareIds;

      const inserted = await client.query<any>(
        `INSERT INTO audit_filter_views
           (org_id, user_id, name, mode, q, action, object_type, status,
            from_date, to_date, shared, shared_role, export_columns)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
         ON CONFLICT (user_id, name)
         DO UPDATE SET mode = EXCLUDED.mode,
                       q = EXCLUDED.q,
                       action = EXCLUDED.action,
                       object_type = EXCLUDED.object_type,
                       status = EXCLUDED.status,
                       from_date = EXCLUDED.from_date,
                       to_date = EXCLUDED.to_date,
                       shared = EXCLUDED.shared,
                       shared_role = EXCLUDED.shared_role,
                       export_columns = EXCLUDED.export_columns,
                       updated_at = now()
         RETURNING id`,
        [
          auth.org_id,
          auth.sub,
          body.name,
          body.mode,
          body.q ?? null,
          body.action ?? null,
          body.object_type ?? null,
          body.status ?? null,
          body.from ?? null,
          body.to ?? null,
          body.shared ?? false,
          body.shared_role ?? null,
          JSON.stringify(exportColumns),
        ],
      );
      const viewId = inserted.rows[0].id as string;
      if (body.shared_user_ids !== undefined) {
        await client.query(
          `DELETE FROM audit_filter_view_shares WHERE view_id = $1`,
          [viewId],
        );
        if (shareIds.length) {
          await client.query(
            `INSERT INTO audit_filter_view_shares (view_id, user_id)
             SELECT $1, unnest($2::uuid[])`,
            [viewId, shareIds],
          );
        }
      }
      const row = await client.query(auditViewRow(viewId), [viewId]);
      const newRecipients = await auditViewRecipients(
        client,
        auth.org_id,
        {
          shared: body.shared ?? false,
          shared_role: body.shared_role ?? null,
        },
        effectiveShareIds,
      );
      return {
        item: row.rows[0],
        recipients: [...newRecipients].filter(
          (userId) => userId !== auth.sub && !oldRecipients.has(userId),
        ),
      };
    });

    if (result.recipients.length) {
      try {
        await query(
          `INSERT INTO user_notifications
             (org_id, user_id, actor_id, kind, title, body, link, ref_type, ref_id)
           SELECT $1, unnest($2::uuid[]), $3,
                  'copilot_audit_view_shared',
                  $4, $5,
                  '?audit_view=' || $6::text || '#/audit',
                  'audit_filter_view', $6::uuid`,
          [
            auth.org_id,
            result.recipients,
            auth.sub,
            `审计视图已共享：${body.name}`,
            `${auth.name ?? '同事'} 共享了审计筛选视图「${body.name}」`,
            result.item.id,
          ],
        );
      } catch (err) {
        req.log?.warn?.({ err }, 'audit view share notification failed');
      }
    }
    return reply.code(201).send({ item: result.item });
  });

  app.get('/api/audit-filter-views/export.json', async (req, reply) => {
    const auth = (req as any).authUser;
    if (!auth?.sub) throw httpError(401, 'UNAUTHORIZED', '请先登录');
    const rows = await query<any>(
      `SELECT name, mode, q, action, object_type, status,
              from_date::text AS "from", to_date::text AS "to",
              export_columns
         FROM audit_filter_views
        WHERE user_id = $1
        ORDER BY name`,
      [auth.sub],
    );
    const filename = `audit-views-${new Date().toISOString().slice(0, 10)}.json`;
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send({
        version: 1,
        exported_at: new Date().toISOString(),
        views: rows.map((row) => ({
          name: row.name,
          mode: row.mode,
          q: row.q,
          action: row.action,
          object_type: row.object_type,
          status: row.status,
          from: row.from,
          to: row.to,
          export_columns: row.export_columns ?? [],
        })),
      });
  });

  const importViewItem = z.object({
    name: z.string().trim().min(1).max(80),
    mode: z.enum(['live', 'archive']).default('live'),
    q: z.string().trim().max(200).nullable().optional(),
    action: z.string().trim().max(200).nullable().optional(),
    object_type: z.string().trim().max(120).nullable().optional(),
    status: z.enum(['2xx', '3xx', '4xx', '5xx']).nullable().optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    export_columns: z.array(z.string()).max(20).optional(),
  });

  const importViewsBody = z.object({
    version: z.literal(1).optional(),
    views: z.array(importViewItem).min(1).max(100),
  });

  const normalizeImportViews = (
    views: Array<z.infer<typeof importViewItem>>,
  ) => {
    const normalized = views.map((view) => {
      if (view.from && view.to && view.from > view.to) {
        throw httpError(
          400,
          'INVALID_DATE_RANGE',
          `视图「${view.name}」开始日期不能晚于结束日期`,
        );
      }
      return {
        ...view,
        export_columns: normalizeAuditExportColumns(view.export_columns),
      };
    });
    return Array.from(
      new Map(normalized.map((view) => [view.name, view])).values(),
    );
  };

  app.post('/api/audit-filter-views/import/preview', async (req) => {
    const auth = (req as any).authUser;
    if (!auth?.sub) throw httpError(401, 'UNAUTHORIZED', '请先登录');
    const body = importViewsBody.parse(req.body ?? {});
    const views = normalizeImportViews(body.views);
    const rows = await query<{ name: string }>(
      `SELECT name FROM audit_filter_views
        WHERE user_id = $1 AND name = ANY($2::text[])`,
      [auth.sub, views.map((view) => view.name)],
    );
    const existing = new Set(rows.map((row) => row.name));
    const conflicts = views
      .filter((view) => existing.has(view.name))
      .map((view) => view.name);
    return {
      total: views.length,
      new: views.length - conflicts.length,
      conflicts,
    };
  });

  /** 导入 JSON 视图，可覆盖或跳过同名项；只恢复筛选与导出列，不恢复共享关系。 */
  app.post('/api/audit-filter-views/import', async (req, reply) => {
    const auth = (req as any).authUser;
    if (!auth?.sub || !auth.org_id) {
      throw httpError(401, 'UNAUTHORIZED', '请先登录');
    }
    const body = importViewsBody
      .extend({ mode: z.enum(['overwrite', 'skip']).default('overwrite') })
      .parse(req.body ?? {});
    const views = normalizeImportViews(body.views);

    const existingRows = await query<{ name: string }>(
      `SELECT name FROM audit_filter_views
        WHERE user_id = $1 AND name = ANY($2::text[])`,
      [auth.sub, views.map((view) => view.name)],
    );
    const existing = new Set(existingRows.map((row) => row.name));
    let skipped = 0;
    let toImport = views;
    if (body.mode === 'skip') {
      toImport = views.filter((view) => !existing.has(view.name));
      skipped = views.length - toImport.length;
    }
    const results = views.map((view) =>
      body.mode === 'skip' && existing.has(view.name)
        ? { name: view.name, status: 'skipped', reason: '同名视图已存在' }
        : {
            name: view.name,
            status: 'imported',
            reason: existing.has(view.name) ? '已覆盖同名视图' : '新增',
          },
    );

    const items: any[] = [];
    for (const view of toImport) {
      const row = await one(
        `INSERT INTO audit_filter_views
           (org_id, user_id, name, mode, q, action, object_type, status,
            from_date, to_date, export_columns)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
         ON CONFLICT (user_id, name)
         DO UPDATE SET mode = EXCLUDED.mode,
                       q = EXCLUDED.q,
                       action = EXCLUDED.action,
                       object_type = EXCLUDED.object_type,
                       status = EXCLUDED.status,
                       from_date = EXCLUDED.from_date,
                       to_date = EXCLUDED.to_date,
                       export_columns = EXCLUDED.export_columns,
                       updated_at = now()
         RETURNING id, name, mode, q, action, object_type, status,
                   from_date::text AS "from", to_date::text AS "to",
                   export_columns, created_at, updated_at`,
        [
          auth.org_id,
          auth.sub,
          view.name,
          view.mode,
          view.q ?? null,
          view.action ?? null,
          view.object_type ?? null,
          view.status ?? null,
          view.from ?? null,
          view.to ?? null,
          JSON.stringify(view.export_columns),
        ],
      );
      items.push(row);
    }
    return reply.code(201).send({
      imported: items.length,
      skipped,
      results,
      items,
    });
  });

  app.patch('/api/audit-filter-views/:id', async (req) => {
    const auth = (req as any).authUser;
    if (!auth?.sub) throw httpError(401, 'UNAUTHORIZED', '请先登录');
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z
      .object({ name: z.string().trim().min(1).max(80) })
      .parse(req.body ?? {});
    const item = await one(
      `UPDATE audit_filter_views
          SET name = $2, updated_at = now()
        WHERE id = $1 AND user_id = $3
        RETURNING id, name, mode, q, action, object_type, status,
                  from_date::text AS "from", to_date::text AS "to",
                  export_columns, shared, shared_role, created_at, updated_at`,
      [id, body.name, auth.sub],
    );
    if (!item) throw httpError(404, 'NOT_FOUND', '筛选视图不存在');
    return { item };
  });

  app.delete('/api/audit-filter-views/:id', async (req) => {
    const auth = (req as any).authUser;
    if (!auth?.sub) throw httpError(401, 'UNAUTHORIZED', '请先登录');
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const row = await one(
      `DELETE FROM audit_filter_views
        WHERE id = $1 AND user_id = $2
        RETURNING id`,
      [id, auth.sub],
    );
    if (!row) throw httpError(404, 'NOT_FOUND', '筛选视图不存在');
    return { ok: true };
  });
}
