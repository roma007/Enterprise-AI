import { query } from '../db';

const COLLAB_AUDIT_FILTER = `(
  object_type IN ('user_notification','copilot_batch_filter_view','notification_audit','collab_audit')
  OR action IN (
    'EXPORT copilot-notification-audits',
    'EXPORT copilot-collab-audits',
    'EXPORT copilot-batch-filter-view-audits'
  )
)`;

/** 协作审计保留天数，默认 365，限制 1–3650。 */
export function collabAuditRetentionDays(): number {
  const raw = Number(process.env.COLLAB_AUDIT_RETENTION_DAYS ?? 365);
  if (!Number.isFinite(raw)) return 365;
  return Math.min(3650, Math.max(1, Math.floor(raw)));
}

/** 归档间隔（秒），默认 86400，0 关闭。 */
export function collabAuditArchiveIntervalSeconds(): number {
  const raw = Number(process.env.COLLAB_AUDIT_ARCHIVE_INTERVAL_SECONDS ?? 86400);
  if (!Number.isFinite(raw)) return 86400;
  return Math.min(86400, Math.max(0, Math.floor(raw)));
}

/** 把超过保留期的协作审计从热表归档到 audit_logs_archive。 */
export async function archiveCollabAudits(): Promise<number> {
  const days = collabAuditRetentionDays();
  const rows = await query<{ id: string }>(
    `WITH moved AS (
       SELECT id FROM audit_logs
        WHERE ${COLLAB_AUDIT_FILTER}
          AND created_at < now() - make_interval(days => $1)
     ),
     inserted AS (
       INSERT INTO audit_logs_archive
         (id, org_id, user_id, action, object_type, object_id, status_code,
          ip, user_agent, request_id, detail, created_at)
       SELECT id, org_id, user_id, action, object_type, object_id, status_code,
              ip, user_agent, request_id, detail, created_at
         FROM audit_logs
        WHERE id IN (SELECT id FROM moved)
       ON CONFLICT (id) DO NOTHING
     )
     DELETE FROM audit_logs
      WHERE id IN (SELECT id FROM moved)
      RETURNING id`,
    [days],
  );
  if (rows.length) {
    try {
      await query(
        `INSERT INTO audit_logs
           (org_id, user_id, action, object_type, status_code, detail)
         VALUES (NULL, NULL, 'ARCHIVE copilot-collab-audits',
                 'collab_audit_archive', 200, $1::jsonb)`,
        [JSON.stringify({ count: rows.length, days })],
      );
    } catch {
      // 归档审计失败不影响归档本身
    }
  }
  return rows.length;
}
