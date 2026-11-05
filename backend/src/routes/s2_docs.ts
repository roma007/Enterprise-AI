import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildDocx } from '../services/export';
import { loadQuoteBundle, renderQuoteDoc } from '../services/quote_docs';
import { renderQuoteCompare } from '../services/quote_diff_docs';
import {
  generateQuoteDeliverable,
  generateSolutionDeliverable,
} from '../services/s2_deliverables';
import { loadSolutionBundle, renderSolutionDoc } from '../services/solution_docs';
import { renderSolutionCompare } from '../services/solution_diff_docs';
import { one } from '../db';
import { requestOrg } from '../services/tenant';

const solutionDocType = z.enum(['proposal', 'architecture', 'prd', 'acceptance']);
const params = z.object({ id: z.uuid() });

function disposition(title: string, ext: string, inline = false) {
  const safe = `${title}.${ext}`;
  const ascii = `s2-document.${ext}`;
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

export async function s2DocRoutes(app: FastifyInstance) {
  app.post('/api/solutions/:id/documents', async (req, reply) => {
    const { id } = params.parse(req.params);
    const { type } = z.object({ type: solutionDocType }).parse(req.body);
    const org = await requestOrg(req);

    const item = await generateSolutionDeliverable(id, type, org);
    return reply.code(201).send({ item });
  });

  app.get('/api/solutions/:id/document', async (req, reply) => {
    const { id } = params.parse(req.params);
    const { type } = z.object({ type: solutionDocType }).parse(req.query);
    const org = await requestOrg(req);

    const bundle = await loadSolutionBundle(id, org);
    if (!bundle) return reply.code(404).send({ error: 'NOT_FOUND', message: '方案不存在' });
    const rendered = renderSolutionDoc(bundle, type);
    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .send(rendered.markdown);
  });

  app.get('/api/solutions/:id/document.docx', async (req, reply) => {
    const { id } = params.parse(req.params);
    const { type } = z.object({ type: solutionDocType }).parse(req.query);
    const org = await requestOrg(req);

    const bundle = await loadSolutionBundle(id, org);
    if (!bundle) return reply.code(404).send({ error: 'NOT_FOUND', message: '方案不存在' });
    const rendered = renderSolutionDoc(bundle, type);
    const buffer = await buildDocx(rendered.markdown, {
      title: rendered.title,
      client: rendered.meta.client,
      project: rendered.meta.project,
      version: rendered.meta.version,
    });
    return reply
      .header(
        'content-type',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      )
      .header('content-disposition', disposition(rendered.title, 'docx'))
      .send(buffer);
  });

  app.post('/api/quotes/:id/documents', async (req, reply) => {
    const { id } = params.parse(req.params);
    const org = await requestOrg(req);
    const item = await generateQuoteDeliverable(id, org);
    return reply.code(201).send({ item });
  });

  app.get('/api/quotes/:id/document', async (req, reply) => {
    const { id } = params.parse(req.params);
    const org = await requestOrg(req);
    const bundle = await loadQuoteBundle(id, org);
    if (!bundle) return reply.code(404).send({ error: 'NOT_FOUND', message: '报价不存在' });
    const rendered = renderQuoteDoc(bundle);
    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .send(rendered.markdown);
  });

  const compareParams = z.object({ id: z.uuid(), otherId: z.uuid() });
  const compareQuery = z.object({
    audience: z.enum(['internal', 'customer']).default('internal'),
  });

  async function loadCompare(
    id: string,
    otherId: string,
    org: string,
    audience: 'internal' | 'customer',
  ) {
    const [before, after] = await Promise.all([
      loadSolutionBundle(id, org),
      loadSolutionBundle(otherId, org),
    ]);
    if (!before || !after) return null;
    if (before.solution.opportunity_id !== after.solution.opportunity_id) {
      return 'mismatch' as const;
    }
    const quoteSql = `SELECT
        COALESCE(sum(qi.amount) FILTER (WHERE qi.kind = 'one_time'), 0)::float8 AS one_time,
        COALESCE(sum(qi.amount) FILTER (WHERE qi.kind = 'annual_ops'), 0)::float8 AS annual_ops
       FROM quote_items qi
       JOIN quotes q ON q.id = qi.quote_id
      WHERE qi.solution_id = $1
        AND q.status NOT IN ('expired','rejected')`;
    const [costs, quotes] = await Promise.all([
      Promise.all([
        one<{ total: number }>(
          `SELECT COALESCE(sum(cost), 0)::float8 AS total
             FROM workload_estimates WHERE solution_id = $1`,
          [id],
        ),
        one<{ total: number }>(
          `SELECT COALESCE(sum(cost), 0)::float8 AS total
             FROM workload_estimates WHERE solution_id = $1`,
          [otherId],
        ),
      ]),
      Promise.all([
        one<{ one_time: number; annual_ops: number }>(quoteSql, [id]),
        one<{ one_time: number; annual_ops: number }>(quoteSql, [otherId]),
      ]),
    ]);
    return renderSolutionCompare(
      before,
      after,
      Number(costs[0]?.total ?? 0),
      Number(costs[1]?.total ?? 0),
      {
        oneTime: Number(quotes[0]?.one_time ?? 0),
        annualOps: Number(quotes[0]?.annual_ops ?? 0),
      },
      {
        oneTime: Number(quotes[1]?.one_time ?? 0),
        annualOps: Number(quotes[1]?.annual_ops ?? 0),
      },
      audience,
    );
  }

  function compareFailure(rendered: Awaited<ReturnType<typeof loadCompare>>, reply: any) {
    if (rendered === 'mismatch') {
      return reply
        .code(422)
        .send({ error: 'SOLUTION_MISMATCH', message: '只能对比同一机会点的方案版本' });
    }
    return reply.code(404).send({ error: 'NOT_FOUND', message: '方案不存在' });
  }

  app.get('/api/solutions/:id/compare/:otherId/document', async (req, reply) => {
    const params = compareParams.parse(req.params);
    const { audience } = compareQuery.parse(req.query);
    const org = await requestOrg(req);
    const rendered = await loadCompare(params.id, params.otherId, org, audience);
    if (!rendered || rendered === 'mismatch') return compareFailure(rendered, reply);
    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .send(rendered.markdown);
  });

  app.get('/api/solutions/:id/compare/:otherId/document.docx', async (req, reply) => {
    const params = compareParams.parse(req.params);
    const { audience } = compareQuery.parse(req.query);
    const org = await requestOrg(req);
    const rendered = await loadCompare(params.id, params.otherId, org, audience);
    if (!rendered || rendered === 'mismatch') return compareFailure(rendered, reply);
    const buffer = await buildDocx(rendered.markdown, {
      title: rendered.title,
      client: rendered.meta.client,
      project: rendered.meta.project,
      version: rendered.meta.version,
    });
    return reply
      .header(
        'content-type',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      )
      .header('content-disposition', disposition(rendered.title, 'docx'))
      .send(buffer);
  });

  const quoteCompareParams = z.object({ id: z.uuid(), otherId: z.uuid() });

  async function loadQuoteCompare(id: string, otherId: string, org: string) {
    const [before, after] = await Promise.all([
      loadQuoteBundle(id, org),
      loadQuoteBundle(otherId, org),
    ]);
    if (!before || !after) return null;
    if (before.quote.engagement_id !== after.quote.engagement_id) {
      return 'mismatch' as const;
    }
    return renderQuoteCompare(before, after);
  }

  function quoteCompareFailure(
    rendered: Awaited<ReturnType<typeof loadQuoteCompare>>,
    reply: any,
  ) {
    if (rendered === 'mismatch') {
      return reply
        .code(422)
        .send({ error: 'QUOTE_MISMATCH', message: '只能对比同一项目的报价版本' });
    }
    return reply.code(404).send({ error: 'NOT_FOUND', message: '报价不存在' });
  }

  app.get('/api/quotes/:id/compare/:otherId/document', async (req, reply) => {
    const compare = quoteCompareParams.parse(req.params);
    const org = await requestOrg(req);
    const rendered = await loadQuoteCompare(compare.id, compare.otherId, org);
    if (!rendered || rendered === 'mismatch') {
      return quoteCompareFailure(rendered, reply);
    }
    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .send(rendered.markdown);
  });

  app.get('/api/quotes/:id/compare/:otherId/document.docx', async (req, reply) => {
    const compare = quoteCompareParams.parse(req.params);
    const org = await requestOrg(req);
    const rendered = await loadQuoteCompare(compare.id, compare.otherId, org);
    if (!rendered || rendered === 'mismatch') {
      return quoteCompareFailure(rendered, reply);
    }
    const buffer = await buildDocx(rendered.markdown, {
      title: rendered.title,
      client: rendered.meta.client,
      project: rendered.meta.project,
      version: rendered.meta.version,
    });
    return reply
      .header(
        'content-type',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      )
      .header('content-disposition', disposition(rendered.title, 'docx'))
      .send(buffer);
  });

  app.get('/api/quotes/:id/document.docx', async (req, reply) => {
    const { id } = params.parse(req.params);
    const org = await requestOrg(req);
    const bundle = await loadQuoteBundle(id, org);
    if (!bundle) return reply.code(404).send({ error: 'NOT_FOUND', message: '报价不存在' });
    const rendered = renderQuoteDoc(bundle);
    const buffer = await buildDocx(rendered.markdown, {
      title: rendered.title,
      client: rendered.meta.client,
      project: rendered.meta.project,
      version: rendered.meta.version,
    });
    return reply
      .header(
        'content-type',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      )
      .header('content-disposition', disposition(rendered.title, 'docx'))
      .send(buffer);
  });
}
