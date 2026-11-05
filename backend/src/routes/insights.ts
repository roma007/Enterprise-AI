import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildDocx } from '../services/export';
import { buildInsights, renderInsightsMarkdown } from '../services/insights';
import { requestOrg } from '../services/tenant';

const params = z.object({ id: z.uuid() });

function disposition(title: string, ext: string) {
  const safe = `${title}.${ext}`;
  return `attachment; filename="insights.${ext}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

export async function insightsRoutes(app: FastifyInstance) {
  app.get('/api/engagements/:id/insights', async (req, reply) => {
    const { id } = params.parse(req.params);
    const org = await requestOrg(req);
    const report = await buildInsights(id, org);
    if (!report) return reply.code(404).send({ error: 'NOT_FOUND', message: '项目不存在' });
    return report;
  });

  app.get('/api/engagements/:id/insights/document', async (req, reply) => {
    const { id } = params.parse(req.params);
    const org = await requestOrg(req);
    const report = await buildInsights(id, org);
    if (!report) return reply.code(404).send({ error: 'NOT_FOUND', message: '项目不存在' });
    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .send(renderInsightsMarkdown(report));
  });

  app.get('/api/engagements/:id/insights/document.docx', async (req, reply) => {
    const { id } = params.parse(req.params);
    const org = await requestOrg(req);
    const report = await buildInsights(id, org);
    if (!report) return reply.code(404).send({ error: 'NOT_FOUND', message: '项目不存在' });
    const title = `${report.engagement.client_name} · 经营洞察`;
    const buffer = await buildDocx(renderInsightsMarkdown(report), {
      title,
      client: report.engagement.client_name,
      project: report.engagement.name,
      version: report.engagement.stage,
    });
    return reply
      .header(
        'content-type',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      )
      .header('content-disposition', disposition(title, 'docx'))
      .send(buffer);
  });
}
