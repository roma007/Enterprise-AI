/**
 * 登录会话清理 CLI
 *
 *   npm run sessions:cleanup -- --days=30 --dry-run
 *   npm run sessions:cleanup -- --days=30
 */
import { cleanupUserSessions } from '../src/services/sessions';
import { closePool } from '../src/db';

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main() {
  const days = Number(arg('days', process.env.USER_SESSION_RETENTION_DAYS ?? '30'));
  if (!Number.isFinite(days) || days < 1) {
    throw new Error('--days 必须是大于 0 的整数');
  }
  const dryRun = process.argv.includes('--dry-run');
  const batchSize = Number(arg('batch', '1000'));
  const orgId = arg('org');
  const before = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const result = await cleanupUserSessions({ before, orgId, batchSize, dryRun });
  console.log(JSON.stringify({ ...result, orgId, days, mode: dryRun ? 'dry-run' : 'cleanup' }, null, 2));
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
