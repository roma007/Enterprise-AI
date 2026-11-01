import { fmtLocalDateTime } from '../services/time';
import type {
  Bundle,
  Dependency,
  Limitation,
  Opportunity,
  ProcessEdge,
  ProcessNode,
  Risk,
  RoiModel,
} from '../types';
import { chainFor, derivedFor, reportableOpportunities, roiFor } from '../repo';
import { chainProduct, stageImpacts } from '../rules/chain';
import { POSITION_LABEL, positionOf } from '../rules/benchmark';

export type SectionKind =
  | 'meta'
  | 'summary'
  | 'scope_method'
  | 'benchmark'
  | 'business'
  | 'diagnosis'
  | 'pain_points'
  | 'scope'
  | 'opportunity_map'
  | 'roi'
  | 'amount_limitation'
  | 'roadmap'
  | 'risk'
  | 'method';

export interface Section {
  key: string;
  kind: SectionKind;
  /** ROI 段对应机会点编号；金额类局限段记录它跟随的是哪个机会点 */
  ref?: string;
  body: string;
  limitationIds?: string[];
}

export interface Portfolio {
  codes: string[];
  count: number;
  realized: number;
  investment: number;
  annualOps: number;
  paybackMonths: number | null;
  paybackMonthsWithOps: number | null;
}

export interface RenderedReport {
  markdown: string;
  sections: Section[];
  /** 全部可进入路线的机会点（C2 的汇总口径） */
  portfolio: Portfolio;
  /** 评分最高的三个机会点组成的核心组合（对外建议口径） */
  corePortfolio: Portfolio;
  /** 一期（target_phase = phase1） */
  phase1Portfolio: Portfolio;
  /** 只做评分最高的那一个 */
  singlePortfolio: Portfolio | null;
  amountLimitations: Limitation[];
  scopeLimitations: Limitation[];
  methodLimitations: Limitation[];
  excludedInternal: Limitation[];
}

const fmt = (v: number | null | undefined, digits = 1): string =>
  v === null || v === undefined ? '—' : Number(v.toFixed(digits)).toString();

const money = (v: number | null | undefined) => `${fmt(v)} 万`;

function portfolioOf(bundle: Bundle, opps: Opportunity[]): Portfolio {
  const rois = opps
    .map((o) => roiFor(bundle, o.id))
    .filter((r): r is RoiModel => !!r && r.realized_value !== null);

  const realized = Number(rois.reduce((a, r) => a + (r.realized_value ?? 0), 0).toFixed(1));
  const investment = Number(rois.reduce((a, r) => a + r.one_time_cost, 0).toFixed(1));
  const annualOps = Number(rois.reduce((a, r) => a + r.annual_cost, 0).toFixed(1));
  const payback = realized > 0 ? Number(((investment * 12) / realized).toFixed(1)) : null;
  const net = Number((realized - annualOps).toFixed(1));
  const paybackOps = net > 0 ? Number(((investment * 12) / net).toFixed(1)) : null;

  return {
    codes: rois
      .map((r) => opps.find((o) => o.id === r.opportunity_id)?.code)
      .filter((c): c is string => !!c),
    count: rois.length,
    realized,
    investment,
    annualOps,
    paybackMonths: payback,
    paybackMonthsWithOps: paybackOps,
  };
}

/** 报告 §2 要展示的行业指标及其客户实际值。
 *
 *  口径来源优先级：
 *    1. 模板 payload.benchmark_metrics 指定展示哪些指标；
 *    2. 客户值来自盘点项的 attributes.benchmark_value（净利率来自 client_financials）；
 *    3. 没有值就显示「—」，不拿别的字段凑数。
 */
function referencedBenchmarks(bundle: Bundle) {
  const fromTemplate = bundle.template?.payload?.benchmark_metrics as string[] | undefined;
  const keys =
    fromTemplate && fromTemplate.length
      ? fromTemplate
      : [
          ...new Set(
            bundle.inventory
              .map((i) => i.attributes?.benchmark_metric_key as string | undefined)
              .filter((k): k is string => !!k),
          ),
        ];

  const valueOf = (metricKey: string): number | null => {
    if (metricKey === 'net_margin') {
      const f = bundle.financials.find((x) => x.metric_key === 'net_margin');
      return f ? f.value : null;
    }
    const item = bundle.inventory.find(
      (i) =>
        i.attributes?.benchmark_metric_key === metricKey &&
        typeof i.attributes?.benchmark_value === 'number',
    );
    return item ? (item.attributes.benchmark_value as number) : null;
  };

  const rows: Array<{
    metricKey: string;
    metricName: string;
    unit: string;
    value: number | null;
    position: string;
    p25: number | null;
    p50: number | null;
    p75: number | null;
    calibrated: boolean;
  }> = [];

  for (const key of keys) {
    const bench = bundle.benchmarks.find((b) => b.metric_key === key);
    if (!bench) continue;
    const value = valueOf(key);
    rows.push({
      metricKey: key,
      metricName: bench.metric_name,
      unit: bench.unit,
      value,
      position: positionOf(bench, value),
      p25: bench.p25,
      p50: bench.p50,
      p75: bench.p75,
      calibrated: bench.calibrated,
    });
  }
  return rows;
}

const DIMENSION_LABEL: Record<string, string> = {
  business: '业务',
  data: '数据',
  system: '系统',
  org: '组织',
};

const NODE_TYPE_LABEL: Record<string, string> = {
  start: '起点',
  action: '动作',
  manual: '手工',
  decision: '判断',
  end: '终点',
};

const ATTRIBUTE_LABEL: Record<string, string> = {
  roles: '角色',
  daily_volume: '日均量',
  trucks: '车辆数',
  dispatchers: '调度人数',
  minutes_per_case: '单均耗时',
  leakage_rate: '漏收率',
  error_rate_permille: '错单率',
  port_congestion_rate: '压港率',
  detention_rate: '压车率',
  cycle: '周期',
  system: '系统',
  format: '格式',
  size_gb: '容量',
  history_years: '历史跨度',
  daily_increment: '日增',
  completeness: '完整度',
  sampled: '已抽样',
  unique_id: '唯一键',
  vendor: '厂商',
  version: '版本',
  api: 'API',
  export: '可导出',
  annual_fee: '年费',
  maintainer: '维护方',
  headcount: '人数',
  digital_skill: '数字化能力',
  change_willingness: '变革意愿',
};

const ATTRIBUTE_UNIT: Record<string, string> = {
  daily_volume: ' 单/日',
  minutes_per_case: ' 分钟',
  leakage_rate: '%',
  error_rate_permille: '‰',
  port_congestion_rate: '%',
  detention_rate: '%',
  size_gb: ' GB',
  history_years: ' 年',
  daily_increment: ' 条/日',
  completeness: '%',
  headcount: ' 人',
  annual_fee: ' 万/年',
};

const ATTRIBUTE_KEYS: Record<string, string[]> = {
  business: [
    'roles',
    'daily_volume',
    'trucks',
    'dispatchers',
    'minutes_per_case',
    'leakage_rate',
    'error_rate_permille',
    'port_congestion_rate',
    'detention_rate',
    'cycle',
  ],
  data: ['system', 'format', 'size_gb', 'history_years', 'daily_increment', 'completeness', 'sampled', 'unique_id'],
  system: ['vendor', 'version', 'api', 'export', 'annual_fee', 'maintainer'],
  org: ['headcount', 'digital_skill', 'change_willingness'],
};

function formatAttribute(value: unknown): string {
  if (Array.isArray(value)) return value.join('、');
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

function attributeSummary(dimension: string, attrs: Record<string, unknown>): string {
  const keys = ATTRIBUTE_KEYS[dimension] ?? [];
  const picked = keys.filter((k) => attrs[k] !== undefined && attrs[k] !== null);
  const parts = picked.map(
    (k) => `${ATTRIBUTE_LABEL[k] ?? k}=${formatAttribute(attrs[k])}${ATTRIBUTE_UNIT[k] ?? ''}`,
  );
  if (parts.length) return parts.join('；');

  const fallback = Object.entries(attrs)
    .filter(([k, v]) => !k.startsWith('benchmark_') && v !== null && v !== undefined)
    .slice(0, 3)
    .map(([k, v]) => `${ATTRIBUTE_LABEL[k] ?? k}=${formatAttribute(v)}`);
  return fallback.length ? fallback.join('；') : '未获取';
}

const DISCOVERED_BY_LABEL: Record<string, string> = {
  interview: '访谈',
  observation: '现场观察',
  data: '数据抽样',
  workshop: '工作坊',
};

/** 把 process_nodes / process_edges 渲染成可读的树状链条（分支条件另列）。 */
function renderProcessChain(nodes: ProcessNode[], edges: ProcessEdge[]): string {
  if (!nodes.length) return '';
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const order = new Map(nodes.map((n, i) => [n.id, n.sort_order ?? i]));
  const children = new Map<string, ProcessEdge[]>();
  const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));

  for (const e of edges) {
    if (!byId.has(e.from_node_id) || !byId.has(e.to_node_id)) continue;
    const list = children.get(e.from_node_id) ?? [];
    list.push(e);
    children.set(e.from_node_id, list);
    indegree.set(e.to_node_id, (indegree.get(e.to_node_id) ?? 0) + 1);
  }
  for (const list of children.values()) {
    list.sort((a, b) => (order.get(a.to_node_id) ?? 0) - (order.get(b.to_node_id) ?? 0));
  }

  const meta = (n: ProcessNode) => {
    const bits: string[] = [];
    if (n.duration_min !== null) bits.push(`${n.duration_min} 分钟`);
    if (n.abnormal_rate !== null) bits.push(`异常 ${n.abnormal_rate}%`);
    if (n.is_implicit) bits.push('隐性');
    return bits.length ? `（${bits.join('，')}）` : '';
  };

  const lines: string[] = [];
  const seen = new Set<string>();

  const walk = (id: string, prefix: string, isLast: boolean, depth: number, edgeLabel?: string) => {
    const n = byId.get(id);
    if (!n) return;
    const branch = depth === 0 ? '' : `${prefix}${isLast ? '└─▶ ' : '├─▶ '}`;

    // 共享节点/回边只标「见上」，不再展开，避免同一段流程被重复打印或成环。
    if (seen.has(id)) {
      lines.push(`${branch}[${n.lane}] ${n.name}（见上）`);
      return;
    }
    seen.add(id);

    const suffix = edgeLabel ? `　← ${edgeLabel}` : '';
    const label = `[${n.lane}] ${n.name}${meta(n)}${suffix}`;
    lines.push(depth === 0 ? label : `${branch}${label}`);

    const kids = children.get(id) ?? [];
    kids.forEach((e, i) => {
      const last = i === kids.length - 1;
      const childPrefix = depth === 0 ? '' : prefix + (isLast ? '    ' : '│   ');
      walk(e.to_node_id, childPrefix, last, depth + 1, e.condition ?? e.label ?? undefined);
    });
  };

  const roots = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0);
  const start = roots.length ? roots : nodes.slice(0, 1);
  start.forEach((n) => walk(n.id, '', true, 0));

  return ['```text', ...lines, '```'].join('\n');
}

interface RiskRow {
  title: string;
  category: Risk['category'];
  probability: number | null;
  impact: number | null;
  mitigation: string;
  source: string;
}

const RISK_CATEGORY_LABEL: Record<string, string> = {
  data: '数据',
  tech: '技术',
  org: '组织',
  commercial: '商务',
  compliance: '合规',
};

/** 显式风险表 + 从结构化字段自动识别的风险（技术阻断 / 数据不可得 / 低置信度基线）。 */
function deriveRisks(bundle: Bundle): RiskRow[] {
  const rows: RiskRow[] = bundle.risks.map((r) => ({
    title: r.title,
    category: r.category,
    probability: r.probability,
    impact: r.impact,
    mitigation: r.mitigation ?? '—',
    source: '风险登记册',
  }));

  for (const o of bundle.opportunities) {
    if (o.has_tech_blocker) {
      rows.push({
        title: `${o.code} ${o.title}：技术阻断`,
        category: 'tech',
        probability: null,
        impact: null,
        mitigation: o.tech_blocker_note ?? '需先解除技术阻断，再进入方案设计',
        source: '机会点字段',
      });
    }
    if (o.data_status === 'unavailable') {
      rows.push({
        title: `${o.code} ${o.title}：数据不可得`,
        category: 'data',
        probability: null,
        impact: null,
        mitigation: '先完成数据可得性验证，再评估收益',
        source: '机会点字段',
      });
    }
  }

  for (const b of bundle.baselines.filter((x) => x.confidence === 'low')) {
    const o = bundle.opportunities.find((x) => x.id === b.opportunity_id);
    rows.push({
      title: `${o?.code ?? '—'} ${b.metric}基线置信度为 low`,
      category: 'data',
      probability: null,
      impact: null,
      mitigation: '补采样验证后再对外承诺',
      source: `基线 · ${b.source}`,
    });
  }

  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.category}|${r.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 把依赖关系渲染成 Mermaid flowchart；报告预览和外部 Markdown 工具都能识别。 */
function dependencyMermaid(deps: Dependency[], opportunities: Opportunity[]): string {
  const nodeId = (code: string) => code.replace(/[^A-Za-z0-9_]/g, '_');
  const codes = [...new Set(deps.flatMap((d) => [d.from_code, d.to_code]))].sort();
  const lines = ['flowchart LR'];

  for (const code of codes) {
    const o = opportunities.find((x) => x.code === code);
    const label = `${code}${o ? ` ${o.title}` : ''}`.replace(/"/g, "'").replace(/\|/g, '/');
    lines.push(`  ${nodeId(code)}["${label}"]`);
  }

  for (const d of deps) {
    const arrow = d.type === 'blocks' ? '-.->' : d.type === 'enables' ? '==>' : '-->';
    const label = d.type === 'blocks' ? '阻断' : d.type === 'enables' ? '使能' : '依赖';
    lines.push(`  ${nodeId(d.from_code)} ${arrow}|${label}| ${nodeId(d.to_code)}`);
  }

  return lines.join('\n');
}

export function renderDiagnosis(bundle: Bundle): RenderedReport {
  const { engagement } = bundle;
  const opps = reportableOpportunities(bundle);
  const portfolio = portfolioOf(bundle, opps);
  const corePortfolio = portfolioOf(bundle, opps.slice(0, 3));
  const phase1Portfolio = portfolioOf(
    bundle,
    opps.filter((o) => o.target_phase === 'phase1'),
  );
  const singlePortfolio = opps.length ? portfolioOf(bundle, opps.slice(0, 1)) : null;
  const sections: Section[] = [];

  const amount = bundle.limitations.filter((l) => l.impact_class === 'amount');
  const scope = bundle.limitations.filter((l) => l.impact_class === 'scope');
  const method = bundle.limitations.filter((l) => l.impact_class === 'method');
  const internal = bundle.limitations.filter((l) => l.impact_class === 'internal');

  const benchRows = referencedBenchmarks(bundle);
  const riskRows = deriveRisks(bundle);
  const roiOpps = opps
    .filter((o) => roiFor(bundle, o.id))
    .sort((a, b) => a.code.localeCompare(b.code));

  const hasBench = benchRows.length > 0;
  const hasBusiness = bundle.processNodes.length > 0;
  const hasDiagnosis = bundle.inventory.length > 0;
  const hasRisk = riskRows.length > 0;
  const hasMethod = method.length > 0;

  // 章节号按「实际出现的章节」动态分配，避免出现 0 → 1 → 5 这种断号。
  let cursor = 1; // 0 已用于结论摘要
  const num = {
    scope: cursor++,
    benchmark: hasBench ? cursor++ : null,
    business: hasBusiness ? cursor++ : null,
    diagnosis: hasDiagnosis ? cursor++ : null,
    pains: cursor++,
    opps: cursor++,
    roi: cursor++,
    roadmap: cursor++,
    risk: hasRisk ? cursor++ : null,
    method: hasMethod ? cursor++ : null,
  };

  const roiFirst = `${num.roi}.3`;
  const roiLast = `${num.roi}.${2 + roiOpps.length}`;

  // ---------------------------------------------------------------- meta
  sections.push({
    key: 'meta',
    kind: 'meta',
    body: [
      `# ${engagement.client_name} AI 化诊断报告`,
      '',
      `> 项目：${engagement.name}　｜　阶段：${engagement.stage}　｜　生成时间：${fmtLocalDateTime()}`,
      `> 模板：${bundle.template?.template_key ?? 'logistics_diagnosis'} v${bundle.template?.version ?? '2.2.0'}`,
      '',
      '> 本文件中的金额单位均为**万元/年**；回本周期按系统口径（投入 ÷ 年收益/12）与含运维口径同时给出。',
    ].join('\n'),
  });

  // ------------------------------------------------------------- summary
  const phase1 = opps.filter((o) => o.target_phase === 'phase1');
  const summaryLines = [
    `- 共识别 **${bundle.opportunities.length}** 个 AI 机会点，其中进入本期路线 **${opps.length}** 个（一期 ${phase1.length} 个）。`,
  ];
  if (corePortfolio.codes.length) {
    summaryLines.push(
      `- 推荐组合（评分前三：${corePortfolio.codes.join(' + ')}）可实现年化收益 **${money(corePortfolio.realized)}**，` +
        `一次性投入 **${money(corePortfolio.investment)}**，年运维 **${money(corePortfolio.annualOps)}**。`,
      `- 该组合回本：**${fmt(corePortfolio.paybackMonths)} 个月**（系统口径）／**${fmt(corePortfolio.paybackMonthsWithOps)} 个月**（含运维）。`,
    );
  } else {
    summaryLines.push('- 本期尚未完成 ROI 测算，暂无推荐组合。');
  }
  if (portfolio.codes.length) {
    summaryLines.push(
      `- 若一期二期全部实施（${portfolio.codes.join(' + ')}）：可实现 **${money(portfolio.realized)}**，` +
        `投入 **${money(portfolio.investment)}**，回本 **${fmt(portfolio.paybackMonths)} 个月**（含运维 ${fmt(portfolio.paybackMonthsWithOps)} 个月）。`,
    );
  }

  sections.push({
    key: 'summary',
    kind: 'summary',
    body: [
      '## 0. 结论摘要',
      '',
      ...summaryLines,
      '',
      '> 收益不是「理论上能省多少」，而是按每张 ROI 卡的传导链逐段打折后的可实现值。',
      roiOpps.length
        ? `> 每一段的取值、责任方与断崖条件都写在 ${roiFirst}–${roiLast}，可以逐条质疑。`
        : '> ROI 卡尚未建立，本摘要只包含机会点与路线信息。',
    ].join('\n'),
  });

  // ------------------------------------------------- scope & method (§1)
  const interviewMinutes = bundle.interviews.reduce((a, i) => a + (i.duration_min ?? 0), 0);
  const observationCount = bundle.inventory.filter((i) => i.discovered_by === 'observation').length;
  const sampledBaselines = bundle.baselines.filter((b) => {
    if (/未抽样/.test(b.source)) return false;
    return /抽样|台账|TMS|北斗|计时/.test(b.source);
  }).length;
  const systemCount = bundle.inventory.filter((i) => i.dimension === 'system').length;

  const methodRows = [
    `| 深度访谈 | ${bundle.interviews.length} 场，合计 ${interviewMinutes} 分钟（${bundle.interviews.filter((i) => i.status === 'confirmed').length} 场已确认） |`,
    `| 现场观察 | 盘点记录中 ${observationCount} 项来自现场观察 |`,
    `| 数据抽样 | ${sampledBaselines}/${bundle.baselines.length} 条基线来自抽样、台账或现场计时 |`,
    `| 系统盘点 | ${systemCount} 套系统入库 |`,
    `| 流程盘点 | ${bundle.processNodes.length} 个节点、${bundle.processEdges.length} 条连线 |`,
    `| 行业对标 | ${benchRows.length} 项物流核心指标（${benchRows.every((r) => r.calibrated) ? '已校准' : '经验值，待校准'}） |`,
  ];

  sections.push({
    key: 'scope_method',
    kind: 'scope_method',
    body: [
      `## ${num.scope}. 诊断范围与方法`,
      '',
      `### ${num.scope}.1 本次诊断回答的三个问题`,
      '',
      '1. 哪些环节的重复劳动最值得用 AI 替代？',
      '2. 我们的数据能不能支撑这些替代？',
      '3. 先做哪一个，能在半年内看到可验证的效果？',
      '',
      `### ${num.scope}.2 明确不在本次范围内`,
      '',
      '技术选型、详细架构、报价条款、组织架构调整建议。',
      '',
      `### ${num.scope}.3 方法`,
      '',
      '| 方法 | 执行情况 |',
      '|---|---|',
      ...methodRows,
      '',
      '**方法边界：** 访谈纪要为顾问手写整理，不做录音转写；数字来自数据库中的基线、盘点和财务快照，模板只负责措辞。',
    ].join('\n'),
  });

  // ----------------------------------------------------------- benchmark
  if (hasBench) {
    const lagging = benchRows.filter((r) => r.position === 'lagging');
    const excellent = benchRows.filter((r) => r.position === 'excellent');
    const unknown = benchRows.filter((r) => r.position === 'unknown');

    const reading: string[] = [];
    if (lagging.length) {
      reading.push(
        `**明确落后：${lagging.map((r) => r.metricName).join('、')}。** 这几项是本次诊断优先解释的对象。`,
      );
    }
    if (excellent.length) {
      reading.push(`**优于同行：${excellent.map((r) => r.metricName).join('、')}。** 不建议把资源继续压在这些环节。`);
    }
    if (unknown.length) {
      reading.push(`**客户值未获取：${unknown.map((r) => r.metricName).join('、')}。** 需要补采后才能判断位置。`);
    }
    if (!reading.length) {
      reading.push('本期指标均处于中位区间，没有明显落后项。');
    }

    sections.push({
      key: 'benchmark',
      kind: 'benchmark',
      body: [
        `## ${num.benchmark}. 行业定位`,
        '',
        '| 指标 | 客户值 | p25 | p50 | p75 | 位置 | 基准状态 |',
        '|---|---|---|---|---|---|---|',
        ...benchRows.map(
          (r) =>
            `| ${r.metricName}（${r.unit}） | ${r.value ?? '—'} | ${r.p25 ?? '—'} | ${r.p50 ?? '—'} | ${r.p75 ?? '—'} | ${POSITION_LABEL[r.position as keyof typeof POSITION_LABEL]} | ${r.calibrated ? '已校准' : '**未校准**'} |`,
        ),
        '',
        `### ${num.benchmark}.1 怎么读这张表`,
        '',
        reading.join('\n\n'),
        '',
        '> 分位边界规则：触发「落后」的那条边界归落后，其余边界归优。边界值原样呈现，不做四舍五入。',
        '> ⚠ 对标数据为行业经验值（`calibrated=false`），未用实样校准，仅作方向参考。',
      ].join('\n'),
    });
  }

  // ---------------------------------------------------- business (§3)
  if (hasBusiness) {
    const quantified = bundle.processNodes.filter(
      (n) => n.duration_min !== null || n.abnormal_rate !== null,
    );
    const implicit = bundle.processNodes.filter((n) => n.is_implicit);
    const branchNotes = bundle.processEdges.filter((e) => e.condition || e.label);

    sections.push({
      key: 'business',
      kind: 'business',
      body: [
        `## ${num.business}. 业务现状`,
        '',
        `### ${num.business}.1 业务链条`,
        '',
        renderProcessChain(bundle.processNodes, bundle.processEdges),
        branchNotes.length
          ? `\n> 分支条件：${branchNotes
              .map((e) => `${e.from_name} —[${e.condition ?? e.label}]→ ${e.to_name}`)
              .join('；')}。`
          : '',
        '',
        `### ${num.business}.2 关键环节量化`,
        '',
        '| 环节 | 泳道 | 类型 | 单均耗时 | 异常率 | 隐性 |',
        '|---|---|---|---|---|---|',
        ...quantified.map(
          (n) =>
            `| ${n.name} | ${n.lane} | ${NODE_TYPE_LABEL[n.node_type] ?? n.node_type} | ${n.duration_min !== null ? `${n.duration_min} 分钟` : '—'} | ${n.abnormal_rate !== null ? `${n.abnormal_rate}%` : '—'} | ${n.is_implicit ? '是' : '否'} |`,
        ),
        '',
        `### ${num.business}.3 隐性环节`,
        '',
        implicit.length
          ? [
              '| 隐性环节 | 所属 | 发现方式 |',
              '|---|---|---|',
              ...implicit.map(
                (n) =>
                  `| ${n.name} | ${n.lane} | ${DISCOVERED_BY_LABEL[n.discovered_by ?? ''] ?? n.discovered_by ?? '未记录'} |`,
              ),
              '',
              '> 这些环节通常不在任何流程文件里，却是 AI 机会的主要来源。',
            ].join('\n')
          : '本次未标记隐性环节。',
      ].join('\n'),
    });
  }

  // --------------------------------------------------- diagnosis (§4)
  if (hasDiagnosis) {
    const dimensions = ['business', 'data', 'system', 'org'].filter((d) =>
      bundle.inventory.some((i) => i.dimension === d),
    );
    const blocks: string[] = [`## ${num.diagnosis}. 四维诊断`, ''];
    dimensions.forEach((dim, idx) => {
      const items = bundle.inventory.filter((i) => i.dimension === dim);
      const avg = Math.round(items.reduce((a, i) => a + i.completeness, 0) / items.length);
      const unverified = items.filter((i) => !i.verified).length;
      blocks.push(
        `### ${num.diagnosis}.${idx + 1} ${DIMENSION_LABEL[dim] ?? dim}维度`,
        '',
        `> 本维度 ${items.length} 项盘点，平均完整度 ${avg}%，${unverified} 项尚未核实。`,
        '',
        '| 对象 | 类别 | 关键信息 | 完整度 | 核实 |',
        '|---|---|---|---|---|',
        ...items.map(
          (i) =>
            `| ${i.name} | ${i.category ?? '—'} | ${attributeSummary(dim, i.attributes)} | ${i.completeness}% | ${i.verified ? '已核实' : '未核实'} |`,
        ),
        '',
      );
    });
    sections.push({
      key: 'diagnosis',
      kind: 'diagnosis',
      body: blocks.join('\n'),
    });
  }

  // --------------------------------------------------------- pain points
  sections.push({
    key: 'pain_points',
    kind: 'pain_points',
    body: [
      `## ${num.pains}. 痛点清单`,
      '',
      '| 编号 | 痛点 | 环节 | 频次 | 严重度 | 量化影响 | 来源 |',
      '|---|---|---|---|---|---|---|',
      ...bundle.painPoints.map(
        (p) =>
          `| ${p.code} | ${p.description} | ${p.channel ?? '—'} | ${p.frequency ?? '—'} | ${p.severity ?? '—'} | ${p.quantified_impact ?? '待确认'} | ${p.source_ref} |`,
      ),
      '',
      `**共 ${bundle.painPoints.length} 条，全部有来源。**`,
    ].join('\n'),
  });

  // scope：紧跟痛点清单
  if (scope.length) {
    sections.push({
      key: 'scope',
      kind: 'scope',
      limitationIds: scope.map((l) => l.id),
      body: [
        `### ${num.pains}.1 本次覆盖的范围，以及没覆盖的`,
        '',
        '| 空缺 | 影响 | 说明 |',
        '|---|---|---|',
        ...scope.map(
          (l) => `| ${l.title} | ${l.affected_refs.join('、') || '全局'} | ${l.detail} |`,
        ),
      ].join('\n'),
    });
  }

  // ------------------------------------------------------ opportunity map
  sections.push({
    key: 'opportunity_map',
    kind: 'opportunity_map',
    body: [
      `## ${num.opps}. 机会地图`,
      '',
      `### ${num.opps}.1 评分方法`,
      '',
      '**评分 = V（价值）× F（可行性）× U（紧迫度）**；≥20 优先，12–19 候选，<12 搁置。',
      '',
      `### ${num.opps}.2 评分结果`,
      '',
      '| 编号 | 机会点 | V | F | U | 得分 | 档位 | 数据状态 | 阻断 | 路线 |',
      '|---|---|---|---|---|---|---|---|---|---|',
      ...bundle.opportunities.map((o) => {
        const blocker = o.has_tech_blocker ? '⚠ 技术阻断' : o.data_status === 'unavailable' ? '⚠ 数据不可得' : '—';
        return `| ${o.code} | ${o.title} | ${o.value_score} | ${o.feasibility_score} | ${o.urgency} | ${o.score} | ${o.priority_band} | ${o.data_status} | ${blocker} | ${o.target_phase ?? '—'} |`;
      }),
    ].join('\n'),
  });

  // ---------------------------------------------------------------- ROI
  const summaryRows = roiOpps.map((o) => {
    const r = roiFor(bundle, o.id)!;
    return `| ${o.code} | ${o.title} | ${r.realization_mode ?? '—'} (${fmt(r.realization_factor, 4)}) | ${money(r.neutral_value)} | ${money(r.realized_value)} | ${money(r.one_time_cost)} | ${fmt(r.payback_months)} 个月 |`;
  });

  const comboRows: string[] = [];
  if (singlePortfolio) {
    comboRows.push(
      `| 只做 ${singlePortfolio.codes.join(' + ')} | ${money(singlePortfolio.realized)} | ${money(singlePortfolio.investment)} | ${money(singlePortfolio.annualOps)} | ${fmt(singlePortfolio.paybackMonths)} 个月 | ${fmt(singlePortfolio.paybackMonthsWithOps)} 个月 |`,
    );
  }
  if (phase1Portfolio.count && phase1Portfolio.codes.join() !== singlePortfolio?.codes.join()) {
    comboRows.push(
      `| 一期（${phase1Portfolio.codes.join(' + ')}） | ${money(phase1Portfolio.realized)} | ${money(phase1Portfolio.investment)} | ${money(phase1Portfolio.annualOps)} | ${fmt(phase1Portfolio.paybackMonths)} 个月 | ${fmt(phase1Portfolio.paybackMonthsWithOps)} 个月 |`,
    );
  }
  comboRows.push(
    `| **核心组合（${corePortfolio.codes.join(' + ')}）** | **${money(corePortfolio.realized)}** | **${money(corePortfolio.investment)}** | **${money(corePortfolio.annualOps)}** | **${fmt(corePortfolio.paybackMonths)} 个月** | **${fmt(corePortfolio.paybackMonthsWithOps)} 个月** |`,
  );
  if (portfolio.codes.join() !== corePortfolio.codes.join()) {
    comboRows.push(
      `| 全部一期 + 二期（${portfolio.codes.join(' + ')}） | ${money(portfolio.realized)} | ${money(portfolio.investment)} | ${money(portfolio.annualOps)} | ${fmt(portfolio.paybackMonths)} 个月 | ${fmt(portfolio.paybackMonthsWithOps)} 个月 |`,
    );
  }

  sections.push({
    key: 'roi_summary',
    kind: 'roi',
    body: [
      `## ${num.roi}. ROI 测算`,
      '',
      `### ${num.roi}.1 汇总`,
      '',
      '| 编号 | 机会点 | 实现形态（系数） | 理论收益 | 可实现收益 | 投入 | 回本 |',
      '|---|---|---|---|---|---|---|',
      ...summaryRows,
      '',
      `### ${num.roi}.2 组合测算`,
      '',
      '| 组合 | 可实现收益 | 一次性投入 | 年运维 | 回本（系统口径） | 含运维 |',
      '|---|---|---|---|---|---|',
      ...comboRows,
      '',
      '> 系统口径 = 一次性投入 ÷ (年收益 ÷ 12)；含运维 = 投入 ÷ ((年收益 − 年运维) ÷ 12)。对外汇报建议用含运维口径。',
      '',
      '> 折算系数不由顾问手填，而是由每张卡的传导链连乘得出（R5-C12 校验两者相等）。',
    ].join('\n'),
  });

  const emittedAmount = new Set<string>();

  roiOpps.forEach((o, idx) => {
    const r = roiFor(bundle, o.id)!;
    const stages = chainFor(bundle, o.id);
    const derived = derivedFor(bundle, o.id);
    const product = chainProduct(stages);
    const impacts = stageImpacts(r.neutral_value, stages);
    const roiNum = `${num.roi}.${idx + 3}`;

    const chainRows = stages
      .sort((a, b) => a.stage - b.stage)
      .map(
        (s) =>
          `| ${s.stage} | ${s.variable_label} | ${s.base_value ?? '—'}${s.unit ?? ''} | ×${fmt(s.mult_base, 2)} | ${s.controllable ? '✅' : '❌'} | ${s.owner_role ?? '—'} |${s.shape === 'threshold' ? ' ⚠ 阈值型' : ''} |`,
      );

    const impactRows = impacts.map(
      (i) =>
        `| ${i.variableLabel} | ${i.lowValue ?? '—'}${i.unit ?? ''} | ${money(i.realizedIfLow)} | **−${fmt(i.loss)} 万** |${i.shape === 'threshold' ? ' 线性近似，实际更陡 |' : ' |'}`,
    );

    const thresholdNotes = impacts
      .filter((i) => i.shape === 'threshold' && i.thresholdNote)
      .map((i) => `> **${i.variableLabel}是阈值型变量**：${i.thresholdNote}。\n> 因此单段恶化表里的数字只是线性近似，不能用来回答「准确率 88% 会怎样」。`);

    sections.push({
      key: `roi:${o.code}`,
      kind: 'roi',
      ref: o.code,
      body: [
        `### ${roiNum} ${o.code} · ${o.title}`,
        '',
        `**理论收益 ${money(r.neutral_value)} → 可实现收益 ${money(r.realized_value)}**（系数 ${fmt(product ?? r.realization_factor, 4)}）`,
        '',
        '| 段 | 变量 | 基准取值 | 系数 | 可干预 | 责任方 | |',
        '|---|---|---|---|---|---|---|',
        ...chainRows,
        `| 终点 | **可实现年化收益** | | **${fmt(product ?? r.realization_factor, 4)}** | | | **${money(r.realized_value)}** |`,
        '',
        derived.length
          ? `> 灰线（派生，不参与乘法）：${derived.map((d) => `${d.variable_label} ≈ ${d.base_value ?? '—'}${d.unit ?? ''}（由 ${d.depends_on.join(' × ')} 决定）`).join('；')}`
          : '',
        '',
        '**单段恶化（其余各段保持基准）：**',
        '',
        '| 恶化的段 | 悲观取值 | 可实现收益 | 损失 | 说明 |',
        '|---|---|---|---|---|',
        ...impactRows,
        '',
        ...thresholdNotes,
        '',
        `实现形态：\`${r.realization_mode ?? '未选'}\`，判断理由：${r.realization_note ?? '—'}`,
        r.assumptions_note ? `\n口径假设：${r.assumptions_note}` : '',
        r.annual_cost > 0
          ? `\n含运维口径回本：**${fmt(r.payback_months_with_ops)} 个月**（年运维 ${money(r.annual_cost)}）。`
          : '',
      ]
        .filter((x) => x !== '')
        .join('\n'),
    });

    // amount 类局限：紧跟它质疑的那张 ROI 卡（C14）
    let sub = 1;
    for (const l of amount) {
      if (emittedAmount.has(l.id)) continue;
      if (!l.affected_refs.includes(o.code)) continue;
      emittedAmount.add(l.id);
      sections.push({
        key: `amount:${l.id}`,
        kind: 'amount_limitation',
        ref: o.code,
        limitationIds: [l.id],
        body: [
          `#### ${roiNum}.${sub++} 这些数字还不能对外承诺（${l.affected_refs.join('、')}）`,
          '',
          `**${l.title}**`,
          '',
          l.detail,
          '',
          '> 在这个数字被验证之前，不应写进任何对客户的正式承诺。',
        ].join('\n'),
      });
    }
  });

  // 未被任何 ROI 段接住的 amount 局限：仍然写出来，但 C14 会报错
  const orphanAmount = amount.filter((l) => !emittedAmount.has(l.id));
  if (orphanAmount.length) {
    sections.push({
      key: 'amount_orphan',
      kind: 'amount_limitation',
      limitationIds: orphanAmount.map((l) => l.id),
      body: [
        `#### ${num.roi}.${2 + roiOpps.length + 1} 未能归位的金额类局限`,
        '',
        ...orphanAmount.map((l) => `- **${l.title}**：${l.detail}`),
      ].join('\n'),
    });
  }

  // ------------------------------------------------------------ roadmap
  const route = [...opps].sort((a, b) => b.score - a.score);
  const deps = bundle.dependencies;
  let roadmapSub = 1;
  const roadmapBlocks: string[] = [`## ${num.roadmap}. 依赖与路线`, ''];
  if (deps.length) {
    roadmapBlocks.push(
      `### ${num.roadmap}.${roadmapSub++} 机会点依赖关系`,
      '',
      '```mermaid',
      dependencyMermaid(deps, bundle.opportunities),
      '```',
      '',
      '**依赖明细：**',
      '',
      '| 机会点 | 关系 | 关联机会点 | 说明 |',
      '|---|---|---|---|',
      ...deps.map(
        (d) =>
          `| ${d.from_code} | ${d.type === 'requires' ? '依赖' : d.type === 'blocks' ? '阻断' : '使能'} | ${d.to_code} | ${d.note ?? '—'} |`,
      ),
      '',
    );
  }
  roadmapBlocks.push(
    `### ${num.roadmap}.${roadmapSub} 推荐路线`,
    '',
    '| 期次 | 机会点 | 得分 | 前置依赖 | 说明 |',
    '|---|---|---|---|---|',
    ...route.map((o) => {
      const requires = deps
        .filter((d) => d.from_id === o.id && d.type === 'requires')
        .map((d) => d.to_code);
      return `| ${o.target_phase} | ${o.code} ${o.title} | ${o.score} | ${requires.length ? requires.join('、') : '—'} | ${o.score_rationale} |`;
    }),
    '',
    '> 被 `killed` / `parked` 的机会点不进入推荐路线；技术阻断未解除的不进入 `designed`。',
  );
  sections.push({
    key: 'roadmap',
    kind: 'roadmap',
    body: roadmapBlocks.join('\n'),
  });

  // --------------------------------------------------------------- risk
  if (hasRisk) {
    sections.push({
      key: 'risk',
      kind: 'risk',
      body: [
        `## ${num.risk}. 风险与阻断`,
        '',
        '| 风险 | 类型 | 概率 | 影响 | 应对 | 来源 |',
        '|---|---|---|---|---|---|',
        ...riskRows.map(
          (r) =>
            `| ${r.title} | ${RISK_CATEGORY_LABEL[r.category] ?? r.category} | ${r.probability ?? '—'} | ${r.impact ?? '—'} | ${r.mitigation} | ${r.source} |`,
        ),
        '',
        '> 概率/影响为 1–5 分；评为「—」的条目来自结构化字段自动识别（技术阻断、数据不可得、低置信度基线），尚未人工评分。',
      ].join('\n'),
    });
  }

  // ------------------------------------------------------------- method
  if (hasMethod) {
    sections.push({
      key: 'method',
      kind: 'method',
      limitationIds: method.map((l) => l.id),
      body: [
        `## ${num.method}. 关于方法与口径的说明`,
        '',
        `> 本章为方法层面的说明，不影响上面的金额判断。影响金额的局限已放到对应 ROI 卡之后，影响范围的已放到 ${num.pains}.1。`,
        '',
        ...method.map((l, i) => `${i + 1}. **${l.title}** —— ${l.detail}`),
      ].join('\n'),
    });
  }

  // internal 类完全丢弃：不进客户文档（C13）
  const markdown = sections.map((s) => s.body).join('\n\n---\n\n') + '\n';

  return {
    markdown,
    sections,
    portfolio,
    corePortfolio,
    phase1Portfolio,
    singlePortfolio,
    amountLimitations: amount,
    scopeLimitations: scope,
    methodLimitations: method,
    excludedInternal: internal,
  };
}
