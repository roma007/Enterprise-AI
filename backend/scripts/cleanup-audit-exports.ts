/**
 * 手动清理过期审计导出任务。
 *
 *   npm run audit:exports:cleanup -- --dry-run
 *   npm run audit:exports:cleanup -- --yes --days=7 --limit=100
 *   npm run audit:exports:cleanup -- --org=hengzhi --yes
 */
import { query } from '../src/db';
import {
  cleanupAuditExportJobsForOrg,
  previewAuditExportCleanup,
} from '../src/services/audit_exports';

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const days = arg('days') ? Number(arg('days')) : undefined;
const limit = arg('limit') ? Number(arg('limit')) : 100;
const orgSlug = arg('org');
const yes = process.argv.includes('--yes');
const dryRun = !yes;

if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 365)) {
  console.error('--days 需为 1–365 的整数');
  process.exit(1);
}
if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
  console.error('--limit 需为 1–500 的整数');
  process.exit(1);
}

const orgs = await query<{ id: string; slug: string }>(
  orgSlug
    ? `SELECT id, slug FROM organizations WHERE slug = $1`
    : `SELECT id, slug FROM organizations ORDER BY slug`,
  orgSlug ? [orgSlug] : [],
);
if (!orgs.length) {
  console.error(orgSlug ? `组织不存在：${orgSlug}` : '没有组织');
  process.exit(1);
}

console.log(`模式：${dryRun ? 'dry-run（不删除）' : '执行清理'}`);
let total = 0;
for (const org of orgs) {
  const preview = await previewAuditExportCleanup(org.id, days, limit);
  console.log(
    `${org.slug}: retention=${preview.retention_days}天 candidates=${preview.items.length}`,
  );
  for (const item of preview.items) {
    console.log(
      `  - ${item.id} status=${item.status} created=${item.created_at} rows=${item.row_count ?? '—'}`,
    );
  }
  if (!dryRun && preview.items.length) {
    const result = await cleanupAuditExportJobsForOrg({
      orgId: org.id,
      userId: null,
      days,
      limit,
    });
    console.log(`${org.slug}: 已删除 ${result.deleted} 个任务与文件`);
    total += result.deleted;
  }
}
if (!dryRun) console.log(`合计删除 ${total} 个任务`);
