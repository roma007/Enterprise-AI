import { randomUUID } from 'node:crypto';
import { one, query } from '../db';
import { buildPrintHtml } from './export';
import { htmlToPdf } from './pdf';
import { cachedPdf, pdfCacheKey } from './pdf_cache';

const WORKER_ID = `${process.env.HOSTNAME ?? 'worker'}:${process.pid}:${randomUUID().slice(0, 8)}`;

function envInt(name: string, fallback: number, min = 1): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

async function claimJob(): Promise<string | null> {
  const leaseMinutes = envInt('PDF_JOB_LEASE_MINUTES', 15);
  const row = await one<{ id: string }>(
    `WITH candidate AS (
       SELECT id FROM pdf_jobs
        WHERE status = 'queued'
           OR (status = 'running' AND (locked_at IS NULL OR locked_at < now() - ($2::int * interval '1 minute')))
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE pdf_jobs j
        SET status = 'running',
            locked_by = $1,
            locked_at = now(),
            started_at = COALESCE(j.started_at, now()),
            attempts = j.attempts + 1
       FROM candidate c
      WHERE j.id = c.id
      RETURNING j.id`,
    [WORKER_ID, leaseMinutes],
  );
  return row?.id ?? null;
}

async function processJob(jobId: string): Promise<void> {
  const job = await one<any>(
    `SELECT j.id, j.status, j.deliverable_id,
            d.title, d.version, d.content,
            e.name AS engagement_name, c.name AS client_name
       FROM pdf_jobs j
       JOIN deliverables d ON d.id = j.deliverable_id
       JOIN engagements e ON e.id = d.engagement_id
       JOIN clients c ON c.id = e.client_id
      WHERE j.id = $1`,
    [jobId],
  );
  if (!job) {
    await query(
      `UPDATE pdf_jobs SET status = 'failed', error = '交付物不存在', finished_at = now()
        WHERE id = $1`,
      [jobId],
    );
    return;
  }

  try {
    const html = buildPrintHtml(
      job.content?.markdown ?? '',
      {
        title: job.title,
        client: job.client_name,
        project: job.engagement_name,
        version: `v${job.version}`,
      },
      false,
    );
    const key = pdfCacheKey([
      job.deliverable_id,
      job.version,
      job.title,
      job.client_name,
      job.engagement_name,
      html,
    ]);
    await cachedPdf(key, () => htmlToPdf(html));
    await query(
      `UPDATE pdf_jobs
          SET status = 'done', cache_key = $2, error = NULL, finished_at = now(),
              locked_at = NULL
        WHERE id = $1 AND locked_by = $3`,
      [jobId, key, WORKER_ID],
    );
  } catch (err: any) {
    await query(
      `UPDATE pdf_jobs
          SET status = 'failed', error = $2, finished_at = now(), locked_at = NULL
        WHERE id = $1 AND locked_by = $3`,
      [jobId, String(err?.message ?? err).slice(0, 500), WORKER_ID],
    );
  }
}

/**
 * PostgreSQL 队列 worker：多实例通过 SKIP LOCKED 竞争任务；
 * 返回停止函数，API 进程可内联运行，也可用 `npm run worker:pdf` 独立运行。
 */
export function startPdfWorker(): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      for (;;) {
        if (stopped) break;
        const id = await claimJob();
        if (!id) break;
        await processJob(id);
      }
    } catch (err) {
      console.error('[pdf-worker] poll failed', err);
    } finally {
      if (!stopped) timer = setTimeout(tick, 1000);
    }
  };

  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export interface PdfJobCleanupResult {
  before: string;
  dryRun: boolean;
  candidates: number;
  deleted: number;
}

/** 清理已完成/失败且超过保留期的任务；不删除 PDF 文件缓存。 */
export async function cleanupPdfJobs(options: {
  before: string;
  batchSize?: number;
  dryRun?: boolean;
}): Promise<PdfJobCleanupResult> {
  const batchSize = Math.min(Math.max(options.batchSize ?? 1000, 1), 1000);
  const where = `status IN ('done','failed')
      AND COALESCE(finished_at, created_at) < $1`;
  const total = await one<{ count: number }>(
    `SELECT count(*)::int AS count FROM pdf_jobs WHERE ${where}`,
    [options.before],
  );
  const candidates = total?.count ?? 0;
  if (options.dryRun) {
    return { before: options.before, dryRun: true, candidates, deleted: 0 };
  }

  let deleted = 0;
  for (let i = 0; i < 1000; i += 1) {
    const rows = await query<{ id: string }>(
      `DELETE FROM pdf_jobs
        WHERE id IN (
          SELECT id FROM pdf_jobs WHERE ${where}
           ORDER BY COALESCE(finished_at, created_at)
           LIMIT $2
        )
        RETURNING id`,
      [options.before, batchSize],
    );
    deleted += rows.length;
    if (rows.length < batchSize) break;
  }
  return { before: options.before, dryRun: false, candidates, deleted };
}
