import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db';
import { httpError } from '../services/s1';
import { csvCell } from '../services/csv';
import { collabAuditRetentionDays } from '../services/collab_audit_archive';
import {
  localDateInTimezone,
  resolveOrgTimezone,
} from '../services/collab_audit_snapshot';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const NOTIFICATION_ACTIONS = [
  'DELETE copilot-notification',
  'RESTORE copilot-notification',
  'PURGE copilot-notification',
] as const;
const VIEW_ACTIONS = [
  'SAVE copilot-batch-filter-view',
  'DELETE copilot-batch-filter-view',
] as const;
const EXPORT_ACTIONS = [
  'EXPORT copilot-notification-audits',
  'EXPORT copilot-collab-audits',
  'EXPORT copilot-batch-filter-view-audits',
  'EXPORT copilot-collab-merged',
  'EXPORT copilot-collab-archive',
] as const;
const DECISION_ACTIONS = ['DECIDE copilot-reconcile-difference'] as const;
const ACTION_VALUES = [
  ...NOTIFICATION_ACTIONS,
  ...VIEW_ACTIONS,
  ...EXPORT_ACTIONS,
  ...DECISION_ACTIONS,
] as const;
const TYPE_VALUES = [
  'all',
  'notification',
  'filter_view',
  'export',
  'decision',
] as const;

const ACTION_LABEL: Record<string, string> = {
  'DELETE copilot-notification': '删除通知',
  'RESTORE copilot-notification': '恢复通知',
  'PURGE copilot-notification': '彻底删除通知',
  'SAVE copilot-batch-filter-view': '保存筛选视图',
  'DELETE copilot-batch-filter-view': '删除筛选视图',
  'EXPORT copilot-notification-audits': '导出通知审计',
  'EXPORT copilot-collab-audits': '导出协作审计',
  'EXPORT copilot-batch-filter-view-audits': '导出视图审计',
  'EXPORT copilot-collab-merged': '导出合并审计',
  'EXPORT copilot-collab-archive': '导出归档审计',
  'DECIDE copilot-reconcile-difference': '差异决策',
};

const TYPE_LABEL: Record<string, string> = {
  notification: '通知',
  filter_view: '筛选视图',
  export: '导出',
  decision: '决策',
};

const EXPORT_ACTION_SQL =
  "('EXPORT copilot-notification-audits','EXPORT copilot-collab-audits','EXPORT copilot-batch-filter-view-audits','EXPORT copilot-collab-merged','EXPORT copilot-collab-archive')";

function collabCondition(
  type: (typeof TYPE_VALUES)[number],
  alias = 'a',
): string {
  if (type === 'notification') return `${alias}.object_type = 'user_notification'`;
  if (type === 'filter_view') return `${alias}.object_type = 'copilot_batch_filter_view'`;
  if (type === 'export') return `${alias}.action IN ${EXPORT_ACTION_SQL}`;
  if (type === 'decision') return `${alias}.action = 'DECIDE copilot-reconcile-difference'`;
  return `(${alias}.object_type IN ('user_notification','copilot_batch_filter_view') OR ${alias}.action IN ${EXPORT_ACTION_SQL} OR ${alias}.action = 'DECIDE copilot-reconcile-difference')`;
}

function allowedActionsFor(type: (typeof TYPE_VALUES)[number]): readonly string[] {
  if (type === 'notification') return NOTIFICATION_ACTIONS;
  if (type === 'filter_view') return VIEW_ACTIONS;
  if (type === 'export') return EXPORT_ACTIONS;
  if (type === 'decision') return DECISION_ACTIONS;
  return ACTION_VALUES;
}

function assertActionForType(
  type: (typeof TYPE_VALUES)[number],
  action: string | undefined,
): void {
  if (!action) return;
  if (!allowedActionsFor(type).includes(action)) {
    throw httpError(400, 'INVALID_ACTION_TYPE', '操作类型与审计类型不匹配');
  }
}

function assertAuditViewer(req: any): void {
  const auth = req.authUser;
  if (
    !auth ||
    !(auth.platform_admin || ['admin', 'director'].includes(auth.role))
  ) {
    throw httpError(403, 'FORBIDDEN', '仅管理员/总监可查看协作审计');
  }
}

async function recordCollabExportAudit(
  req: any,
  action: string,
  detail: Record<string, unknown>,
  objectType = 'collab_audit',
): Promise<void> {
  const auth = req.authUser;
  try {
    await query(
      `INSERT INTO audit_logs
         (org_id, user_id, action, object_type, status_code,
          ip, user_agent, request_id, detail)
       VALUES ($1,$2,$3,$7,200,$4,$5,$6,$8::jsonb)`,
      [
        auth?.org_id ?? null,
        auth?.sub ?? null,
        action,
        req.ip,
        String(req.headers['user-agent'] ?? '').slice(0, 500),
        req.id,
        JSON.stringify(detail),
        objectType,
      ],
    );
  } catch (err) {
    req.log?.warn?.({ err }, 'collab audit export audit failed');
  }
}

async function loadSnapshotSeries(
  orgId: string,
  days: number,
  endDate: string,
): Promise<any[]> {
  return query(
    `WITH days AS (
       SELECT generate_series(
         $3::date - ($2::int - 1) * interval '1 day',
         $3::date,
         interval '1 day'
       )::date AS day
     ),
     filled AS (
       SELECT d.day,
              COALESCE(s.total, 0) AS total,
              COALESCE(s.notification_count, 0) AS notification_count,
              COALESCE(s.filter_view_count, 0) AS filter_view_count,
              COALESCE(s.export_count, 0) AS export_count,
              COALESCE(s.decision_count, 0) AS decision_count
         FROM days d
         LEFT JOIN LATERAL (
           SELECT total, notification_count, filter_view_count,
                  export_count, decision_count
             FROM collab_audit_snapshots
            WHERE org_id = $1 AND snapshot_date <= d.day
            ORDER BY snapshot_date DESC
            LIMIT 1
         ) s ON true
     ),
     ranked AS (
       SELECT *,
              LAG(total) OVER (ORDER BY day) AS prev_total,
              LAG(notification_count) OVER (ORDER BY day) AS prev_notification,
              LAG(filter_view_count) OVER (ORDER BY day) AS prev_filter_view,
              LAG(export_count) OVER (ORDER BY day) AS prev_export,
              LAG(decision_count) OVER (ORDER BY day) AS prev_decision
         FROM filled
     )
     SELECT day::text AS snapshot_date,
            total, notification_count, filter_view_count, export_count,
            decision_count,
            GREATEST(total - COALESCE(prev_total, total), 0) AS delta_total,
            GREATEST(notification_count - COALESCE(prev_notification, notification_count), 0) AS delta_notification,
            GREATEST(filter_view_count - COALESCE(prev_filter_view, filter_view_count), 0) AS delta_filter_view,
            GREATEST(export_count - COALESCE(prev_export, export_count), 0) AS delta_export,
            GREATEST(decision_count - COALESCE(prev_decision, decision_count), 0) AS delta_decision
       FROM ranked
      ORDER BY day DESC`,
    [orgId, days, endDate],
  );
}

type SnapshotBucket = 'day' | 'week' | 'month';

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400000);
}

function aggregateSnapshotRows(rows: any[], bucket: SnapshotBucket): any[] {
  if (bucket === 'day') {
    return rows.map((row) => ({
      ...row,
      period_start: row.snapshot_date,
      period_end: row.snapshot_date,
    }));
  }

  const ascending = [...rows].reverse();
  const buckets = new Map<string, any>();
  for (const row of ascending) {
    const day = new Date(`${row.snapshot_date}T00:00:00Z`);
    let key: string;
    let start: string;
    let end: string;
    if (bucket === 'week') {
      const offset = (day.getUTCDay() + 6) % 7;
      const monday = addDays(day, -offset);
      const sunday = addDays(monday, 6);
      key = isoDate(monday);
      start = key;
      end = isoDate(sunday);
    } else {
      key = `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, '0')}`;
      start = `${key}-01`;
      const last = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0));
      end = isoDate(last);
    }
    const current = buckets.get(key) ?? {
      snapshot_date: key,
      period_start: start,
      period_end: end,
      total: 0,
      notification_count: 0,
      filter_view_count: 0,
      export_count: 0,
      decision_count: 0,
      delta_total: 0,
      delta_notification: 0,
      delta_filter_view: 0,
      delta_export: 0,
      delta_decision: 0,
    };
    current.total = row.total;
    current.notification_count = row.notification_count;
    current.filter_view_count = row.filter_view_count;
    current.export_count = row.export_count;
    current.decision_count = row.decision_count;
    current.delta_total += row.delta_total;
    current.delta_notification += row.delta_notification;
    current.delta_filter_view += row.delta_filter_view;
    current.delta_export += row.delta_export;
    current.delta_decision += row.delta_decision;
    buckets.set(key, current);
  }
  return [...buckets.values()].reverse();
}

function summarizeSnapshotPeriod(items: any[]) {
  if (!items.length) return null;
  const ascending = [...items].reverse();
  const first = ascending[0];
  const last = ascending[ascending.length - 1];
  const sum = (key: string) =>
    ascending.reduce((acc, row) => acc + (Number(row[key]) || 0), 0);
  return {
    start: first.period_start,
    end: last.period_end,
    total: last.total,
    delta_total: sum('delta_total'),
    delta_notification: sum('delta_notification'),
    delta_filter_view: sum('delta_filter_view'),
    delta_export: sum('delta_export'),
    delta_decision: sum('delta_decision'),
  };
}

function compareSnapshotPeriods(current: any[], previous: any[]) {
  const c = summarizeSnapshotPeriod(current);
  const p = summarizeSnapshotPeriod(previous);
  if (!c) return null;
  const change = (key: string) =>
    (c as any)[key] - ((p as any)?.[key] ?? 0);
  return {
    current: c,
    previous: p,
    change: {
      delta_total: change('delta_total'),
      delta_notification: change('delta_notification'),
      delta_filter_view: change('delta_filter_view'),
      delta_export: change('delta_export'),
      delta_decision: change('delta_decision'),
    },
  };
}

async function loadSnapshotComparison(
  orgId: string,
  days: number,
  bucket: SnapshotBucket,
) {
  const endDate = localDateInTimezone(await resolveOrgTimezone(orgId));
  const windowDays = Math.min(days * 2 + 31, 3650);
  const rows = await loadSnapshotSeries(orgId, windowDays, endDate);
  const items = aggregateSnapshotRows(rows.slice(0, days), bucket);
  const allBuckets = aggregateSnapshotRows(rows, bucket);
  const currentKeys = new Set(items.map((item) => item.snapshot_date));
  const previous = allBuckets
    .filter((item) => !currentKeys.has(item.snapshot_date))
    .slice(0, items.length);
  return { items, comparison: compareSnapshotPeriods(items, previous) };
}

export async function collabAuditRoutes(app: FastifyInstance) {
  app.get('/api/collab-audits', async (req) => {
    assertAuditViewer(req);
    const { limit, offset, type, action, from, to, actor_id } = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
        type: z.enum(TYPE_VALUES).default('all'),
        action: z.enum(ACTION_VALUES).optional(),
        from: dateStr.optional(),
        to: dateStr.optional(),
        actor_id: z.uuid().optional(),
      })
      .parse(req.query ?? {});
    if (from && to && from > to) {
      throw httpError(400, 'INVALID_DATE_RANGE', '开始日期不能晚于结束日期');
    }
    assertActionForType(type, action);
    const condition = collabCondition(type);

    const [items, totals] = await Promise.all([
      query<any>(
        `SELECT a.id, a.action, a.user_id, a.object_id, a.request_id,
                a.detail, a.created_at,
                u.name AS actor_name,
                rev.engagement_id,
                CASE WHEN a.object_type = 'user_notification'
                     THEN 'notification'
                     WHEN a.object_type = 'copilot_batch_filter_view'
                     THEN 'filter_view'
                     WHEN a.action = 'DECIDE copilot-reconcile-difference'
                     THEN 'decision'
                     ELSE 'export' END AS audit_type
           FROM audit_logs a
           LEFT JOIN users u ON u.id = a.user_id
           LEFT JOIN copilot_reconcile_reviews rev
             ON a.action = 'DECIDE copilot-reconcile-difference'
            AND rev.id = a.object_id
          WHERE ${condition}
            AND ($2::text IS NULL OR a.action = $2)
            AND ($3::date IS NULL OR a.created_at >= $3::date)
            AND ($4::date IS NULL OR a.created_at < ($4::date + interval '1 day'))
            AND ($5::uuid IS NULL OR a.user_id = $5)
          ORDER BY a.created_at DESC
          LIMIT $1 OFFSET $6`,
        [limit, action ?? null, from ?? null, to ?? null, actor_id ?? null, offset],
      ),
      query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_logs a
          WHERE ${condition}
            AND ($1::text IS NULL OR a.action = $1)
            AND ($2::date IS NULL OR a.created_at >= $2::date)
            AND ($3::date IS NULL OR a.created_at < ($3::date + interval '1 day'))
            AND ($4::uuid IS NULL OR a.user_id = $4)`,
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

  app.get('/api/collab-audits/stats', async (req) => {
    assertAuditViewer(req);
    const { from, to, actor_id, scope } = z
      .object({
        from: dateStr.optional(),
        to: dateStr.optional(),
        actor_id: z.uuid().optional(),
        scope: z.enum(['live', 'archive', 'all']).default('live'),
      })
      .parse(req.query ?? {});
    if (from && to && from > to) {
      throw httpError(400, 'INVALID_DATE_RANGE', '开始日期不能晚于结束日期');
    }
    const condition = collabCondition('all');
    const source =
      scope === 'archive'
        ? 'audit_logs_archive a'
        : scope === 'all'
          ? `(SELECT object_type, action, user_id, created_at FROM audit_logs
              UNION ALL
              SELECT object_type, action, user_id, created_at FROM audit_logs_archive) a`
          : 'audit_logs a';
    const [typeRows, actionRows, actorRows] = await Promise.all([
      query<any>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE object_type = 'user_notification')::text AS notification,
                count(*) FILTER (WHERE object_type = 'copilot_batch_filter_view')::text AS filter_view,
                count(*) FILTER (WHERE action IN ${EXPORT_ACTION_SQL})::text AS export,
                count(*) FILTER (WHERE action = 'DECIDE copilot-reconcile-difference')::text AS decision
           FROM ${source}
          WHERE ${condition}
            AND ($1::date IS NULL OR a.created_at >= $1::date)
            AND ($2::date IS NULL OR a.created_at < ($2::date + interval '1 day'))
            AND ($3::uuid IS NULL OR a.user_id = $3)`,
        [from ?? null, to ?? null, actor_id ?? null],
      ),
      query<{ action: string; count: string }>(
        `SELECT a.action, count(*)::text AS count
           FROM ${source}
          WHERE ${condition}
            AND ($1::date IS NULL OR a.created_at >= $1::date)
            AND ($2::date IS NULL OR a.created_at < ($2::date + interval '1 day'))
            AND ($3::uuid IS NULL OR a.user_id = $3)
          GROUP BY a.action
          ORDER BY count(*) DESC
          LIMIT 10`,
        [from ?? null, to ?? null, actor_id ?? null],
      ),
      query<{ user_id: string | null; actor_name: string | null; count: string }>(
        `SELECT a.user_id, u.name AS actor_name, count(*)::text AS count
           FROM audit_logs a
           LEFT JOIN users u ON u.id = a.user_id
          WHERE ${condition}
            AND ($1::date IS NULL OR a.created_at >= $1::date)
            AND ($2::date IS NULL OR a.created_at < ($2::date + interval '1 day'))
            AND ($3::uuid IS NULL OR a.user_id = $3)
          GROUP BY a.user_id, u.name
          ORDER BY count(*) DESC
          LIMIT 10`,
        [from ?? null, to ?? null, actor_id ?? null],
      ),
    ]);
    return {
      total: Number(typeRows[0]?.total ?? 0),
      by_type: {
        notification: Number(typeRows[0]?.notification ?? 0),
        filter_view: Number(typeRows[0]?.filter_view ?? 0),
        export: Number(typeRows[0]?.export ?? 0),
        decision: Number(typeRows[0]?.decision ?? 0),
      },
      top_actions: actionRows.map((r) => ({
        action: r.action,
        count: Number(r.count),
      })),
      top_actors: actorRows.map((r) => ({
        user_id: r.user_id,
        actor_name: r.actor_name,
        count: Number(r.count),
      })),
      retention_days: collabAuditRetentionDays(),
      scope,
    };
  });

  app.get('/api/collab-audits/merged', async (req) => {
    assertAuditViewer(req);
    const { limit, offset, type, action, from, to, actor_id } = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
        type: z.enum(TYPE_VALUES).default('all'),
        action: z.enum(ACTION_VALUES).optional(),
        from: dateStr.optional(),
        to: dateStr.optional(),
        actor_id: z.uuid().optional(),
      })
      .parse(req.query ?? {});
    if (from && to && from > to) {
      throw httpError(400, 'INVALID_DATE_RANGE', '开始日期不能晚于结束日期');
    }
    assertActionForType(type, action);
    const condition = collabCondition(type);
    const typeCase = `CASE WHEN a.object_type = 'user_notification' THEN 'notification'
                           WHEN a.object_type = 'copilot_batch_filter_view' THEN 'filter_view'
                           WHEN a.action = 'DECIDE copilot-reconcile-difference' THEN 'decision'
                           ELSE 'export' END`;

    const [items, totals] = await Promise.all([
      query<any>(
        `SELECT c.*, u.name AS actor_name, rev.engagement_id
           FROM (
             SELECT a.id, a.action, a.user_id, a.object_id, a.request_id,
                    a.detail, a.created_at,
                    NULL::timestamptz AS archived_at, false AS is_archived,
                    ${typeCase} AS audit_type
               FROM audit_logs a
              WHERE ${condition}
                AND ($2::text IS NULL OR a.action = $2)
                AND ($3::date IS NULL OR a.created_at >= $3::date)
                AND ($4::date IS NULL OR a.created_at < ($4::date + interval '1 day'))
                AND ($5::uuid IS NULL OR a.user_id = $5)
             UNION ALL
             SELECT a.id, a.action, a.user_id, a.object_id, a.request_id,
                    a.detail, a.created_at,
                    a.archived_at, true AS is_archived,
                    ${typeCase} AS audit_type
               FROM audit_logs_archive a
              WHERE ${condition}
                AND ($2::text IS NULL OR a.action = $2)
                AND ($3::date IS NULL OR a.created_at >= $3::date)
                AND ($4::date IS NULL OR a.created_at < ($4::date + interval '1 day'))
                AND ($5::uuid IS NULL OR a.user_id = $5)
           ) c
           LEFT JOIN users u ON u.id = c.user_id
           LEFT JOIN copilot_reconcile_reviews rev
             ON c.action = 'DECIDE copilot-reconcile-difference'
            AND rev.id = c.object_id
          ORDER BY c.created_at DESC
          LIMIT $1 OFFSET $6`,
        [limit, action ?? null, from ?? null, to ?? null, actor_id ?? null, offset],
      ),
      query<{ count: string }>(
        `SELECT (
           (SELECT count(*) FROM audit_logs a
             WHERE ${condition}
               AND ($1::text IS NULL OR a.action = $1)
               AND ($2::date IS NULL OR a.created_at >= $2::date)
               AND ($3::date IS NULL OR a.created_at < ($3::date + interval '1 day'))
               AND ($4::uuid IS NULL OR a.user_id = $4))
           +
           (SELECT count(*) FROM audit_logs_archive a
             WHERE ${condition}
               AND ($1::text IS NULL OR a.action = $1)
               AND ($2::date IS NULL OR a.created_at >= $2::date)
               AND ($3::date IS NULL OR a.created_at < ($3::date + interval '1 day'))
               AND ($4::uuid IS NULL OR a.user_id = $4))
         )::text AS count`,
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

  app.get('/api/collab-audits/archive', async (req) => {
    assertAuditViewer(req);
    const { limit, offset, type, action, from, to, actor_id } = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
        type: z.enum(TYPE_VALUES).default('all'),
        action: z.enum(ACTION_VALUES).optional(),
        from: dateStr.optional(),
        to: dateStr.optional(),
        actor_id: z.uuid().optional(),
      })
      .parse(req.query ?? {});
    if (from && to && from > to) {
      throw httpError(400, 'INVALID_DATE_RANGE', '开始日期不能晚于结束日期');
    }
    assertActionForType(type, action);
    const condition = collabCondition(type);

    const [items, totals, lastRun] = await Promise.all([
      query<any>(
        `SELECT a.id, a.action, a.user_id, a.object_id, a.request_id,
                a.detail, a.created_at, a.archived_at,
                u.name AS actor_name, rev.engagement_id,
                CASE WHEN a.object_type = 'user_notification'
                     THEN 'notification'
                     WHEN a.object_type = 'copilot_batch_filter_view'
                     THEN 'filter_view'
                     WHEN a.action = 'DECIDE copilot-reconcile-difference'
                     THEN 'decision'
                     ELSE 'export' END AS audit_type
           FROM audit_logs_archive a
           LEFT JOIN users u ON u.id = a.user_id
           LEFT JOIN copilot_reconcile_reviews rev
             ON a.action = 'DECIDE copilot-reconcile-difference'
            AND rev.id = a.object_id
          WHERE ${condition}
            AND ($2::text IS NULL OR a.action = $2)
            AND ($3::date IS NULL OR a.created_at >= $3::date)
            AND ($4::date IS NULL OR a.created_at < ($4::date + interval '1 day'))
            AND ($5::uuid IS NULL OR a.user_id = $5)
          ORDER BY a.created_at DESC
          LIMIT $1 OFFSET $6`,
        [limit, action ?? null, from ?? null, to ?? null, actor_id ?? null, offset],
      ),
      query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_logs_archive a
          WHERE ${condition}
            AND ($1::text IS NULL OR a.action = $1)
            AND ($2::date IS NULL OR a.created_at >= $2::date)
            AND ($3::date IS NULL OR a.created_at < ($3::date + interval '1 day'))
            AND ($4::uuid IS NULL OR a.user_id = $4)`,
        [action ?? null, from ?? null, to ?? null, actor_id ?? null],
      ),
      query<any>(
        `SELECT detail, created_at
           FROM audit_logs
          WHERE action = 'ARCHIVE copilot-collab-audits'
          ORDER BY created_at DESC
          LIMIT 1`,
      ),
    ]);

    return {
      items,
      total: Number(totals[0]?.count ?? 0),
      last_archive: lastRun[0]
        ? {
            count: Number(lastRun[0].detail?.count ?? 0),
            days: Number(lastRun[0].detail?.days ?? 0),
            created_at: lastRun[0].created_at,
          }
        : null,
      limit,
      offset,
    };
  });

  app.get('/api/collab-audits/merged/export.csv', async (req, reply) => {
    assertAuditViewer(req);
    const { type, action, from, to, actor_id } = z
      .object({
        type: z.enum(TYPE_VALUES).default('all'),
        action: z.enum(ACTION_VALUES).optional(),
        from: dateStr.optional(),
        to: dateStr.optional(),
        actor_id: z.uuid().optional(),
      })
      .parse(req.query ?? {});
    if (from && to && from > to) {
      throw httpError(400, 'INVALID_DATE_RANGE', '开始日期不能晚于结束日期');
    }
    assertActionForType(type, action);
    const condition = collabCondition(type);
    const typeCase = `CASE WHEN a.object_type = 'user_notification' THEN 'notification'
                           WHEN a.object_type = 'copilot_batch_filter_view' THEN 'filter_view'
                           WHEN a.action = 'DECIDE copilot-reconcile-difference' THEN 'decision'
                           ELSE 'export' END`;
    const rows = await query<any>(
      `SELECT c.*, u.name AS actor_name
         FROM (
           SELECT a.id, a.action, a.user_id, a.detail, a.created_at,
                  NULL::timestamptz AS archived_at, false AS is_archived,
                  ${typeCase} AS audit_type
             FROM audit_logs a
            WHERE ${condition}
              AND ($1::text IS NULL OR a.action = $1)
              AND ($2::date IS NULL OR a.created_at >= $2::date)
              AND ($3::date IS NULL OR a.created_at < ($3::date + interval '1 day'))
              AND ($4::uuid IS NULL OR a.user_id = $4)
           UNION ALL
           SELECT a.id, a.action, a.user_id, a.detail, a.created_at,
                  a.archived_at, true AS is_archived,
                  ${typeCase} AS audit_type
             FROM audit_logs_archive a
            WHERE ${condition}
              AND ($1::text IS NULL OR a.action = $1)
              AND ($2::date IS NULL OR a.created_at >= $2::date)
              AND ($3::date IS NULL OR a.created_at < ($3::date + interval '1 day'))
              AND ($4::uuid IS NULL OR a.user_id = $4)
         ) c
         LEFT JOIN users u ON u.id = c.user_id
        ORDER BY c.created_at DESC
        LIMIT 5000`,
      [action ?? null, from ?? null, to ?? null, actor_id ?? null],
    );

    const header = [
      '时间', '位置', '类型', '操作', '操作人', '数量/对象', '详情', '归档时间',
    ];
    const lines = [header.join(',')];
    for (const row of rows) {
      const detail = row.detail ?? {};
      const isNotification = row.audit_type === 'notification';
      const isExport = row.audit_type === 'export';
      const isDecision = row.audit_type === 'decision';
      const filters = detail.filters ?? {};
      const detailText = isExport
        ? [
            filters.type ? `类型 ${filters.type}` : '',
            filters.action ? `操作 ${filters.action}` : '',
            filters.from ? `从 ${filters.from}` : '',
            filters.to ? `到 ${filters.to}` : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : isNotification
          ? [
              detail.mode === 'all' ? '按筛选' : '按 ID',
              filters.unread ? '仅未读' : '',
              filters.kind ? `类型 ${filters.kind}` : '',
              filters.from ? `从 ${filters.from}` : '',
              filters.to ? `到 ${filters.to}` : '',
            ]
              .filter(Boolean)
              .join(' · ')
          : isDecision
            ? [
                detail.difference_id ? `差异 ${detail.difference_id}` : '',
                detail.decision ? `决策 ${detail.decision}` : '',
                detail.mode === 'batch' ? `批量 ${detail.count ?? 0} 条` : '',
                detail.note ? `备注 ${detail.note}` : '',
              ]
                .filter(Boolean)
                .join(' · ')
            : [
                detail.shared ? '全员' : '',
                detail.shared_role ? `角色 ${detail.shared_role}` : '',
                Array.isArray(detail.shared_user_ids) && detail.shared_user_ids.length
                  ? `指定 ${detail.shared_user_ids.length} 人`
                  : '',
              ]
                .filter(Boolean)
                .join(' · ');
      lines.push(
        [
          row.created_at ? new Date(row.created_at).toISOString() : '',
          row.is_archived ? '归档' : '热表',
          TYPE_LABEL[row.audit_type] ?? row.audit_type,
          ACTION_LABEL[row.action] ?? row.action,
          row.actor_name,
          isExport
            ? detail.rows ?? ''
            : isDecision
              ? detail.mode === 'batch'
                ? detail.count ?? 0
                : 1
              : detail.count ?? '',
          isExport
            ? '导出'
            : isNotification
              ? detail.mode === 'all'
                ? '按筛选'
                : '按 ID'
              : isDecision
                ? detail.difference_id ?? ''
                : detail.name,
          detailText,
          row.archived_at ? new Date(row.archived_at).toISOString() : '',
        ]
          .map(csvCell)
          .join(','),
      );
    }

    await recordCollabExportAudit(req, 'EXPORT copilot-collab-merged', {
      rows: rows.length,
      filters: {
        type,
        action: action ?? null,
        from: from ?? null,
        to: to ?? null,
        actor_id: actor_id ?? null,
      },
    });

    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header(
        'content-disposition',
        'attachment; filename="collab-merged-audits.csv"',
      )
      .send(`\uFEFF${lines.join('\r\n')}`);
  });

  app.get('/api/collab-audits/snapshots', async (req) => {
    assertAuditViewer(req);
    const auth = (req as any).authUser;
    const { days, bucket } = z
      .object({
        days: z.coerce.number().int().min(1).max(365).default(30),
        bucket: z.enum(['day', 'week', 'month']).default('day'),
      })
      .parse(req.query ?? {});

    const { items, comparison } = await loadSnapshotComparison(
      auth.org_id,
      days,
      bucket,
    );
    return { items, bucket, comparison, total: days, limit: days, offset: 0 };
  });

  app.get('/api/collab-audits/snapshots/export.csv', async (req, reply) => {
    assertAuditViewer(req);
    const auth = (req as any).authUser;
    const { days, bucket } = z
      .object({
        days: z.coerce.number().int().min(1).max(365).default(30),
        bucket: z.enum(['day', 'week', 'month']).default('day'),
      })
      .parse(req.query ?? {});
    const endDate = localDateInTimezone(await resolveOrgTimezone(auth.org_id));
    const rows = aggregateSnapshotRows(
      await loadSnapshotSeries(auth.org_id, days, endDate),
      bucket,
    );

    const header = [
      '周期',
      '总数',
      '新增',
      '通知',
      '新增通知',
      '筛选视图',
      '新增筛选视图',
      '导出',
      '新增导出',
      '决策',
      '新增决策',
    ];
    const lines = [header.join(',')];
    for (const row of rows) {
      lines.push(
        [
          `${row.period_start} ~ ${row.period_end}`,
          row.total,
          row.delta_total,
          row.notification_count,
          row.delta_notification,
          row.filter_view_count,
          row.delta_filter_view,
          row.export_count,
          row.delta_export,
          row.decision_count,
          row.delta_decision,
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
         VALUES ($1,$2,'EXPORT copilot-collab-snapshots','collab_audit_snapshot',200,$3,$4,$5,$6::jsonb)`,
        [
          auth?.org_id ?? null,
          auth?.sub ?? null,
          req.ip,
          String(req.headers['user-agent'] ?? '').slice(0, 500),
          req.id,
          JSON.stringify({ rows: rows.length, days }),
        ],
      );
    } catch (err) {
      req.log?.warn?.({ err }, 'snapshot export audit failed');
    }

    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="collab-snapshots.csv"')
      .send(`\uFEFF${lines.join('\r\n')}`);
  });

  app.get('/api/collab-audits/snapshots/comparison/export.csv', async (req, reply) => {
    assertAuditViewer(req);
    const auth = (req as any).authUser;
    const { days, bucket } = z
      .object({
        days: z.coerce.number().int().min(1).max(365).default(30),
        bucket: z.enum(['day', 'week', 'month']).default('day'),
      })
      .parse(req.query ?? {});
    const { comparison } = await loadSnapshotComparison(
      auth.org_id,
      days,
      bucket,
    );
    const current = comparison?.current;
    const previous = comparison?.previous ?? null;
    const change = comparison?.change;

    const header = [
      '指标',
      '本周期区间',
      '上周期区间',
      '本周期新增',
      '上周期新增',
      '环比',
    ];
    const lines = [header.join(',')];
    type DeltaKey =
      | 'delta_total'
      | 'delta_notification'
      | 'delta_filter_view'
      | 'delta_export'
      | 'delta_decision';
    const rows: Array<[string, DeltaKey]> = [
      ['总数', 'delta_total'],
      ['通知', 'delta_notification'],
      ['筛选视图', 'delta_filter_view'],
      ['导出', 'delta_export'],
      ['决策', 'delta_decision'],
    ];
    for (const [label, key] of rows) {
      lines.push(
        [
          label,
          current ? `${current.start} ~ ${current.end}` : '',
          previous ? `${previous.start} ~ ${previous.end}` : '无数据',
          current ? current[key] : 0,
          previous ? previous[key] : 0,
          change ? change[key] : 0,
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
         VALUES ($1,$2,'EXPORT copilot-collab-snapshots','collab_audit_snapshot',200,$3,$4,$5,$6::jsonb)`,
        [
          auth?.org_id ?? null,
          auth?.sub ?? null,
          req.ip,
          String(req.headers['user-agent'] ?? '').slice(0, 500),
          req.id,
          JSON.stringify({ kind: 'comparison', days, bucket, rows: rows.length }),
        ],
      );
    } catch (err) {
      req.log?.warn?.({ err }, 'snapshot comparison export audit failed');
    }

    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header(
        'content-disposition',
        'attachment; filename="collab-snapshot-comparison.csv"',
      )
      .send(`\uFEFF${lines.join('\r\n')}`);
  });

  app.get('/api/collab-audits/archive-runs', async (req) => {
    assertAuditViewer(req);
    const { limit, offset, from, to } = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
        from: dateStr.optional(),
        to: dateStr.optional(),
      })
      .parse(req.query ?? {});
    if (from && to && from > to) {
      throw httpError(400, 'INVALID_DATE_RANGE', '开始日期不能晚于结束日期');
    }
    const [items, totals] = await Promise.all([
      query<any>(
        `SELECT id, detail, created_at
           FROM audit_logs
          WHERE action = 'ARCHIVE copilot-collab-audits'
            AND ($3::date IS NULL OR created_at >= $3::date)
            AND ($4::date IS NULL OR created_at < ($4::date + interval '1 day'))
          ORDER BY created_at DESC
          LIMIT $1 OFFSET $2`,
        [limit, offset, from ?? null, to ?? null],
      ),
      query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_logs
          WHERE action = 'ARCHIVE copilot-collab-audits'
            AND ($1::date IS NULL OR created_at >= $1::date)
            AND ($2::date IS NULL OR created_at < ($2::date + interval '1 day'))`,
        [from ?? null, to ?? null],
      ),
    ]);
    return {
      items: items.map((row) => ({
        id: row.id,
        count: Number(row.detail?.count ?? 0),
        days: Number(row.detail?.days ?? 0),
        created_at: row.created_at,
      })),
      total: Number(totals[0]?.count ?? 0),
      limit,
      offset,
    };
  });

  app.get('/api/collab-audits/archive/export.csv', async (req, reply) => {
    assertAuditViewer(req);
    const { type, action, from, to, actor_id } = z
      .object({
        type: z.enum(TYPE_VALUES).default('all'),
        action: z.enum(ACTION_VALUES).optional(),
        from: dateStr.optional(),
        to: dateStr.optional(),
        actor_id: z.uuid().optional(),
      })
      .parse(req.query ?? {});
    if (from && to && from > to) {
      throw httpError(400, 'INVALID_DATE_RANGE', '开始日期不能晚于结束日期');
    }
    assertActionForType(type, action);
    const condition = collabCondition(type);
    const rows = await query<any>(
      `SELECT a.id, a.action, a.detail, a.created_at, a.archived_at,
              u.name AS actor_name,
              CASE WHEN a.object_type = 'user_notification'
                   THEN 'notification'
                   WHEN a.object_type = 'copilot_batch_filter_view'
                   THEN 'filter_view'
                   WHEN a.action = 'DECIDE copilot-reconcile-difference'
                   THEN 'decision'
                   ELSE 'export' END AS audit_type
         FROM audit_logs_archive a
         LEFT JOIN users u ON u.id = a.user_id
        WHERE ${condition}
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
      '类型',
      '操作',
      '操作人',
      '数量/对象',
      '详情',
      '归档时间',
    ];
    const lines = [header.join(',')];
    for (const row of rows) {
      const detail = row.detail ?? {};
      const isNotification = row.audit_type === 'notification';
      const isExport = row.audit_type === 'export';
      const isDecision = row.audit_type === 'decision';
      const filters = detail.filters ?? {};
      const detailText = isExport
        ? [
            filters.type ? `类型 ${filters.type}` : '',
            filters.action ? `操作 ${filters.action}` : '',
            filters.from ? `从 ${filters.from}` : '',
            filters.to ? `到 ${filters.to}` : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : isNotification
          ? [
              detail.mode === 'all' ? '按筛选' : '按 ID',
              filters.unread ? '仅未读' : '',
              filters.kind ? `类型 ${filters.kind}` : '',
              filters.from ? `从 ${filters.from}` : '',
              filters.to ? `到 ${filters.to}` : '',
            ]
              .filter(Boolean)
              .join(' · ')
          : isDecision
            ? [
                detail.difference_id ? `差异 ${detail.difference_id}` : '',
                detail.decision ? `决策 ${detail.decision}` : '',
                detail.mode === 'batch' ? `批量 ${detail.count ?? 0} 条` : '',
                detail.note ? `备注 ${detail.note}` : '',
              ]
                .filter(Boolean)
                .join(' · ')
            : [
                detail.shared ? '全员' : '',
                detail.shared_role ? `角色 ${detail.shared_role}` : '',
                Array.isArray(detail.shared_user_ids) && detail.shared_user_ids.length
                  ? `指定 ${detail.shared_user_ids.length} 人`
                  : '',
              ]
                .filter(Boolean)
                .join(' · ');
      lines.push(
        [
          row.created_at ? new Date(row.created_at).toISOString() : '',
          TYPE_LABEL[row.audit_type] ?? row.audit_type,
          ACTION_LABEL[row.action] ?? row.action,
          row.actor_name,
          isExport
            ? detail.rows ?? ''
            : isDecision
              ? detail.mode === 'batch'
                ? detail.count ?? 0
                : 1
              : detail.count ?? '',
          isExport
            ? '导出'
            : isNotification
              ? detail.mode === 'all'
                ? '按筛选'
                : '按 ID'
              : isDecision
                ? detail.difference_id ?? ''
                : detail.name,
          detailText,
          row.archived_at ? new Date(row.archived_at).toISOString() : '',
        ]
          .map(csvCell)
          .join(','),
      );
    }

    await recordCollabExportAudit(
      req,
      'EXPORT copilot-collab-archive',
      {
        rows: rows.length,
        filters: {
          type,
          action: action ?? null,
          from: from ?? null,
          to: to ?? null,
          actor_id: actor_id ?? null,
        },
      },
      'collab_audit_archive',
    );

    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header(
        'content-disposition',
        'attachment; filename="collab-archive-audits.csv"',
      )
      .send(`\uFEFF${lines.join('\r\n')}`);
  });

  app.get('/api/collab-audits/export.csv', async (req, reply) => {
    assertAuditViewer(req);
    const { type, action, from, to, actor_id } = z
      .object({
        type: z.enum(TYPE_VALUES).default('all'),
        action: z.enum(ACTION_VALUES).optional(),
        from: dateStr.optional(),
        to: dateStr.optional(),
        actor_id: z.uuid().optional(),
      })
      .parse(req.query ?? {});
    if (from && to && from > to) {
      throw httpError(400, 'INVALID_DATE_RANGE', '开始日期不能晚于结束日期');
    }
    assertActionForType(type, action);
    const condition = collabCondition(type);
    const rows = await query<any>(
      `SELECT a.id, a.action, a.detail, a.created_at,
              u.name AS actor_name,
              CASE WHEN a.object_type = 'user_notification'
                   THEN 'notification'
                   WHEN a.object_type = 'copilot_batch_filter_view'
                   THEN 'filter_view'
                   WHEN a.action = 'DECIDE copilot-reconcile-difference'
                   THEN 'decision'
                   ELSE 'export' END AS audit_type
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.user_id
        WHERE ${condition}
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
      '类型',
      '操作',
      '操作人',
      '数量',
      '对象/模式',
      '详情',
    ];
    const lines = [header.join(',')];
    for (const row of rows) {
      const detail = row.detail ?? {};
      const isNotification = row.audit_type === 'notification';
      const isExport = row.audit_type === 'export';
      const isDecision = row.audit_type === 'decision';
      const filters = detail.filters ?? {};
      const filterText = isExport
        ? [
            filters.type ? `类型 ${filters.type}` : '',
            filters.action ? `操作 ${filters.action}` : '',
            filters.from ? `从 ${filters.from}` : '',
            filters.to ? `到 ${filters.to}` : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : isNotification
        ? [
            detail.mode === 'all' ? '按筛选' : '按 ID',
            filters.unread ? '仅未读' : '',
            filters.kind ? `类型 ${filters.kind}` : '',
            filters.from ? `从 ${filters.from}` : '',
            filters.to ? `到 ${filters.to}` : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : [
            detail.name ?? '',
            detail.shared ? '全员' : '',
            detail.shared_role ? `角色 ${detail.shared_role}` : '',
            Array.isArray(detail.shared_user_ids) && detail.shared_user_ids.length
              ? `指定 ${detail.shared_user_ids.length} 人`
              : '',
          ]
            .filter(Boolean)
            .join(' · ');
      lines.push(
        [
          row.created_at ? new Date(row.created_at).toISOString() : '',
          TYPE_LABEL[row.audit_type] ?? row.audit_type,
          ACTION_LABEL[row.action] ?? row.action,
          row.actor_name,
          isExport
            ? detail.rows ?? ''
            : isDecision
              ? detail.mode === 'batch'
                ? detail.count ?? 0
                : 1
              : detail.count ?? '',
          isExport
            ? '导出'
            : isNotification
              ? detail.mode === 'all'
                ? '按筛选'
                : '按 ID'
              : isDecision
                ? detail.difference_id ?? ''
                : detail.name,
          filterText,
        ]
          .map(csvCell)
          .join(','),
      );
    }

    await recordCollabExportAudit(req, 'EXPORT copilot-collab-audits', {
      rows: rows.length,
      filters: { type, action: action ?? null, from: from ?? null, to: to ?? null, actor_id: actor_id ?? null },
    });

    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="collab-audits.csv"')
      .send(`\uFEFF${lines.join('\r\n')}`);
  });
}
