import { withTransaction } from '../db';
import { httpError } from './s1';
import { loadValueBundle, renderValueDoc, type ValueDocType } from './s5_docs';

export interface GeneratedValueDeliverable {
  id: string;
  title: string;
  version: number;
  type: string;
}

const TYPE_MAP: Record<ValueDocType, string> = {
  value: 'value_report',
  renewal: 'renewal_recommendation',
};

/** 生成价值报告 / 续约建议，按项目 + 类型版本化。 */
export async function generateValueDeliverable(
  engagementId: string,
  docType: ValueDocType,
  orgId?: string,
): Promise<GeneratedValueDeliverable> {
  const bundle = await loadValueBundle(engagementId, orgId);
  if (!bundle) throw httpError(404, 'NOT_FOUND', '项目不存在');

  const rendered = renderValueDoc(bundle, docType);
  const type = TYPE_MAP[docType];

  return withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
      engagementId,
      type,
    ]);
    const v = await client.query<{ version: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS version
         FROM deliverables WHERE engagement_id = $1 AND type = $2`,
      [engagementId, type],
    );
    const version = v.rows[0].version;

    const ins = await client.query<{ id: string }>(
      `INSERT INTO deliverables
         (engagement_id, type, title, version, status, content, generated_from,
          template_id, template_version, generated_snapshot)
       VALUES ($1,$2,$3,$4,'draft',$5,$6,'logistics_value','1.0.0',$7)
       RETURNING id`,
      [
        engagementId,
        type,
        rendered.title,
        version,
        JSON.stringify({ markdown: rendered.markdown }),
        JSON.stringify({ docType }),
        JSON.stringify({
          asOf: new Date().toISOString(),
          targets: bundle.targets.map((t) => ({
            opportunity: t.opportunity_code,
            metric: t.metric_name,
            baseline: t.baseline,
            target: t.target,
            latest: t.latest_value,
            period: t.latest_period,
          })),
          values: bundle.values.map((v2) => ({
            period: v2.period,
            metric: v2.metric_name,
            realized: v2.realized_value,
            confidence: v2.confidence,
          })),
          usage: bundle.usage.map((u) => ({
            period: u.period,
            activeUsers: u.active_users,
            volume: u.volume,
            errors: u.errors,
          })),
          risks: bundle.risks.map((r) => ({
            kind: r.kind,
            title: r.title,
            status: r.status,
          })),
        }),
      ],
    );

    return { id: ins.rows[0].id, title: rendered.title, version, type };
  });
}
