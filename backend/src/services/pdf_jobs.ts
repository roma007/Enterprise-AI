import { one, query } from '../db';
import { buildPrintHtml } from './export';
import { htmlToPdf } from './pdf';
import { cachedPdf, pdfCacheKey } from './pdf_cache';

const queue: string[] = [];
let draining = false;
let started = false;

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
  if (!job || job.status === 'done' || job.status === 'failed') return;

  await query(
    `UPDATE pdf_jobs SET status = 'running', started_at = now() WHERE id = $1`,
    [jobId],
  );

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
          SET status = 'done', cache_key = $2, error = NULL, finished_at = now()
        WHERE id = $1`,
      [jobId, key],
    );
  } catch (err: any) {
    await query(
      `UPDATE pdf_jobs
          SET status = 'failed', error = $2, finished_at = now()
        WHERE id = $1`,
      [jobId, String(err?.message ?? err).slice(0, 500)],
    );
  }
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const id = queue.shift();
      if (id) await processJob(id);
    }
  } finally {
    draining = false;
  }
}

export function enqueuePdfJob(jobId: string): void {
  queue.push(jobId);
  void drain();
}

/** 启动时恢复队列：中断的 running 标记失败，queued 重新入队。 */
export async function startPdfWorker(): Promise<void> {
  if (started) return;
  started = true;
  await query(
    `UPDATE pdf_jobs
        SET status = 'failed', error = '服务重启中断', finished_at = now()
      WHERE status = 'running'`,
  );
  const rows = await query<{ id: string }>(
    `SELECT id FROM pdf_jobs WHERE status = 'queued' ORDER BY created_at`,
  );
  for (const row of rows) queue.push(row.id);
  void drain();
}

/** 测试用：等待当前队列清空。 */
export async function waitForPdfQueue(): Promise<void> {
  while (draining || queue.length) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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
