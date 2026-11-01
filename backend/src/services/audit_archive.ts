import { one, query } from '../db';

export interface ArchiveOptions {
  /** 归档早于该时间（ISO 时间戳） */
  before: string;
  batchSize?: number;
  dryRun?: boolean;
}

export interface ArchiveResult {
  before: string;
  dryRun: boolean;
  candidates: number;
  moved: number;
}

const MAX_BATCH = 1000;

/**
 * 把 audit_logs 中早于 before 的记录分批移入 audit_logs_archive。
 * - 单条 SQL 内 DELETE ... RETURNING + INSERT，避免中途丢数据；
 * - 支持 dryRun 只统计不移动；
 * - 返回本次候选数与实际移动数。
 */
export async function archiveAuditLogs(options: ArchiveOptions): Promise<ArchiveResult> {
  const batchSize = Math.min(Math.max(options.batchSize ?? 1000, 1), MAX_BATCH);
  const candidates = await one<{ count: number }>(
    `SELECT count(*)::int AS count FROM audit_logs WHERE created_at < $1`,
    [options.before],
  );
  const total = candidates?.count ?? 0;
  if (options.dryRun) {
    return { before: options.before, dryRun: true, candidates: total, moved: 0 };
  }

  let moved = 0;
  for (let i = 0; i < 1000; i += 1) {
    const rows = await query<{ id: string }>(
      `WITH moved AS (
         DELETE FROM audit_logs
          WHERE id IN (
            SELECT id FROM audit_logs
             WHERE created_at < $1
             ORDER BY created_at
             LIMIT $2
          )
         RETURNING id, org_id, user_id, action, object_type, object_id,
                   status_code, ip, user_agent, request_id, detail, created_at
       )
       INSERT INTO audit_logs_archive
         (id, org_id, user_id, action, object_type, object_id,
          status_code, ip, user_agent, request_id, detail, created_at)
       SELECT id, org_id, user_id, action, object_type, object_id,
              status_code, ip, user_agent, request_id, detail, created_at
         FROM moved
       RETURNING id`,
      [options.before, batchSize],
    );
    moved += rows.length;
    if (rows.length < batchSize) break;
  }

  return { before: options.before, dryRun: false, candidates: total, moved };
}
