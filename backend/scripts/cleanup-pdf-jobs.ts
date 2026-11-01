/**
 * PDF 任务清理 CLI
 *
 *   npm run pdf:cleanup -- --days=30 --dry-run
 *   npm run pdf:cleanup -- --days=30
 */
import { cleanupPdfJobs } from '../src/services/pdf_jobs';
import { closePool } from '../src/db';

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main() {
  const days = Number(arg('days', process.env.PDF_JOB_RETENTION_DAYS ?? '30'));
  if (!Number.isFinite(days) || days < 1) {
    throw new Error('--days 必须是大于 0 的整数');
  }
  const dryRun = process.argv.includes('--dry-run');
  const batchSize = Number(arg('batch', '1000'));
  const before = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const result = await cleanupPdfJobs({ before, batchSize, dryRun });
  console.log(JSON.stringify({ ...result, days, mode: dryRun ? 'dry-run' : 'cleanup' }, null, 2));
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
