import 'dotenv/config';
import { requestContext } from '@fastify/request-context';
import pg from 'pg';
import { closeRedis } from './services/redis';

const { Pool, types } = pg;

// pg 默认把 numeric 返回成字符串（避免精度丢失），本系统金额都是万元，
// 精度到 0.01 足够，统一转成 number，省掉调用处的 Number()。
types.setTypeParser(1700, (v: string) => (v === null ? null : Number(v)));
// int8 用于 count(*)，转 number
types.setTypeParser(20, (v: string) => (v === null ? null : Number(v)));
// date（OID 1082）保持 YYYY-MM-DD 字符串，避免 JS Date 的时区偏移
// （否则 2026-12-31 在东八区会显示成 2026-12-30）
types.setTypeParser(1082, (v: string) => v);

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://127.0.0.1:5432/ai_delivery',
  max: Number(process.env.PG_POOL_MAX ?? 20),
});

const APP_ROLE = (process.env.DB_APP_ROLE ?? 'ai_delivery_app').trim();
const APP_ROLE_OK = /^[a-z_][a-z0-9_]*$/.test(APP_ROLE);

function requestScope(): {
  orgId?: string;
  platformAdmin: boolean;
  dbClient?: pg.PoolClient;
} {
  try {
    return {
      orgId: requestContext.get('orgId') as string | undefined,
      platformAdmin: Boolean(requestContext.get('platformAdmin')),
      dbClient: requestContext.get('dbClient') as pg.PoolClient | undefined,
    };
  } catch {
    return { platformAdmin: false };
  }
}

async function applyScope(client: pg.PoolClient, orgId?: string, platformAdmin = false) {
  if (!orgId || !APP_ROLE_OK || !APP_ROLE) return;
  await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
  await client.query(
    `SELECT set_config('app.org_id', $1, true),
            set_config('app.platform_admin', $2, true)`,
    [orgId, platformAdmin ? 'on' : 'off'],
  );
}

/** 为一个请求建立复用连接：设置受限角色与会话级 org 上下文。 */
export async function acquireScopedClient(
  orgId: string,
  platformAdmin: boolean,
): Promise<pg.PoolClient> {
  const client = await pool.connect();
  try {
    if (APP_ROLE_OK && APP_ROLE) {
      await client.query(`SET ROLE ${APP_ROLE}`);
      await client.query(
        `SELECT set_config('app.org_id', $1, false),
                set_config('app.platform_admin', $2, false)`,
        [orgId, platformAdmin ? 'on' : 'off'],
      );
    }
    return client;
  } catch (err) {
    client.release();
    throw err;
  }
}

export async function releaseScopedClient(client: pg.PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.query('RESET ROLE').catch(() => undefined);
    await client.query(
      `SELECT set_config('app.org_id', '', false), set_config('app.platform_admin', 'off', false)`,
    ).catch(() => undefined);
  } finally {
    client.release();
  }
}

export async function query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const scope = requestScope();
  if (scope.dbClient) {
    const res = await scope.dbClient.query(sql, params as any[]);
    return res.rows as T[];
  }
  if (!scope.orgId) {
    const res = await pool.query(sql, params as any[]);
    return res.rows as T[];
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyScope(client, scope.orgId, scope.platformAdmin);
    const res = await client.query(sql, params as any[]);
    await client.query('COMMIT');
    return res.rows as T[];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function one<T = any>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/** 在一个事务里执行；抛错自动回滚。用于「交付物 + 审计记录」这类必须同时落库的写操作。 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const scope = requestScope();
  if (scope.dbClient) {
    try {
      await scope.dbClient.query('BEGIN');
      const result = await fn(scope.dbClient);
      await scope.dbClient.query('COMMIT');
      return result;
    } catch (err) {
      await scope.dbClient.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyScope(client, scope.orgId, scope.platformAdmin);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
  await closeRedis();
}
