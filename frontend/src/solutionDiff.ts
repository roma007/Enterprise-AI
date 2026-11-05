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
