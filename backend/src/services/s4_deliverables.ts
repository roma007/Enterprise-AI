import { withTransaction } from '../db';
import { httpError } from './s1';
import { loadDeliveryBundle, renderDeliveryDoc, type DeliveryDocType } from './s4_docs';

export interface GeneratedDeliveryDeliverable {
  id: string;
  title: string;
  version: number;
  type: string;
}

const TYPE_MAP: Record<DeliveryDocType, string> = {
  plan: 'delivery_plan',
  uat: 'uat_report',
  go_live: 'go_live_checklist',
  training: 'training_materials',
};

/** 生成 S4 交付文档，按项目 + 类型版本化。 */
export async function generateDeliveryDeliverable(
  engagementId: string,
  docType: DeliveryDocType,
  orgId?: string,
): Promise<GeneratedDeliveryDeliverable> {
  const bundle = await loadDeliveryBundle(engagementId, orgId);
  if (!bundle) throw httpError(404, 'NOT_FOUND', '项目不存在');

  const rendered = renderDeliveryDoc(bundle, docType);
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
       VALUES ($1,$2,$3,$4,'draft',$5,$6,'logistics_delivery','1.0.0',$7)
       RETURNING id`,
      [
        engagementId,
        type,
        rendered.title,
        version,
        JSON.stringify({ markdown: rendered.markdown }),
        JSON.stringify({
          docType,
          planId: bundle.plan?.id ?? null,
          planVersion: bundle.plan?.version ?? null,
        }),
        JSON.stringify({
          asOf: new Date().toISOString(),
          planVersion: bundle.plan?.version ?? null,
          tasks: bundle.tasks.map((t) => ({ name: t.name, status: t.status, progress: t.progress })),
          uat: bundle.uat.map((u) => ({ code: u.code, status: u.status })),
          goLive: bundle.goLive.map((g) => ({ item: g.item, status: g.status, blocking: g.blocking })),
          trainings: bundle.trainings.map((t) => ({ title: t.title, status: t.status })),
          issues: bundle.issues.map((i) => ({ code: i.code, kind: i.kind, status: i.status })),
        }),
      ],
    );

    return { id: ins.rows[0].id, title: rendered.title, version, type };
  });
}
