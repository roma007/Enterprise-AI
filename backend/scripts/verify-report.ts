/**
 * verify-report.ts · 报告渲染与生成接口的回归断言
 *
 *   npm run verify:report
 *
 * 覆盖：
 *   1. 章节号连续、无重复（修复 0 → 1 → 5 断号）
 *   2. 已入库的流程节点、四维盘点、依赖、风险确实进入报告
 *   3. 一页纸简报是独立文档，不串成完整诊断报告
 *   4. 未实现的交付物类型明确拒绝
 *   5. 并发生成不产生版本冲突（每个请求都拿到唯一版本号）
 */
import assert from 'node:assert/strict';
import { one, query, closePool } from '../src/db';
import { loadBundle } from '../src/repo';
import { runChecks } from '../src/rules/consistency';
import { renderOnePager } from '../src/templates/one_pager';
import { generateDeliverable } from '../src/services/deliverables';
import type { DeliverableType } from '../src/services/types';

const C = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

let failures = 0;
let passes = 0;

function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passes += 1;
      console.log(`  ${C.green('PASS')}  ${name}`);
    })
    .catch((err: any) => {
      failures += 1;
      console.log(`  ${C.red('FAIL')}  ${name}`);
      console.log(C.dim(`        ${err?.message ?? err}`));
    });
}

/** 从 Markdown 里抽出全部章节号，检查父级存在且同级不重复。 */
function headingNumbers(markdown: string) {
  const top: number[] = [];
  const sub: string[] = [];
  const subsub: string[] = [];

  for (const line of markdown.split('\n')) {
    const m3 = line.match(/^#### (\d+)\.(\d+)\.(\d+) /);
    if (m3) subsub.push(`${m3[1]}.${m3[2]}.${m3[3]}`);
    const m2 = line.match(/^### (\d+)\.(\d+) /);
    if (m2) sub.push(`${m2[1]}.${m2[2]}`);
    const m1 = line.match(/^## (\d+)\. /);
    if (m1) top.push(Number(m1[1]));
  }
  return { top, sub, subsub };
}

function assertNoDuplicates(label: string, values: string[]) {
  const seen = new Set<string>();
  const dup = values.filter((v) => (seen.has(v) ? true : (seen.add(v), false)));
  assert.equal(dup.length, 0, `${label} 出现重复编号：${[...new Set(dup)].join(', ')}`);
}

async function main() {
  const eng = await one<{ id: string }>(
    `SELECT id FROM engagements ORDER BY created_at DESC LIMIT 1`,
  );
  assert.ok(eng, '数据库里没有项目，先跑 npm run db:reset');

  const bundle = await loadBundle(eng!.id);
  assert.ok(bundle, 'bundle 加载失败');
  const result = runChecks(bundle!);
  assert.equal(result.summary.block, 0, `存在 block 级校验：${result.checks
    .filter((c) => c.outcome === 'block')
    .map((c) => c.code)
    .join('、')}`);

  const md = result.report.markdown;
  const { top, sub, subsub } = headingNumbers(md);

  console.log('');
  console.log(C.bold('  报告结构'));
  await check('顶部章节号从 0 开始连续，无断号', () => {
    assert.ok(top.length >= 6, `只找到 ${top.length} 个一级章节`);
    top.forEach((n, i) => assert.equal(n, i, `第 ${i + 1} 个一级章节编号是 ${n}，应为 ${i}`));
  });

  await check('二级/三级编号不重复', () => {
    assertNoDuplicates('二级章节', sub);
    assertNoDuplicates('三级章节', subsub);
  });

  await check('每个二级编号的父章节都存在', () => {
    const parents = new Set(top);
    for (const s of sub) {
      const p = Number(s.split('.')[0]);
      assert.ok(parents.has(p), `### ${s} 的父章节 ${p} 不存在`);
    }
    const parentSub = new Set(sub);
    for (const s of subsub) {
      const p = s.split('.').slice(0, 2).join('.');
      assert.ok(parentSub.has(p), `#### ${s} 的父章节 ${p} 不存在`);
    }
  });

  await check('ROI 每张卡有独立编号，金额类局限各自编号', () => {
    const roiSections = result.report.sections.filter((s) => s.kind === 'roi' && s.ref);
    const roiOpps = result.report.portfolio.codes;
    assert.equal(roiSections.length, roiOpps.length, 'ROI 卡数量与推荐机会点不一致');
    const roiNums = roiSections.map((s) => s.body.split('\n')[0].match(/^### (\d+\.\d+)/)?.[1]);
    assert.equal(new Set(roiNums).size, roiNums.length, 'ROI 卡编号重复');
    const amountNums = result.report.sections
      .filter((s) => s.kind === 'amount_limitation')
      .map((s) => s.body.split('\n')[0].match(/^#### (\d+\.\d+\.\d+)/)?.[1]);
    assert.equal(new Set(amountNums).size, amountNums.length, '金额类局限编号重复');
  });

  await check('已入库的流程节点全部出现在业务链条中', () => {
    if (!bundle!.processNodes.length) return;
    for (const n of bundle!.processNodes) {
      assert.ok(md.includes(n.name), `流程节点「${n.name}」未渲染`);
    }
  });

  await check('已入库的四维盘点全部出现在报告中', () => {
    if (!bundle!.inventory.length) return;
    for (const i of bundle!.inventory) {
      assert.ok(md.includes(i.name), `盘点项「${i.name}」未渲染`);
    }
    const labels: Record<string, string> = {
      business: '业务维度',
      data: '数据维度',
      system: '系统维度',
      org: '组织维度',
    };
    for (const dim of new Set(bundle!.inventory.map((i) => i.dimension))) {
      assert.ok(md.includes(labels[dim] ?? dim), `缺少「${labels[dim] ?? dim}」小节`);
    }
    assert.ok(/四维诊断/.test(md), '缺少「四维诊断」章节');
  });

  await check('有依赖时生成 Mermaid 依赖图', () => {
    if (!bundle!.dependencies.length) return;
    assert.ok(md.includes('```mermaid'), '缺少 Mermaid 依赖图');
    assert.ok(md.includes('flowchart LR'), 'Mermaid 图类型应为 flowchart LR');
    for (const d of bundle!.dependencies) {
      assert.ok(
        md.includes(d.from_code) && md.includes(d.to_code),
        `依赖 ${d.from_code} → ${d.to_code} 未出现在图中`,
      );
    }
  });

  await check('显式风险与派生风险都进入风险章节', () => {
    for (const r of bundle!.risks) {
      assert.ok(md.includes(r.title), `风险「${r.title}」未渲染`);
    }
    for (const o of bundle!.opportunities.filter((x) => x.has_tech_blocker)) {
      assert.ok(md.includes(`${o.code} ${o.title}：技术阻断`), `技术阻断 ${o.code} 未渲染`);
    }
    assert.ok(/风险与阻断/.test(md), '缺少「风险与阻断」章节');
  });

  console.log('');
  console.log(C.bold('  一页纸简报'));
  await check('一页纸是独立文档，不串成完整诊断报告', () => {
    const one = renderOnePager(bundle!, result.report);
    const lines = one.markdown.split('\n').length;
    assert.ok(lines <= 70, `一页纸 ${lines} 行，超过 70 行`);
    assert.ok(one.markdown.startsWith('# '), '缺少标题');
    assert.ok(one.markdown.includes('## 结论'), '缺少结论');
    assert.ok(one.markdown.includes('## 需要拍板'), '缺少待拍板事项');
    assert.ok(!one.markdown.includes('## 7. ROI 测算'), '一页纸混入了完整报告的 ROI 章节');
    for (const l of result.report.excludedInternal) {
      assert.ok(!one.markdown.includes(l.title), `内部局限「${l.title}」泄露到一页纸`);
    }
  });

  console.log('');
  console.log(C.bold('  生成接口'));
  const created: string[] = [];

  await check('未实现的交付物类型返回 400，且不写库', async () => {
    const before = await one<{ n: number }>(`SELECT count(*) AS n FROM deliverables`);
    let code: string | undefined;
    let status: number | undefined;
    try {
      await generateDeliverable({
        engagementId: eng!.id,
        type: 'prd' as DeliverableType,
      });
    } catch (err: any) {
      code = err.code;
      status = err.statusCode;
    }
    assert.equal(status, 400, '未返回 400');
    assert.equal(code, 'DELIVERABLE_TYPE_NOT_IMPLEMENTED', '错误码不对');
    const after = await one<{ n: number }>(`SELECT count(*) AS n FROM deliverables`);
    assert.equal(after!.n, before!.n, '拒绝时仍然写了库');
  });

  await check('5 个并发生成请求全部成功且版本号唯一', async () => {
    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        generateDeliverable({ engagementId: eng!.id, type: 'one_pager' }),
      ),
    );
    const failed = settled.filter((s) => s.status === 'rejected');
    assert.equal(
      failed.length,
      0,
      `有 ${failed.length} 个请求失败：${failed
        .map((s: any) => s.reason?.code ?? s.reason?.message)
        .join('、')}`,
    );

    const results = settled.map((s) => (s as PromiseFulfilledResult<any>).value);
    results.forEach((r, i) => {
      assert.equal(r.blocked, false, `第 ${i + 1} 个请求被拦截`);
      assert.ok(r.deliverable, `第 ${i + 1} 个请求没有返回交付物`);
      created.push(r.deliverable!.id);
    });
    const versions = results.map((r) => r.deliverable!.version);
    assert.equal(new Set(versions).size, versions.length, `版本号重复：${versions.join(',')}`);
  });

  // 清理并发测试产生的交付物（审计记录随外键级联删除）
  if (created.length) {
    await query(`DELETE FROM deliverables WHERE id = ANY($1::uuid[])`, [created]);
  }

  console.log('');
  console.log(
    failures === 0
      ? C.green(`  全部 ${passes} 项通过`)
      : C.red(`  ${failures} 项失败 / ${passes} 项通过`),
  );
  console.log('');

  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void closePool());
