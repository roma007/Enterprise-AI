import { one, query } from '../db';
import {
  auditFilter,
  buildAuditCsv,
  type AuditQuery,
} from './audit_query';
import { objectStorage } from './object_storage';

export interface AuditExportJob {
  id: string;
  org_id: string;
  user_id: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  scope: 'live' | 'archive';
  filters: AuditQuery;
  columns: string[];
  row_count: number | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const MAX_ROWS = Number(process.env.AUDIT_EXPORT_MAX_ROWS ?? 100000);
const fileKey = (id: string) => `audit-exports/${id}.csv`;

export async function createAuditExportJob(input: {
  orgId: string;
  userId: string;
  scope: 'live' | 'archive';
  filters: AuditQuery;
  columns: string[];
}): Promise<AuditExportJob> {
  const row = await one<AuditExportJob>(
    `INSERT INTO audit_export_jobs
       (org_id, user_id, scope, filters, columns)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)
     RETURNING *`,
    [
      input.orgId,
      input.userId,
      input.scope,
      JSON.stringify(input.filters),
      JSON.stringify(input.columns),
    ],
  );
  if (!row) throw new Error('创建导出任务失败');
  setImmediate(() => {
    void processAuditExportJob(row.id).catch(() => undefined);
  });
  return row;
}

export async function listAuditExportJobs(
  orgId: string,
  userId: string,
  limit: number,
): Promise<AuditExportJob[]> {
  return query<AuditExportJob>(
    `SELECT id, org_id, user_id, status, scope, filters, columns,
            row_count, error, created_at, started_at, finished_at
       FROM audit_export_jobs
      WHERE org_id = $1 AND user_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [orgId, userId, limit],
  );
}

export async function getAuditExportDownload(
  orgId: string,
  userId: string,
  id: string,
): Promise<{ job: AuditExportJob; buffer: Buffer; filename: string }> {
  const job = await one<AuditExportJob>(
    `SELECT * FROM audit_export_jobs
      WHERE id = $1 AND org_id = $2 AND user_id = $3`,
    [id, orgId, userId],
  );
  if (!job) throw new Error('NOT_FOUND');
  if (job.status !== 'done') throw new Error('NOT_READY');
  const buffer = await objectStorage().get(fileKey(id));
  if (!buffer) throw new Error('FILE_MISSING');
  const day = new Date(job.created_at).toISOString().slice(0, 10);
  return {
    job,
    buffer,
    filename: `audit-logs-${job.scope}-${day}-${id.slice(0, 8)}.csv`,
  };
}

export async function deleteAuditExportJob(
  orgId: string,
  userId: string,
  id: string,
): Promise<boolean> {
  const row = await one<{ id: string }>(
    `DELETE FROM audit_export_jobs
      WHERE id = $1 AND org_id = $2 AND user_id = $3
      RETURNING id`,
    [id, orgId, userId],
  );
  if (!row) return false;
  await objectStorage().delete(fileKey(id));
  return true;
}

export async function processAuditExportJob(id: string): Promise<void> {
  const claimed = await one<AuditExportJob>(
    `UPDATE audit_export_jobs
        SET status = 'running', started_at = now(), error = NULL
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,
    [id],
  );
  if (!claimed) return;
  try {
    const { where, params } = auditFilter(claimed.org_id, claimed.filters);
    const table =
      claimed.scope === 'archive' ? 'audit_logs_archive' : 'audit_logs';
    const rows = await query<any>(
      `SELECT a.created_at, a.action, a.object_type, a.object_id,
              a.status_code, u.name AS user_name, a.user_id,
              a.request_id, a.ip, a.user_agent, a.detail,
              ${claimed.scope === 'archive' ? 'a.archived_at' : 'NULL::timestamptz AS archived_at'}
         FROM ${table} a
         LEFT JOIN users u ON u.id = a.user_id
        WHERE ${where}
        ORDER BY a.created_at DESC
        LIMIT $8`,
      [...params, MAX_ROWS],
    );
    const columns = Array.isArray(claimed.columns) ? claimed.columns : [];
    await objectStorage().put(
      fileKey(id),
      Buffer.from(buildAuditCsv(rows, columns), 'utf8'),
      'text/csv',
    );
    await query(
      `UPDATE audit_export_jobs
          SET status = 'done', row_count = $2, finished_at = now()
        WHERE id = $1`,
      [id, rows.length],
    );
  } catch (err) {
    await query(
      `UPDATE audit_export_jobs
          SET status = 'failed', error = $2, finished_at = now()
        WHERE id = $1`,
      [id, (err instanceof Error ? err.message : String(err)).slice(0, 500)],
    ).catch(() => undefined);
  }
}

/** 失败任务重新排队；只有 failed 状态可重试。 */
export async function retryAuditExportJob(
  orgId: string,
  userId: string,
  id: string,
): Promise<{ job?: AuditExportJob; error?: 'NOT_FOUND' | 'NOT_RETRYABLE' }> {
  const row = await one<AuditExportJob>(
    `UPDATE audit_export_jobs
        SET status = 'pending', error = NULL, row_count = NULL,
            started_at = NULL, finished_at = NULL
      WHERE id = $1 AND org_id = $2 AND user_id = $3 AND status = 'failed'
      RETURNING *`,
    [id, orgId, userId],
  );
  if (!row) {
    const existing = await one<{ status: string }>(
      `SELECT status FROM audit_export_jobs
        WHERE id = $1 AND org_id = $2 AND user_id = $3`,
      [id, orgId, userId],
    );
    return { error: existing ? 'NOT_RETRYABLE' : 'NOT_FOUND' };
  }
  await objectStorage().delete(fileKey(id)).catch(() => undefined);
  setImmediate(() => {
    void processAuditExportJob(id).catch(() => undefined);
  });
  return { job: row };
}

/** 导出任务与文件保留天数，默认 7，限制 1–365。 */
export function auditExportRetentionDays(): number {
  const raw = Number(process.env.AUDIT_EXPORT_RETENTION_DAYS ?? 7);
  if (!Number.isFinite(raw)) return 7;
  return Math.min(365, Math.max(1, Math.floor(raw)));
}

/** 常驻清理间隔（秒），默认 3600，0 关闭。 */
export function auditExportCleanupIntervalSeconds(): number {
  const raw = Number(
    process.env.AUDIT_EXPORT_CLEANUP_INTERVAL_SECONDS ?? 3600,
  );
  if (!Number.isFinite(raw)) return 3600;
  return Math.min(86400, Math.max(0, Math.floor(raw)));
}

/** 删除超过保留期的导出任务及其文件。 */
export async function cleanupAuditExportJobs(days?: number): Promise<number> {
  const retention = days ?? auditExportRetentionDays();
  const rows = await query<{ id: string; org_id: string }>(
    `SELECT id, org_id FROM audit_export_jobs
      WHERE created_at < now() - make_interval(days => $1)
      ORDER BY created_at
      LIMIT 500`,
    [retention],
  );
  if (!rows.length) return 0;
  for (const row of rows) {
    await objectStorage().delete(fileKey(row.id)).catch(() => undefined);
  }
  const deleted = await query<{ id: string }>(
    `DELETE FROM audit_export_jobs
      WHERE id = ANY($1::uuid[])
      RETURNING id`,
    [rows.map((row) => row.id)],
  );
  if (!deleted.length) return 0;

  const byOrg = new Map<string, number>();
  for (const row of rows) {
    byOrg.set(row.org_id, (byOrg.get(row.org_id) ?? 0) + 1);
  }
  for (const [orgId, count] of byOrg) {
    await query(
      `INSERT INTO audit_logs
         (org_id, user_id, action, object_type, status_code, detail)
       VALUES ($1, NULL, 'CLEANUP audit-exports', 'audit_export_job', 200, $2::jsonb)`,
      [
        orgId,
        JSON.stringify({
          retention_days: retention,
          deleted: count,
        }),
      ],
    ).catch(() => undefined);
  }
  return deleted.length;
}

/** 进程重启后把中断的任务重新排队。 */
export async function resumePendingAuditExportJobs(): Promise<void> {
  await query(
    `UPDATE audit_export_jobs SET status = 'pending'
      WHERE status = 'running'`,
  ).catch(() => undefined);
  const rows = await query<{ id: string }>(
    `SELECT id FROM audit_export_jobs WHERE status = 'pending' LIMIT 50`,
  ).catch(() => [] as Array<{ id: string }>);
  for (const row of rows) {
    setImmediate(() => {
      void processAuditExportJob(row.id).catch(() => undefined);
    });
  }
}
