import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, query } from '../db';
import { buildDocx, buildPrintHtml } from '../services/export';
import { htmlToPdf } from '../services/pdf';
import { cachedPdf, pdfCacheKey, readPdfCache } from '../services/pdf_cache';
import { cleanupPdfJobs, enqueuePdfJob } from '../services/pdf_jobs';
import { queryBool } from '../utils/query';

const params = z.object({ id: z.uuid() });
const printQuery = z.object({ print: queryBool(false) });
const pdfQuery = z.object({ refresh: queryBool(false) });

async function loadDeliverable(id: string) {
  return one<any>(
    `SELECT d.id, d.title, d.type, d.version, d.content,
            e.name AS engagement_name, c.name AS client_name
       FROM deliverables d
       JOIN engagements e ON e.id = d.engagement_id
       JOIN clients c ON c.id = e.client_id
      WHERE d.id = $1`,
    [id],
  );
}

function disposition(title: string, version: number, ext: string, inline = false) {
  const safe = `${title} v${version}.${ext}`;
  const ascii = `report-${version}.${ext}`;
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

export async function exportRoutes(app: FastifyInstance) {
  app.get('/api/deliverables/:id/export.docx', async (req, reply) => {
    const { id } = params.parse(req.params);
    const deliverable = await loadDeliverable(id);
    if (!deliverable) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '交付物不存在' });
    }

    const markdown = deliverable.content?.markdown ?? '';
    const buffer = await buildDocx(markdown, {
      title: deliverable.title,
      client: deliverable.client_name,
      project: deliverable.engagement_name,
      version: `v${deliverable.version}`,
    });

    return reply
      .header(
        'content-type',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      )
      .header('content-disposition', disposition(deliverable.title, deliverable.version, 'docx'))
      .send(buffer);
  });

  app.post('/api/deliverables/:id/pdf-jobs', async (req, reply) => {
    const { id } = params.parse(req.params);
    const deliverable = await loadDeliverable(id);
    if (!deliverable) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '交付物不存在' });
    }
    const auth = (req as any).authUser;
    const job = await one<any>(
      `INSERT INTO pdf_jobs (deliverable_id, status, requested_by)
       VALUES ($1, 'queued', $2) RETURNING *`,
      [id, auth?.sub ?? null],
    );
    enqueuePdfJob(job.id);
    return reply.code(202).send({ item: job });
  });

  app.get('/api/deliverables/:id/pdf-jobs', async (req) => {
    const { id } = params.parse(req.params);
    const items = await query(
      `SELECT * FROM pdf_jobs WHERE deliverable_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [id],
    );
    return { items };
  });

  app.post('/api/pdf-jobs/cleanup', async (req, reply) => {
    const body = z
      .object({
        before: z.string().refine((v) => !Number.isNaN(Date.parse(v)), '日期格式不正确'),
        dry_run: z.boolean().default(true),
        confirm: z.string().optional(),
        batch_size: z.coerce.number().int().min(1).max(1000).default(1000),
      })
      .parse(req.body ?? {});

    if (!body.dry_run && body.confirm !== 'CLEANUP') {
      return reply.code(422).send({
        error: 'CLEANUP_CONFIRM_REQUIRED',
        message: '执行清理需要 confirm=CLEANUP',
      });
    }

    const result = await cleanupPdfJobs({
      before: new Date(body.before).toISOString(),
      batchSize: body.batch_size,
      dryRun: body.dry_run,
    });
    return result;
  });

  app.get('/api/pdf-jobs/:id', async (req, reply) => {
    const { id } = params.parse(req.params);
    const item = await one<any>(
      `SELECT j.*, d.title, d.version
         FROM pdf_jobs j JOIN deliverables d ON d.id = j.deliverable_id
        WHERE j.id = $1`,
      [id],
    );
    if (!item) return reply.code(404).send({ error: 'NOT_FOUND', message: '任务不存在' });
    return reply.send({ item });
  });

  app.get('/api/pdf-jobs/:id/file', async (req, reply) => {
    const { id } = params.parse(req.params);
    const job = await one<any>(
      `SELECT j.*, d.title, d.version
         FROM pdf_jobs j JOIN deliverables d ON d.id = j.deliverable_id
        WHERE j.id = $1`,
      [id],
    );
    if (!job) return reply.code(404).send({ error: 'NOT_FOUND', message: '任务不存在' });
    if (job.status !== 'done' || !job.cache_key) {
      return reply.code(409).send({
        error: 'PDF_NOT_READY',
        message: job.status === 'failed' ? job.error ?? 'PDF 生成失败' : 'PDF 仍在生成中',
      });
    }
    const buffer = await readPdfCache(job.cache_key);
    if (!buffer) {
      return reply.code(410).send({ error: 'PDF_CACHE_EXPIRED', message: 'PDF 缓存已过期，请重新生成' });
    }
    return reply
      .header('content-type', 'application/pdf')
      .header('x-pdf-cache', 'HIT')
      .header('content-disposition', disposition(job.title, job.version, 'pdf'))
      .send(buffer);
  });

  app.get('/api/deliverables/:id/export.pdf', async (req, reply) => {
    const { id } = params.parse(req.params);
    const q = pdfQuery.parse(req.query ?? {});
    const deliverable = await loadDeliverable(id);
    if (!deliverable) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '交付物不存在' });
    }

    const html = buildPrintHtml(
      deliverable.content?.markdown ?? '',
      {
        title: deliverable.title,
        client: deliverable.client_name,
        project: deliverable.engagement_name,
        version: `v${deliverable.version}`,
      },
      false,
    );

    try {
      const key = pdfCacheKey([
        id,
        deliverable.version,
        deliverable.title,
        deliverable.client_name,
        deliverable.engagement_name,
        html,
      ]);
      const { buffer, cache } = await cachedPdf(
        key,
        () => htmlToPdf(html),
        q.refresh ?? false,
      );
      return reply
        .header('content-type', 'application/pdf')
        .header('x-pdf-cache', cache)
        .header('content-disposition', disposition(deliverable.title, deliverable.version, 'pdf'))
        .send(buffer);
    } catch (err: any) {
      if (err?.statusCode && err.statusCode < 500) {
        return reply.code(err.statusCode).send({ error: err.code, message: err.message });
      }
      req.log.error({ err, requestId: req.id }, 'pdf render failed');
      return reply.code(500).send({
        error: 'PDF_RENDER_FAILED',
        message: 'PDF 渲染失败，请检查服务端 Chromium 与字体',
      });
    }
  });

  app.get('/api/deliverables/:id/export.html', async (req, reply) => {
    const { id } = params.parse(req.params);
    const query = printQuery.parse(req.query);
    const deliverable = await loadDeliverable(id);
    if (!deliverable) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '交付物不存在' });
    }

    const html = buildPrintHtml(
      deliverable.content?.markdown ?? '',
      {
        title: deliverable.title,
        client: deliverable.client_name,
        project: deliverable.engagement_name,
        version: `v${deliverable.version}`,
      },
      query.print ?? false,
    );

    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-disposition', disposition(deliverable.title, deliverable.version, 'html', true))
      .send(html);
  });
}
