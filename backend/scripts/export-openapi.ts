/**
 * export-openapi.ts · 导出 OpenAPI JSON
 *
 *   npm run openapi
 *
 * 不启动端口；buildApp + ready 后直接取 spec，写到 backend/docs/openapi.json。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app';
import { closePool } from '../src/db';

async function main() {
  process.env.LOG_LEVEL ??= 'silent';
  const app = buildApp();
  await app.ready();

  const spec = app.swagger();
  const out = path.resolve(process.cwd(), 'docs/openapi.json');
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(spec, null, 2)}\n`);

  console.log(`已生成 ${out}`);
  await app.close();
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
