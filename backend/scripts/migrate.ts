/**
 * migrate.ts · 最小增量迁移执行器
 *
 *   npm run db:migrate
 *
 * 规则：
 *   - db/migrations/NNNN_*.sql 按文件名排序执行；
 *   - 每个文件在独立事务里执行，成功后写 schema_migrations；
 *   - 已执行文件的 checksum 不允许变化（防止改历史迁移）；
 *   - 如果库是旧的 db:reset 建出来的（有 engagements 但没有 schema_migrations），
 *     自动把 0001/0002 标记为已执行，再继续后面的迁移。
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { closePool, pool } from '../src/db';

interface Migration {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

async function loadMigrations(): Promise<Migration[]> {
  const dir = path.resolve(process.cwd(), 'db/migrations');
  const files = (await readdir(dir))
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();

  if (!files.length) throw new Error(`没有找到迁移文件：${dir}`);

  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(path.join(dir, name), 'utf8');
      return {
        version: name.slice(0, 4),
        name,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    }),
  );
}

async function main() {
  const migrations = await loadMigrations();
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     text PRIMARY KEY,
        name        text NOT NULL,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const appliedRows = await client.query<{ version: string; checksum: string }>(
      `SELECT version, checksum FROM schema_migrations`,
    );
    const applied = new Map(appliedRows.rows.map((r) => [r.version, r.checksum]));

    // 兼容旧库：有 S1 核心表但没有迁移记录 → 把 0001/0002 视为基线
    if (applied.size === 0) {
      const core = await client.query<{ t: string | null }>(
        `SELECT to_regclass('public.engagements')::text AS t`,
      );
      if (core.rows[0]?.t) {
        for (const m of migrations.filter((x) => x.version <= '0002')) {
          await client.query(
            `INSERT INTO schema_migrations (version, name, checksum)
             VALUES ($1,$2,$3) ON CONFLICT (version) DO NOTHING`,
            [m.version, m.name, m.checksum],
          );
          applied.set(m.version, m.checksum);
        }
        console.log('检测到已有 S1 schema，已将 0001/0002 标记为基线');
      }
    }

    let count = 0;
    for (const m of migrations) {
      const previous = applied.get(m.version);
      if (previous) {
        if (previous !== m.checksum) {
          throw new Error(
            `迁移 ${m.name} 的 checksum 与已执行版本不一致。历史迁移不允许修改，请新增迁移文件。`,
          );
        }
        continue;
      }

      console.log(`→ 执行 ${m.name}`);
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query(
          `INSERT INTO schema_migrations (version, name, checksum) VALUES ($1,$2,$3)`,
          [m.version, m.name, m.checksum],
        );
        await client.query('COMMIT');
        count++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    console.log(count ? `完成：执行 ${count} 个迁移` : '数据库已是最新，无需迁移');
  } finally {
    client.release();
    await closePool();
  }
}

main().catch((err) => {
  console.error('迁移失败：', err);
  process.exitCode = 1;
});
