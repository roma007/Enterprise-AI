import { query, withTransaction } from '../db';

const EXPORT_ACTION_SQL =
  "('EXPORT copilot-notification-audits','EXPORT copilot-collab-audits','EXPORT copilot-batch-filter-view-audits','EXPORT copilot-collab-merged','EXPORT copilot-collab-archive')";

const DECISION_ACTION = 'DECIDE copilot-reconcile-difference';

/** 协作审计口径：通知、筛选视图、协作审计导出、差异决策。热表与归档表通用。 */
export function collabAuditFilterSql(alias: string): string {
  return `(${alias}.object_type IN ('user_notification','copilot_batch_filter_view')
    OR ${alias}.action IN ${EXPORT_ACTION_SQL}
    OR ${alias}.action = '${DECISION_ACTION}')`;
}

/** IANA 时区是否可用；用 Intl 校验，避免每次请求扫 pg_timezone_names。 */
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** 指定时区下的本地日期（YYYY-MM-DD）。 */
export function localDateInTimezone(
  timezone: string,
  now: Date = new Date(),
): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** 解析组织时区；缺失或非法时回退 Asia/Shanghai。 */
export async function resolveOrgTimezone(orgId: string): Promise<string> {
  const rows = await query<{ timezone: string }>(
    `SELECT COALESCE(NULLIF(settings->>'timezone', ''), 'Asia/Shanghai') AS timezone
       FROM organizations WHERE id = $1`,
    [orgId],
  );
  const candidate = (rows[0]?.timezone ?? 'Asia/Shanghai').trim();
  return isValidTimezone(candidate) ? candidate : 'Asia/Shanghai';
}

/** 快照间隔（秒），默认 86400，0 关闭。 */
export function collabSnapshotIntervalSeconds(): number {
  const raw = Number(process.env.COLLAB_AUDIT_SNAPSHOT_INTERVAL_SECONDS ?? 86400);
  if (!Number.isFinite(raw)) return 86400;
  return Math.min(86400, Math.max(0, Math.floor(raw)));
}

/** 快照保留天数，默认 365，限制 1–3650。 */
export function collabSnapshotRetentionDays(): number {
  const raw = Number(process.env.COLLAB_AUDIT_SNAPSHOT_RETENTION_DAYS ?? 365);
  if (!Number.isFinite(raw)) return 365;
  return Math.min(3650, Math.max(1, Math.floor(raw)));
}

/** 清理超过保留期的快照。 */
export async function cleanupCollabSnapshots(): Promise<number> {
  const days = collabSnapshotRetentionDays();
  const rows = await query<{ id: string }>(
    `DELETE FROM collab_audit_snapshots
      WHERE snapshot_date < current_date - make_interval(days => $1)
      RETURNING id`,
    [days],
  );
  if (rows.length) {
    try {
      await query(
        `INSERT INTO audit_logs
           (org_id, user_id, action, object_type, status_code, detail)
         VALUES (NULL, NULL, 'CLEANUP copilot-collab-snapshots',
                 'collab_audit_snapshot', 200, $1::jsonb)`,
        [JSON.stringify({ count: rows.length, days })],
      );
    } catch {
      // 清理审计失败不影响清理本身
    }
  }
  return rows.length;
}

/** 按组织时区重算历史快照日期；同一天只保留最新一条。 */
export async function retimeCollabSnapshots(orgId: string): Promise<number> {
  const tz = await resolveOrgTimezone(orgId);

  return withTransaction(async (client) => {
    await client.query(
      `CREATE TEMP TABLE tmp_collab_snapshots ON COMMIT DROP AS
       SELECT DISTINCT ON (new_date)
              new_date, total, notification_count, filter_view_count,
              export_count, decision_count, created_at
         FROM (
           SELECT (created_at AT TIME ZONE $2)::date AS new_date,
                  total, notification_count, filter_view_count,
                  export_count, decision_count, created_at
             FROM collab_audit_snapshots
            WHERE org_id = $1
         ) x
        ORDER BY new_date, created_at DESC`,
      [orgId, tz],
    );
    await client.query(`DELETE FROM collab_audit_snapshots WHERE org_id = $1`, [
      orgId,
    ]);
    await client.query(
      `INSERT INTO collab_audit_snapshots
         (org_id, snapshot_date, total, notification_count, filter_view_count,
          export_count, decision_count, created_at)
       SELECT $1, new_date, total, notification_count, filter_view_count,
              export_count, decision_count, created_at
         FROM tmp_collab_snapshots`,
      [orgId],
    );
    const result = await client.query(`SELECT count(*)::int AS count FROM tmp_collab_snapshots`);
    return Number(result.rows[0]?.count ?? 0);
  });
}

/** 写入/更新今天的协作审计快照（按组织时区）；可只处理指定组织。 */
export async function snapshotCollabAudits(onlyOrgId?: string): Promise<number> {
  const orgs = await query<{ id: string; timezone: string }>(
    `SELECT id, COALESCE(NULLIF(settings->>'timezone', ''), 'Asia/Shanghai') AS timezone
       FROM organizations
      WHERE ($1::uuid IS NULL OR id = $1)`,
    [onlyOrgId ?? null],
  );
  let updated = 0;
  for (const org of orgs) {
    const timezone = isValidTimezone(org.timezone)
      ? org.timezone
      : 'Asia/Shanghai';
    const snapshotDate = localDateInTimezone(timezone);
    const rows = await query<{ org_id: string }>(
      `INSERT INTO collab_audit_snapshots
         (org_id, snapshot_date, total, notification_count, filter_view_count,
          export_count, decision_count)
       SELECT $1, $2::date,
              count(*),
              count(*) FILTER (WHERE event.object_type = 'user_notification'),
              count(*) FILTER (WHERE event.object_type = 'copilot_batch_filter_view'),
              count(*) FILTER (WHERE event.action IN ${EXPORT_ACTION_SQL}),
              count(*) FILTER (WHERE event.action = '${DECISION_ACTION}')
         FROM (
           SELECT object_type, action
             FROM audit_logs
            WHERE org_id = $1 AND ${collabAuditFilterSql('audit_logs')}
           UNION ALL
           SELECT object_type, action
             FROM audit_logs_archive
            WHERE org_id = $1 AND ${collabAuditFilterSql('audit_logs_archive')}
         ) AS event
       HAVING count(*) > 0
       ON CONFLICT (org_id, snapshot_date)
       DO UPDATE SET total = EXCLUDED.total,
                     notification_count = EXCLUDED.notification_count,
                     filter_view_count = EXCLUDED.filter_view_count,
                     export_count = EXCLUDED.export_count,
                     decision_count = EXCLUDED.decision_count
       RETURNING org_id`,
      [org.id, snapshotDate],
    );
    if (rows.length) updated += 1;
  }
  return updated;
}
