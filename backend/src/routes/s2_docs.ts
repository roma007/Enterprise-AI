import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildDocx } from '../services/export';
import { loadQuoteBundle, renderQuoteDoc } from '../services/quote_docs';
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

  app.get('/api/solutions/:id/compare/:otherId/document.docx', async (req, reply) => {
    const params = z
      .object({ id: z.uuid(), otherId: z.uuid() })
      .parse(req.params);
    const org = await requestOrg(req);
    const [before, after] = await Promise.all([
      loadSolutionBundle(params.id, org),
      loadSolutionBundle(params.otherId, org),
    ]);
    if (!before || !after) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '方案不存在' });
    }
    if (before.solution.opportunity_id !== after.solution.opportunity_id) {
      return reply
        .code(422)
        .send({ error: 'SOLUTION_MISMATCH', message: '只能对比同一机会点的方案版本' });
    }
    const costs = await Promise.all([
      one<{ total: number }>(
        `SELECT COALESCE(sum(cost), 0)::float8 AS total
           FROM workload_estimates WHERE solution_id = $1`,
        [params.id],
      ),
      one<{ total: number }>(
        `SELECT COALESCE(sum(cost), 0)::float8 AS total
           FROM workload_estimates WHERE solution_id = $1`,
        [params.otherId],
      ),
    ]);
    const rendered = renderSolutionCompare(
      before,
      after,
      Number(costs[0]?.total ?? 0),
      Number(costs[1]?.total ?? 0),
    );
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
