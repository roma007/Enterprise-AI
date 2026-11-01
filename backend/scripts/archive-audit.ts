/**
 * 审计日志归档 CLI（适合 cron / 运维手工执行）
 *
 *   npm run audit:archive -- --days=180 --dry-run
 *   npm run audit:archive -- --days=180
 *
 * 只把早于 before 的记录从 audit_logs 移入 audit_logs_archive，不物理删除。
 */
import { archiveAuditLogs } from '../src/services/audit_archive';
import { closePool } from '../src/db';

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main() {
  const days = Number(arg('days', process.env.AUDIT_RETENTION_DAYS ?? '180'));
  if (!Number.isFinite(days) || days < 1) {
    throw new Error('--days 必须是大于 0 的整数');
  }
  const dryRun = process.argv.includes('--dry-run');
  const batchSize = Number(arg('batch', '1000'));
  const before = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

  const result = await archiveAuditLogs({ before, batchSize, dryRun });
  console.log(
    JSON.stringify(
      { ...result, days, batchSize, mode: dryRun ? 'dry-run' : 'archive' },
      null,
      2,
    ),
  );
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
