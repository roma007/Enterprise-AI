import { fmtLocalDateTime } from './time';
import { one, query } from '../db';

export type SolutionDocType = 'proposal' | 'architecture' | 'prd' | 'acceptance';

export interface SolutionBundle {
  solution: any;
  components: any[];
  integrations: any[];
  acceptance: any[];
  reviews: any[];
}

const PHASE_LABEL: Record<string, string> = {
  phase1: '一期',
  phase2: '二期',
  watch: '观望',
};

const COMPONENT_LABEL: Record<string, string> = {
  build: '自研',
  buy: '采购',
  integrate: '集成',
  service: '服务',
};

const DIRECTION_LABEL: Record<string, string> = {
  inbound: '入站',
  outbound: '出站',
  bidirectional: '双向',
};

const ACCEPTANCE_LABEL: Record<string, string> = {
  pending: '待验证',
  met: '已达成',
  not_met: '未达成',
  waived: '豁免',
};

const statusLabel: Record<string, string> = {
  draft: '草稿',
  in_review: '评审中',
  approved: '已批准',
  rejected: '已驳回',
  archived: '已归档',
};

const table = (headers: string[], rows: string[][]) =>
  [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');

const section = (title: string, body: string | null | undefined) =>
  `### ${title}\n\n${body?.trim() || '—'}`;

export async function loadSolutionBundle(
  solutionId: string,
  orgId?: string,
): Promise<SolutionBundle | null> {
  const solution = await one<any>(
    `SELECT s.*, o.code AS opportunity_code, o.title AS opportunity_title,
            o.description AS opportunity_description, o.target_phase,
            o.value_score, o.feasibility_score, o.urgency, o.score,
            e.id AS engagement_id, e.name AS engagement_name, e.stage,
            c.name AS client_name
       FROM solutions s
       JOIN opportunities o ON o.id = s.opportunity_id
       JOIN engagements e ON e.id = o.engagement_id
       JOIN clients c ON c.id = e.client_id
      WHERE s.id = $1
        AND e.deleted_at IS NULL AND c.deleted_at IS NULL
        ${orgId ? 'AND e.org_id = $2' : ''}`,
    orgId ? [solutionId, orgId] : [solutionId],
  );
  if (!solution) return null;

  const [components, integrations, acceptance, reviews] = await Promise.all([
    query(`SELECT * FROM solution_components WHERE solution_id = $1 ORDER BY sort_order, name`, [
      solutionId,
    ]),
    query(`SELECT * FROM integrations WHERE solution_id = $1 ORDER BY sort_order, system`, [
      solutionId,
    ]),
    query(
      `SELECT * FROM acceptance_criteria WHERE solution_id = $1 ORDER BY sort_order, metric`,
      [solutionId],
    ),
    query(
      `SELECT r.*, u.name AS reviewer_name FROM solution_reviews r
         LEFT JOIN users u ON u.id = r.reviewer
        WHERE r.solution_id = $1 ORDER BY r.reviewed_at DESC`,
      [solutionId],
    ),
  ]);

  return { solution, components, integrations, acceptance, reviews };
}

export function renderSolutionDoc(
  bundle: SolutionBundle,
  type: SolutionDocType,
): { title: string; markdown: string; meta: { client: string; project: string; version: string } } {
  const s = bundle.solution;
  const meta = {
    client: s.client_name,
    project: s.engagement_name,
    version: `v${s.version}`,
  };
  const title = `${s.opportunity_title} · ${
    type === 'proposal'
      ? '方案说明书'
      : type === 'architecture'
        ? '技术架构与集成方案'
        : type === 'prd'
          ? '产品需求文档（PRD 骨架）'
          : '验收标准'
  }`;
  const head = [
    `# ${s.client_name} · ${title}`,
    '',
    `> 项目：${s.engagement_name}　｜　机会点：${s.opportunity_code} ${s.opportunity_title}　｜　方案版本：v${s.version}　｜　状态：${statusLabel[s.status] ?? s.status}`,
    `> 目标期：${PHASE_LABEL[s.target_phase] ?? s.target_phase ?? '—'}　｜　生成时间：${fmtLocalDateTime()}`,
  ];

  const componentTable = table(
    ['组件', '类型', '说明'],
    bundle.components.map((c) => [
      c.name,
      COMPONENT_LABEL[c.type] ?? c.type,
      c.description ?? '—',
    ]),
  );

  const integrationTable = table(
    ['系统', '方向', '协议', '字段', '频率', '责任方', '风险'],
    bundle.integrations.map((i) => [
      i.system,
      DIRECTION_LABEL[i.direction] ?? i.direction,
      i.protocol ?? '—',
      i.fields ?? '—',
      i.frequency ?? '—',
      i.owner ?? '—',
      i.risk ?? '—',
    ]),
  );

  const acceptanceTable = table(
    ['指标', '基线', '目标', '验证方法', '责任人', '状态'],
    bundle.acceptance.map((a) => [
      a.metric,
      a.baseline ?? '—',
      a.target,
      a.method,
      a.owner ?? '—',
      ACCEPTANCE_LABEL[a.status] ?? a.status,
    ]),
  );

  const reviewLine = bundle.reviews.length
    ? bundle.reviews
        .map(
          (r) =>
            `- ${new Date(r.reviewed_at).toISOString().slice(0, 10)} ${r.reviewer_name ?? '—'}：${r.decision}${r.comments ? `（${r.comments}）` : ''}`,
        )
        .join('\n')
    : '- 尚无评审记录。';

  if (type === 'architecture') {
    return {
      title,
      meta,
      markdown: [
        ...head,
        '',
        '## 1. 总体架构',
        '',
        s.architecture?.trim() || '待补充。',
        '',
        '## 2. 方案组件',
        '',
        componentTable,
        '',
        '## 3. 集成清单',
        '',
        bundle.integrations.length ? integrationTable : '本期无外部系统集成。',
        '',
        '## 4. 部署方式',
        '',
        s.deployment?.trim() || '待确认。',
        '',
        '## 5. 安全与数据边界',
        '',
        s.security?.trim() || '待确认。',
        '',
        '## 6. 关键假设与待确认',
        '',
        section('关键假设', s.assumptions),
        '',
        section('待确认', s.exclusions ? `排除项：${s.exclusions}` : '接口文档、网络策略、账号权限待客户确认。'),
      ].join('\n'),
    };
  }

  if (type === 'prd') {
    return {
      title,
      meta,
      markdown: [
        ...head,
        '',
        '## 1. 背景与目标',
        '',
        s.opportunity_description?.trim() || s.scope,
        '',
        '## 2. 用户与场景',
        '',
        '| 角色 | 场景 | 期望 |',
        '|---|---|---|',
        '| 客户业务人员 | 日常业务操作 | 少手工、可追溯 |',
        '| 客户 IT | 系统对接与运维 | 接口清晰、可监控 |',
        '| 供应商交付 | 实施与验收 | 范围明确、可测试 |',
        '',
        '> 以上为 PRD 骨架，具体交互与字段需产品负责人在方案评审后补全。',
        '',
        '## 3. 范围',
        '',
        s.scope,
        '',
        '## 4. 功能能力（按方案组件）',
        '',
        componentTable,
        '',
        '## 5. 非功能需求',
        '',
        `- 部署：${s.deployment || '待确认'}`,
        `- 安全：${s.security || '待确认'}`,
        '- 性能、可用性、审计要求需在 G2 前补齐。',
        '',
        '## 6. 验收标准',
        '',
        bundle.acceptance.length ? acceptanceTable : '待补充。',
        '',
        '## 7. 排除项',
        '',
        s.exclusions?.trim() || '—',
      ].join('\n'),
    };
  }

  if (type === 'acceptance') {
    return {
      title,
      meta,
      markdown: [
        ...head,
        '',
        '## 1. 验收原则',
        '',
        '验收以基线、目标和可复核的测量方法为准；不以“感觉好用”作为通过条件。',
        '',
        '## 2. 验收指标',
        '',
        bundle.acceptance.length ? acceptanceTable : '尚未录入验收标准。',
        '',
        '## 3. 测量方法',
        '',
        '每个指标按上表的验证方法执行；抽样、样本量和统计口径需在 POC 前锁定。',
        '',
        '## 4. 未达成处理',
        '',
        '未达成时记录差距、原因与补救计划；涉及合同条款的，按报价单/合同约定处理。',
        '',
        '## 5. 评审记录',
        '',
        reviewLine,
      ].join('\n'),
    };
  }

  return {
    title,
    meta,
    markdown: [
      ...head,
      '',
      '## 1. 背景与目标',
      '',
      s.opportunity_description?.trim() || '—',
      '',
      `- 价值评分：V${s.value_score} × F${s.feasibility_score} × U${s.urgency} = ${s.score}`,
      `- 目标期：${PHASE_LABEL[s.target_phase] ?? s.target_phase ?? '—'}`,
      '',
      '## 2. 方案范围',
      '',
      s.scope,
      '',
      '### 2.1 明确不做',
      '',
      s.exclusions?.trim() || '—',
      '',
      '## 3. 技术路线',
      '',
      s.approach?.trim() || '待补充。',
      '',
      '## 4. 架构与部署',
      '',
      section('架构', s.architecture),
      '',
      section('部署', s.deployment),
      '',
      section('安全', s.security),
      '',
      '## 5. 方案组件',
      '',
      componentTable,
      '',
      '## 6. 集成清单',
      '',
      bundle.integrations.length ? integrationTable : '本期无外部系统集成。',
      '',
      '## 7. 验收标准',
      '',
      bundle.acceptance.length ? acceptanceTable : '待补充。',
      '',
      '## 8. 关键假设',
      '',
      s.assumptions?.trim() || '—',
      '',
      '## 9. 评审记录',
      '',
      reviewLine,
      '',
      '> 本方案书不包含内部工作量成本与毛利；报价另附。',
    ].join('\n'),
  };
}
