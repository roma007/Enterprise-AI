import { query } from '../db';

/** 批量任务 running 超时时间（分钟），默认 10，限制 1–1440。 */
export function batchTimeoutMinutes(): number {
  const raw = Number(process.env.BATCH_RUNNING_TIMEOUT_MINUTES ?? 10);
  if (!Number.isFinite(raw)) return 10;
  return Math.min(1440, Math.max(1, Math.floor(raw)));
}

/** 常驻回收间隔（秒），默认 300，0 表示关闭。 */
export function batchReapIntervalSeconds(): number {
  const raw = Number(process.env.BATCH_REAP_INTERVAL_SECONDS ?? 300);
  if (!Number.isFinite(raw)) return 300;
  return Math.min(86400, Math.max(0, Math.floor(raw)));
}

/**
 * 把长时间停留在 running 的批次标记为失败。
 * 在请求上下文里调用时受 RLS 限制，只处理当前组织；CLI 调用处理全部。
 */
export async function reapStaleBatches(): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `UPDATE copilot_reconcile_batches
        SET status = 'failed',
            failed_count = GREATEST(requested_count - created_count - skipped_count, 0),
            finished_at = now()
      WHERE status = 'running'
        AND created_at < now() - make_interval(mins => $1)
      RETURNING id`,
    [batchTimeoutMinutes()],
  );
  return rows.map((r) => r.id);
}
