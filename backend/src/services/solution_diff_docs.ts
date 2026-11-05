import { loadSolutionBundle, type SolutionBundle } from './solution_docs';

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  in_review: '评审中',
  approved: '已批准',
  rejected: '已驳回',
  archived: '已归档',
};

const DIFF_LABEL: Record<string, string> = {
  added: '新增',
  removed: '删除',
  changed: '变更',
  same: '未变',
};

const text = (value: unknown) => (value == null ? '' : String(value).trim());

function namedDiff(
  before: Array<{ name: string; signature: string }>,
  after: Array<{ name: string; signature: string }>,
) {
  const a = new Map(before.map((item) => [item.name, item.signature]));
  const b = new Map(after.map((item) => [item.name, item.signature]));
  return Array.from(new Set([...a.keys(), ...b.keys()]))
    .sort()
    .map((name) => {
      const left = a.get(name);
      const right = b.get(name);
      if (left === undefined) return { name, status: 'added', detail: right ?? '' };
      if (right === undefined) return { name, status: 'removed', detail: left };
      return { name, status: left === right ? 'same' : 'changed', detail: right };
    });
}

type Bundle = SolutionBundle;

/** 生成两个方案版本的 Markdown 对比稿，供 Word 导出复用。 */
export function renderSolutionCompare(
  before: Bundle,
  after: Bundle,
  beforeWorkloadCost = 0,
  afterWorkloadCost = 0,
): { title: string; markdown: string; meta: { client: string; project: string; version: string } } {
  const s1 = before.solution;
  const s2 = after.solution;
  const title = `${s1.opportunity_title} · 方案版本对比 v${s1.version} → v${s2.version}`;
  const fields: Array<[string, string, string]> = [
    ['状态', STATUS_LABEL[s1.status] ?? s1.status, STATUS_LABEL[s2.status] ?? s2.status],
    ['范围', text(s1.scope), text(s2.scope)],
    ['方案思路', text(s1.approach), text(s2.approach)],
    ['架构', text(s1.architecture), text(s2.architecture)],
    ['部署', text(s1.deployment), text(s2.deployment)],
    ['安全', text(s1.security), text(s2.security)],
    ['假设', text(s1.assumptions), text(s2.assumptions)],
    ['排除项', text(s1.exclusions), text(s2.exclusions)],
  ];
  const changedFields = fields.filter(([, a, b]) => a !== b);

  const components = namedDiff(
    before.components.map((item) => ({
      name: item.name,
      signature: `${item.type}|${item.effort_days}|${item.description ?? ''}`,
    })),
    after.components.map((item) => ({
      name: item.name,
      signature: `${item.type}|${item.effort_days}|${item.description ?? ''}`,
    })),
  );
  const integrations = namedDiff(
    before.integrations.map((item) => ({
      name: item.system,
      signature: `${item.direction}|${item.protocol ?? ''}|${item.frequency ?? ''}|${item.owner ?? ''}|${item.risk ?? ''}`,
    })),
    after.integrations.map((item) => ({
      name: item.system,
      signature: `${item.direction}|${item.protocol ?? ''}|${item.frequency ?? ''}|${item.owner ?? ''}|${item.risk ?? ''}`,
    })),
  );
  const acceptance = namedDiff(
    before.acceptance.map((item) => ({
      name: item.metric,
      signature: `${item.baseline ?? ''}|${item.target}|${item.method}|${item.status}`,
    })),
    after.acceptance.map((item) => ({
      name: item.metric,
      signature: `${item.baseline ?? ''}|${item.target}|${item.method}|${item.status}`,
    })),
  );

  const table = (headers: string[], rows: string[][]) =>
    [
      `| ${headers.join(' | ')} |`,
      `|${headers.map(() => '---').join('|')}|`,
      ...rows.map((row) => `| ${row.join(' | ')} |`),
    ].join('\n');

  const lines = [
    `# ${title}`,
    '',
    `> 客户：${s1.client_name} ｜ 项目：${s1.engagement_name} ｜ 机会点：${s1.opportunity_code}`,
    '',
    `- 工作量成本：${beforeWorkloadCost} → ${afterWorkloadCost} 万元（内部口径）`,
    '',
    '## 一、概要字段',
    '',
    changedFields.length
      ? table(['字段', '基准', '对比'], changedFields.map(([label, a, b]) => [label, a || '—', b || '—']))
      : '无变化。',
  ];

  const sections: Array<[string, Array<{ name: string; status: string; detail: string }>]> = [
    ['二、组件', components],
    ['三、集成', integrations],
    ['四、验收标准', acceptance],
  ];
  for (const [heading, items] of sections) {
    const changed = items.filter((item) => item.status !== 'same');
    lines.push('', `## ${heading}`, '');
    if (!changed.length) {
      lines.push('无变化。');
    } else {
      for (const item of changed) {
        lines.push(
          `- **${DIFF_LABEL[item.status] ?? item.status}**：${item.name}${item.detail ? `（${item.detail}）` : ''}`,
        );
      }
    }
  }
  lines.push('', '> 本对比稿用于内部评审；客户版交付物以正式方案书/报价单为准。');
  return {
    title,
    markdown: `${lines.join('\n')}\n`,
    meta: {
      client: s1.client_name,
      project: s1.engagement_name,
      version: `v${s1.version} → v${s2.version}`,
    },
  };
}
