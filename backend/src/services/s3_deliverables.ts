import { withTransaction } from '../db';
import { httpError } from './s1';
import { loadPocBundle, renderPocDoc } from './poc_docs';

export interface GeneratedPocDeliverable {
  id: string;
  title: string;
  version: number;
  type: string;
}

/** 生成 POC 验证报告交付物，按项目 + 类型版本化。 */
export async function generatePocDeliverable(
  experimentId: string,
  orgId?: string,
): Promise<GeneratedPocDeliverable> {
  const bundle = await loadPocBundle(experimentId, orgId);
  if (!bundle) throw httpError(404, 'NOT_FOUND', 'POC 实验不存在');

  const rendered = renderPocDoc(bundle);
  const engagementId = bundle.experiment.engagement_id;

  return withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
      engagementId,
      'poc_report',
    ]);
    const v = await client.query<{ version: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS version
         FROM deliverables WHERE engagement_id = $1 AND type = 'poc_report'`,
      [engagementId],
    );
    const version = v.rows[0].version;

    const ins = await client.query<{ id: string }>(
      `INSERT INTO deliverables
         (engagement_id, type, title, version, status, content, generated_from,
          template_id, template_version, generated_snapshot)
       VALUES ($1,'poc_report',$2,$3,'draft',$4,$5,'logistics_poc','1.0.0',$6)
       RETURNING id`,
      [
        engagementId,
        rendered.title,
        version,
        JSON.stringify({ markdown: rendered.markdown }),
        JSON.stringify({
          experimentId,
          experimentVersion: bundle.experiment.version,
          opportunityId: bundle.experiment.opportunity_id,
          decision: bundle.conclusion?.decision ?? null,
        }),
        JSON.stringify({
          asOf: new Date().toISOString(),
          experimentVersion: bundle.experiment.version,
          status: bundle.experiment.status,
          decision: bundle.conclusion?.decision ?? null,
          datasetCount: bundle.datasets.length,
          runCount: bundle.runs.length,
          reviewCount: bundle.reviews.length,
          metrics: bundle.runs.map((r) => ({ runNo: r.run_no, metrics: r.metrics })),
        }),
      ],
    );

    return {
      id: ins.rows[0].id,
      title: rendered.title,
      version,
      type: 'poc_report',
    };
  });
}
