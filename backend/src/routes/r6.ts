import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, query } from '../db';
import {
  buildAiDraft,
  loadAiContext,
  summarizeAiContext,
  type AiDraftKind,
} from '../services/ai_drafts';
import { enhanceDraft, llmConfig } from '../services/llm';
import { httpError } from '../services/s1';
import { requestOrg } from '../services/tenant';
import { pageResult, parsePage } from '../services/pagination';

const uuid = z.uuid();
const text = z.string().trim().min(1);
const textArray = z.array(z.string().trim().min(1)).default([]);

const knowledgeCreate = z.object({
  industry: z.string().default('general'),
  category: z.enum(['opportunity', 'pattern', 'template', 'lesson', 'case']).default('pattern'),
  title: text,
  summary: text,
  content: text,
  tags: textArray,
  source: z.string().nullish(),
  engagement_id: uuid.nullish(),
  expires_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  status: z.enum(['draft', 'published', 'archived']).default('published'),
  created_by: uuid.nullish(),
});

const knowledgePatch = z.object({
  industry: z.string().optional(),
  category: z.enum(['opportunity', 'pattern', 'template', 'lesson', 'case']).optional(),
  title: text.optional(),
  summary: text.optional(),
  content: text.optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
  source: z.string().nullish(),
  expires_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  status: z.enum(['draft', 'published', 'archived']).optional(),
});

const draftCreate = z.object({
  kind: z.enum([
    'interview_summary',
    'report_draft',
    'solution_skeleton',
    'prd_skeleton',
    'answer',
  ]),
  source_id: uuid.nullish(),
  prompt: z.string().nullish(),
  created_by: uuid.nullish(),
});

const draftPatch = z.object({
  title: text.optional(),
  content: text.optional(),
});

async function updateById(
  table: string,
  id: string,
  patch: Record<string, any>,
  allowed: string[],
) {
  const keys = Object.keys(patch).filter((k) => allowed.includes(k) && patch[k] !== undefined);
  if (!keys.length) throw httpError(400, 'EMPTY_UPDATE', '没有可更新字段');
  const values = keys.map((k) => patch[k]);
  values.push(id);
  const row = await one(
    `UPDATE ${table}
        SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = now()
      WHERE id = $${values.length}
      RETURNING *`,
    values,
  );
  if (!row) throw httpError(404, 'NOT_FOUND', '记录不存在');
  return row;
}

function bigrams(input: string) {
  const textValue = input.replace(/[^\p{L}\p{N}]+/gu, '');
  const set = new Set<string>();
  for (let i = 0; i < textValue.length - 1; i += 1) set.add(textValue.slice(i, i + 2));
  return set;
}

export async function r6Routes(app: FastifyInstance) {
  // ------------------------------------------------------------ 知识库
  app.get('/api/knowledge', async (req) => {
    const org = await requestOrg(req);
    const q = z
      .object({
        q: z.string().optional(),
        industry: z.string().optional(),
        category: z.string().optional(),
        tag: z.string().optional(),
        status: z.string().optional(),
        expiring: z.string().optional(),
        expired: z.string().optional(),
      })
      .parse(req.query ?? {});

    const where = [`org_id = $1`];
    const params: any[] = [org];
    if (q.industry) {
      params.push(q.industry);
      where.push(`industry = $${params.length}`);
    }
    if (q.category) {
      params.push(q.category);
      where.push(`category = $${params.length}`);
    }
    if (q.status) {
      params.push(q.status);
      where.push(`status = $${params.length}`);
    } else {
      where.push(`status <> 'archived'`);
    }
    if (q.tag) {
      params.push([q.tag]);
      where.push(`tags && $${params.length}::text[]`);
    }
    if (q.expired === '1') {
      where.push(`expires_at IS NOT NULL AND expires_at < CURRENT_DATE`);
    }
    if (q.expiring === '1') {
      where.push(
        `expires_at IS NOT NULL AND expires_at >= CURRENT_DATE AND expires_at <= CURRENT_DATE + 30`,
      );
    }
    if (q.q) {
      params.push(`%${q.q.trim()}%`);
      where.push(
        `(title ILIKE $${params.length} OR summary ILIKE $${params.length} OR content ILIKE $${params.length})`,
      );
    }

    const page = parsePage(req.query);
    const total = await one<{ count: number }>(
      `SELECT count(*)::int AS count FROM knowledge_items
        WHERE ${where.join(' AND ')}`,
      params,
    );
    const items = await query(
      `SELECT * FROM knowledge_items
        WHERE ${where.join(' AND ')}
        ORDER BY status = 'published' DESC, updated_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, page.limit, page.offset],
    );
    return pageResult(items, total?.count ?? 0, page);
  });

  app.post('/api/knowledge', async (req, reply) => {
    const org = await requestOrg(req);
    const body = knowledgeCreate.parse(req.body);
    const row = await one(
      `INSERT INTO knowledge_items
         (org_id, industry, category, title, summary, content, tags, source,
          engagement_id, expires_at, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        org, body.industry, body.category, body.title, body.summary, body.content,
        body.tags, body.source ?? null, body.engagement_id ?? null,
        body.expires_at ?? null, body.status, body.created_by ?? null,
      ],
    );
    return reply.code(201).send({ item: row });
  });

  app.get('/api/knowledge/:id', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const org = await requestOrg(req);
    const item = await one(`SELECT * FROM knowledge_items WHERE id = $1 AND org_id = $2`, [
      id,
      org,
    ]);
    if (!item) return reply.code(404).send({ error: 'NOT_FOUND', message: '知识条目不存在' });
    return { item };
  });

  app.patch('/api/knowledge/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = knowledgePatch.parse(req.body);
    return {
      item: await updateById(
        'knowledge_items', id, body,
        ['industry', 'category', 'title', 'summary', 'content', 'tags', 'source', 'expires_at', 'status'],
      ),
    };
  });

  /** 审批知识条目：通过=published，退回=draft；同时记录审批人和时间。 */
  app.post('/api/knowledge/:id/review', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        decision: z.enum(['approve', 'reject']),
        note: z.string().nullish(),
        reviewed_by: uuid.nullish(),
      })
      .parse(req.body ?? {});
    const authUser = (req as any).authUser;
    const row = await one(
      `UPDATE knowledge_items
          SET status = $2, reviewed_by = $3, reviewed_at = now(),
              review_note = $4, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [
        id,
        body.decision === 'approve' ? 'published' : 'draft',
        body.reviewed_by ?? authUser?.sub ?? null,
        body.note ?? null,
      ],
    );
    if (!row) throw httpError(404, 'NOT_FOUND', '知识条目不存在');
    return { item: row };
  });

  app.delete('/api/knowledge/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM knowledge_items WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '知识条目不存在');
    return { ok: true };
  });

  /** 相似项目/知识推荐：行业 + 痛点渠道 + 机会点标题的字符重叠。 */
  app.get('/api/engagements/:id/similar-knowledge', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const org = await requestOrg(req);
    const engagement = await one<any>(
      `SELECT e.id, e.name, c.industry, c.sub_industry
         FROM engagements e JOIN clients c ON c.id = e.client_id
        WHERE e.id = $1 AND e.deleted_at IS NULL`,
      [id],
    );
    if (!engagement) throw httpError(404, 'NOT_FOUND', '项目不存在');

    const [pains, opps, items] = await Promise.all([
      query<any>(`SELECT description, channel FROM pain_points WHERE engagement_id = $1`, [id]),
      query<any>(`SELECT code, title FROM opportunities WHERE engagement_id = $1`, [id]),
      query<any>(
        `SELECT * FROM knowledge_items WHERE org_id = $1 AND status = 'published' LIMIT 100`,
        [org],
      ),
    ]);

    const context = [
      engagement.name,
      engagement.sub_industry ?? '',
      ...pains.map((p) => `${p.description} ${p.channel ?? ''}`),
      ...opps.map((o) => o.title),
    ].join(' ');
    const contextGrams = bigrams(context);

    const ranked = items
      .map((item) => {
        const itemGrams = bigrams(
          `${item.title} ${item.summary} ${(item.tags ?? []).join(' ')} ${item.content}`,
        );
        let overlap = 0;
        for (const g of contextGrams) if (itemGrams.has(g)) overlap += 1;
        const industryMatch = item.industry === engagement.industry;
        return {
          item,
          score: Math.min(overlap, 20) + (industryMatch ? 6 : 0),
          reason: industryMatch ? '同行业 + 文本相似' : '文本相似',
        };
      })
      .sort((a, b) => b.score - a.score)
      .filter((x) => x.score > 0)
      .slice(0, 6);

    return { items: ranked };
  });

  // ------------------------------------------------------------ AI 草稿
  app.get('/api/ai/config', async () => {
    const config = llmConfig();
    return { configured: config.configured, model: config.configured ? config.model : 'rule-based-v1' };
  });

  app.get('/api/engagements/:id/ai-drafts', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const q = z
      .object({ kind: z.string().optional(), status: z.string().optional() })
      .parse(req.query ?? {});
    const where = [`engagement_id = $1`];
    const params: any[] = [id];
    if (q.kind) {
      params.push(q.kind);
      where.push(`kind = $${params.length}`);
    }
    if (q.status) {
      params.push(q.status);
      where.push(`status = $${params.length}`);
    }
    const items = await query(
      `SELECT d.*, u.name AS created_by_name, c.name AS confirmed_by_name
         FROM ai_drafts d
         LEFT JOIN users u ON u.id = d.created_by
         LEFT JOIN users c ON c.id = d.confirmed_by
        WHERE ${where.join(' AND ')}
        ORDER BY d.created_at DESC`,
      params,
    );
    return { items };
  });

  app.post('/api/engagements/:id/ai-drafts', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = draftCreate.parse(req.body);
    const ctx = await loadAiContext(id);
    if (!ctx) throw httpError(404, 'NOT_FOUND', '项目不存在');

    const built = buildAiDraft(
      ctx,
      body.kind as AiDraftKind,
      body.source_id ?? undefined,
      body.prompt ?? undefined,
    );
    const enhanced = await enhanceDraft({
      kind: body.kind,
      title: built.title,
      draft: built.content,
      prompt: body.prompt ?? undefined,
      context: summarizeAiContext(ctx),
    });
    const authUser = (req as any).authUser;
    const row = await one(
      `INSERT INTO ai_drafts
         (engagement_id, kind, source_type, source_id, title, prompt, content, model, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        id,
        body.kind,
        body.source_id ? 'record' : null,
        body.source_id ?? null,
        built.title,
        body.prompt ?? null,
        enhanced.content,
        enhanced.model,
        body.created_by ?? authUser?.sub ?? null,
      ],
    );
    return reply.code(201).send({ item: row, context: { model: enhanced.model } });
  });

  app.get('/api/ai-drafts/:id', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const item = await one(
      `SELECT d.*, u.name AS created_by_name, c.name AS confirmed_by_name
         FROM ai_drafts d
         LEFT JOIN users u ON u.id = d.created_by
         LEFT JOIN users c ON c.id = d.confirmed_by
        WHERE d.id = $1`,
      [id],
    );
    if (!item) return reply.code(404).send({ error: 'NOT_FOUND', message: '草稿不存在' });
    return { item };
  });

  app.patch('/api/ai-drafts/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = draftPatch.parse(req.body);
    return {
      item: await updateById('ai_drafts', id, body, ['title', 'content']),
    };
  });

  app.post('/api/ai-drafts/:id/confirm', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({ confirmed_by: uuid.nullish(), note: z.string().nullish() })
      .parse(req.body ?? {});
    const authUser = (req as any).authUser;
    const row = await one(
      `UPDATE ai_drafts
          SET status = 'confirmed', confirmed_by = $2, confirmed_at = now(), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, body.confirmed_by ?? authUser?.sub ?? null],
    );
    if (!row) throw httpError(404, 'NOT_FOUND', '草稿不存在');
    return { item: row };
  });

  app.post('/api/ai-drafts/:id/reject', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(
      `UPDATE ai_drafts
          SET status = 'rejected', confirmed_by = $2, confirmed_at = now(), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, (req as any).authUser?.sub ?? null],
    );
    if (!row) throw httpError(404, 'NOT_FOUND', '草稿不存在');
    return { item: row };
  });

  app.delete('/api/ai-drafts/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM ai_drafts WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '草稿不存在');
    return { ok: true };
  });
}
