import { withTransaction } from '../db';
import { httpError } from './s1';
import { loadSolutionBundle, renderSolutionDoc, type SolutionDocType } from './solution_docs';
import { loadQuoteBundle, renderQuoteDoc } from './quote_docs';

export interface GeneratedS2Deliverable {
  id: string;
  title: string;
  version: number;
  type: string;
}

async function insertDeliverable(input: {
  engagementId: string;
  type: string;
  title: string;
  markdown: string;
  templateId: string;
  templateVersion: string;
  generatedFrom: Record<string, unknown>;
  snapshot: Record<string, unknown>;
}): Promise<GeneratedS2Deliverable> {
  return withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
      input.engagementId,
      input.type,
    ]);
    const v = await client.query<{ version: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS version
         FROM deliverables WHERE engagement_id = $1 AND type = $2`,
      [input.engagementId, input.type],
    );
    const version = v.rows[0].version;

    const ins = await client.query<{ id: string; created_at: string }>(
      `INSERT INTO deliverables
         (engagement_id, type, title, version, status, content, generated_from,
          template_id, template_version, generated_snapshot)
       VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9)
       RETURNING id, created_at`,
      [
        input.engagementId,
        input.type,
        input.title,
        version,
        JSON.stringify({ markdown: input.markdown }),
        JSON.stringify(input.generatedFrom),
        input.templateId,
        input.templateVersion,
        JSON.stringify(input.snapshot),
      ],
    );

    return {
      id: ins.rows[0].id,
      title: input.title,
      version,
      type: input.type,
    };
  });
}

export async function generateSolutionDeliverable(
  solutionId: string,
  docType: SolutionDocType,
  orgId?: string,
): Promise<GeneratedS2Deliverable> {
  const bundle = await loadSolutionBundle(solutionId, orgId);
  if (!bundle) throw httpError(404, 'NOT_FOUND', '方案不存在');

  const rendered = renderSolutionDoc(bundle, docType);
  const typeMap: Record<SolutionDocType, string> = {
    proposal: 'proposal',
    architecture: 'architecture',
    prd: 'prd',
    acceptance: 'acceptance',
  };

  return insertDeliverable({
    engagementId: bundle.solution.engagement_id,
    type: typeMap[docType],
    title: rendered.title,
    markdown: rendered.markdown,
    templateId: 'logistics_solution',
    templateVersion: '1.0.0',
    generatedFrom: {
      solutionId,
      solutionVersion: bundle.solution.version,
      docType,
      opportunityId: bundle.solution.opportunity_id,
    },
    snapshot: {
      asOf: new Date().toISOString(),
      solutionVersion: bundle.solution.version,
      components: bundle.components.map((c) => ({ name: c.name, type: c.type })),
      integrations: bundle.integrations.map((i) => ({ system: i.system, direction: i.direction })),
      acceptance: bundle.acceptance.map((a) => ({ metric: a.metric, target: a.target })),
    },
  });
}

export async function generateQuoteDeliverable(
  quoteId: string,
  orgId?: string,
): Promise<GeneratedS2Deliverable> {
  const bundle = await loadQuoteBundle(quoteId, orgId);
  if (!bundle) throw httpError(404, 'NOT_FOUND', '报价不存在');

  const rendered = renderQuoteDoc(bundle);
  return insertDeliverable({
    engagementId: bundle.quote.engagement_id,
    type: 'quote',
    title: rendered.title,
    markdown: rendered.markdown,
    templateId: 'logistics_quote',
    templateVersion: '1.0.0',
    generatedFrom: {
      quoteId,
      quoteVersion: bundle.quote.version,
      itemIds: bundle.items.map((i) => i.id),
    },
    snapshot: {
      asOf: new Date().toISOString(),
      quoteVersion: bundle.quote.version,
      totals: bundle.totals,
      items: bundle.items.map((i) => ({
        kind: i.kind,
        description: i.description,
        qty: i.qty,
        unitPrice: i.unit_price,
        amount: i.amount,
      })),
    },
  });
}
