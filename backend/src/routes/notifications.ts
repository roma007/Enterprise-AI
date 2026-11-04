import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, query } from '../db';
import { httpError } from '../services/s1';
import { csvCell } from '../services/csv';
import {
  cleanupDeletedNotifications,
  notificationTrashRetentionDays,
} from '../services/notification_cleanup';

function currentUser(req: any): { id: string } {
  const auth = req.authUser;
  if (!auth?.sub) throw httpError(401, 'UNAUTHORIZED', '请先登录');
  return { id: auth.sub as string };
}

function assertAuditViewer(req: any): void {
  const auth = req.authUser;
  if (
    !auth ||
    !(auth.platform_admin || ['admin', 'director'].includes(auth.role))
  ) {
    throw httpError(403, 'FORBIDDEN', '仅管理员/总监可查看通知审计');
  }
}

const NOTIFICATION_ACTION_LABEL: Record<string, string> = {
  'DELETE copilot-notification': '删除',
  'RESTORE copilot-notification': '恢复',
  'PURGE copilot-notification': '彻底删除',
};

async function recordNotificationAudit(
  req: any,
  action: string,
  ids: string[],
  detail: Record<string, unknown>,
): Promise<void> {
  const auth = req.authUser;
  try {
    await query(
      `INSERT INTO audit_logs
         (org_id, user_id, action, object_type, object_id, status_code,
          ip, user_agent, request_id, detail)
       VALUES ($1,$2,$3,'user_notification',$4,200,$5,$6,$7,$8::jsonb)`,
      [
        auth?.org_id ?? null,
        auth?.sub ?? null,
        action,
        ids[0] ?? null,
        req.ip,
        String(req.headers['user-agent'] ?? '').slice(0, 500),
        req.id,
        JSON.stringify({
          ...detail,
          count: ids.length,
          ids: ids.length <= 20 ? ids : undefined,
        }),
      ],
    );
  } catch (err) {
    req.log?.warn?.({ err }, 'notification audit failed');
  }
}

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function notificationRoutes(app: FastifyInstance) {
  app.get('/api/notifications/unread-count', async (req) => {
    const auth = currentUser(req);
    const row = await one<{ count: string }>(
      `SELECT count(*)::text AS count FROM user_notifications
        WHERE user_id = $1 AND read_at IS NULL AND deleted_at IS NULL`,
      [auth.id],
    );
    return { count: Number(row?.count ?? 0) };
  });

  app.get('/api/notifications', async (req) => {
    const auth = currentUser(req);
    const { limit, offset, unread, kind, from, to, trash } = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
        unread: z.enum(['0', '1']).optional(),
        kind: z.string().trim().max(80).optional(),
        from: dateStr.optional(),
        to: dateStr.optional(),
        trash: z.enum(['0', '1']).optional(),
      })
      .parse(req.query ?? {});
    const isTrash = trash === '1';
    if (isTrash) {
      await cleanupDeletedNotifications(auth.id);
    }
    const onlyUnread = !isTrash && unread === '1';
    const kindFilter = kind || null;
    if (from && to && from > to) {
      throw httpError(400, 'INVALID_DATE_RANGE', '开始日期不能晚于结束日期');
    }
    const fromDate = from ?? null;
    const toDate = to ?? null;

    const [items, totals, kinds] = await Promise.all([
      query(
        `SELECT n.id, n.kind, n.title, n.body, n.link, n.ref_type, n.ref_id,
                n.read_at, n.deleted_at, n.created_at, u.name AS actor_name
           FROM user_notifications n
           LEFT JOIN users u ON u.id = n.actor_id
          WHERE n.user_id = $1
            AND (($8::boolean = false AND n.deleted_at IS NULL)
              OR ($8::boolean = true AND n.deleted_at IS NOT NULL))
            AND ($4::boolean = false OR n.read_at IS NULL)
            AND ($5::text IS NULL OR n.kind = $5)
            AND ($6::date IS NULL OR n.created_at >= $6::date)
            AND ($7::date IS NULL OR n.created_at < ($7::date + interval '1 day'))
          ORDER BY n.created_at DESC
          LIMIT $2 OFFSET $3`,
        [
          auth.id,
          limit,
          offset,
          onlyUnread,
          kindFilter,
          fromDate,
          toDate,
          isTrash,
        ],
      ),
      query<{ total: string; unread: string }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE read_at IS NULL)::text AS unread
           FROM user_notifications
          WHERE user_id = $1
            AND (($6::boolean = false AND deleted_at IS NULL)
              OR ($6::boolean = true AND deleted_at IS NOT NULL))
            AND ($2::boolean = false OR read_at IS NULL)
            AND ($3::text IS NULL OR kind = $3)
            AND ($4::date IS NULL OR created_at >= $4::date)
            AND ($5::date IS NULL OR created_at < ($5::date + interval '1 day'))`,
        [auth.id, onlyUnread, kindFilter, fromDate, toDate, isTrash],
      ),
      query<{ kind: string }>(
        `SELECT DISTINCT kind FROM user_notifications
          WHERE user_id = $1 ORDER BY kind`,
        [auth.id],
      ),
    ]);

    return {
      items,
      total: Number(totals[0]?.total ?? 0),
      unread_count: Number(totals[0]?.unread ?? 0),
      kinds: kinds.map((k) => k.kind),
      trash_retention_days: notificationTrashRetentionDays(),
      limit,
      offset,
    };
  });

  /** 通知审计查询（管理员/总监/平台管理员）。 */
  app.get('/api/notification-audits', async (req) => {
    assertAuditViewer(req);
    const { limit, offset, action, from, to, actor_id } = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
        action: z
          .enum([
            'DELETE copilot-notification',
            'RESTORE copilot-notification',
            'PURGE copilot-notification',
          ])
          .optional(),
        from: dateStr.optional(),
        to: dateStr.optional(),
        actor_id: z.uuid().optional(),
      })
      .parse(req.query ?? {});
    if (from && to && from > to) {
      throw httpError(400, 'INVALID_DATE_RANGE', '开始日期不能晚于结束日期');
    }
    const [items, totals] = await Promise.all([
      query(
        `SELECT a.id, a.action, a.user_id, u.name AS actor_name,
                a.detail, a.created_at
           FROM audit_logs a
           LEFT JOIN users u ON u.id = a.user_id
          WHERE a.object_type = 'user_notification'
            AND ($2::text IS NULL OR a.action = $2)
            AND ($3::date IS NULL OR a.created_at >= $3::date)
            AND ($4::date IS NULL OR a.created_at < ($4::date + interval '1 day'))
            AND ($5::uuid IS NULL OR a.user_id = $5)
          ORDER BY a.created_at DESC
          LIMIT $1 OFFSET $6`,
        [limit, action ?? null, from ?? null, to ?? null, actor_id ?? null, offset],
      ),
      query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_logs
          WHERE object_type = 'user_notification'
            AND ($1::text IS NULL OR action = $1)
            AND ($2::date IS NULL OR created_at >= $2::date)
            AND ($3::date IS NULL OR created_at < ($3::date + interval '1 day'))
            AND ($4::uuid IS NULL OR user_id = $4)`,
        [action ?? null, from ?? null, to ?? null, actor_id ?? null],
      ),
    ]);
    return {
      items,
      total: Number(totals[0]?.count ?? 0),
      limit,
      offset,
    };
  });

  /** 导出通知审计 CSV。 */
  app.get('/api/notification-audits/export.csv', async (req, reply) => {
    assertAuditViewer(req);
    const auth = (req as any).authUser;
    const { action, from, to, actor_id } = z
      .object({
        action: z
          .enum([
            'DELETE copilot-notification',
            'RESTORE copilot-notification',
            'PURGE copilot-notification',
          ])
          .optional(),
        from: dateStr.optional(),
        to: dateStr.optional(),
        actor_id: z.uuid().optional(),
      })
      .parse(req.query ?? {});
    if (from && to && from > to) {
      throw httpError(400, 'INVALID_DATE_RANGE', '开始日期不能晚于结束日期');
    }
    const rows = await query<any>(
      `SELECT a.id, a.action, a.detail, a.created_at, u.name AS actor_name
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.user_id
        WHERE a.object_type = 'user_notification'
          AND ($1::text IS NULL OR a.action = $1)
          AND ($2::date IS NULL OR a.created_at >= $2::date)
          AND ($3::date IS NULL OR a.created_at < ($3::date + interval '1 day'))
          AND ($4::uuid IS NULL OR a.user_id = $4)
        ORDER BY a.created_at DESC
        LIMIT 5000`,
      [action ?? null, from ?? null, to ?? null, actor_id ?? null],
    );

    const header = [
      '时间',
      '操作',
      '操作人',
      '数量',
      '模式',
      '筛选条件',
      '通知ID',
    ];
    const lines = [header.join(',')];
    for (const row of rows) {
      const detail = row.detail ?? {};
      const filters = detail.filters ?? {};
      const filterText = [
        filters.unread ? '仅未读' : '',
        filters.kind ? `类型 ${filters.kind}` : '',
        filters.from ? `从 ${filters.from}` : '',
        filters.to ? `到 ${filters.to}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      lines.push(
        [
          row.created_at ? new Date(row.created_at).toISOString() : '',
          NOTIFICATION_ACTION_LABEL[row.action] ?? row.action,
          row.actor_name,
          detail.count,
          detail.mode === 'all' ? '按筛选' : '按 ID',
          filterText,
          Array.isArray(detail.ids) ? detail.ids.join(' ') : '',
        ]
          .map(csvCell)
          .join(','),
      );
    }

    try {
      await query(
        `INSERT INTO audit_logs
           (org_id, user_id, action, object_type, status_code,
            ip, user_agent, request_id, detail)
         VALUES ($1,$2,'EXPORT copilot-notification-audits','notification_audit',200,$3,$4,$5,$6::jsonb)`,
        [
          auth?.org_id ?? null,
          auth?.sub ?? null,
          req.ip,
          String(req.headers['user-agent'] ?? '').slice(0, 500),
          req.id,
          JSON.stringify({
            rows: rows.length,
            filters: {
              action: action ?? null,
              from: from ?? null,
              to: to ?? null,
              actor_id: actor_id ?? null,
            },
          }),
        ],
      );
    } catch (err) {
      req.log?.warn?.({ err }, 'notification audit export audit failed');
    }

    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header(
        'content-disposition',
        'attachment; filename="notification-audits.csv"',
      )
      .send(`\uFEFF${lines.join('\r\n')}`);
  });

  app.post('/api/notifications/delete', async (req) => {
    const auth = currentUser(req);
    const body = z
      .union([
        z.object({ ids: z.array(z.uuid()).min(1).max(100) }),
        z.object({
          all: z.literal(true),
          unread: z.boolean().optional(),
          kind: z.string().trim().max(80).optional(),
          from: dateStr.optional(),
          to: dateStr.optional(),
        }),
      ])
      .parse(req.body ?? {});

    if ('ids' in body) {
      const uniqueIds = Array.from(new Set(body.ids));
      const rows = await query(
        `UPDATE user_notifications
            SET deleted_at = now()
          WHERE user_id = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])
          RETURNING id`,
        [auth.id, uniqueIds],
      );
      const ids = rows.map((r: any) => r.id as string);
      await recordNotificationAudit(req, 'DELETE copilot-notification', ids, {
        mode: 'ids',
      });
      return { ok: true, deleted: ids.length };
    }

    if (body.from && body.to && body.from > body.to) {
      throw httpError(400, 'INVALID_DATE_RANGE', '开始日期不能晚于结束日期');
    }
    const rows = await query(
      `UPDATE user_notifications
          SET deleted_at = now()
        WHERE user_id = $1
          AND deleted_at IS NULL
          AND ($2::boolean = false OR read_at IS NULL)
          AND ($3::text IS NULL OR kind = $3)
          AND ($4::date IS NULL OR created_at >= $4::date)
          AND ($5::date IS NULL OR created_at < ($5::date + interval '1 day'))
        RETURNING id`,
      [
        auth.id,
        body.unread ?? false,
        body.kind || null,
        body.from ?? null,
        body.to ?? null,
      ],
    );
    const ids = rows.map((r: any) => r.id as string);
    await recordNotificationAudit(req, 'DELETE copilot-notification', ids, {
      mode: 'all',
      filters: {
        unread: body.unread ?? false,
        kind: body.kind ?? null,
        from: body.from ?? null,
        to: body.to ?? null,
      },
    });
    return { ok: true, deleted: ids.length };
  });

  app.post('/api/notifications/restore', async (req) => {
    const auth = currentUser(req);
    const { ids } = z
      .object({ ids: z.array(z.uuid()).min(1).max(100) })
      .parse(req.body ?? {});
    const uniqueIds = Array.from(new Set(ids));
    const rows = await query(
      `UPDATE user_notifications
          SET deleted_at = NULL
        WHERE user_id = $1 AND deleted_at IS NOT NULL AND id = ANY($2::uuid[])
        RETURNING id`,
      [auth.id, uniqueIds],
    );
    const restored = rows.map((r: any) => r.id as string);
    await recordNotificationAudit(req, 'RESTORE copilot-notification', restored, {});
    return { ok: true, restored: restored.length };
  });

  app.post('/api/notifications/purge', async (req) => {
    const auth = currentUser(req);
    const { ids } = z
      .object({ ids: z.array(z.uuid()).min(1).max(100) })
      .parse(req.body ?? {});
    const uniqueIds = Array.from(new Set(ids));
    const rows = await query(
      `DELETE FROM user_notifications
        WHERE user_id = $1 AND deleted_at IS NOT NULL AND id = ANY($2::uuid[])
        RETURNING id`,
      [auth.id, uniqueIds],
    );
    const purged = rows.map((r: any) => r.id as string);
    await recordNotificationAudit(req, 'PURGE copilot-notification', purged, {});
    return { ok: true, deleted: purged.length };
  });

  /** 批量标为已读：按 ID 或按当前筛选。 */
  app.post('/api/notifications/read', async (req) => {
    const auth = currentUser(req);
    const body = z
      .union([
        z.object({ ids: z.array(z.uuid()).min(1).max(100) }),
        z.object({
          all: z.literal(true),
          kind: z.string().trim().max(80).optional(),
          from: dateStr.optional(),
          to: dateStr.optional(),
        }),
      ])
      .parse(req.body ?? {});

    if ('ids' in body) {
      const uniqueIds = Array.from(new Set(body.ids));
      const rows = await query(
        `UPDATE user_notifications
            SET read_at = now()
          WHERE user_id = $1
            AND deleted_at IS NULL
            AND read_at IS NULL
            AND id = ANY($2::uuid[])
          RETURNING id`,
        [auth.id, uniqueIds],
      );
      return { ok: true, updated: rows.length };
    }

    if (body.from && body.to && body.from > body.to) {
      throw httpError(400, 'INVALID_DATE_RANGE', '开始日期不能晚于结束日期');
    }
    const rows = await query(
      `UPDATE user_notifications
          SET read_at = now()
        WHERE user_id = $1
          AND deleted_at IS NULL
          AND read_at IS NULL
          AND ($2::text IS NULL OR kind = $2)
          AND ($3::date IS NULL OR created_at >= $3::date)
          AND ($4::date IS NULL OR created_at < ($4::date + interval '1 day'))
        RETURNING id`,
      [auth.id, body.kind || null, body.from ?? null, body.to ?? null],
    );
    return { ok: true, updated: rows.length };
  });

  const savedViewBody = z.object({
    name: z.string().trim().min(1).max(80),
    kind: z.string().trim().max(80).nullable().optional(),
    unread: z.boolean().optional(),
    from: dateStr.nullable().optional(),
    to: dateStr.nullable().optional(),
    scope: z.enum(['inbox', 'trash']).optional(),
    shared: z.boolean().optional(),
    shared_role: z
      .enum(['admin', 'director', 'pm', 'consultant', 'tech_lead'])
      .nullable()
      .optional(),
  });

  /** 当前用户保存的通知筛选视图。 */
  app.get('/api/notification-filter-views', async (req) => {
    const auth = (req as any).authUser;
    const items = await query(
      `SELECT v.id, v.name, v.kind, v.unread,
              v.from_date::text AS "from", v.to_date::text AS "to",
              v.scope, v.shared, v.shared_role, (v.user_id = $1) AS is_owner,
              u.name AS owner_name, v.created_at, v.updated_at
         FROM notification_filter_views v
         LEFT JOIN users u ON u.id = v.user_id
        WHERE v.user_id = $1
           OR v.shared
           OR v.shared_role = $2
        ORDER BY v.name`,
      [auth.sub, auth.role ?? ''],
    );
    return { items };
  });

  app.post('/api/notification-filter-views', async (req, reply) => {
    const auth = (req as any).authUser;
    if (!auth?.sub || !auth.org_id) {
      throw httpError(401, 'UNAUTHORIZED', '请先登录');
    }
    const body = savedViewBody.parse(req.body ?? {});
    if (body.from && body.to && body.from > body.to) {
      throw httpError(400, 'INVALID_DATE_RANGE', '开始日期不能晚于结束日期');
    }
    const item = await one(
      `INSERT INTO notification_filter_views
         (org_id, user_id, name, kind, unread, from_date, to_date, scope,
          shared, shared_role)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (user_id, name)
       DO UPDATE SET kind = EXCLUDED.kind,
                     unread = EXCLUDED.unread,
                     from_date = EXCLUDED.from_date,
                     to_date = EXCLUDED.to_date,
                     scope = EXCLUDED.scope,
                     shared = EXCLUDED.shared,
                     shared_role = EXCLUDED.shared_role,
                     updated_at = now()
       RETURNING id, name, kind, unread,
                 from_date::text AS "from", to_date::text AS "to",
                 scope, shared, shared_role, true AS is_owner,
                 (SELECT name FROM users WHERE id = user_id) AS owner_name,
                 created_at, updated_at`,
      [
        auth.org_id,
        auth.sub,
        body.name,
        body.kind || null,
        body.unread ?? false,
        body.from ?? null,
        body.to ?? null,
        body.scope ?? 'inbox',
        body.shared ?? false,
        body.shared_role ?? null,
      ],
    );
    return reply.code(201).send({ item });
  });

  app.delete('/api/notification-filter-views/:id', async (req) => {
    const auth = currentUser(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const row = await one(
      `DELETE FROM notification_filter_views
        WHERE id = $1 AND user_id = $2
        RETURNING id`,
      [id, auth.id],
    );
    if (!row) throw httpError(404, 'NOT_FOUND', '筛选视图不存在');
    return { ok: true };
  });

  app.post('/api/notifications/read-all', async (req) => {
    const auth = currentUser(req);
    const rows = await query(
      `UPDATE user_notifications
          SET read_at = now()
        WHERE user_id = $1 AND read_at IS NULL AND deleted_at IS NULL
        RETURNING id`,
      [auth.id],
    );
    return { ok: true, updated: rows.length };
  });

  app.post('/api/notifications/:id/read', async (req) => {
    const auth = currentUser(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const row = await one(
      `UPDATE user_notifications
          SET read_at = COALESCE(read_at, now())
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
        RETURNING id`,
      [id, auth.id],
    );
    if (!row) throw httpError(404, 'NOT_FOUND', '通知不存在');
    return { ok: true };
  });
}
