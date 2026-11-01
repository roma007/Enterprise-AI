/**
 * verify-rules.ts · 把四条硬规则 + 分位边界 + 传导链在真实数据库上跑一遍
 *
 *   npm run verify
 *
 * 每个用例单独开事务、结束时 ROLLBACK，不会污染样例数据。
 * 任何一条不符合预期，进程以非零码退出（可直接接 CI）。
 */
import { pool, closePool, query } from '../src/db';

let passed = 0;
let failed = 0;

const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const r = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

type SqlStep = string | { sql: string; params?: unknown[] };

async function expectError(name: string, sql: SqlStep | SqlStep[], params: unknown[], match: RegExp) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const step of Array.isArray(sql) ? sql : [sql]) {
      if (typeof step === 'string') await client.query(step, params);
      else await client.query(step.sql, step.params ?? []);
    }
    failed += 1;
    console.log(`  ${r('FAIL')}  ${name} ${dim('— 预期报错，但执行成功')}`);
  } catch (e: any) {
    if (match.test(e.message)) {
      passed += 1;
      console.log(`  ${g('PASS')}  ${name} ${dim(`— ${e.code ?? 'ERR'}: ${e.message.split('\n')[0].slice(0, 70)}`)}`);
    } else {
      failed += 1;
      console.log(`  ${r('FAIL')}  ${name} ${dim(`— 报错信息不匹配：${e.message.split('\n')[0]}`)}`);
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

async function expectValue(name: string, fn: () => Promise<{ actual: unknown; expected: unknown }>) {
  try {
    const { actual, expected } = await fn();
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
      passed += 1;
      console.log(`  ${g('PASS')}  ${name} ${dim(`— ${JSON.stringify(actual)}`)}`);
    } else {
      failed += 1;
      console.log(`  ${r('FAIL')}  ${name} ${dim(`— 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)}`);
    }
  } catch (e: any) {
    failed += 1;
    console.log(`  ${r('FAIL')}  ${name} ${dim(`— ${e.message}`)}`);
  }
}

const OPP = {
  op01: 'a9000000-0000-4000-8000-000000000001',
  op05: 'a9000000-0000-4000-8000-000000000005',
  op06: 'a9000000-0000-4000-8000-000000000006',
  p004: 'a7000000-0000-4000-8000-000000000004',
};

async function main() {
  console.log('');
  console.log('  数据库规则实测（每个用例独立事务，结束回滚）');

  // ---------------------------------------------------------------- R1
  console.log('\n  R1 · 无来源/已归并的痛点不能关联机会点');
  await expectError(
    '已归并痛点不能单独关联',
    [
      { sql: `UPDATE pain_points SET status='merged' WHERE id=$1`, params: [OPP.p004] },
      {
        sql: `INSERT INTO opportunity_pain_points(opportunity_id, pain_point_id) VALUES ($2,$1)`,
        params: [OPP.p004, OPP.op01],
      },
    ],
    [],
    /R1/,
  );

  // ---------------------------------------------------------------- R2
  console.log('\n  R2 · 无基线 → ROI 置信度自动降为 low');
  await expectValue('OP-06 无基线，high 被降为 low', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO roi_models (opportunity_id, benefit_type, neutral_value, one_time_cost, confidence)
         VALUES ($1,'efficiency',20,30,'high')`,
        [OPP.op06],
      );
      const res = await client.query(`SELECT confidence FROM roi_models WHERE opportunity_id=$1`, [OPP.op06]);
      return { actual: res.rows[0].confidence, expected: 'low' };
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  // ---------------------------------------------------------------- P1
  console.log('\n  P1 · 收益形态全有或全无');
  await expectError(
    '缺署名被拒绝',
    `UPDATE roi_models SET realization_confirmed_at=NULL WHERE opportunity_id=$1`,
    [OPP.op01],
    /realization_all_or_nothing/,
  );
  await expectError(
    '理由不足 10 字被拒绝',
    `UPDATE roi_models SET realization_note='因为' WHERE opportunity_id=$1`,
    [OPP.op01],
    /realization_all_or_nothing/,
  );

  // ---------------------------------------------------------------- R3
  console.log('\n  R3 · 有技术阻断禁止进入 designed');
  await expectError(
    'OP-05 未指定承担人 → 拒绝',
    `UPDATE opportunities SET stage='designed' WHERE id=$1`,
    [OPP.op05],
    /R3/,
  );
  await expectValue('OP-05 指定承担人 → 允许', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE opportunities SET blocker_owner='a1000000-0000-4000-8000-000000000003' WHERE id=$1`,
        [OPP.op05],
      );
      await client.query(`UPDATE opportunities SET stage='designed' WHERE id=$1`, [OPP.op05]);
      const res = await client.query(`SELECT stage FROM opportunities WHERE id=$1`, [OPP.op05]);
      return { actual: res.rows[0].stage, expected: 'designed' };
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  // ---------------------------------------------------------------- R4
  console.log('\n  R4 · 终止必须写原因');
  await expectError(
    'killed 且原因为空 → 拒绝',
    `UPDATE opportunities SET stage='killed' WHERE id=$1`,
    [OPP.op06],
    /kill_requires_reason/,
  );

  // --------------------------------------------------------------- P2
  console.log('\n  P2 · 分位边界（落后那条边界归落后）');
  await expectValue('空驶率 35 → median', async () => {
    const [row] = await query<{ p: string }>(
      `SELECT benchmark_position('logistics','empty_run_rate',35) AS p`,
    );
    return { actual: row.p, expected: 'median' };
  });
  await expectValue('空驶率 38 → lagging（p75 归落后）', async () => {
    const [row] = await query<{ p: string }>(
      `SELECT benchmark_position('logistics','empty_run_rate',38) AS p`,
    );
    return { actual: row.p, expected: 'lagging' };
  });
  await expectValue('调度人均管车 20 → good（p50 归优）', async () => {
    const [row] = await query<{ p: string }>(
      `SELECT benchmark_position('logistics','trucks_per_dispatcher',20) AS p`,
    );
    return { actual: row.p, expected: 'good' };
  });
  await expectValue('调度人均管车 15 → lagging', async () => {
    const [row] = await query<{ p: string }>(
      `SELECT benchmark_position('logistics','trucks_per_dispatcher',15) AS p`,
    );
    return { actual: row.p, expected: 'lagging' };
  });

  // --------------------------------------------------------------- P3
  console.log('\n  P3 · 缺口比例分级');
  await expectValue('ratio_level(10,10) = pass', async () => {
    const [row] = await query<{ l: string }>(`SELECT ratio_level(10,10) AS l`);
    return { actual: row.l, expected: 'pass' };
  });
  await expectValue('ratio_level(8,10) = warn', async () => {
    const [row] = await query<{ l: string }>(`SELECT ratio_level(8,10) AS l`);
    return { actual: row.l, expected: 'warn' };
  });
  await expectValue('ratio_level(4,10) = block', async () => {
    const [row] = await query<{ l: string }>(`SELECT ratio_level(4,10) AS l`);
    return { actual: row.l, expected: 'block' };
  });

  // --------------------------------------------------------------- P4
  console.log('\n  P4 · 传导链乘积 = realization_factor');
  await expectValue('OP-01 链条 = 0.5985', async () => {
    const [row] = await query<{ p: number; f: number }>(
      `SELECT chain_product(o.id) AS p, r.realization_factor AS f
         FROM opportunities o JOIN roi_models r ON r.opportunity_id=o.id
        WHERE o.id=$1`,
      [OPP.op01],
    );
    return { actual: [row.p, row.f], expected: [0.5985, 0.5985] };
  });
  await expectValue('全部 ROI 卡无乘积偏差', async () => {
    const rows = await query(`SELECT * FROM fn_chain_factor_mismatches('a4000000-0000-4000-8000-000000000001')`);
    return { actual: rows.length, expected: 0 };
  });
  await expectValue('OP-01 派生变量不参与连乘', async () => {
    const [row] = await query<{ n: number }>(
      `SELECT count(*) AS n FROM roi_sensitivity WHERE opportunity_id=$1 AND is_derived`,
      [OPP.op01],
    );
    return { actual: row.n, expected: 1 };
  });

  console.log('');
  console.log(
    failed === 0
      ? `  ${g(`全部 ${passed} 项通过`)}`
      : `  ${g(`${passed} 项通过`)} / ${r(`${failed} 项失败`)}`,
  );
  console.log('');
  process.exitCode = failed === 0 ? 0 : 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void closePool());
