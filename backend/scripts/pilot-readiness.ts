/**
 * 试点就绪检查：不连接真实客户环境，只检查代码/配置是否具备试点条件。
 *
 *   npm run readiness:check
 *   npm run readiness:check -- --report-only   # 只报告，不因 FAIL 退出 1
 *
 * 外部资源（真实客户、K8s、支付厂商、模型、Alertmanager）不在本脚本内伪造。
 */
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { closePool, query } from '../src/db';

type Level = 'PASS' | 'WARN' | 'FAIL';

interface Check {
  level: Level;
  name: string;
  detail: string;
}

const backendRoot = process.cwd();
const root = path.basename(backendRoot) === 'backend' ? path.resolve(backendRoot, '..') : backendRoot;
const checks: Check[] = [];

const add = (level: Level, name: string, detail: string) => {
  checks.push({ level, name, detail });
};

const env = (key: string) => (process.env[key] ?? '').trim();

const checkEnv = (key: string, level: Level, hint: string) => {
  if (env(key)) add('PASS', key, '已设置');
  else add(level, key, hint);
};

async function checkDatabase() {
  try {
    await query('SELECT 1');
    add('PASS', '数据库连接', '可连接');
  } catch (err) {
    add('FAIL', '数据库连接', `连接失败：${(err as Error).message}`);
    return;
  }

  try {
    const migrations = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM schema_migrations',
    );
    const files = readdirSync(path.join(backendRoot, 'db/migrations')).filter((file) =>
      file.endsWith('.sql'),
    ).length;
    const applied = Number(migrations[0]?.n ?? 0);
    if (applied === files) {
      add('PASS', '迁移一致性', `${applied}/${files} 个迁移已应用`);
    } else {
      add('FAIL', '迁移一致性', `已应用 ${applied}，文件 ${files}；请执行 npm run db:migrate`);
    }
  } catch (err) {
    add('FAIL', '迁移一致性', `无法读取 schema_migrations：${(err as Error).message}`);
  }

  try {
    const noRls = await query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
        ORDER BY 1`,
    );
    const total = await query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const allowed = new Set([
      'benchmarks',
      'industry_templates',
      'metric_definitions',
      'schema_migrations',
    ]);
    const unexpected = noRls
      .map((row) => row.relname)
      .filter((name) => !allowed.has(name));
    if (unexpected.length) {
      add('FAIL', 'RLS', `未启用 RLS 且不在白名单：${unexpected.join('、')}`);
    } else {
      add(
        'PASS',
        'RLS',
        `${Number(total[0]?.n ?? 0)} 张表；仅全局表未启用（${noRls
          .map((row) => row.relname)
          .join('、') || '无'}）`,
      );
    }
  } catch (err) {
    add('FAIL', 'RLS', `检查失败：${(err as Error).message}`);
  }
}

function checkFiles() {
  const required = [
    ['ops/alerts.yml', '告警规则'],
    ['ops/alertmanager.yml', 'Alertmanager 配置'],
    ['ops/prometheus.scrape.example.yml', 'Prometheus 抓取示例'],
    ['ops/grafana-dashboard.json', 'Grafana 看板'],
    ['OPERATIONS.md', '运维手册'],
    ['SECURITY.md', '依赖安全记录'],
  ] as const;
  for (const [file, label] of required) {
    if (existsSync(path.join(root, file))) add('PASS', label, file);
    else add('FAIL', label, `缺少 ${file}`);
  }

  const oncall = path.join(root, 'ops/oncall.yml');
  if (existsSync(oncall)) {
    const text = readFileSync(oncall, 'utf8');
    if (/owner:\s*\S+/.test(text) && /channel:\s*\S+/.test(text)) {
      add('PASS', '值班与告警接收', 'ops/oncall.yml 已配置 owner/channel');
    } else {
      add('WARN', '值班与告警接收', 'ops/oncall.yml 缺少 owner 或 channel');
    }
  } else {
    add(
      'WARN',
      '值班与告警接收',
      '未配置 ops/oncall.yml（可从 ops/oncall.example.yml 复制）',
    );
  }

  const backup = path.join(root, 'backups');
  try {
    if (!existsSync(backup)) {
      add('WARN', '备份目录', 'backups/ 不存在；首次备份会自动创建');
    } else {
      statSync(backup);
      add('PASS', '备份目录', 'backups/ 存在');
    }
  } catch (err) {
    add('WARN', '备份目录', `不可访问：${(err as Error).message}`);
  }
}

function checkFrontend() {
  const dist = path.join(root, 'frontend/dist/index.html');
  if (existsSync(dist)) add('PASS', '前端构建产物', 'frontend/dist/index.html 存在');
  else add('WARN', '前端构建产物', '前端尚未 build；试点前需 npm run build');
}

async function main() {
  const reportOnly = process.argv.includes('--report-only');

  checkEnv('DATABASE_URL', 'FAIL', '未设置 DATABASE_URL');
  checkEnv('AUTH_REQUIRED', 'FAIL', '试点环境必须 AUTH_REQUIRED=true');
  if (env('AUTH_REQUIRED') && env('AUTH_REQUIRED') !== 'true') {
    add('FAIL', 'AUTH_REQUIRED', `当前为 ${env('AUTH_REQUIRED')}，试点环境必须为 true`);
  }

  const secret = env('AUTH_SECRET');
  if (!secret) add('FAIL', 'AUTH_SECRET', '未设置');
  else if (secret.length < 32) add('FAIL', 'AUTH_SECRET', '长度不足 32 位');
  else add('PASS', 'AUTH_SECRET', '已设置且长度达标');

  checkEnv('METRICS_TOKEN', 'FAIL', '监控抓取需要 METRICS_TOKEN');
  if (env('SEED_DEMO') === 'true') {
    add('FAIL', 'SEED_DEMO', '试点环境禁止加载演示数据');
  } else {
    add('PASS', 'SEED_DEMO', '未开启演示数据');
  }

  const storage = env('STORAGE_DRIVER') || (env('S3_BUCKET') ? 's3' : 'local');
  if (storage === 's3') {
    checkEnv('S3_BUCKET', 'FAIL', 'S3 模式缺少 S3_BUCKET');
    checkEnv('S3_ENDPOINT', 'WARN', '未设置 S3_ENDPOINT（使用 AWS 默认 endpoint）');
  } else {
    add('WARN', '对象存储', '当前为 local；多副本试点建议切换到 S3');
  }

  if ((env('PAYMENT_PROVIDER') || 'mock') === 'mock') {
    add('WARN', '支付', '当前为 mock；真实收款仍需支付厂商联调');
  } else {
    add('PASS', '支付', `PAYMENT_PROVIDER=${env('PAYMENT_PROVIDER')}`);
  }

  if (env('AI_BASE_URL') && env('AI_MODEL')) {
    add('PASS', 'AI 模型', `${env('AI_MODEL')} @ ${env('AI_BASE_URL')}`);
  } else {
    add('WARN', 'AI 模型', '未配置 AI_BASE_URL/AI_MODEL；将回退规则草稿');
  }

  if (env('TRUST_PROXY') === 'true') add('PASS', 'TRUST_PROXY', '已开启');
  else add('WARN', 'TRUST_PROXY', '前置网关场景建议 TRUST_PROXY=true');

  checkFiles();
  checkFrontend();
  await checkDatabase();

  const width = Math.max(...checks.map((c) => c.name.length), 8);
  console.log('\n试点就绪检查（代码/配置，不含真实客户联调）\n');
  for (const check of checks) {
    console.log(`[${check.level}] ${check.name.padEnd(width)}  ${check.detail}`);
  }
  const summary = {
    PASS: checks.filter((c) => c.level === 'PASS').length,
    WARN: checks.filter((c) => c.level === 'WARN').length,
    FAIL: checks.filter((c) => c.level === 'FAIL').length,
  };
  console.log(
    `\n汇总：PASS ${summary.PASS} / WARN ${summary.WARN} / FAIL ${summary.FAIL}`,
  );
  console.log(
    '提示：真实客户试点、K8s 滚动发布、支付厂商、模型联调仍需外部资源，不能用本检查代替。\n',
  );

  await closePool();
  if (summary.FAIL > 0 && !reportOnly) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error(err);
  await closePool().catch(() => undefined);
  process.exitCode = 1;
});
