import { one, query } from '../db';

/** 客户公开分享的访问记录与内存限流。 */

const buckets = new Map<string, number[]>();

function envNumber(name: string, fallback: number, min = 1): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

export function allowShareAccess(key: string): { allowed: boolean; retryAfter: number } {
  const limit = envNumber('PUBLIC_SHARE_RATE_LIMIT', 60);
  const windowMs = envNumber('PUBLIC_SHARE_RATE_WINDOW_MS', 60_000, 1000);
  const now = Date.now();
  const recent = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);

  if (recent.length >= limit) {
    const retryAfter = Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000));
    buckets.set(key, recent);
    return { allowed: false, retryAfter };
  }

  recent.push(now);
  buckets.set(key, recent);
  if (buckets.size > 10_000) {
    for (const [k, times] of buckets) {
      if (!times.some((t) => now - t < windowMs)) buckets.delete(k);
    }
  }
  return { allowed: true, retryAfter: 0 };
}

/** 仅测试用。 */
export function resetShareRateLimit(): void {
  buckets.clear();
}


export interface ShareViewCleanupResult {
  before: string;
  dryRun: boolean;
  candidates: number;
  archived: number;
  /** 兼容旧字段：表示从热表移除的条数，等同 archived。 */
  deleted: number;
}

/** 把早于 before 的分享访问明细移入归档表；可按组织限定。不删除分享链接本身。 */
export async function cleanupShareViews(options: {
  before: string;
  orgId?: string;
  batchSize?: number;
  dryRun?: boolean;
}): Promise<ShareViewCleanupResult> {
  const batchSize = Math.min(Math.max(options.batchSize ?? 1000, 1), 1000);
  const params: any[] = [options.before];
  let orgFilter = '';
  if (options.orgId) {
    params.push(options.orgId);
    orgFilter = ` AND e.org_id = $${params.length}`;
  }
  const match = `sv.viewed_at < $1${orgFilter}`;
  const base = `FROM share_views sv
      JOIN deliverable_shares sh ON sh.id = sv.share_id
      JOIN deliverables d ON d.id = sh.deliverable_id
      JOIN engagements e ON e.id = d.engagement_id
     WHERE ${match}`;

  const total = await one<{ count: number }>(`SELECT count(*)::int AS count ${base}`, params);
  const candidates = total?.count ?? 0;
  if (options.dryRun) {
    return {
      before: options.before,
      dryRun: true,
      candidates,
      archived: 0,
      deleted: 0,
    };
  }

  let archived = 0;
  for (let i = 0; i < 1000; i += 1) {
    const rows = await query<{ id: string }>(
      `WITH moved AS (
         DELETE FROM share_views
          WHERE id IN (
            SELECT sv.id ${base} ORDER BY sv.viewed_at LIMIT $${params.length + 1}
          )
         RETURNING id, share_id, token, kind, ip, user_agent, referer, viewed_at
       )
       INSERT INTO share_views_archive
         (id, share_id, token, kind, ip, user_agent, referer, viewed_at, org_id)
       SELECT m.id, m.share_id, m.token, m.kind, m.ip, m.user_agent, m.referer, m.viewed_at,
              (SELECT e.org_id
                 FROM deliverable_shares sh
                 JOIN deliverables d ON d.id = sh.deliverable_id
                 JOIN engagements e ON e.id = d.engagement_id
                WHERE sh.id = m.share_id)
         FROM moved m
       RETURNING id`,
      [...params, batchSize],
    );
    archived += rows.length;
    if (rows.length < batchSize) break;
  }
  return {
    before: options.before,
    dryRun: false,
    candidates,
    archived,
    deleted: archived,
  };
}
