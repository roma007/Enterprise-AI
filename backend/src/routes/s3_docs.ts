import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildDocx } from '../services/export';
import { loadPocBundle, renderPocDoc } from '../services/poc_docs';
import { generatePocDeliverable } from '../services/s3_deliverables';
import { requestOrg } from '../services/tenant';

const params = z.object({ id: z.uuid() });

function disposition(title: string, ext: string, inline = false) {
  const safe = `${title}.${ext}`;
  const ascii = `poc-report.${ext}`;
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

export async function s3DocRoutes(app: FastifyInstance) {
  app.post('/api/poc-experiments/:id/documents', async (req, reply) => {
    const { id } = params.parse(req.params);
    const org = await requestOrg(req);
    const item = await generatePocDeliverable(id, org);
    return reply.code(201).send({ item });
  });

  app.get('/api/poc-experiments/:id/document', async (req, reply) => {
    const { id } = params.parse(req.params);
    const org = await requestOrg(req);
    const bundle = await loadPocBundle(id, org);
    if (!bundle) return reply.code(404).send({ error: 'NOT_FOUND', message: 'POC 实验不存在' });
    const rendered = renderPocDoc(bundle);
    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .send(rendered.markdown);
  });

  app.get('/api/poc-experiments/:id/document.docx', async (req, reply) => {
    const { id } = params.parse(req.params);
    const org = await requestOrg(req);
    const bundle = await loadPocBundle(id, org);
    if (!bundle) return reply.code(404).send({ error: 'NOT_FOUND', message: 'POC 实验不存在' });
    const rendered = renderPocDoc(bundle);
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
