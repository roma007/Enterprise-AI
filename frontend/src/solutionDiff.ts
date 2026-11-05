import type { SolutionDetail } from './types';

export interface SolutionFieldDiff {
  key: string;
  label: string;
  before: string;
  after: string;
  changed: boolean;
}

export interface NamedDiff {
  name: string;
  status: 'added' | 'removed' | 'changed' | 'same';
  detail: string;
}

export interface SolutionDiff {
  versionBefore: number;
  versionAfter: number;
  fields: SolutionFieldDiff[];
  components: NamedDiff[];
  integrations: NamedDiff[];
  acceptance: NamedDiff[];
  workloadBefore: number;
  workloadAfter: number;
  changedCount: number;
}

export type QuoteCoverageLevel = 'unknown' | 'missing' | 'under' | 'ok';

export interface QuoteCoverage {
  level: QuoteCoverageLevel;
  /** 一次性报价 / 工作量成本；成本未估算时为 null。 */
  ratio: number | null;
  /** 报价减成本（万元）；负值表示毛利为负。 */
  margin: number;
}

/** 报价覆盖率：仅用于提示，不替代商务判断。 */
export function quoteCoverage(
  quoteOneTime?: number,
  workloadCost?: number,
): QuoteCoverage {
  const rawQuote = Number(quoteOneTime ?? 0);
  const rawCost = Number(workloadCost ?? 0);
  const quote = Number.isFinite(rawQuote) ? Math.max(0, rawQuote) : 0;
  const cost = Number.isFinite(rawCost) ? Math.max(0, rawCost) : 0;
  if (cost <= 0) return { level: 'unknown', ratio: null, margin: 0 };
  if (quote <= 0) return { level: 'missing', ratio: 0, margin: -cost };
  const ratio = quote / cost;
  return quote + 1e-9 < cost
    ? { level: 'under', ratio, margin: quote - cost }
    : { level: 'ok', ratio, margin: quote - cost };
}

const FIELD_LABELS: Array<[keyof SolutionDetail['item'], string]> = [
  ['status', '状态'],
  ['scope', '范围'],
  ['approach', '方案思路'],
  ['architecture', '架构'],
  ['deployment', '部署'],
  ['security', '安全'],
  ['assumptions', '假设'],
  ['exclusions', '排除项'],
];

const text = (value: unknown) =>
  value == null ? '' : String(value).trim();

function diffNamed(
  before: Array<{ name: string; signature: string }>,
  after: Array<{ name: string; signature: string }>,
): NamedDiff[] {
  const beforeMap = new Map(before.map((item) => [item.name, item.signature]));
  const afterMap = new Map(after.map((item) => [item.name, item.signature]));
  const names = Array.from(new Set([...beforeMap.keys(), ...afterMap.keys()])).sort();
  return names.map((name) => {
    const a = beforeMap.get(name);
    const b = afterMap.get(name);
    if (a === undefined) return { name, status: 'added', detail: b ?? '' };
    if (b === undefined) return { name, status: 'removed', detail: a };
    return { name, status: a === b ? 'same' : 'changed', detail: b };
  });
}

/** 比较两个方案版本；纯函数，便于组件单测。 */
export function diffSolutionDetails(
  before: SolutionDetail,
  after: SolutionDetail,
): SolutionDiff {
  const fields = FIELD_LABELS.map(([key, label]) => {
    const a = text(before.item[key]);
    const b = text(after.item[key]);
    return { key: String(key), label, before: a, after: b, changed: a !== b };
  });
  const components = diffNamed(
    before.components.map((item) => ({
      name: item.name,
      signature: `${item.type}|${item.effort_days}|${item.description ?? ''}`,
    })),
    after.components.map((item) => ({
      name: item.name,
      signature: `${item.type}|${item.effort_days}|${item.description ?? ''}`,
    })),
  );
  const integrations = diffNamed(
    before.integrations.map((item) => ({
      name: item.system,
      signature: `${item.direction}|${item.protocol ?? ''}|${item.frequency ?? ''}|${item.owner ?? ''}|${item.risk ?? ''}`,
    })),
    after.integrations.map((item) => ({
      name: item.system,
      signature: `${item.direction}|${item.protocol ?? ''}|${item.frequency ?? ''}|${item.owner ?? ''}|${item.risk ?? ''}`,
    })),
  );
  const acceptance = diffNamed(
    before.acceptanceCriteria.map((item) => ({
      name: item.metric,
      signature: `${item.baseline ?? ''}|${item.target}|${item.method}|${item.status}`,
    })),
    after.acceptanceCriteria.map((item) => ({
      name: item.metric,
      signature: `${item.baseline ?? ''}|${item.target}|${item.method}|${item.status}`,
    })),
  );
  const changedCount =
    fields.filter((field) => field.changed).length +
    components.filter((item) => item.status !== 'same').length +
    integrations.filter((item) => item.status !== 'same').length +
    acceptance.filter((item) => item.status !== 'same').length +
    (before.workloadTotal !== after.workloadTotal ? 1 : 0);
  return {
    versionBefore: before.item.version,
    versionAfter: after.item.version,
    fields,
    components,
    integrations,
    acceptance,
    workloadBefore: before.workloadTotal,
    workloadAfter: after.workloadTotal,
    changedCount,
  };
}
const STATUS_LABEL: Record<NamedDiff['status'], string> = {
  added: '新增',
  removed: '删除',
  changed: '变更',
  same: '未变',
};

/** 版本对比 Markdown，便于贴到评审纪要/邮件；客户版隐藏内部成本。 */
export function solutionDiffMarkdown(
  diff: SolutionDiff,
  audience: 'internal' | 'customer' = 'internal',
): string {
  const lines: string[] = [
    `# 方案版本对比：v${diff.versionBefore} → v${diff.versionAfter}`,
    '',
    `- 变化点：${diff.changedCount}`,
  ];
  if (audience === 'internal') {
    lines.push(
      `- 工作量成本：${diff.workloadBefore} → ${diff.workloadAfter} 万元（内部口径）`,
    );
  }
  lines.push('', '## 概要字段', '', '| 字段 | 基准 | 对比 |', '|---|---|---|');
  const changedFields = diff.fields.filter((field) => field.changed);
  if (!changedFields.length) lines.push('| — | 无变化 | — |');
  for (const field of changedFields) {
    lines.push(`| ${field.label} | ${field.before || '—'} | ${field.after || '—'} |`);
  }
  const sections: Array<[string, NamedDiff[]]> = [
    ['组件', diff.components],
    ['集成', diff.integrations],
    ['验收标准', diff.acceptance],
  ];
  for (const [label, items] of sections) {
    lines.push('', `## ${label}`, '');
    const changed = items.filter((item) => item.status !== 'same');
    if (!changed.length) {
      lines.push('- 无变化');
      continue;
    }
    for (const item of changed) {
      lines.push(
        `- ${STATUS_LABEL[item.status]}：${item.name}${item.detail ? `（${item.detail}）` : ''}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

/** 版本对比 CSV（含概要字段与三类明细）；客户版隐藏内部成本。 */
export function solutionDiffCsv(
  diff: SolutionDiff,
  audience: 'internal' | 'customer' = 'internal',
): string {
  const cell = (value: unknown) => {
    let text = value == null ? '' : String(value);
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const lines = [
    ['类型', '名称', '变化', '基准', '对比'].map(cell).join(','),
  ];
  for (const field of diff.fields.filter((item) => item.changed)) {
    lines.push(
      [cell('概要'), cell(field.label), cell('变更'), cell(field.before), cell(field.after)].join(','),
    );
  }
  for (const item of diff.components.filter((item) => item.status !== 'same')) {
    lines.push([cell('组件'), cell(item.name), cell(STATUS_LABEL[item.status]), cell(''), cell(item.detail)].join(','));
  }
  for (const item of diff.integrations.filter((item) => item.status !== 'same')) {
    lines.push([cell('集成'), cell(item.name), cell(STATUS_LABEL[item.status]), cell(''), cell(item.detail)].join(','));
  }
  for (const item of diff.acceptance.filter((item) => item.status !== 'same')) {
    lines.push([cell('验收标准'), cell(item.name), cell(STATUS_LABEL[item.status]), cell(''), cell(item.detail)].join(','));
  }
  if (audience === 'internal' && diff.workloadBefore !== diff.workloadAfter) {
    lines.push([
      cell('工作量成本'),
      cell('合计人天'),
      cell('变更'),
      cell(diff.workloadBefore),
      cell(diff.workloadAfter),
    ].join(','));
  }
  return `\uFEFF${lines.join('\r\n')}`;
}
