import { createHash } from 'node:crypto';
import { one, query, withTransaction } from '../db';
import { httpError } from './s1';
import { DIFF_LABEL, DIFF_SOURCE_LABEL } from './reconcile_labels';

export interface ReconcileBundle {
  review: any;
  actions: any[];
}

/** 读取复核记录及其风险/待办动作，供详情与导出共用。 */
export async function loadReconcileBundle(id: string): Promise<ReconcileBundle> {
  const review = await one<any>(
    `SELECT rev.*,
            rr.status AS risk_status,
            ii.status AS issue_status,
            e.name AS engagement_name,
            c.name AS client_name
       FROM copilot_reconcile_reviews rev
       LEFT JOIN risks rr ON rr.id = rev.risk_id
       LEFT JOIN delivery_issues ii ON ii.id = rev.issue_id
       LEFT JOIN engagements e ON e.id = rev.engagement_id
       LEFT JOIN clients c ON c.id = e.client_id
      WHERE rev.id = $1`,
    [id],
  );
  if (!review) throw httpError(404, 'NOT_FOUND', '对账复核记录不存在');
  const actions = await query(
    `SELECT a.id, a.difference_id, a.action_type, a.target_id, a.created_at,
            CASE WHEN a.action_type = 'issue' THEN i.code ELSE NULL END AS item_code,
            CASE WHEN a.action_type = 'risk' THEN r.title ELSE i.title END AS item_title,
            CASE WHEN a.action_type = 'risk' THEN r.status ELSE i.status END AS item_status
       FROM copilot_reconcile_actions a
       LEFT JOIN risks r ON a.action_type = 'risk' AND r.id = a.target_id
       LEFT JOIN delivery_issues i ON a.action_type = 'issue' AND i.id = a.target_id
      WHERE a.review_id = $1
      ORDER BY a.created_at`,
    [id],
  );
  return { review, actions };
}

function cell(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return String(value).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

function amount(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : String(value);
}

function fmtTime(value: unknown): string {
  if (!value) return '—';
  const date = new Date(value as any);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 把复核记录渲染成 Markdown（可再转 Word）。 */
export function renderReconcileDoc(bundle: ReconcileBundle): {
  title: string;
  markdown: string;
  meta: { client: string; project: string; version: string };
} {
  const { review, actions } = bundle;
  const doc = review.document ?? {};
  const kindLabel = review.kind === 'statement' ? '客户对账单' : '车队结算单';
  const documentNo = String(
    doc.statement_no ?? doc.settlement_no ?? review.document_id ?? review.id,
  );
  const party = String(
    doc.customer_name ?? doc.carrier_name ?? review.client_name ?? '—',
  );
  const period = `${doc.period_start ?? '—'} → ${doc.period_end ?? '—'}`;
  const differences: any[] = Array.isArray(review.differences)
    ? review.differences
    : [];
  const decisions = new Map<string, any>();
  for (const d of Array.isArray(review.decisions) ? review.decisions : []) {
    if (d?.difference_id) decisions.set(String(d.difference_id), d);
  }

  const title = `对账复核报告 · ${documentNo}`;
  const lines: string[] = [];

  lines.push(`# ${title}`);
  lines.push('');
  lines.push(
    `> ${kindLabel} · ${party} · 账期 ${period} · 差异 ${differences.length} 条`,
  );
  lines.push('');

  lines.push('## 一、单据信息');
  lines.push('');
  lines.push('| 项目 | 内容 |');
  lines.push('| --- | --- |');
  lines.push(`| 单据类型 | ${cell(kindLabel)} |`);
  lines.push(`| 单据号 | ${cell(documentNo)} |`);
  lines.push(`| 客户/车队 | ${cell(party)} |`);
  lines.push(`| 账期 | ${cell(period)} |`);
  lines.push(`| 合计 | ${cell(amount(doc.total_amount))} |`);
  lines.push(`| 差异数 | ${differences.length} |`);
  lines.push(`| 复核记录 | ${cell(review.id)} |`);
  lines.push(`| 回写来源 | ${cell(review.source)} |`);
  lines.push(`| 收到时间 | ${cell(fmtTime(review.received_at))} |`);
  lines.push('');

  const typeCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  const confidenceCounts = { high: 0, medium: 0, low: 0, unknown: 0 };
  const decisionCounts = new Map<string, number>();
  for (const diff of differences) {
    const type = String(diff?.type ?? 'unknown');
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    const source = String(diff?.source ?? '未知');
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
    const value = Number(diff?.confidence);
    if (!Number.isFinite(value)) confidenceCounts.unknown += 1;
    else if (value >= 0.8) confidenceCounts.high += 1;
    else if (value >= 0.6) confidenceCounts.medium += 1;
    else confidenceCounts.low += 1;
    const decision = diff?.difference_id
      ? decisions.get(String(diff.difference_id))?.decision
      : undefined;
    const key =
      decision === '采纳' || decision === '忽略' || decision === '待确认'
        ? decision
        : '未决';
    decisionCounts.set(key, (decisionCounts.get(key) ?? 0) + 1);
  }

  lines.push('## 二、差异分布');
  lines.push('');
  if (differences.length === 0) {
    lines.push('无。');
  } else {
    lines.push('| 维度 | 取值 | 数量 |');
    lines.push('| --- | --- | --- |');
    for (const [type, count] of [...typeCounts.entries()].sort(
      (a, b) => b[1] - a[1],
    )) {
      lines.push(`| 类型 | ${cell(DIFF_LABEL[type] ?? type)} | ${count} |`);
    }
    for (const [source, count] of [...sourceCounts.entries()].sort(
      (a, b) => b[1] - a[1],
    )) {
      lines.push(
        `| 来源 | ${cell(DIFF_SOURCE_LABEL[source] ?? source)} | ${count} |`,
      );
    }
    const buckets: Array<[string, number]> = [
      ['高 (≥0.8)', confidenceCounts.high],
      ['中 (0.6–0.8)', confidenceCounts.medium],
      ['低 (<0.6)', confidenceCounts.low],
      ['未知', confidenceCounts.unknown],
    ];
    for (const [label, count] of buckets) {
      lines.push(`| 置信度 | ${label} | ${count} |`);
    }
    for (const [decision, count] of [...decisionCounts.entries()].sort(
      (a, b) => b[1] - a[1],
    )) {
      lines.push(`| 决策 | ${cell(decision)} | ${count} |`);
    }
  }
  lines.push('');

  lines.push('## 三、差异汇总');
  lines.push('');
  if (differences.length === 0) {
    lines.push('本次复核未发现差异。');
  } else {
    lines.push(
      '| # | 类型 | 运单/趟次 | 对账单金额 | 系统金额 | 差额 | 来源 | 置信度 | 决策 |',
    );
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    differences.forEach((diff, index) => {
      const decision = diff?.difference_id
        ? decisions.get(String(diff.difference_id))
        : undefined;
      lines.push(
        `| ${index + 1} | ${cell(
          DIFF_LABEL[diff?.type] ?? diff?.type,
        )} | ${cell(diff?.waybill_no || diff?.trip_no)} | ${cell(
          amount(diff?.statement_amount),
        )} | ${cell(amount(diff?.system_amount))} | ${cell(
          amount(diff?.delta),
        )} | ${cell(
          DIFF_SOURCE_LABEL[diff?.source ?? ''] ?? diff?.source,
        )} | ${cell(diff?.confidence)} | ${cell(decision?.decision)} |`,
      );
    });
  }
  lines.push('');

  lines.push('## 四、差异依据');
  lines.push('');
  if (differences.length === 0) {
    lines.push('无。');
  } else {
    differences.forEach((diff, index) => {
      const decision = diff?.difference_id
        ? decisions.get(String(diff.difference_id))
        : undefined;
      lines.push(
        `### ${index + 1}. ${DIFF_LABEL[diff?.type] ?? diff?.type} · ${
          diff?.waybill_no || diff?.trip_no || '—'
        }`,
      );
      lines.push('');
      lines.push(`- 差异 ID：${cell(diff?.difference_id)}`);
      lines.push(`- 差额：${cell(amount(diff?.delta))}`);
      lines.push(
        `- 来源：${cell(
          DIFF_SOURCE_LABEL[diff?.source ?? ''] ?? diff?.source,
        )}（置信度 ${cell(diff?.confidence)}）`,
      );
      if (Array.isArray(diff?.evidence) && diff.evidence.length) {
        lines.push('- 证据：');
        for (const item of diff.evidence) lines.push(`  - ${cell(item)}`);
      } else {
        lines.push('- 证据：—');
      }
      if (Array.isArray(diff?.possible_causes) && diff.possible_causes.length) {
        lines.push('- 可能原因：');
        for (const item of diff.possible_causes) lines.push(`  - ${cell(item)}`);
      } else {
        lines.push('- 可能原因：—');
      }
      lines.push(`- 建议动作：${cell(diff?.suggested_action)}`);
      lines.push(
        `- 决策：${cell(decision?.decision)}${
          decision?.note ? `（${cell(decision.note)}）` : ''
        }`,
      );
      lines.push('');
    });
  }

  lines.push('## 五、已生成的风险与待办');
  lines.push('');
  if (!actions.length) {
    lines.push('暂无。');
  } else {
    lines.push('| 类型 | 差异 ID | 目标 | 状态 | 创建时间 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const action of actions) {
      lines.push(
        `| ${action.action_type === 'risk' ? '风险' : '待办'} | ${cell(
          action.difference_id,
        )} | ${cell(action.item_title ?? action.item_code)} | ${cell(
          action.item_status,
        )} | ${cell(fmtTime(action.created_at))} |`,
      );
    }
  }
  lines.push('');

  lines.push('## 六、说明');
  lines.push('');
  lines.push(
    '- 金额、差异类型与证据由规则计算；大模型仅生成可能原因与建议动作，失败时回退规则模板。',
  );
  lines.push('- 本报告用于复核留痕与内部沟通，不构成付款或法律结论。');
  lines.push('');

  return {
    title,
    markdown: lines.join('\n'),
    meta: {
      client: party,
      project: String(review.engagement_name ?? ''),
      version: '复核版',
    },
  };
}

/** 报告内容的稳定哈希，用于判断交付物是否过期。 */
export function reconcileMarkdownHash(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

/** 列出该复核生成的交付物，并标记内容是否已过期。 */
export async function listReconcileDocuments(reviewId: string): Promise<
  Array<{
    id: string;
    title: string;
    version: number;
    status: string;
    created_at: string;
    is_stale: boolean;
  }>
> {
  const bundle = await loadReconcileBundle(reviewId);
  const currentHash = reconcileMarkdownHash(renderReconcileDoc(bundle).markdown);
  const rows = await query<any>(
    `SELECT id, title, version, status, created_at,
            generated_from->>'content_hash' AS content_hash
       FROM deliverables
      WHERE type = 'data_report'
        AND deleted_at IS NULL
        AND generated_from->>'reviewId' = $1
      ORDER BY version DESC`,
    [reviewId],
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    version: row.version,
    status: row.status,
    created_at: row.created_at,
    is_stale: row.content_hash !== currentHash,
  }));
}

/** 生成复核报告交付物（data_report），按项目版本化；审批后可通过现有分享流程外发。 */
export async function generateReconcileDeliverable(
  reviewId: string,
): Promise<{
  id: string;
  title: string;
  version: number;
  type: string;
  status: string;
  reused: boolean;
}> {
  const bundle = await loadReconcileBundle(reviewId);
  const review = bundle.review;
  if (!review.engagement_id) {
    throw httpError(422, 'NO_ENGAGEMENT', '复核记录未关联项目');
  }
  const rendered = renderReconcileDoc(bundle);
  const engagementId = review.engagement_id as string;
  const currentHash = reconcileMarkdownHash(rendered.markdown);

  const latest = await one<any>(
    `SELECT id, title, version, type, status,
            generated_from->>'content_hash' AS content_hash
       FROM deliverables
      WHERE type = 'data_report'
        AND deleted_at IS NULL
        AND generated_from->>'reviewId' = $1
      ORDER BY version DESC
      LIMIT 1`,
    [reviewId],
  );
  if (latest && latest.content_hash === currentHash) {
    return {
      id: latest.id,
      title: latest.title,
      version: latest.version,
      type: latest.type,
      status: latest.status,
      reused: true,
    };
  }

  const created = await withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
      engagementId,
      'reconcile_report',
    ]);
    const v = await client.query<{ version: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS version
         FROM deliverables WHERE engagement_id = $1 AND type = 'data_report'`,
      [engagementId],
    );
    const version = v.rows[0].version;
    const inserted = await client.query<any>(
      `INSERT INTO deliverables
         (engagement_id, type, title, version, status, content, generated_from,
          template_id, template_version, generated_snapshot)
       VALUES ($1,'data_report',$2,$3,'draft',$4,$5,
               'reconcile_pilot','1.0.0',$6)
       RETURNING id, title, version, type, status`,
      [
        engagementId,
        rendered.title,
        version,
        JSON.stringify({ markdown: rendered.markdown }),
        JSON.stringify({
          reviewId,
          documentId: review.document_id,
          differences: Array.isArray(review.differences)
            ? review.differences.length
            : 0,
          content_hash: currentHash,
        }),
        JSON.stringify({
          asOf: new Date().toISOString(),
          reviewId,
          differences: Array.isArray(review.differences)
            ? review.differences.length
            : 0,
          source: review.source,
        }),
      ],
    );
    return inserted.rows[0];
  });
  return { ...created, reused: false };
}
