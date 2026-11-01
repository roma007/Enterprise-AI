import { fmtLocalDateTime } from '../services/time';
import type { Bundle } from '../types';
import { reportableOpportunities, roiFor } from '../repo';
import type { RenderedReport, Section, Portfolio } from './diagnosis';

const fmt = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : Number(v.toFixed(1)).toString();

const money = (v: number | null | undefined) => `${fmt(v)} 万`;

function portfolioLine(label: string, p: Portfolio): string {
  return (
    `- ${label}：${p.codes.join(' + ') || '—'}，可实现 **${money(p.realized)}**，` +
    `投入 **${money(p.investment)}**，回本 **${fmt(p.paybackMonths)} 个月**` +
    `（含运维 ${fmt(p.paybackMonthsWithOps)} 个月）。`
  );
}

/**
 * 一页纸简报：只给决策人看结论、钱、待拍板事项和不确定性。
 * 详细口径一律回指诊断报告，不在这里重复论证。
 */
export function renderOnePager(
  bundle: Bundle,
  report: RenderedReport,
): { markdown: string; sections: Section[] } {
  const opps = reportableOpportunities(bundle);
  const phase1 = opps.filter((o) => o.target_phase === 'phase1');
  const excluded = bundle.opportunities.filter(
    (o) => o.stage === 'killed' || o.stage === 'parked' || o.target_phase === 'watch',
  );
  const lowBaselines = bundle.baselines.filter((b) => b.confidence === 'low');
  const g1 = bundle.gates.find((g) => g.code === 'G1');
  const g1Open = (g1?.checklist ?? []).filter((i) => i.passed === false);

  const rows = opps
    .slice()
    .sort((a, b) => b.score - a.score)
    .map((o) => {
      const r = roiFor(bundle, o.id);
      return `| ${o.code} ${o.title} | ${o.target_phase ?? '—'} | ${o.score} | ${money(r?.realized_value)} | ${money(r?.one_time_cost)} | ${fmt(r?.payback_months)} 个月 |`;
    });

  const uncertainty = [
    ...report.amountLimitations.map((l) => `- **${l.title}**：${l.detail}`),
    ...lowBaselines
      .filter((b) => !report.amountLimitations.some((l) => l.source_id === b.id))
      .map((b) => `- **${b.metric}基线置信度为 low**：来源「${b.source}」，需补采样。`),
  ];

  const asks: string[] = [];
  if (g1Open.length) asks.push(`- G1 仍有 ${g1Open.length} 项未闭环：${g1Open.map((i) => i.item).join('；')}。`);
  if (phase1.length) asks.push(`- 确认一期范围：${phase1.map((o) => o.code).join(' + ')}。`);
  if (uncertainty.length) asks.push('- 确认哪些数字可以在补采样前对外使用（见「主要不确定性」）。');

  const body = [
    `# ${bundle.engagement.client_name} · AI 化诊断一页纸`,
    '',
    `> 项目：${bundle.engagement.name}　｜　阶段：${bundle.engagement.stage}　｜　生成时间：${fmtLocalDateTime()}`,
    `> 读给：决策人　｜　详细论证见同批次的《AI 化诊断报告》`,
    '',
    '## 结论',
    '',
    `- 共识别 **${bundle.opportunities.length}** 个 AI 机会点，建议本期做 **${opps.length}** 个（一期 ${phase1.length} 个）。`,
    portfolioLine('核心组合（评分前三）', report.corePortfolio),
    portfolioLine('一期 + 二期全部实施', report.portfolio),
    '',
    '## 建议先做',
    '',
    '| 机会点 | 期次 | 得分 | 可实现收益 | 一次性投入 | 回本 |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    '## 为什么不是全部',
    '',
    excluded.length
      ? `- 暂不纳入：${excluded.map((o) => `${o.code} ${o.title}（${o.stage === 'parked' || o.target_phase === 'watch' ? '观望' : '已终止'}）`).join('、')}。详细原因见诊断报告。`
      : '- 本期识别的机会点均已纳入路线。',
    '',
    '## 需要拍板',
    '',
    ...(asks.length ? asks : ['- 本期无待拍板事项。']),
    '',
    '## 主要不确定性',
    '',
    ...(uncertainty.length ? uncertainty : ['- 本期无金额类或低置信度不确定性记录。']),
    '',
    '## 下一步',
    '',
    '1. 补齐 G1 未闭环项与未访谈对象。',
    '2. 对低置信度基线做抽样验证。',
    '3. 确认一期范围后，进入方案设计与 POC 验证。',
  ].join('\n');

  return {
    markdown: body + '\n',
    sections: [{ key: 'one_pager', kind: 'summary', body }],
  };
}
