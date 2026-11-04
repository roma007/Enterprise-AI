import { query } from '../db';
import { collabAuditFilterSql } from './collab_audit_snapshot';

/** 周报检查间隔（秒），默认 3600，0 关闭。 */
export function collabDigestIntervalSeconds(): number {
  const raw = Number(process.env.COLLAB_AUDIT_DIGEST_INTERVAL_SECONDS ?? 3600);
  if (!Number.isFinite(raw)) return 3600;
  return Math.min(86400, Math.max(0, Math.floor(raw)));
}

interface DigestCounts {
  total: number;
  notification: number;
  filter_view: number;
  export: number;
  decision: number;
  previous_total: number;
}

async function orgDigestCounts(orgId: string): Promise<DigestCounts> {
  const source = `(SELECT object_type, action, created_at
                     FROM audit_logs WHERE org_id = $1
                   UNION ALL
                   SELECT object_type, action, created_at
                     FROM audit_logs_archive WHERE org_id = $1)`;
  const rows = await query<any>(
    `SELECT count(*) FILTER (WHERE a.created_at >= now() - interval '7 days')::int AS total,
            count(*) FILTER (WHERE a.created_at >= now() - interval '7 days'
                               AND a.object_type = 'user_notification')::int AS notification,
            count(*) FILTER (WHERE a.created_at >= now() - interval '7 days'
                               AND a.object_type = 'copilot_batch_filter_view')::int AS filter_view,
            count(*) FILTER (WHERE a.created_at >= now() - interval '7 days'
                               AND a.action IN ('EXPORT copilot-notification-audits',
                                                'EXPORT copilot-collab-audits',
                                                'EXPORT copilot-batch-filter-view-audits',
                                                'EXPORT copilot-collab-merged',
                                                'EXPORT copilot-collab-archive'))::int AS export,
            count(*) FILTER (WHERE a.created_at >= now() - interval '7 days'
                               AND a.action = 'DECIDE copilot-reconcile-difference')::int AS decision,
            count(*) FILTER (WHERE a.created_at < now() - interval '7 days'
                               AND a.created_at >= now() - interval '14 days')::int AS previous_total
       FROM ${source} a
      WHERE ${collabAuditFilterSql('a')}`,
    [orgId],
  );
  const row = rows[0] ?? {};
  return {
    total: Number(row.total ?? 0),
    notification: Number(row.notification ?? 0),
    filter_view: Number(row.filter_view ?? 0),
    export: Number(row.export ?? 0),
    decision: Number(row.decision ?? 0),
    previous_total: Number(row.previous_total ?? 0),
  };
}

/**
 * 向每个组织的管理员/总监/项目经理发送最近 7 天协作审计摘要。
 * 同一用户 6 天内只发一次，避免每次巡检重复提醒。
 */
export async function sendCollabAuditDigest(): Promise<number> {
  const orgs = await query<{ id: string; name: string }>(
    `SELECT id, name FROM organizations WHERE status = 'active'`,
  );
  let sent = 0;
  for (const org of orgs) {
    const counts = await orgDigestCounts(org.id);
    if (counts.total === 0) continue;
    const recipients = await query<{ id: string }>(
      `SELECT u.id
         FROM users u
         JOIN memberships m ON m.user_id = u.id
        WHERE u.org_id = $1
          AND u.status = 'active'
          AND m.role IN ('admin', 'director', 'pm')
          AND NOT EXISTS (
            SELECT 1 FROM user_notifications n
             WHERE n.user_id = u.id
               AND n.kind = 'copilot_collab_audit_digest'
               AND n.created_at > now() - interval '6 days'
          )`,
      [org.id],
    );
    const change = counts.total - counts.previous_total;
    const body = `最近 7 天协作审计 ${counts.total} 条（通知 ${counts.notification} / 筛选视图 ${counts.filter_view} / 导出 ${counts.export} / 决策 ${counts.decision}），较前 7 天 ${
      change >= 0 ? '+' : ''
    }${change}`;
    for (const recipient of recipients) {
      await query(
        `INSERT INTO user_notifications
           (org_id, user_id, actor_id, kind, title, body, link, ref_type)
         VALUES ($1,$2,NULL,'copilot_collab_audit_digest','协作审计周报',$3,'#/collab-audits','collab_audit_digest')`,
        [org.id, recipient.id, body],
      );
      sent += 1;
    }
  }
  return sent;
}
