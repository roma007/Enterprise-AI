import { one, query } from '../db';

export async function createSession(input: {
  jti: string;
  userId: string;
  orgId: string;
  ip?: string | null;
  userAgent?: string | null;
  expiresAt: string;
}): Promise<void> {
  await query(
    `INSERT INTO user_sessions (jti, user_id, org_id, ip, user_agent, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      input.jti,
      input.userId,
      input.orgId,
      input.ip ?? null,
      input.userAgent ?? null,
      input.expiresAt,
    ],
  );
}

/** token 中的 jti 对应会话是否仍有效。 */
export async function sessionActive(jti: string | undefined): Promise<boolean> {
  if (!jti) return false;
  const row = await one(
    `SELECT 1 FROM user_sessions
      WHERE jti = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [jti],
  );
  return Boolean(row);
}

export async function touchSession(jti: string | undefined): Promise<void> {
  if (!jti) return;
  await query(`UPDATE user_sessions SET last_seen_at = now() WHERE jti = $1`, [jti]);
}

export async function revokeSession(jti: string | undefined): Promise<boolean> {
  if (!jti) return false;
  const row = await one(
    `UPDATE user_sessions SET revoked_at = now()
      WHERE jti = $1 AND revoked_at IS NULL RETURNING id`,
    [jti],
  );
  return Boolean(row);
}

export async function revokeAllForUser(userId: string, orgId: string): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE user_sessions SET revoked_at = now()
      WHERE user_id = $1 AND org_id = $2
        AND revoked_at IS NULL AND expires_at > now()
      RETURNING id`,
    [userId, orgId],
  );
  return rows.length;
}

export async function listSessions(userId: string, orgId: string, currentJti?: string) {
  const rows = await query<any>(
    `SELECT id, jti, ip, user_agent, created_at, last_seen_at, expires_at, revoked_at
       FROM user_sessions
      WHERE user_id = $1 AND org_id = $2
      ORDER BY created_at DESC LIMIT 50`,
    [userId, orgId],
  );
  return rows.map((row) => ({
    id: row.id,
    ip: row.ip,
    user_agent: row.user_agent,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    current: Boolean(currentJti && row.jti === currentJti),
    active: !row.revoked_at && new Date(row.expires_at).getTime() > Date.now(),
  }));
}

export async function revokeOwnSessionById(
  id: string,
  userId: string,
  orgId: string,
): Promise<boolean> {
  const row = await one(
    `UPDATE user_sessions SET revoked_at = now()
      WHERE id = $1 AND user_id = $2 AND org_id = $3 AND revoked_at IS NULL
      RETURNING id`,
    [id, userId, orgId],
  );
  return Boolean(row);
}


export interface SessionCleanupResult {
  before: string;
  dryRun: boolean;
  candidates: number;
  deleted: number;
}

/** 删除早于 before 的已过期/已撤销会话；活跃会话永不删除。 */
export async function cleanupUserSessions(options: {
  before: string;
  orgId?: string;
  batchSize?: number;
  dryRun?: boolean;
}): Promise<SessionCleanupResult> {
  const batchSize = Math.min(Math.max(options.batchSize ?? 1000, 1), 1000);
  const params: any[] = [options.before];
  let orgFilter = '';
  if (options.orgId) {
    params.push(options.orgId);
    orgFilter = ` AND org_id = $${params.length}`;
  }
  const condition = `(revoked_at IS NOT NULL OR expires_at < now())
      AND COALESCE(revoked_at, expires_at) < $1${orgFilter}`;

  const total = await one<{ count: number }>(
    `SELECT count(*)::int AS count FROM user_sessions WHERE ${condition}`,
    params,
  );
  const candidates = total?.count ?? 0;
  if (options.dryRun) {
    return { before: options.before, dryRun: true, candidates, deleted: 0 };
  }

  let deleted = 0;
  for (let i = 0; i < 1000; i += 1) {
    const rows = await query<{ id: string }>(
      `DELETE FROM user_sessions
        WHERE id IN (
          SELECT id FROM user_sessions WHERE ${condition}
           ORDER BY COALESCE(revoked_at, expires_at)
           LIMIT $${params.length + 1}
        )
        RETURNING id`,
      [...params, batchSize],
    );
    deleted += rows.length;
    if (rows.length < batchSize) break;
  }
  return { before: options.before, dryRun: false, candidates, deleted };
}


/** 撤销除当前会话外的其他会话（改密后保留当前设备）。 */
export async function revokeOtherSessions(
  userId: string,
  orgId: string,
  currentJti: string | undefined,
): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE user_sessions SET revoked_at = now()
      WHERE user_id = $1 AND org_id = $2
        AND revoked_at IS NULL AND expires_at > now()
        AND ($3::uuid IS NULL OR jti <> $3::uuid)
      RETURNING id`,
    [userId, orgId, currentJti ?? null],
  );
  return rows.length;
}
