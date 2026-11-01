import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildDocx } from '../services/export';
import { loadDeliveryBundle, renderDeliveryDoc } from '../services/s4_docs';
import { generateDeliveryDeliverable } from '../services/s4_deliverables';
import { requestOrg } from '../services/tenant';

const docType = z.enum(['plan', 'uat', 'go_live', 'training']);
const params = z.object({ id: z.uuid() });

function disposition(title: string, ext: string) {
  const safe = `${title}.${ext}`;
  const ascii = `delivery-document.${ext}`;
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

export async function s4DocRoutes(app: FastifyInstance) {
  app.post('/api/engagements/:id/delivery-documents', async (req, reply) => {
    const { id } = params.parse(req.params);
    const { type } = z.object({ type: docType }).parse(req.body);
    const org = await requestOrg(req);
    const item = await generateDeliveryDeliverable(id, type, org);
    return reply.code(201).send({ item });
  });

  app.get('/api/engagements/:id/delivery-document', async (req, reply) => {
    const { id } = params.parse(req.params);
    const { type } = z.object({ type: docType }).parse(req.query);
    const org = await requestOrg(req);
    const bundle = await loadDeliveryBundle(id, org);
    if (!bundle) return reply.code(404).send({ error: 'NOT_FOUND', message: '项目不存在' });
    const rendered = renderDeliveryDoc(bundle, type);
    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .send(rendered.markdown);
  });

  app.get('/api/engagements/:id/delivery-document.docx', async (req, reply) => {
    const { id } = params.parse(req.params);
    const { type } = z.object({ type: docType }).parse(req.query);
    const org = await requestOrg(req);
    const bundle = await loadDeliveryBundle(id, org);
    if (!bundle) return reply.code(404).send({ error: 'NOT_FOUND', message: '项目不存在' });
    const rendered = renderDeliveryDoc(bundle, type);
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
