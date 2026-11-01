import { fmtLocalDateTime } from './time';
import { one, query } from '../db';

export interface PocBundle {
  experiment: any;
  datasets: any[];
  runs: any[];
  reviews: any[];
  conclusion: any | null;
}

const DECISION_LABEL: Record<string, string> = {
  go: 'Go（通过）',
  no_go: 'No-Go（不通过）',
  conditional: '有条件通过',
  pending: '待定',
};

const ACCESS_LABEL: Record<string, string> = {
  pending: '待申请',
  approved: '已批准',
  rejected: '已拒绝',
  not_required: '无需申请',
};

const table = (headers: string[], rows: string[][]) =>
  [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');

export async function loadPocBundle(
  experimentId: string,
  orgId?: string,
): Promise<PocBundle | null> {
  const experiment = await one<any>(
    `SELECT e.*, o.code AS opportunity_code, o.title AS opportunity_title,
            o.description AS opportunity_description, o.target_phase, o.score,
            en.id AS engagement_id, en.name AS engagement_name, en.stage AS engagement_stage,
            c.name AS client_name
       FROM poc_experiments e
       JOIN opportunities o ON o.id = e.opportunity_id
       JOIN engagements en ON en.id = o.engagement_id
       JOIN clients c ON c.id = en.client_id
      WHERE e.id = $1
        AND en.deleted_at IS NULL AND c.deleted_at IS NULL
        ${orgId ? 'AND en.org_id = $2' : ''}`,
    orgId ? [experimentId, orgId] : [experimentId],
  );
  if (!experiment) return null;

  const [datasets, runs, reviews, conclusion] = await Promise.all([
    query(`SELECT * FROM poc_datasets WHERE experiment_id = $1 ORDER BY created_at`, [experimentId]),
    query(
      `SELECT r.*, d.name AS dataset_name
         FROM poc_runs r LEFT JOIN poc_datasets d ON d.id = r.dataset_id
        WHERE r.experiment_id = $1 ORDER BY r.run_no DESC`,
      [experimentId],
    ),
    query(
      `SELECT rv.*, u.name AS reviewer_name
         FROM poc_reviews rv
         JOIN poc_runs r ON r.id = rv.run_id
         LEFT JOIN users u ON u.id = rv.reviewer
        WHERE r.experiment_id = $1 ORDER BY rv.reviewed_at DESC`,
      [experimentId],
    ),
    one(`SELECT * FROM poc_conclusions WHERE experiment_id = $1`, [experimentId]),
  ]);

  return { experiment, datasets, runs, reviews, conclusion };
}

export function renderPocDoc(bundle: PocBundle): {
  title: string;
  markdown: string;
  meta: { client: string; project: string; version: string };
} {
  const e = bundle.experiment;
  const title = `${e.opportunity_title} · POC 验证报告`;
  const meta = {
    client: e.client_name,
    project: e.engagement_name,
    version: `v${e.version}`,
  };

  const datasetTable = bundle.datasets.length
    ? table(
        ['样本', '来源', '数量', '字段', '访问状态', '版本'],
        bundle.datasets.map((d) => [
          d.name,
          d.source ?? '—',
          d.sample_count != null ? String(d.sample_count) : '—',
          d.fields ?? '—',
          ACCESS_LABEL[d.access_status] ?? d.access_status,
          d.version ?? '—',
        ]),
      )
    : '尚无样本数据。';

  const runTable = bundle.runs.length
    ? table(
        ['序号', '样本', '配置', '指标', '问题'],
        bundle.runs.map((r) => [
          `#${r.run_no}`,
          r.dataset_name ?? '—',
          r.config ?? '—',
          Object.entries(r.metrics ?? {})
            .map(([k, v]) => `${k}=${String(v)}`)
            .join('；') || '—',
          r.issues ?? '—',
        ]),
      )
    : '尚无运行记录。';

  const reviewTable = bundle.reviews.length
    ? table(
        ['复核人', '样本量', '准确率', '误报', '备注'],
        bundle.reviews.map((r) => [
          r.reviewer_name ?? '—',
          r.sample_count != null ? String(r.sample_count) : '—',
          r.accuracy != null ? `${(Number(r.accuracy) * 100).toFixed(1)}%` : '—',
          r.false_positive != null ? String(r.false_positive) : '—',
          r.notes ?? '—',
        ]),
      )
    : '尚无人工复核。';

  const conclusion = bundle.conclusion;
  const conclusionText = conclusion
    ? [
        `- 决策：**${DECISION_LABEL[conclusion.decision] ?? conclusion.decision}**`,
        `- 证据：${conclusion.evidence}`,
        conclusion.conditions ? `- 后续条件：${conclusion.conditions}` : null,
        `- 决策时间：${fmtLocalDateTime(conclusion.decided_at)}`,
      ]
        .filter(Boolean)
        .join('\n')
    : '尚未提交结论。';

  return {
    title,
    meta,
    markdown: [
      `# ${e.client_name} · ${e.opportunity_title} POC 验证报告`,
      '',
      `> 项目：${e.engagement_name}　｜　机会点：${e.opportunity_code} ${e.opportunity_title}　｜　实验版本：v${e.version}　｜　状态：${e.status}`,
      `> 生成时间：${fmtLocalDateTime()}`,
      '',
      '## 1. 实验设计',
      '',
      `**假设：** ${e.hypothesis}`,
      '',
      `**方法：** ${e.method}`,
      '',
      `- 成功指标：${e.success_metric}`,
      `- 成功阈值：${e.threshold}`,
      `- 样本量：${e.sample_size ?? '—'}`,
      `- 实验周期：${e.start_date ?? '—'} → ${e.end_date ?? '—'}`,
      '',
      '## 2. 样本数据',
      '',
      datasetTable,
      '',
      '## 3. 运行记录',
      '',
      runTable,
      '',
      '## 4. 人工复核',
      '',
      reviewTable,
      '',
      '## 5. 结论与证据',
      '',
      conclusionText,
      '',
      '## 6. 建议',
      '',
      conclusion?.decision === 'go'
        ? 'POC 达到成功阈值，建议进入交付实施阶段；仍需在合同中明确上线范围与验收口径。'
        : conclusion?.decision === 'no_go'
          ? 'POC 未达到阈值，建议暂停该机会点；保留失败样本与方法，供后续复盘。'
          : conclusion?.decision === 'conditional'
            ? 'POC 有条件通过；先关闭后续条件，再决定是否进入交付。'
            : '结论待定；补齐样本、运行与复核后再做 Go/No-Go。',
      '',
      '> 本报告中的指标来自 POC 运行与人工复核记录；结论不能替代合同验收。',
    ].join('\n'),
  };
}
