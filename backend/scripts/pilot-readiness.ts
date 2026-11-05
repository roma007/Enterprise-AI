/**
 * 试点就绪检查：不连接真实客户环境，只检查代码/配置是否具备试点条件。
 *
 *   npm run readiness:check
 *   npm run readiness:check -- --report-only   # 只报告，不因 FAIL 退出 1
 */
import { closePool } from '../src/db';
import { runReadinessChecks } from '../src/services/readiness';

async function main() {
  const reportOnly = process.argv.includes('--report-only');
  const report = await runReadinessChecks();
  const width = Math.max(...report.checks.map((c) => c.name.length), 8);

  console.log('\n试点就绪检查（代码/配置，不含真实客户联调）\n');
  for (const check of report.checks) {
    console.log(`[${check.level}] ${check.name.padEnd(width)}  ${check.detail}`);
  }
  console.log(
    `\n汇总：PASS ${report.summary.pass} / WARN ${report.summary.warn} / FAIL ${report.summary.fail}`,
  );
  console.log(
    '提示：真实客户试点、K8s 滚动发布、支付厂商、模型联调仍需外部资源，不能用本检查代替。\n',
  );

  await closePool();
  if (report.summary.fail > 0 && !reportOnly) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error(err);
  await closePool().catch(() => undefined);
  process.exitCode = 1;
});
