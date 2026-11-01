import 'dotenv/config';
import pg from 'pg';

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
  max: 10,
});

export async function query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(sql, params as any[]);
  return res.rows as T[];
}

export async function one<T = any>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/** 在一个事务里执行；抛错自动回滚。用于「交付物 + 审计记录」这类必须同时落库的写操作。 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
}
