import { query } from '../db';

/** 回收站保留天数，默认 30，限制 1–3650。 */
export function notificationTrashRetentionDays(): number {
  const raw = Number(process.env.NOTIFICATION_TRASH_RETENTION_DAYS ?? 30);
  if (!Number.isFinite(raw)) return 30;
  return Math.min(3650, Math.max(1, Math.floor(raw)));
}

/** 常驻清理间隔（秒），默认 3600，0 关闭。 */
export function notificationCleanupIntervalSeconds(): number {
  const raw = Number(process.env.NOTIFICATION_CLEANUP_INTERVAL_SECONDS ?? 3600);
  if (!Number.isFinite(raw)) return 3600;
  return Math.min(86400, Math.max(0, Math.floor(raw)));
}

/** 彻底删除超过保留期的回收站通知；传 userId 时只清理该用户。 */
export async function cleanupDeletedNotifications(userId?: string): Promise<number> {
  const days = notificationTrashRetentionDays();
  const rows = userId
    ? await query<{ id: string }>(
        `DELETE FROM user_notifications
          WHERE user_id = $1
            AND deleted_at IS NOT NULL
            AND deleted_at < now() - make_interval(days => $2)
          RETURNING id`,
        [userId, days],
      )
    : await query<{ id: string }>(
        `DELETE FROM user_notifications
          WHERE deleted_at IS NOT NULL
            AND deleted_at < now() - make_interval(days => $1)
          RETURNING id`,
        [days],
      );
  return rows.length;
}
