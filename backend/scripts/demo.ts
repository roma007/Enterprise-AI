/**
 * demo.ts · 一条命令跑完「加载 → 校验 → 渲染 → 生成」
 *
 *   npm run demo
 *
 * 期望结果：14 项校验 11 pass / 3 warn / 0 block；生成 1 份诊断报告。
 */
import { one, closePool } from '../src/db';
import { loadBundle, chainFor, roiFor } from '../src/repo';
import { runChecks } from '../src/rules/consistency';
import { chainProduct, stageImpacts } from '../src/rules/chain';
import { generateDeliverable } from '../src/services/deliverables';

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

const pad = (s: string, n: number) => {
  // 中文按 2 列宽计算，保证表格在终端里对齐
  const width = [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - width));
};

const outcomeTag = (o: 'pass' | 'warn' | 'block') =>
  o === 'pass' ? C.green('pass ') : o === 'warn' ? C.yellow('warn ') : C.red('block');

async function main() {
  const eng = await one<{ id: string; name: string }>(
    `SELECT id, name FROM engagements ORDER BY created_at DESC LIMIT 1`,
  );
  if (!eng) {
    console.error('数据库里没有项目，先跑 npm run db:reset');
    process.exit(1);
  }

  const bundle = await loadBundle(eng.id);
  if (!bundle) throw new Error('bundle 加载失败');

  console.log('');
  console.log(C.bold(`  ${bundle.engagement.client_name} · ${eng.name}`));
  console.log(
    C.dim(
      `  阶段 ${bundle.engagement.stage}　机会点 ${bundle.opportunities.length}　痛点 ${bundle.painPoints.length}` +
        `　基线 ${bundle.baselines.length}　局限 ${bundle.limitations.length}　基准 ${bundle.benchmarks.length}`,
    ),
  );

  // ------------------------------------------------------------ 14 项校验
  const result = runChecks(bundle);

  console.log('');
  console.log(C.bold('  R5 · 生成前一致性校验'));
  console.log(C.dim('  ─────────────────────────────────────────────────────────────'));
  for (const c of result.checks) {
    console.log(`  ${outcomeTag(c.outcome)}  ${pad(c.code, 5)}${pad(c.title, 42)}`);
    if (c.outcome !== 'pass') console.log(`         ${C.dim(c.message)}`);
  }
  console.log(C.dim('  ─────────────────────────────────────────────────────────────'));
  console.log(
    `  合计：${C.green(`${result.summary.pass} pass`)} / ` +
      `${C.yellow(`${result.summary.warn} warn`)} / ` +
      `${C.red(`${result.summary.block} block`)}　→　` +
      (result.blocked ? C.red('禁止生成') : C.green('允许生成')),
  );

  // ---------------------------------------------------------------- 组合
  const p = result.report.portfolio;
  const core = result.report.corePortfolio;
  console.log('');
  console.log(C.bold('  组合口径（进入推荐路线的机会点）'));
  console.log(
    `  推荐组合 ${core.codes.join('+')}：可实现 ${C.cyan(`${core.realized} 万`)}` +
      `　投入 ${C.cyan(`${core.investment} 万`)}　年运维 ${C.cyan(`${core.annualOps} 万`)}` +
      `　回本 ${C.cyan(`${core.paybackMonths} 个月`)}（含运维 ${C.cyan(`${core.paybackMonthsWithOps}`)}）`,
  );
  console.log(
    `  全部一期+二期：可实现 ${C.cyan(`${p.realized} 万`)}　投入 ${C.cyan(`${p.investment} 万`)}` +
      `　年运维 ${C.cyan(`${p.annualOps} 万`)}　回本 ${C.cyan(`${p.paybackMonths} 个月`)}` +
      `（含运维 ${C.cyan(`${p.paybackMonthsWithOps}`)}）`,
  );

  // -------------------------------------------------------------- 传导链
  console.log('');
  console.log(C.bold('  传导链（OP-01）'));
  const op01 = bundle.opportunities.find((o) => o.code === 'OP-01');
  if (op01) {
    const roi = roiFor(bundle, op01.id);
    const stages = chainFor(bundle, op01.id);
    const product = chainProduct(stages);
    for (const s of stages) {
      console.log(
        `  ${pad(String(s.stage), 2)} ${pad(s.variable_label, 22)} ×${String(s.mult_base).padEnd(6)}` +
          (s.shape === 'threshold' ? C.yellow(' 阈值型') : ''),
      );
    }
    console.log(
      `  ${C.dim('→')} 连乘 ${C.cyan(String(product))}　= 存储系数 ${C.cyan(String(roi?.realization_factor))}` +
        (product != null && roi?.realization_factor != null && Math.abs(product - roi.realization_factor) <= 0.005
          ? C.green('  ✓')
          : C.red('  ✗')),
    );
    if (roi) {
      const impacts = stageImpacts(roi.neutral_value, stages);
      console.log(C.dim(`     单段恶化（理论 ${roi.neutral_value} 万 → 可实现 ${roi.realized_value} 万）：`));
      for (const i of impacts) {
        console.log(
          `     ${pad(i.variableLabel, 22)} 悲观 ${String(i.lowValue ?? '—').padEnd(5)}` +
            ` → ${pad(`${i.realizedIfLow} 万`, 9)} 损失 ${C.yellow(`−${i.loss} 万`)}` +
            (i.shape === 'threshold' ? C.dim('  （线性近似，实际有断崖）') : ''),
        );
      }
    }
  }

  // ---------------------------------------------------------------- 局限
  const l = result.report;
  console.log('');
  console.log(C.bold('  局限分流（P5）'));
  console.log(
    `  amount ${C.cyan(String(l.amountLimitations.length))} 条（紧跟 ROI）` +
      `　scope ${C.cyan(String(l.scopeLimitations.length))} 条（紧跟痛点）` +
      `　method ${C.cyan(String(l.methodLimitations.length))} 条（附录）` +
      `　internal ${C.cyan(String(l.excludedInternal.length))} 条（不进客户文档）`,
  );

  // ---------------------------------------------------------------- 生成
  console.log('');
  console.log(C.bold('  生成交付物'));
  const gen = await generateDeliverable({
    engagementId: eng.id,
    type: 'diagnosis_report',
  });
  if (gen.blocked) {
    console.log(C.red('  ⛔ 被校验拦截，未生成'));
  } else {
    console.log(
      `  ✓ ${gen.deliverable!.title} v${gen.deliverable!.version}` +
        C.dim(`　${gen.deliverable!.templateId} v${gen.deliverable!.templateVersion}`),
    );
    console.log(C.dim(`    id: ${gen.deliverable!.id}`));
    console.log(C.dim(`    markdown: ${gen.deliverable!.markdown.length} 字符，${gen.deliverable!.markdown.split('\n').length} 行`));
  }

  console.log('');
  console.log(C.dim('  下一步：npm run dev，然后'));
  console.log(C.dim(`    curl http://127.0.0.1:8788/api/engagements/${eng.id}/consistency-checks`));
  console.log(C.dim(`    curl http://127.0.0.1:8788/api/engagements/${eng.id}/preview`));
  console.log('');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void closePool());
