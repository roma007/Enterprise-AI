/**
 * 分享访问明细归档 CLI（移入 share_views_archive）
 *
 *   npm run share:archive -- --days=180 --dry-run
 *   npm run share:archive -- --days=180
 *   npm run share:archive -- --days=180 --org=<ORG_ID>
 */
import { cleanupShareViews } from '../src/services/share_access';
import { closePool } from '../src/db';

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main() {
  const days = Number(arg('days', process.env.SHARE_VIEW_RETENTION_DAYS ?? '180'));
  if (!Number.isFinite(days) || days < 1) {
    throw new Error('--days 必须是大于 0 的整数');
  }
  const dryRun = process.argv.includes('--dry-run');
  const batchSize = Number(arg('batch', '1000'));
  const orgId = arg('org');
  const before = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const result = await cleanupShareViews({ before, orgId, batchSize, dryRun });
  console.log(JSON.stringify({ ...result, orgId, days, mode: dryRun ? 'dry-run' : 'archive' }, null, 2));
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
