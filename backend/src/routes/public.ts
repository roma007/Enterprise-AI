import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, query } from '../db';
import { buildDocx, buildPrintHtml } from '../services/export';
import { htmlToPdf } from '../services/pdf';
import { cachedPdf, pdfCacheKey } from '../services/pdf_cache';
import { allowShareAccess } from '../services/share_access';

const params = z.object({
  token: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/),
});

interface PublicShare {
  id: string;
  token: string;
  expires_at: string | null;
  revoked_at: string | null;
  view_count: number;
  shared_at: string;
  note: string | null;
  shared_to_name: string;
  deliverable_id: string;
  title: string;
  version: number;
  type: string;
  status: string;
  content: any;
  engagement_name: string;
  client_name: string;
}

async function loadShare(token: string): Promise<PublicShare | null> {
  return one<PublicShare>(
    `SELECT sh.id, sh.token, sh.expires_at, sh.revoked_at, sh.view_count, sh.shared_at, sh.note,
            s.name AS shared_to_name,
            d.id AS deliverable_id, d.title, d.version, d.type, d.status, d.content,
            e.name AS engagement_name, c.name AS client_name
       FROM deliverable_shares sh
       JOIN stakeholders s ON s.id = sh.shared_to
       JOIN deliverables d ON d.id = sh.deliverable_id
       JOIN engagements e ON e.id = d.engagement_id
       JOIN clients c ON c.id = e.client_id
      WHERE sh.token = $1
        AND d.deleted_at IS NULL AND e.deleted_at IS NULL AND c.deleted_at IS NULL`,
    [token],
  );
}

function checkShare(row: PublicShare | null):
  | { ok: true; row: PublicShare }
  | { ok: false; status: number; code: string; message: string } {
  if (!row) return { ok: false, status: 404, code: 'SHARE_NOT_FOUND', message: '分享链接不存在' };
  if (row.revoked_at) {
    return { ok: false, status: 410, code: 'SHARE_REVOKED', message: '分享链接已撤销' };
  }
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, status: 410, code: 'SHARE_EXPIRED', message: '分享链接已过期' };
  }
  if (!['approved', 'shared'].includes(row.status)) {
    return { ok: false, status: 404, code: 'SHARE_NOT_FOUND', message: '分享内容不可用' };
  }
  return { ok: true, row };
}

async function guardRate(
  req: any,
  reply: any,
  token: string,
): Promise<boolean> {
  const result = allowShareAccess(`${req.ip ?? 'unknown'}:${token}`);
  if (!result.allowed) {
    reply
      .code(429)
      .header('retry-after', String(result.retryAfter))
      .send({ error: 'RATE_LIMITED', message: '访问过于频繁，请稍后再试' });
    return false;
  }
  return true;
}

async function recordView(
  req: any,
  shareId: string,
  token: string,
  kind: 'view' | 'docx' | 'pdf',
): Promise<void> {
  await query(
    `INSERT INTO share_views (share_id, token, kind, ip, user_agent, referer)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      shareId,
      token,
      kind,
      req.ip ?? null,
      String(req.headers['user-agent'] ?? '').slice(0, 500),
      String(req.headers.referer ?? '').slice(0, 500),
    ],
  ).catch(() => undefined);
}

function disposition(title: string, version: number, ext: string) {
  const safe = `${title} v${version}.${ext}`;
  return `attachment; filename="shared-${version}.${ext}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

export async function publicRoutes(app: FastifyInstance) {
  app.get('/api/public/shares/:token', async (req, reply) => {
    const { token } = params.parse(req.params);
    if (!(await guardRate(req, reply, token))) return;
    const checked = checkShare(await loadShare(token));
    if (!checked.ok) {
      return reply.code(checked.status).send({ error: checked.code, message: checked.message });
    }
    await query(
      `UPDATE deliverable_shares
          SET view_count = view_count + 1, last_viewed_at = now()
        WHERE id = $1`,
      [checked.row.id],
    );
    await recordView(req, checked.row.id, token, 'view');
    return {
      share: {
        token,
        shared_at: checked.row.shared_at,
        expires_at: checked.row.expires_at,
        shared_to_name: checked.row.shared_to_name,
        view_count: checked.row.view_count + 1,
        note: checked.row.note,
      },
      deliverable: {
        id: checked.row.deliverable_id,
        title: checked.row.title,
        version: checked.row.version,
        type: checked.row.type,
        markdown: checked.row.content?.markdown ?? '',
      },
      project: {
        name: checked.row.engagement_name,
        client: checked.row.client_name,
      },
    };
  });

  app.get('/api/public/shares/:token/export.docx', async (req, reply) => {
    const { token } = params.parse(req.params);
    if (!(await guardRate(req, reply, token))) return;
    const checked = checkShare(await loadShare(token));
    if (!checked.ok) {
      return reply.code(checked.status).send({ error: checked.code, message: checked.message });
    }
    const row = checked.row;
    await recordView(req, row.id, token, 'docx');
    const buffer = await buildDocx(row.content?.markdown ?? '', {
      title: row.title,
      client: row.client_name,
      project: row.engagement_name,
      version: `v${row.version}`,
    });
    return reply
      .header(
        'content-type',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      )
      .header('content-disposition', disposition(row.title, row.version, 'docx'))
      .send(buffer);
  });

  app.get('/api/public/shares/:token/export.pdf', async (req, reply) => {
    const { token } = params.parse(req.params);
    if (!(await guardRate(req, reply, token))) return;
    const checked = checkShare(await loadShare(token));
    if (!checked.ok) {
      return reply.code(checked.status).send({ error: checked.code, message: checked.message });
    }
    const row = checked.row;
    await recordView(req, row.id, token, 'pdf');
    const html = buildPrintHtml(
      row.content?.markdown ?? '',
      {
        title: row.title,
        client: row.client_name,
        project: row.engagement_name,
        version: `v${row.version}`,
      },
      false,
    );
    try {
      const key = pdfCacheKey([
        row.deliverable_id,
        row.version,
        row.title,
        row.client_name,
        row.engagement_name,
        html,
      ]);
      const { buffer, cache } = await cachedPdf(key, () => htmlToPdf(html));
      return reply
        .header('content-type', 'application/pdf')
        .header('x-pdf-cache', cache)
        .header('content-disposition', disposition(row.title, row.version, 'pdf'))
        .send(buffer);
    } catch {
      return reply.code(503).send({
        error: 'PDF_ENGINE_UNAVAILABLE',
        message: 'PDF 暂不可用，请下载 Word',
      });
    }
  });
}
