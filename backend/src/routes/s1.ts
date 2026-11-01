import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, query, withTransaction } from '../db';
import {
  confirmRealization,
  ensureGates,
  httpError,
  nextCode,
  refreshGateMetrics,
  replaceChain,
  replaceProcessModel,
} from '../services/s1';
import { requestOrg } from '../services/tenant';
import { pageResult, parsePage } from '../services/pagination';
import { softDeleteClient, softDeleteEngagement } from '../services/trash';

const uuid = z.uuid();
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
const nonEmpty = z.string().trim().min(1);
const textArray = z.array(z.string()).default([]);

/** 只允许更新白名单列，避免把请求体直接拼进 SQL。 */
async function updateById(
  table: string,
  id: string,
  patch: Record<string, any>,
  allowed: string[],
  opts: { json?: string[]; touchUpdatedAt?: boolean } = {},
) {
  const keys = Object.keys(patch).filter((k) => allowed.includes(k) && patch[k] !== undefined);
  if (!keys.length) throw httpError(400, 'EMPTY_UPDATE', '没有可更新字段');

  const sets = keys.map((k, i) => `${k} = $${i + 1}`);
  const values: any[] = keys.map((k) =>
    opts.json?.includes(k) ? JSON.stringify(patch[k]) : patch[k],
  );
  values.push(id);
  const sql =
    `UPDATE ${table} SET ${sets.join(', ')}` +
    `${opts.touchUpdatedAt ? ', updated_at = now()' : ''}` +
    ` WHERE id = $${values.length} RETURNING *`;
  const row = await one(sql, values);
  if (!row) throw httpError(404, 'NOT_FOUND', '记录不存在');
  return row;
}

async function engagementOr404(id: string) {
  const row = await one<any>(`SELECT * FROM engagements WHERE id = $1`, [id]);
  if (!row) throw httpError(404, 'NOT_FOUND', '项目不存在');
  return row;
}

// ------------------------------------------------------------------ schemas

const clientFields = z.object({
  name: nonEmpty,
  industry: z.string().min(1),
  sub_industry: z.string().nullish(),
  scale: z.enum(['<30', '30-100', '100-500', '500+']).nullish(),
  region: z.string().nullish(),
  annual_revenue: z.coerce.number().nonnegative().nullish(),
  tags: z.array(z.string()),
  created_by: uuid.nullish(),
});

const engagementFields = z.object({
  client_id: uuid,
  name: nonEmpty,
  type: z.enum(['diagnosis', 'full_cycle', 'poc_only']),
  stage: z.enum(['S0', 'S1', 'S2', 'S3', 'S4', 'S5']),
  status: z.enum(['active', 'on_hold', 'won', 'lost', 'closed']),
  owner_id: uuid.nullish(),
  external_owner: uuid.nullish(),
  start_date: dateStr.nullish(),
  target_end_date: dateStr.nullish(),
  contract_amount: z.coerce.number().nonnegative().nullish(),
});

const stakeholderFields = z.object({
  name: nonEmpty,
  title: z.string().nullish(),
  department: z.string().nullish(),
  role_type: z.enum(['decision_maker', 'project_owner', 'business_owner', 'it_data', 'frontline']),
  influence: z.coerce.number().int().min(1).max(5),
  attitude: z.enum(['champion', 'supporter', 'neutral', 'skeptic', 'blocker']),
  concerns: textArray,
  is_key: z.boolean(),
  notes: z.string().nullish(),
});

const interviewFields = z.object({
  stakeholder_id: uuid,
  date: dateStr,
  duration_min: z.coerce.number().int().nonnegative().nullish(),
  mode: z.enum(['onsite', 'video', 'phone']),
  transcript: z.string().nullish(),
  ai_summary: z.string().nullish(),
  key_quotes: textArray,
  status: z.enum(['draft', 'confirmed', 'archived']),
});

const painFields = z.object({
  code: z.string().trim().min(1).nullish(),
  description: nonEmpty,
  channel: z.string().nullish(),
  frequency: z.enum(['daily', 'weekly', 'monthly', 'occasional']).nullish(),
  severity: z.coerce.number().int().min(1).max(5).nullish(),
  quantified_impact: z.string().nullish(),
  current_workaround: z.string().nullish(),
  source_type: z.enum(['interview', 'observation', 'data']),
  source_ref: nonEmpty,
  status: z.enum(['open', 'merged', 'resolved']),
});

const inventoryFields = z.object({
  dimension: z.enum(['business', 'data', 'system', 'org']),
  category: z.string().nullish(),
  name: nonEmpty,
  attributes: z.record(z.string(), z.any()),
  completeness: z.coerce.number().int().min(0).max(100),
  verified: z.boolean(),
  verified_note: z.string().nullish(),
  is_implicit: z.boolean(),
  discovered_by: z.enum(['interview', 'observation', 'data']).nullish(),
});

const nodeFields = z.object({
  key: z.string().min(1).optional(),
  lane: nonEmpty,
  name: nonEmpty,
  node_type: z.enum(['start', 'end', 'action', 'decision', 'wait', 'system', 'manual']),
  owner_role: z.string().nullish(),
  duration_min: z.coerce.number().nonnegative().nullish(),
  abnormal_rate: z.coerce.number().min(0).max(100).nullish(),
  is_implicit: z.boolean(),
  discovered_by: z.enum(['interview', 'observation', 'data']).nullish(),
  pos_x: z.coerce.number().nullish(),
  pos_y: z.coerce.number().nullish(),
  sort_order: z.coerce.number().int().nonnegative().nullish(),
});

const edgeFields = z.object({
  from: z.union([z.number().int().nonnegative(), z.string().min(1)]),
  to: z.union([z.number().int().nonnegative(), z.string().min(1)]),
  label: z.string().nullish(),
  condition: z.string().nullish(),
});

const opportunityFields = z.object({
  code: z.string().trim().min(1).nullish(),
  title: nonEmpty,
  description: z.string().nullish(),
  stage: z.enum([
    'candidate', 'scored', 'selected', 'designed', 'piloting', 'validated',
    'delivering', 'live', 'realized', 'closed', 'parked', 'killed',
  ]),
  value_score: z.coerce.number().int().min(1).max(5),
  feasibility_score: z.coerce.number().int().min(1).max(5),
  urgency: z.union([z.literal(0.8), z.literal(1), z.literal(1.2)]),
  data_readiness: z.coerce.number().int().min(1).max(5).nullish(),
  score_rationale: nonEmpty,
  data_status: z.enum(['ready', 'need_apply', 'need_build', 'unavailable']),
  has_tech_blocker: z.boolean(),
  tech_blocker_note: z.string().nullish(),
  blocker_owner: uuid.nullish(),
  target_phase: z.enum(['phase1', 'phase2', 'watch']).nullish(),
  kill_reason: z.string().nullish(),
});

const baselineFields = z.object({
  metric: nonEmpty,
  value: z.coerce.number(),
  unit: z.string().nullish(),
  source: nonEmpty,
  collected_at: dateStr.nullish(),
  collected_by: uuid.nullish(),
  confidence: z.enum(['high', 'medium', 'low']),
});

const roiFields = z.object({
  benefit_type: z.enum(['cost_reduction', 'efficiency', 'revenue', 'risk']),
  formula: z.string().nullish(),
  conservative_value: z.coerce.number().nullish(),
  neutral_value: z.coerce.number().nonnegative(),
  optimistic_value: z.coerce.number().nullish(),
  one_time_cost: z.coerce.number().nonnegative(),
  annual_cost: z.coerce.number().nonnegative(),
  confidence: z.enum(['high', 'medium', 'low']),
  assumptions_note: z.string().nullish(),
});

const stageFields = z.object({
  stage: z.coerce.number().int().min(1),
  variable_key: nonEmpty,
  variable_label: nonEmpty,
  unit: z.string().nullish(),
  base_value: z.coerce.number().nullish(),
  low_value: z.coerce.number().nullish(),
  high_value: z.coerce.number().nullish(),
  mult_base: z.coerce.number().min(0).max(1),
  mult_low: z.coerce.number().min(0).max(1).nullish(),
  mult_high: z.coerce.number().min(0).max(1).nullish(),
  shape: z.enum(['linear', 'threshold']),
  threshold_note: z.string().nullish(),
  controllable: z.boolean(),
  owner_role: z.string().nullish(),
  is_derived: z.boolean(),
  depends_on: textArray,
  note: z.string().nullish(),
});

const limitationFields = z.object({
  source_type: z.enum([
    'baseline_low_confidence', 'client_financial', 'gate_gap', 'benchmark_uncalibrated', 'manual',
  ]),
  source_id: uuid.nullish(),
  title: nonEmpty,
  detail: nonEmpty,
  affected_refs: textArray,
  impact_class: z.enum(['amount', 'scope', 'method', 'internal']),
  severity: z.coerce.number().int().min(1).max(3),
});

const riskFields = z.object({
  title: nonEmpty,
  category: z.enum(['data', 'tech', 'org', 'commercial', 'compliance']),
  probability: z.coerce.number().int().min(1).max(5),
  impact: z.coerce.number().int().min(1).max(5),
  mitigation: z.string().nullish(),
  status: z.enum(['open', 'mitigated', 'closed']),
});

const checklistItem = z.object({
  item: z.string().min(1),
  passed: z.boolean(),
  note: z.string().optional(),
  actual: z.number().optional(),
  required: z.number().optional(),
});

export async function s1Routes(app: FastifyInstance) {
  // ------------------------------------------------------------ 基础字典
  app.get('/api/users', async (req) => {
    const org = await requestOrg(req);
    return {
      items: await query(
        `SELECT id, name, email, status FROM users
          WHERE org_id = $1 AND status = 'active' ORDER BY name`,
        [org],
      ),
    };
  });

  // ------------------------------------------------------------ 客户
  app.get('/api/clients', async (req) => {
    const org = await requestOrg(req);
    const page = parsePage(req.query);
    const search = z.object({ q: z.string().trim().optional() }).parse(req.query).q ?? null;
    const total = await one<{ count: number }>(
      `SELECT count(*)::int AS count FROM clients
        WHERE org_id = $1 AND deleted_at IS NULL
          AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%' OR industry ILIKE '%' || $2 || '%')`,
      [org, search],
    );
    const items = await query(
      `SELECT c.*,
              (SELECT count(*) FROM engagements e WHERE e.client_id = c.id) AS engagement_count
         FROM clients c
        WHERE c.org_id = $1 AND c.deleted_at IS NULL
          AND ($2::text IS NULL OR c.name ILIKE '%' || $2 || '%' OR c.industry ILIKE '%' || $2 || '%')
        ORDER BY c.created_at DESC
        LIMIT $3 OFFSET $4`,
      [org, search, page.limit, page.offset],
    );
    return pageResult(items, total?.count ?? 0, page);
  });

  app.post('/api/clients', async (req, reply) => {
    const body = clientFields.partial({ industry: true, tags: true }).parse(req.body);
    const orgId = await requestOrg(req);
    const row = await one(
      `INSERT INTO clients (org_id, name, industry, sub_industry, scale, region, annual_revenue, tags, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        orgId,
        body.name,
        body.industry ?? 'logistics',
        body.sub_industry ?? null,
        body.scale ?? null,
        body.region ?? null,
        body.annual_revenue ?? null,
        body.tags ?? [],
        body.created_by ?? null,
      ],
    );
    return reply.code(201).send({ item: row });
  });

  app.patch('/api/clients/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = clientFields.partial().parse(req.body);
    return {
      item: await updateById('clients', id, body, [
        'name', 'industry', 'sub_industry', 'scale', 'region', 'annual_revenue', 'tags',
      ]),
    };
  });

  app.delete('/api/clients/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const org = await requestOrg(req);
    const batch = await withTransaction(async (client) =>
      softDeleteClient(client, id, org),
    );
    return { ok: true, batch };
  });

  // 客户财务快照（报告的净利率等从这里取）
  app.get('/api/clients/:id/financials', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return {
      items: await query(
        `SELECT * FROM client_financials WHERE client_id = $1 ORDER BY period_end DESC, metric_key`,
        [id],
      ),
    };
  });

  app.post('/api/clients/:id/financials', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        metric_key: nonEmpty,
        value: z.coerce.number(),
        unit: nonEmpty,
        period_start: dateStr,
        period_end: dateStr,
        source_type: z.enum(['audited', 'management', 'estimate', 'public']),
        source_note: z.string().nullish(),
        confidence: z.enum(['high', 'medium', 'low']),
        verified_by: uuid.nullish(),
      })
      .parse(req.body);
    const row = await one(
      `INSERT INTO client_financials
         (client_id, metric_key, value, unit, period_start, period_end,
          source_type, source_note, confidence, verified_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        id, body.metric_key, body.value, body.unit, body.period_start, body.period_end,
        body.source_type, body.source_note ?? null, body.confidence, body.verified_by ?? null,
      ],
    );
    return reply.code(201).send({ item: row });
  });

  // ------------------------------------------------------------ 项目
  app.post('/api/engagements', async (req, reply) => {
    const body = engagementFields
      .partial({
        type: true, stage: true, status: true,
        owner_id: true, external_owner: true, start_date: true,
        target_end_date: true, contract_amount: true,
      })
      .parse(req.body);
    const orgId = await requestOrg(req);
    const client = await one<any>(`SELECT * FROM clients WHERE id = $1 AND org_id = $2`, [
      body.client_id,
      orgId,
    ]);
    if (!client) throw httpError(422, 'CLIENT_NOT_FOUND', '客户不存在');

    const result = await withTransaction(async (c) => {
      const ins = await c.query(
        `INSERT INTO engagements
           (client_id, org_id, name, type, stage, status, owner_id, external_owner,
            start_date, target_end_date, contract_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          body.client_id,
          client.org_id,
          body.name,
          body.type ?? 'diagnosis',
          body.stage ?? 'S1',
          body.status ?? 'active',
          body.owner_id ?? null,
          body.external_owner ?? null,
          body.start_date ?? null,
          body.target_end_date ?? null,
          body.contract_amount ?? null,
        ],
      );
      const engagement = ins.rows[0];
      await ensureGates(c, engagement.id);
      return engagement;
    });

    const gates = await query(`SELECT * FROM gates WHERE engagement_id = $1 ORDER BY code`, [
      result.id,
    ]);
    return reply.code(201).send({ item: result, gates });
  });

  app.patch('/api/engagements/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = engagementFields.partial().omit({ client_id: true }).parse(req.body);
    return {
      item: await updateById(
        'engagements',
        id,
        body,
        ['name', 'type', 'stage', 'status', 'owner_id', 'external_owner',
          'start_date', 'target_end_date', 'contract_amount'],
        { touchUpdatedAt: true },
      ),
    };
  });

  app.delete('/api/engagements/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const org = await requestOrg(req);
    const batch = await withTransaction(async (client) =>
      softDeleteEngagement(client, id, org),
    );
    return { ok: true, batch };
  });

  // ------------------------------------------------------------ 门禁
  app.get('/api/engagements/:id/gates', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return { items: await query(`SELECT * FROM gates WHERE engagement_id = $1 ORDER BY code`, [id]) };
  });

  app.put('/api/engagements/:id/gates/:code', async (req) => {
    const { id, code } = z
      .object({ id: uuid, code: z.enum(['G0', 'G1', 'G2', 'G3', 'G4', 'G5']) })
      .parse(req.params);
    const body = z
      .object({
        status: z.enum(['pending', 'in_review', 'passed', 'rejected']),
        checklist: z.array(checklistItem).optional(),
        reviewed_by: uuid.nullish(),
        reject_reason: z.string().nullish(),
      })
      .parse(req.body);

    const gate = await one<any>(`SELECT * FROM gates WHERE engagement_id = $1 AND code = $2`, [id, code]);
    if (!gate) throw httpError(404, 'NOT_FOUND', '门禁不存在');

    const checklist = body.checklist ?? gate.checklist ?? [];
    if (body.status === 'passed' && checklist.length === 0) {
      throw httpError(422, 'GATE_CHECKLIST_EMPTY', '没有 checklist 的门禁不能直接标记为 passed');
    }
    if (body.status === 'passed' && checklist.some((i: any) => i.passed === false)) {
      throw httpError(422, 'GATE_CHECKLIST_NOT_PASSED', 'checklist 仍有未通过项，不能把门禁标记为 passed');
    }

    return {
      item: await updateById(
        'gates',
        gate.id,
        {
          status: body.status,
          checklist: body.checklist,
          reviewed_by: body.reviewed_by,
          reject_reason: body.reject_reason,
          reviewed_at: body.status === 'passed' || body.status === 'rejected' ? new Date().toISOString() : undefined,
        },
        ['status', 'checklist', 'reviewed_by', 'reject_reason', 'reviewed_at'],
        { json: ['checklist'] },
      ),
    };
  });

  app.post('/api/engagements/:id/gates/refresh', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await engagementOr404(id);
    await withTransaction(async (c) => refreshGateMetrics(c, id));
    return {
      item: await one(`SELECT * FROM gates WHERE engagement_id = $1 AND code = 'G1'`, [id]),
    };
  });

  // ------------------------------------------------------------ 干系人
  app.get('/api/engagements/:id/stakeholders', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return {
      items: await query(
        `SELECT s.* FROM stakeholders s
           JOIN engagements e ON e.client_id = s.client_id
          WHERE e.id = $1 ORDER BY s.influence DESC, s.name`,
        [id],
      ),
    };
  });

  app.post('/api/engagements/:id/stakeholders', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const eng = await engagementOr404(id);
    const body = stakeholderFields
      .partial({ influence: true, attitude: true, concerns: true, is_key: true })
      .parse(req.body);
    const row = await one(
      `INSERT INTO stakeholders
         (client_id, name, title, department, role_type, influence, attitude, concerns, is_key, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        eng.client_id, body.name, body.title ?? null, body.department ?? null, body.role_type,
        body.influence ?? 3, body.attitude ?? 'neutral', body.concerns ?? [], body.is_key ?? false,
        body.notes ?? null,
      ],
    );
    return reply.code(201).send({ item: row });
  });

  app.patch('/api/stakeholders/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = stakeholderFields.partial().parse(req.body);
    return {
      item: await updateById('stakeholders', id, body, [
        'name', 'title', 'department', 'role_type', 'influence', 'attitude', 'concerns', 'is_key', 'notes',
      ]),
    };
  });

  app.delete('/api/stakeholders/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM stakeholders WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '干系人不存在');
    return { ok: true };
  });

  // ------------------------------------------------------------ 访谈
  app.get('/api/engagements/:id/interviews', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return {
      items: await query(
        `SELECT i.*, s.name AS stakeholder_name, s.title AS stakeholder_title
           FROM interviews i JOIN stakeholders s ON s.id = i.stakeholder_id
          WHERE i.engagement_id = $1 ORDER BY i.date, i.created_at`,
        [id],
      ),
    };
  });

  app.post('/api/engagements/:id/interviews', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const eng = await engagementOr404(id);
    const body = interviewFields
      .partial({ duration_min: true, mode: true, key_quotes: true, status: true })
      .parse(req.body);

    const st = await one(
      `SELECT 1 FROM stakeholders WHERE id = $1 AND client_id = $2`,
      [body.stakeholder_id, eng.client_id],
    );
    if (!st) throw httpError(422, 'STAKEHOLDER_NOT_IN_CLIENT', '干系人不属于该项目客户');

    const row = await one(
      `INSERT INTO interviews
         (engagement_id, stakeholder_id, date, duration_min, mode, transcript, ai_summary,
          key_quotes, status, confirmed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        id, body.stakeholder_id, body.date, body.duration_min ?? null, body.mode ?? 'onsite',
        body.transcript ?? null, body.ai_summary ?? null, body.key_quotes ?? [],
        body.status ?? 'draft', body.status === 'confirmed' ? new Date().toISOString() : null,
      ],
    );
    return reply.code(201).send({ item: row });
  });

  app.patch('/api/interviews/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = interviewFields.partial().parse(req.body);
    if (body.status === 'confirmed') (body as any).confirmed_at = new Date().toISOString();
    return {
      item: await updateById(
        'interviews',
        id,
        body,
        ['stakeholder_id', 'date', 'duration_min', 'mode', 'transcript', 'ai_summary',
          'key_quotes', 'status', 'confirmed_at'],
      ),
    };
  });

  app.delete('/api/interviews/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM interviews WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '访谈不存在');
    return { ok: true };
  });

  // ------------------------------------------------------------ 痛点
  app.get('/api/engagements/:id/pain-points', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const page = parsePage(req.query);
    const search = z.object({ q: z.string().trim().optional() }).parse(req.query).q ?? null;
    const total = await one<{ count: number }>(
      `SELECT count(*)::int AS count FROM pain_points WHERE engagement_id = $1
        AND ($2::text IS NULL OR code ILIKE '%' || $2 || '%'
             OR description ILIKE '%' || $2 || '%'
             OR channel ILIKE '%' || $2 || '%'
             OR source_ref ILIKE '%' || $2 || '%')`,
      [id, search],
    );
    const items = await query(
      `SELECT * FROM pain_points WHERE engagement_id = $1
        AND ($2::text IS NULL OR code ILIKE '%' || $2 || '%'
             OR description ILIKE '%' || $2 || '%'
             OR channel ILIKE '%' || $2 || '%'
             OR source_ref ILIKE '%' || $2 || '%')
        ORDER BY code LIMIT $3 OFFSET $4`,
      [id, search, page.limit, page.offset],
    );
    return pageResult(items, total?.count ?? 0, page);
  });

  app.post('/api/engagements/:id/pain-points', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await engagementOr404(id);
    const body = painFields
      .partial({ code: true, frequency: true, severity: true, status: true })
      .parse(req.body);

    const row = await withTransaction(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [id, 'P']);
      const code = body.code ?? (await nextCode(c, 'pain_points', id, 'P', 3));
      const ins = await c.query(
        `INSERT INTO pain_points
           (engagement_id, code, description, channel, frequency, severity, quantified_impact,
            current_workaround, source_type, source_ref, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          id, code, body.description, body.channel ?? null, body.frequency ?? null,
          body.severity ?? null, body.quantified_impact ?? null, body.current_workaround ?? null,
          body.source_type, body.source_ref, body.status ?? 'open',
        ],
      );
      await refreshGateMetrics(c, id);
      return ins.rows[0];
    });
    return reply.code(201).send({ item: row });
  });

  app.patch('/api/pain-points/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = painFields.partial().parse(req.body);
    const row = await withTransaction(async (c) => {
      const existing = await c.query<{ engagement_id: string }>(
        `SELECT engagement_id FROM pain_points WHERE id = $1`, [id],
      );
      if (!existing.rows.length) throw httpError(404, 'NOT_FOUND', '痛点不存在');
      const keys = Object.keys(body).filter((k) => body[k as keyof typeof body] !== undefined);
      if (!keys.length) throw httpError(400, 'EMPTY_UPDATE', '没有可更新字段');
      const values: any[] = keys.map((k) => body[k as keyof typeof body]);
      values.push(id);
      const updated = await c.query(
        `UPDATE pain_points SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}
          WHERE id = $${values.length} RETURNING *`,
        values,
      );
      await refreshGateMetrics(c, existing.rows[0].engagement_id);
      return updated.rows[0];
    });
    return { item: row };
  });

  app.delete('/api/pain-points/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one<{ engagement_id: string }>(
      `SELECT engagement_id FROM pain_points WHERE id = $1`, [id],
    );
    if (!row) throw httpError(404, 'NOT_FOUND', '痛点不存在');
    await withTransaction(async (c) => {
      await c.query(`DELETE FROM pain_points WHERE id = $1`, [id]);
      await refreshGateMetrics(c, row.engagement_id);
    });
    return { ok: true };
  });

  // ------------------------------------------------------------ 四维盘点
  app.get('/api/engagements/:id/inventory', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const page = parsePage(req.query);
    const search = z.object({ q: z.string().trim().optional() }).parse(req.query).q ?? null;
    const match = `($2::text IS NULL OR name ILIKE '%' || $2 || '%' OR category ILIKE '%' || $2 || '%' OR dimension ILIKE '%' || $2 || '%')`;
    const total = await one<{ count: number }>(
      `SELECT count(*)::int AS count FROM inventory_items WHERE engagement_id = $1 AND ${match}`,
      [id, search],
    );
    const items = await query(
      `SELECT * FROM inventory_items WHERE engagement_id = $1 AND ${match}
        ORDER BY dimension, name LIMIT $3 OFFSET $4`,
      [id, search, page.limit, page.offset],
    );
    return pageResult(items, total?.count ?? 0, page);
  });

  app.post('/api/engagements/:id/inventory', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await engagementOr404(id);
    const body = inventoryFields.partial({ completeness: true, verified: true, is_implicit: true }).parse(req.body);

    const row = await withTransaction(async (c) => {
      const ins = await c.query(
        `INSERT INTO inventory_items
           (engagement_id, dimension, category, name, attributes, completeness, verified,
            verified_note, is_implicit, discovered_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          id, body.dimension, body.category ?? null, body.name, JSON.stringify(body.attributes),
          body.completeness ?? 0, body.verified ?? false, body.verified_note ?? null,
          body.is_implicit ?? false, body.discovered_by ?? null,
        ],
      );
      await refreshGateMetrics(c, id);
      return ins.rows[0];
    });
    return reply.code(201).send({ item: row });
  });

  app.post('/api/engagements/:id/inventory/bulk', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await engagementOr404(id);
    const body = z
      .object({ items: z.array(inventoryFields.partial({ completeness: true, verified: true, is_implicit: true })).min(1).max(200) })
      .parse(req.body);

    const rows = await withTransaction(async (c) => {
      const out: any[] = [];
      for (const item of body.items) {
        const ins = await c.query(
          `INSERT INTO inventory_items
             (engagement_id, dimension, category, name, attributes, completeness, verified,
              verified_note, is_implicit, discovered_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [
            id, item.dimension, item.category ?? null, item.name, JSON.stringify(item.attributes),
            item.completeness ?? 0, item.verified ?? false, item.verified_note ?? null,
            item.is_implicit ?? false, item.discovered_by ?? null,
          ],
        );
        out.push(ins.rows[0]);
      }
      await refreshGateMetrics(c, id);
      return out;
    });
    return reply.code(201).send({ items: rows });
  });

  app.patch('/api/inventory/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = inventoryFields.partial().parse(req.body);
    const row = await withTransaction(async (c) => {
      const existing = await c.query<{ engagement_id: string }>(
        `SELECT engagement_id FROM inventory_items WHERE id = $1`, [id],
      );
      if (!existing.rows.length) throw httpError(404, 'NOT_FOUND', '盘点项不存在');
      const keys = Object.keys(body).filter((k) => body[k as keyof typeof body] !== undefined);
      if (!keys.length) throw httpError(400, 'EMPTY_UPDATE', '没有可更新字段');
      const values: any[] = keys.map((k) =>
        k === 'attributes' ? JSON.stringify(body[k as keyof typeof body]) : body[k as keyof typeof body],
      );
      values.push(id);
      const updated = await c.query(
        `UPDATE inventory_items SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}
          WHERE id = $${values.length} RETURNING *`,
        values,
      );
      await refreshGateMetrics(c, existing.rows[0].engagement_id);
      return updated.rows[0];
    });
    return { item: row };
  });

  app.delete('/api/inventory/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one<{ engagement_id: string }>(
      `SELECT engagement_id FROM inventory_items WHERE id = $1`, [id],
    );
    if (!row) throw httpError(404, 'NOT_FOUND', '盘点项不存在');
    await withTransaction(async (c) => {
      await c.query(`DELETE FROM inventory_items WHERE id = $1`, [id]);
      await refreshGateMetrics(c, row.engagement_id);
    });
    return { ok: true };
  });

  // ------------------------------------------------------------ 业务流程
  app.get('/api/engagements/:id/process-model', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const model = await one<any>(
      `SELECT * FROM process_models WHERE engagement_id = $1 AND status <> 'archived'
        ORDER BY version DESC LIMIT 1`,
      [id],
    );
    if (!model) return { item: null, nodes: [], edges: [] };
    return {
      item: model,
      nodes: await query(`SELECT * FROM process_nodes WHERE model_id = $1 ORDER BY sort_order NULLS LAST, name`, [model.id]),
      edges: await query(`SELECT * FROM process_edges WHERE model_id = $1`, [model.id]),
    };
  });

  app.put('/api/engagements/:id/process-model', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await engagementOr404(id);
    const body = z
      .object({
        nodes: z.array(nodeFields).min(1).max(200),
        edges: z.array(edgeFields).max(400).default([]),
        confirmed_by: uuid.nullish(),
      })
      .parse(req.body);

    if (body.confirmed_by) {
      const st = await one(
        `SELECT 1 FROM stakeholders s JOIN engagements e ON e.client_id = s.client_id
          WHERE s.id = $1 AND e.id = $2`,
        [body.confirmed_by, id],
      );
      if (!st) throw httpError(422, 'STAKEHOLDER_NOT_IN_CLIENT', '确认人不属于该项目客户');
    }

    const saved = await withTransaction(async (c) => {
      const model = await replaceProcessModel(c, id, body.nodes, body.edges, body.confirmed_by ?? undefined);
      await refreshGateMetrics(c, id);
      return model;
    });
    return reply.code(201).send({ item: saved });
  });

  // ------------------------------------------------------------ 机会点
  app.get('/api/engagements/:id/opportunities', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const page = parsePage(req.query);
    const search = z.object({ q: z.string().trim().optional() }).parse(req.query).q ?? null;
    const match = `($2::text IS NULL OR code ILIKE '%' || $2 || '%' OR title ILIKE '%' || $2 || '%' OR description ILIKE '%' || $2 || '%')`;
    const total = await one<{ count: number }>(
      `SELECT count(*)::int AS count FROM opportunities WHERE engagement_id = $1 AND ${match}`,
      [id, search],
    );
    const items = await query(
      `SELECT * FROM opportunities WHERE engagement_id = $1 AND ${match}
        ORDER BY score DESC, code LIMIT $3 OFFSET $4`,
      [id, search, page.limit, page.offset],
    );
    return pageResult(items, total?.count ?? 0, page);
  });

  app.post('/api/engagements/:id/opportunities', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await engagementOr404(id);
    const body = opportunityFields
      .partial({
        code: true, description: true, stage: true, data_readiness: true, data_status: true,
        has_tech_blocker: true, tech_blocker_note: true, blocker_owner: true,
        target_phase: true, kill_reason: true,
      })
      .parse(req.body);

    const row = await withTransaction(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [id, 'OP']);
      const code = body.code ?? (await nextCode(c, 'opportunities', id, 'OP', 2));
      const ins = await c.query(
        `INSERT INTO opportunities
           (engagement_id, code, title, description, stage, value_score, feasibility_score, urgency,
            data_readiness, score_rationale, data_status, has_tech_blocker, tech_blocker_note,
            blocker_owner, target_phase)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [
          id, code, body.title, body.description ?? null, body.stage ?? 'scored',
          body.value_score, body.feasibility_score, body.urgency, body.data_readiness ?? null,
          body.score_rationale, body.data_status ?? 'ready', body.has_tech_blocker ?? false,
          body.tech_blocker_note ?? null, body.blocker_owner ?? null, body.target_phase ?? null,
        ],
      );
      await refreshGateMetrics(c, id);
      return ins.rows[0];
    });
    return reply.code(201).send({ item: row });
  });

  app.get('/api/opportunities/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const item = await one(`SELECT * FROM opportunities WHERE id = $1`, [id]);
    if (!item) throw httpError(404, 'NOT_FOUND', '机会点不存在');
    return {
      item,
      painPoints: await query(
        `SELECT p.* FROM pain_points p JOIN opportunity_pain_points l ON l.pain_point_id = p.id
          WHERE l.opportunity_id = $1 ORDER BY p.code`, [id]),
      baselines: await query(`SELECT * FROM baselines WHERE opportunity_id = $1 ORDER BY metric`, [id]),
      roi: await one(`SELECT * FROM roi_models WHERE opportunity_id = $1`, [id]),
      chain: await query(`SELECT * FROM roi_sensitivity WHERE opportunity_id = $1 ORDER BY stage`, [id]),
    };
  });

  app.patch('/api/opportunities/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = opportunityFields.partial().parse(req.body);
    const row = await withTransaction(async (c) => {
      const existing = await c.query<{ engagement_id: string }>(
        `SELECT engagement_id FROM opportunities WHERE id = $1`, [id],
      );
      if (!existing.rows.length) throw httpError(404, 'NOT_FOUND', '机会点不存在');
      const keys = Object.keys(body).filter((k) => body[k as keyof typeof body] !== undefined);
      if (!keys.length) throw httpError(400, 'EMPTY_UPDATE', '没有可更新字段');
      const values: any[] = keys.map((k) => body[k as keyof typeof body]);
      values.push(id);
      const updated = await c.query(
        `UPDATE opportunities SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = now()
          WHERE id = $${values.length} RETURNING *`,
        values,
      );
      await refreshGateMetrics(c, existing.rows[0].engagement_id);
      return updated.rows[0];
    });
    return { item: row };
  });

  app.put('/api/opportunities/:id/pain-points', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ pain_point_ids: z.array(uuid).max(100) }).parse(req.body);
    const links = await withTransaction(async (c) => {
      await c.query(`DELETE FROM opportunity_pain_points WHERE opportunity_id = $1`, [id]);
      for (const pid of body.pain_point_ids) {
        await c.query(
          `INSERT INTO opportunity_pain_points (opportunity_id, pain_point_id) VALUES ($1,$2)`,
          [id, pid],
        );
      }
      const r = await c.query(
        `SELECT p.* FROM pain_points p JOIN opportunity_pain_points l ON l.pain_point_id = p.id
          WHERE l.opportunity_id = $1 ORDER BY p.code`, [id],
      );
      return r.rows;
    });
    return { items: links };
  });

  app.delete('/api/opportunities/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one<{ engagement_id: string }>(
      `SELECT engagement_id FROM opportunities WHERE id = $1`, [id],
    );
    if (!row) throw httpError(404, 'NOT_FOUND', '机会点不存在');
    await withTransaction(async (c) => {
      await c.query(`DELETE FROM opportunities WHERE id = $1`, [id]);
      await refreshGateMetrics(c, row.engagement_id);
    });
    return { ok: true };
  });

  // ------------------------------------------------------------ 基线
  app.post('/api/opportunities/:id/baselines', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = baselineFields.partial({ confidence: true }).parse(req.body);
    const row = await withTransaction(async (c) => {
      const opp = await c.query<{ engagement_id: string }>(
        `SELECT engagement_id FROM opportunities WHERE id = $1`, [id],
      );
      if (!opp.rows.length) throw httpError(404, 'NOT_FOUND', '机会点不存在');
      const ins = await c.query(
        `INSERT INTO baselines
           (opportunity_id, metric, value, unit, source, collected_at, collected_by, confidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          id, body.metric, body.value, body.unit ?? null, body.source, body.collected_at ?? null,
          body.collected_by ?? null, body.confidence ?? 'low',
        ],
      );
      await refreshGateMetrics(c, opp.rows[0].engagement_id);
      return ins.rows[0];
    });
    return reply.code(201).send({ item: row });
  });

  app.patch('/api/baselines/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = baselineFields.partial().parse(req.body);
    return {
      item: await updateById('baselines', id, body, [
        'metric', 'value', 'unit', 'source', 'collected_at', 'collected_by', 'confidence',
      ]),
    };
  });

  app.delete('/api/baselines/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one<any>(`SELECT o.engagement_id FROM baselines b
      JOIN opportunities o ON o.id = b.opportunity_id WHERE b.id = $1`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '基线不存在');
    await withTransaction(async (c) => {
      await c.query(`DELETE FROM baselines WHERE id = $1`, [id]);
      await refreshGateMetrics(c, row.engagement_id);
    });
    return { ok: true };
  });

  // ------------------------------------------------------------ ROI
  app.put('/api/opportunities/:id/roi', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = roiFields
      .partial({ formula: true, conservative_value: true, optimistic_value: true,
        one_time_cost: true, annual_cost: true, confidence: true, assumptions_note: true })
      .parse(req.body);

    const opp = await one(`SELECT id FROM opportunities WHERE id = $1`, [id]);
    if (!opp) throw httpError(404, 'NOT_FOUND', '机会点不存在');

    const row = await one(
      `INSERT INTO roi_models
         (opportunity_id, benefit_type, formula, conservative_value, neutral_value,
          optimistic_value, one_time_cost, annual_cost, confidence, assumptions_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (opportunity_id) DO UPDATE SET
         benefit_type = EXCLUDED.benefit_type,
         formula = EXCLUDED.formula,
         conservative_value = EXCLUDED.conservative_value,
         neutral_value = EXCLUDED.neutral_value,
         optimistic_value = EXCLUDED.optimistic_value,
         one_time_cost = EXCLUDED.one_time_cost,
         annual_cost = EXCLUDED.annual_cost,
         confidence = EXCLUDED.confidence,
         assumptions_note = EXCLUDED.assumptions_note,
         updated_at = now()
       RETURNING *`,
      [
        id, body.benefit_type, body.formula ?? null, body.conservative_value ?? null,
        body.neutral_value, body.optimistic_value ?? null, body.one_time_cost ?? 0,
        body.annual_cost ?? 0, body.confidence ?? 'low', body.assumptions_note ?? null,
      ],
    );
    return { item: row };
  });

  app.put('/api/opportunities/:id/chain', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ stages: z.array(stageFields).min(1).max(50) }).parse(req.body);
    const result = await withTransaction(async (c) => {
      const product = await replaceChain(c, id, body.stages);
      const stages = await c.query(
        `SELECT * FROM roi_sensitivity WHERE opportunity_id = $1 ORDER BY stage`, [id],
      );
      return { product, stages: stages.rows };
    });
    return result;
  });

  app.post('/api/opportunities/:id/roi/confirm', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        mode: z.enum(['cut', 'no_headcount_growth', 'redeploy', 'revenue', 'cost_avoidance']),
        note: z.string().trim().min(10, '实现形态理由至少 10 个字'),
        confirmed_by: uuid,
      })
      .parse(req.body);

    const result = await withTransaction(async (c) => {
      const opp = await c.query<{ engagement_id: string }>(
        `SELECT engagement_id FROM opportunities WHERE id = $1`, [id],
      );
      if (!opp.rows.length) throw httpError(404, 'NOT_FOUND', '机会点不存在');
      const confirmed = await confirmRealization(c, id, body.mode, body.note, body.confirmed_by);
      await refreshGateMetrics(c, opp.rows[0].engagement_id);
      return confirmed;
    });
    return result;
  });

  // ------------------------------------------------------------ 局限
  app.get('/api/engagements/:id/limitations', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return {
      items: await query(
        `SELECT * FROM limitations WHERE engagement_id = $1
          ORDER BY CASE impact_class WHEN 'amount' THEN 1 WHEN 'scope' THEN 2
                   WHEN 'method' THEN 3 ELSE 4 END, severity DESC, created_at`, [id]),
    };
  });

  app.post('/api/engagements/:id/limitations', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await engagementOr404(id);
    const body = limitationFields
      .partial({ affected_refs: true, severity: true })
      .parse(req.body);
    const row = await one(
      `INSERT INTO limitations
         (engagement_id, source_type, source_id, title, detail, affected_refs, impact_class, severity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        id, body.source_type, body.source_id ?? null, body.title, body.detail,
        body.affected_refs ?? [], body.impact_class, body.severity ?? 1,
      ],
    );
    return reply.code(201).send({ item: row });
  });

  app.patch('/api/limitations/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = limitationFields.partial().parse(req.body);
    return {
      item: await updateById('limitations', id, body, [
        'source_type', 'source_id', 'title', 'detail', 'affected_refs', 'impact_class', 'severity',
      ]),
    };
  });

  app.delete('/api/limitations/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM limitations WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '局限不存在');
    return { ok: true };
  });

  // ------------------------------------------------------------ 依赖
  app.get('/api/engagements/:id/dependencies', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return {
      items: await query(
        `SELECT d.*, o1.code AS from_code, o2.code AS to_code
           FROM opportunity_dependencies d
           JOIN opportunities o1 ON o1.id = d.from_id
           JOIN opportunities o2 ON o2.id = d.to_id
          WHERE o1.engagement_id = $1 ORDER BY o1.code, o2.code`, [id]),
    };
  });

  app.post('/api/engagements/:id/dependencies', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        from_id: uuid,
        to_id: uuid,
        type: z.enum(['requires', 'blocks', 'enables']),
        note: z.string().nullish(),
      })
      .parse(req.body);
    const pair = await one(
      `SELECT count(*) AS n FROM opportunities
        WHERE engagement_id = $1 AND id = ANY($2::uuid[])`,
      [id, [body.from_id, body.to_id]],
    );
    if ((pair as any).n !== 2) throw httpError(422, 'OPPORTUNITY_NOT_IN_ENGAGEMENT', '两个机会点必须属于同一项目');
    const row = await one(
      `INSERT INTO opportunity_dependencies (from_id, to_id, type, note)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [body.from_id, body.to_id, body.type, body.note ?? null],
    );
    return reply.code(201).send({ item: row });
  });

  app.delete('/api/dependencies/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM opportunity_dependencies WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '依赖不存在');
    return { ok: true };
  });

  // ------------------------------------------------------------ 风险
  app.get('/api/engagements/:id/risks', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return {
      items: await query(
        `SELECT * FROM risks WHERE engagement_id = $1
          ORDER BY (status = 'open') DESC, (probability * impact) DESC, title`, [id]),
    };
  });

  app.post('/api/engagements/:id/risks', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await engagementOr404(id);
    const body = riskFields.partial({ status: true }).parse(req.body);
    const row = await one(
      `INSERT INTO risks (engagement_id, title, category, probability, impact, mitigation, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, body.title, body.category, body.probability, body.impact, body.mitigation ?? null, body.status ?? 'open'],
    );
    return reply.code(201).send({ item: row });
  });

  app.patch('/api/risks/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = riskFields.partial().parse(req.body);
    return {
      item: await updateById('risks', id, body, [
        'title', 'category', 'probability', 'impact', 'mitigation', 'status',
      ]),
    };
  });

  app.delete('/api/risks/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM risks WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '风险不存在');
    return { ok: true };
  });
}
