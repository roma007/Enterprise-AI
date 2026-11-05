import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, query, withTransaction } from '../db';
import { httpError } from '../services/s1';
import { runG2Checks } from '../rules/g2';

const uuid = z.uuid();
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
const text = z.string().trim().min(1);

const solutionCreate = z.object({
  scope: text,
  approach: z.string().nullish(),
  architecture: z.string().nullish(),
  deployment: z.string().nullish(),
  security: z.string().nullish(),
  assumptions: z.string().nullish(),
  exclusions: z.string().nullish(),
  status: z.enum(['draft', 'in_review', 'approved', 'rejected', 'archived']).default('draft'),
  created_by: uuid.nullish(),
  owner_id: uuid.nullish(),
});

const solutionPatch = z.object({
  scope: text.optional(),
  approach: z.string().nullish(),
  architecture: z.string().nullish(),
  deployment: z.string().nullish(),
  security: z.string().nullish(),
  assumptions: z.string().nullish(),
  exclusions: z.string().nullish(),
  status: z.enum(['draft', 'in_review', 'approved', 'rejected', 'archived']).optional(),
  owner_id: uuid.nullish(),
});

const componentBody = z.object({
  name: text,
  type: z.enum(['build', 'buy', 'integrate', 'service']),
  description: z.string().nullish(),
  effort_days: z.coerce.number().min(0).default(0),
  sort_order: z.coerce.number().int().min(0).default(0),
});

const componentPatch = z.object({
  name: text.optional(),
  type: z.enum(['build', 'buy', 'integrate', 'service']).optional(),
  description: z.string().nullish(),
  effort_days: z.coerce.number().min(0).optional(),
  sort_order: z.coerce.number().int().min(0).optional(),
});

const integrationBody = z.object({
  system: text,
  direction: z.enum(['inbound', 'outbound', 'bidirectional']),
  protocol: z.string().nullish(),
  fields: z.string().nullish(),
  frequency: z.string().nullish(),
  owner: z.string().nullish(),
  risk: z.string().nullish(),
  sort_order: z.coerce.number().int().min(0).default(0),
});

const integrationPatch = z.object({
  system: text.optional(),
  direction: z.enum(['inbound', 'outbound', 'bidirectional']).optional(),
  protocol: z.string().nullish(),
  fields: z.string().nullish(),
  frequency: z.string().nullish(),
  owner: z.string().nullish(),
  risk: z.string().nullish(),
  sort_order: z.coerce.number().int().min(0).optional(),
});

const workloadBody = z.object({
  items: z
    .array(
      z.object({
        role: text,
        days: z.coerce.number().min(0),
        rate: z.coerce.number().min(0),
      }),
    )
    .max(50),
});

const acceptanceBody = z.object({
  metric: text,
  baseline: z.string().nullish(),
  target: text,
  method: text,
  owner: z.string().nullish(),
  status: z.enum(['pending', 'met', 'not_met', 'waived']).default('pending'),
  sort_order: z.coerce.number().int().min(0).default(0),
});

const acceptancePatch = z.object({
  metric: text.optional(),
  baseline: z.string().nullish(),
  target: text.optional(),
  method: text.optional(),
  owner: z.string().nullish(),
  status: z.enum(['pending', 'met', 'not_met', 'waived']).optional(),
  sort_order: z.coerce.number().int().min(0).optional(),
});

const reviewBody = z.object({
  reviewer: uuid,
  decision: z.enum(['approved', 'rejected', 'changes_requested']),
  comments: z.string().nullish(),
});

const quoteCreate = z.object({
  currency: z.string().trim().min(1).default('CNY'),
  payment_terms: z.string().nullish(),
  valid_until: dateStr.nullish(),
  status: z.enum(['draft', 'sent', 'accepted', 'rejected', 'expired']).default('draft'),
  notes: z.string().nullish(),
});

const quotePatch = z.object({
  currency: z.string().trim().min(1).optional(),
  payment_terms: z.string().nullish(),
  valid_until: dateStr.nullish(),
  status: z.enum(['draft', 'sent', 'accepted', 'rejected', 'expired']).optional(),
  notes: z.string().nullish(),
});

const quoteItemBody = z.object({
  solution_id: uuid.nullish(),
  kind: z.enum(['one_time', 'annual_ops']).default('one_time'),
  description: text,
  qty: z.coerce.number().positive().default(1),
  unit_price: z.coerce.number().min(0),
  sort_order: z.coerce.number().int().min(0).default(0),
});

const quoteItemPatch = z.object({
  solution_id: uuid.nullish(),
  kind: z.enum(['one_time', 'annual_ops']).optional(),
  description: text.optional(),
  qty: z.coerce.number().positive().optional(),
  unit_price: z.coerce.number().min(0).optional(),
  sort_order: z.coerce.number().int().min(0).optional(),
});

async function updateById(
  table: string,
  id: string,
  patch: Record<string, any>,
  allowed: string[],
  touchUpdatedAt = false,
) {
  const keys = Object.keys(patch).filter((k) => allowed.includes(k) && patch[k] !== undefined);
  if (!keys.length) throw httpError(400, 'EMPTY_UPDATE', '没有可更新字段');
  const values = keys.map((k) => patch[k]);
  values.push(id);
  const row = await one(
    `UPDATE ${table}
        SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}
            ${touchUpdatedAt ? ', updated_at = now()' : ''}
      WHERE id = $${values.length}
      RETURNING *`,
    values,
  );
  if (!row) throw httpError(404, 'NOT_FOUND', '记录不存在');
  return row;
}

async function quoteTotals(quoteId: string) {
  const rows = await query<{ kind: string; total: number }>(
    `SELECT kind, COALESCE(sum(amount), 0) AS total
       FROM quote_items WHERE quote_id = $1 GROUP BY kind`,
    [quoteId],
  );
  const oneTime = Number(rows.find((r) => r.kind === 'one_time')?.total ?? 0);
  const annualOps = Number(rows.find((r) => r.kind === 'annual_ops')?.total ?? 0);
  return { oneTime, annualOps };
}

export async function s2Routes(app: FastifyInstance) {
  // ------------------------------------------------------------ G2 门禁
  app.get('/api/engagements/:id/g2-checks', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);

    const [opportunities, solutions, quotes, unlinkedOneTimeItems] = await Promise.all([
      query(
        `SELECT id, code, title, target_phase, has_tech_blocker, blocker_owner, stage
           FROM opportunities
          WHERE engagement_id = $1
            AND target_phase IN ('phase1','phase2')
            AND stage NOT IN ('killed','parked')
          ORDER BY code`,
        [id],
      ),
      query(
        `SELECT DISTINCT ON (s.opportunity_id)
                s.id, s.opportunity_id, s.version, s.status, s.scope,
                s.owner_id, u.name AS owner_name,
                o.code AS opportunity_code, o.title AS opportunity_title,
                o.has_tech_blocker, o.blocker_owner,
                (SELECT count(*) FROM solution_components c WHERE c.solution_id = s.id) AS component_count,
                (SELECT COALESCE(sum(c.effort_days), 0) FROM solution_components c WHERE c.solution_id = s.id) AS component_days,
                (SELECT count(*) FROM acceptance_criteria a WHERE a.solution_id = s.id) AS criteria_count,
                (SELECT count(*) FROM workload_estimates w WHERE w.solution_id = s.id) AS workload_count,
                (SELECT COALESCE(sum(w.days), 0) FROM workload_estimates w WHERE w.solution_id = s.id) AS workload_days,
                (SELECT COALESCE(sum(w.cost), 0) FROM workload_estimates w WHERE w.solution_id = s.id) AS workload_cost,
                (SELECT COALESCE(sum(qi.amount), 0)
                   FROM quote_items qi
                   JOIN quotes q ON q.id = qi.quote_id
                  WHERE qi.solution_id = s.id AND qi.kind = 'one_time'
                    AND q.status NOT IN ('expired','rejected')) AS quote_one_time,
                (SELECT count(*) FROM solution_reviews r WHERE r.solution_id = s.id) AS review_count,
                (SELECT decision FROM solution_reviews r WHERE r.solution_id = s.id
                  ORDER BY reviewed_at DESC LIMIT 1) AS latest_review
           FROM solutions s
           JOIN opportunities o ON o.id = s.opportunity_id
           LEFT JOIN users u ON u.id = s.owner_id
          WHERE o.engagement_id = $1 AND s.status <> 'archived'
          ORDER BY s.opportunity_id, s.version DESC`,
        [id],
      ),
      query(
        `SELECT q.id, q.version, q.status,
                (SELECT count(*) FROM quote_items qi WHERE qi.quote_id = q.id) AS item_count,
                (SELECT COALESCE(sum(amount), 0) FROM quote_items qi WHERE qi.quote_id = q.id) AS total
           FROM quotes q
          WHERE q.engagement_id = $1 AND q.status NOT IN ('expired','rejected')
          ORDER BY q.version DESC`,
        [id],
      ),
      query(
        `SELECT qi.id, qi.description, qi.amount
           FROM quote_items qi
           JOIN quotes q ON q.id = qi.quote_id
          WHERE q.engagement_id = $1
            AND q.status NOT IN ('expired','rejected')
            AND qi.kind = 'one_time'
            AND qi.solution_id IS NULL`,
        [id],
      ),
    ]);

    return runG2Checks({ opportunities, solutions, quotes, unlinkedOneTimeItems });
  });

  // ------------------------------------------------------------ 方案列表
  app.get('/api/engagements/:id/solutions', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const items = await query(
      `SELECT s.*, o.code AS opportunity_code, o.title AS opportunity_title,
              u.name AS owner_name,
              (SELECT count(*) FROM solution_components c WHERE c.solution_id = s.id) AS component_count,
              (SELECT COALESCE(sum(w.cost), 0) FROM workload_estimates w WHERE w.solution_id = s.id) AS workload_cost,
              (SELECT count(*) FROM acceptance_criteria a WHERE a.solution_id = s.id) AS criteria_count,
              (SELECT COALESCE(sum(qi.amount), 0)
                 FROM quote_items qi
                 JOIN quotes q ON q.id = qi.quote_id
                WHERE qi.solution_id = s.id AND qi.kind = 'one_time'
                  AND q.status NOT IN ('expired','rejected')) AS quote_one_time,
              (SELECT COALESCE(sum(qi.amount), 0)
                 FROM quote_items qi
                 JOIN quotes q ON q.id = qi.quote_id
                WHERE qi.solution_id = s.id AND qi.kind = 'annual_ops'
                  AND q.status NOT IN ('expired','rejected')) AS quote_annual_ops
         FROM solutions s
         JOIN opportunities o ON o.id = s.opportunity_id
         LEFT JOIN users u ON u.id = s.owner_id
        WHERE o.engagement_id = $1
        ORDER BY o.code, s.version DESC`,
      [id],
    );
    return { items };
  });

  app.post('/api/opportunities/:id/solutions', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = solutionCreate.parse(req.body);

    const created = await withTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
        id,
        'solutions',
      ]);
      const v = await client.query<{ v: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM solutions WHERE opportunity_id = $1`,
        [id],
      );
      const row = await client.query(
        `INSERT INTO solutions
           (opportunity_id, version, status, scope, approach, architecture, deployment,
            security, assumptions, exclusions, created_by, owner_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [
          id,
          v.rows[0].v,
          body.status,
          body.scope,
          body.approach ?? null,
          body.architecture ?? null,
          body.deployment ?? null,
          body.security ?? null,
          body.assumptions ?? null,
          body.exclusions ?? null,
          body.created_by ?? null,
          body.owner_id ?? null,
        ],
      );
      return row.rows[0];
    });

    return reply.code(201).send({ item: created });
  });

  app.get('/api/solutions/:id', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const item = await one(
      `SELECT s.*, o.code AS opportunity_code, o.title AS opportunity_title,
              o.engagement_id, e.name AS engagement_name, u.name AS owner_name
         FROM solutions s
         JOIN opportunities o ON o.id = s.opportunity_id
         JOIN engagements e ON e.id = o.engagement_id
         LEFT JOIN users u ON u.id = s.owner_id
        WHERE s.id = $1`,
      [id],
    );
    if (!item) return reply.code(404).send({ error: 'NOT_FOUND', message: '方案不存在' });

    const [components, integrations, workload, acceptanceCriteria, reviews] =
      await Promise.all([
        query(`SELECT * FROM solution_components WHERE solution_id = $1 ORDER BY sort_order, name`, [id]),
        query(`SELECT * FROM integrations WHERE solution_id = $1 ORDER BY sort_order, system`, [id]),
        query(`SELECT * FROM workload_estimates WHERE solution_id = $1 ORDER BY role`, [id]),
        query(
          `SELECT * FROM acceptance_criteria WHERE solution_id = $1 ORDER BY sort_order, metric`,
          [id],
        ),
        query(
          `SELECT r.*, u.name AS reviewer_name
             FROM solution_reviews r
             LEFT JOIN users u ON u.id = r.reviewer
            WHERE r.solution_id = $1
            ORDER BY r.reviewed_at DESC`,
          [id],
        ),
      ]);

    const workloadTotal = workload.reduce((a: number, w: any) => a + Number(w.cost ?? 0), 0);

    return {
      item,
      components,
      integrations,
      workload,
      workloadTotal: Number(workloadTotal.toFixed(2)),
      acceptanceCriteria,
      reviews,
    };
  });

  app.patch('/api/solutions/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = solutionPatch.parse(req.body);
    return {
      item: await updateById(
        'solutions',
        id,
        body,
        [
          'scope', 'approach', 'architecture', 'deployment', 'security',
          'assumptions', 'exclusions', 'status', 'owner_id',
        ],
        true,
      ),
    };
  });

  app.delete('/api/solutions/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM solutions WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '方案不存在');
    return { ok: true };
  });

  // ------------------------------------------------------------ 组件
  app.post('/api/solutions/:id/components', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = componentBody.parse(req.body);
    const row = await one(
      `INSERT INTO solution_components
         (solution_id, name, type, description, effort_days, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, body.name, body.type, body.description ?? null, body.effort_days, body.sort_order],
    );
    return reply.code(201).send({ item: row });
  });

  app.patch('/api/components/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = componentPatch.parse(req.body);
    return {
      item: await updateById('solution_components', id, body, [
        'name', 'type', 'description', 'effort_days', 'sort_order',
      ]),
    };
  });

  app.delete('/api/components/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM solution_components WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '组件不存在');
    return { ok: true };
  });

  // ------------------------------------------------------------ 集成
  app.post('/api/solutions/:id/integrations', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = integrationBody.parse(req.body);
    const row = await one(
      `INSERT INTO integrations
         (solution_id, system, direction, protocol, fields, frequency, owner, risk, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        id, body.system, body.direction, body.protocol ?? null, body.fields ?? null,
        body.frequency ?? null, body.owner ?? null, body.risk ?? null, body.sort_order,
      ],
    );
    return reply.code(201).send({ item: row });
  });

  app.patch('/api/integrations/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = integrationPatch.parse(req.body);
    return {
      item: await updateById('integrations', id, body, [
        'system', 'direction', 'protocol', 'fields', 'frequency', 'owner', 'risk', 'sort_order',
      ]),
    };
  });

  app.delete('/api/integrations/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM integrations WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '集成不存在');
    return { ok: true };
  });

  // ------------------------------------------------------------ 工作量
  app.get('/api/solutions/:id/workload', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const items = await query(
      `SELECT * FROM workload_estimates WHERE solution_id = $1 ORDER BY role`,
      [id],
    );
    const total = items.reduce((a: number, w: any) => a + Number(w.cost ?? 0), 0);
    return { items, total: Number(total.toFixed(2)) };
  });

  app.put('/api/solutions/:id/workload', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = workloadBody.parse(req.body);
    const result = await withTransaction(async (client) => {
      await client.query(`DELETE FROM workload_estimates WHERE solution_id = $1`, [id]);
      for (const item of body.items) {
        await client.query(
          `INSERT INTO workload_estimates (solution_id, role, days, rate)
           VALUES ($1,$2,$3,$4)`,
          [id, item.role, item.days, item.rate],
        );
      }
      const rows = await client.query(
        `SELECT * FROM workload_estimates WHERE solution_id = $1 ORDER BY role`,
        [id],
      );
      const total = rows.rows.reduce((a: number, w: any) => a + Number(w.cost ?? 0), 0);
      return { items: rows.rows, total: Number(total.toFixed(2)) };
    });
    return result;
  });

  // ------------------------------------------------------------ 验收标准
  app.post('/api/solutions/:id/acceptance-criteria', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = acceptanceBody.parse(req.body);
    const row = await one(
      `INSERT INTO acceptance_criteria
         (solution_id, metric, baseline, target, method, owner, status, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        id, body.metric, body.baseline ?? null, body.target, body.method,
        body.owner ?? null, body.status, body.sort_order,
      ],
    );
    return reply.code(201).send({ item: row });
  });

  app.patch('/api/acceptance-criteria/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = acceptancePatch.parse(req.body);
    return {
      item: await updateById('acceptance_criteria', id, body, [
        'metric', 'baseline', 'target', 'method', 'owner', 'status', 'sort_order',
      ]),
    };
  });

  app.delete('/api/acceptance-criteria/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM acceptance_criteria WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '验收标准不存在');
    return { ok: true };
  });

  // ------------------------------------------------------------ 评审
  app.post('/api/solutions/:id/reviews', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = reviewBody.parse(req.body);

    const result = await withTransaction(async (client) => {
      const review = await client.query(
        `INSERT INTO solution_reviews (solution_id, reviewer, decision, comments)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [id, body.reviewer, body.decision, body.comments ?? null],
      );
      const nextStatus =
        body.decision === 'approved'
          ? 'approved'
          : body.decision === 'rejected'
            ? 'rejected'
            : 'in_review';
      await client.query(
        `UPDATE solutions SET status = $2, updated_at = now() WHERE id = $1`,
        [id, nextStatus],
      );
      return { review: review.rows[0], status: nextStatus };
    });

    return reply.code(201).send(result);
  });

  // ------------------------------------------------------------ 报价
  app.get('/api/engagements/:id/quotes', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const items = await query(
      `SELECT q.*,
              COALESCE((SELECT sum(amount) FROM quote_items qi WHERE qi.quote_id = q.id AND qi.kind = 'one_time'), 0) AS one_time,
              COALESCE((SELECT sum(amount) FROM quote_items qi WHERE qi.quote_id = q.id AND qi.kind = 'annual_ops'), 0) AS annual_ops,
              (SELECT count(*) FROM quote_items qi WHERE qi.quote_id = q.id) AS item_count
         FROM quotes q
        WHERE q.engagement_id = $1
        ORDER BY q.version DESC`,
      [id],
    );
    return { items };
  });

  app.post('/api/engagements/:id/quotes', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = quoteCreate.parse(req.body);

    const created = await withTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
        id,
        'quotes',
      ]);
      const v = await client.query<{ v: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM quotes WHERE engagement_id = $1`,
        [id],
      );
      const row = await client.query(
        `INSERT INTO quotes
           (engagement_id, version, currency, payment_terms, valid_until, status, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          id, v.rows[0].v, body.currency, body.payment_terms ?? null,
          body.valid_until ?? null, body.status, body.notes ?? null,
        ],
      );
      return row.rows[0];
    });

    return reply.code(201).send({ item: created });
  });

  app.get('/api/quotes/:id', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const quote = await one(
      `SELECT q.*, e.name AS engagement_name
         FROM quotes q JOIN engagements e ON e.id = q.engagement_id
        WHERE q.id = $1`,
      [id],
    );
    if (!quote) return reply.code(404).send({ error: 'NOT_FOUND', message: '报价不存在' });

    const items = await query(
      `SELECT qi.*, s.version AS solution_version, o.code AS opportunity_code
         FROM quote_items qi
         LEFT JOIN solutions s ON s.id = qi.solution_id
         LEFT JOIN opportunities o ON o.id = s.opportunity_id
        WHERE qi.quote_id = $1
        ORDER BY qi.sort_order, qi.created_at`,
      [id],
    );
    const totals = await quoteTotals(id);
    return { item: quote, items, totals };
  });

  app.patch('/api/quotes/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = quotePatch.parse(req.body);
    return {
      item: await updateById(
        'quotes',
        id,
        body,
        ['currency', 'payment_terms', 'valid_until', 'status', 'notes'],
        true,
      ),
    };
  });

  app.delete('/api/quotes/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM quotes WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '报价不存在');
    return { ok: true };
  });

  app.post('/api/quotes/:id/items', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = quoteItemBody.parse(req.body);

    const quote = await one<{ engagement_id: string }>(
      `SELECT engagement_id FROM quotes WHERE id = $1`,
      [id],
    );
    if (!quote) throw httpError(404, 'NOT_FOUND', '报价不存在');

    if (body.solution_id) {
      const solution = await one(
        `SELECT 1 FROM solutions s
           JOIN opportunities o ON o.id = s.opportunity_id
          WHERE s.id = $1 AND o.engagement_id = $2`,
        [body.solution_id, quote.engagement_id],
      );
      if (!solution) throw httpError(422, 'SOLUTION_NOT_IN_ENGAGEMENT', '方案不属于该项目');
    }

    const row = await one(
      `INSERT INTO quote_items
         (quote_id, solution_id, kind, description, qty, unit_price, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        id, body.solution_id ?? null, body.kind, body.description,
        body.qty, body.unit_price, body.sort_order,
      ],
    );
    return reply.code(201).send({ item: row });
  });

  app.patch('/api/quote-items/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = quoteItemPatch.parse(req.body);
    return {
      item: await updateById('quote_items', id, body, [
        'solution_id', 'kind', 'description', 'qty', 'unit_price', 'sort_order',
      ]),
    };
  });

  app.delete('/api/quote-items/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM quote_items WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '报价行不存在');
    return { ok: true };
  });
}
