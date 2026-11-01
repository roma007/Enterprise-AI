import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, query, withTransaction } from '../db';
import { httpError } from '../services/s1';

const uuid = z.uuid();
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
const text = z.string().trim().min(1);

const experimentCreate = z.object({
  hypothesis: text,
  method: text,
  sample_size: z.coerce.number().int().positive().nullish(),
  success_metric: text,
  threshold: text,
  start_date: dateStr.nullish(),
  end_date: dateStr.nullish(),
  owner: uuid.nullish(),
  status: z.enum(['planned', 'running', 'reviewing', 'passed', 'failed', 'cancelled']).default('planned'),
});

const experimentPatch = z.object({
  hypothesis: text.optional(),
  method: text.optional(),
  sample_size: z.coerce.number().int().positive().nullish(),
  success_metric: text.optional(),
  threshold: text.optional(),
  start_date: dateStr.nullish(),
  end_date: dateStr.nullish(),
  owner: uuid.nullish(),
  status: z.enum(['planned', 'running', 'reviewing', 'passed', 'failed', 'cancelled']).optional(),
});

const datasetBody = z.object({
  name: text,
  source: z.string().nullish(),
  sample_count: z.coerce.number().int().positive().nullish(),
  fields: z.string().nullish(),
  access_status: z.enum(['pending', 'approved', 'rejected', 'not_required']).default('pending'),
  version: z.string().nullish(),
  note: z.string().nullish(),
});

const datasetPatch = z.object({
  name: text.optional(),
  source: z.string().nullish(),
  sample_count: z.coerce.number().int().positive().nullish(),
  fields: z.string().nullish(),
  access_status: z.enum(['pending', 'approved', 'rejected', 'not_required']).optional(),
  version: z.string().nullish(),
  note: z.string().nullish(),
});

const runBody = z.object({
  dataset_id: uuid.nullish(),
  config: z.string().nullish(),
  started_at: z.string().datetime().nullish(),
  finished_at: z.string().datetime().nullish(),
  metrics: z.record(z.string(), z.any()).default({}),
  issues: z.string().nullish(),
});

const runPatch = z.object({
  dataset_id: uuid.nullish(),
  config: z.string().nullish(),
  started_at: z.string().datetime().nullish(),
  finished_at: z.string().datetime().nullish(),
  metrics: z.record(z.string(), z.any()).optional(),
  issues: z.string().nullish(),
});

const reviewBody = z.object({
  reviewer: uuid,
  sample_count: z.coerce.number().int().positive().nullish(),
  accuracy: z.coerce.number().min(0).max(1).nullish(),
  false_positive: z.coerce.number().min(0).nullish(),
  notes: z.string().nullish(),
});

const conclusionBody = z.object({
  decision: z.enum(['go', 'no_go', 'conditional', 'pending']),
  evidence: text,
  conditions: z.string().nullish(),
  decided_by: uuid.nullish(),
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

/** 最新实验的 G3 校验。 */
async function runG3Checks(engagementId: string) {
  const experiments = await query<any>(
    `SELECT DISTINCT ON (e.opportunity_id)
            e.*, o.code AS opportunity_code, o.title AS opportunity_title, o.stage,
            (SELECT count(*) FROM poc_datasets d WHERE d.experiment_id = e.id
              AND d.access_status IN ('approved','not_required')) AS usable_dataset_count,
            (SELECT count(*) FROM poc_runs r WHERE r.experiment_id = e.id) AS run_count,
            (SELECT count(*) FROM poc_reviews rv
               JOIN poc_runs r ON r.id = rv.run_id
              WHERE r.experiment_id = e.id) AS review_count,
            c.decision, c.evidence, c.conditions
       FROM poc_experiments e
       JOIN opportunities o ON o.id = e.opportunity_id
       LEFT JOIN poc_conclusions c ON c.experiment_id = e.id
      WHERE o.engagement_id = $1 AND e.status <> 'cancelled'
      ORDER BY e.opportunity_id, e.version DESC`,
    [engagementId],
  );

  const piloting = await query<any>(
    `SELECT o.id, o.code, o.title
       FROM opportunities o
      WHERE o.engagement_id = $1 AND o.stage = 'piloting'
        AND NOT EXISTS (
          SELECT 1 FROM poc_experiments e
           WHERE e.opportunity_id = o.id AND e.status <> 'cancelled'
        )
      ORDER BY o.code`,
    [engagementId],
  );

  const checks: any[] = [];
  const ok = (code: string, title: string, message: string, evidence?: unknown) =>
    checks.push({ code, title, level: 'block', outcome: 'pass', message, evidence });
  const warn = (code: string, title: string, message: string, evidence?: unknown) =>
    checks.push({ code, title, level: 'warn', outcome: 'warn', message, evidence });
  const block = (code: string, title: string, message: string, evidence?: unknown) =>
    checks.push({ code, title, level: 'block', outcome: 'block', message, evidence });

  {
    const missing = piloting;
    missing.length
      ? block('G3-1', 'piloting 机会点必须有 POC 实验', `${missing.map((o) => o.code).join('、')} 没有实验`, missing)
      : ok('G3-1', 'piloting 机会点必须有 POC 实验', 'piloting 机会点均有实验');
  }

  {
    const missing = experiments.filter(
      (e) =>
        !String(e.hypothesis ?? '').trim() ||
        !String(e.method ?? '').trim() ||
        !String(e.success_metric ?? '').trim() ||
        !String(e.threshold ?? '').trim(),
    );
    missing.length
      ? block('G3-2', '实验设计完整（假设/方法/指标/阈值）', `${missing.map((e) => `${e.opportunity_code} v${e.version}`).join('、')} 设计不完整`, missing)
      : ok('G3-2', '实验设计完整（假设/方法/指标/阈值）', `${experiments.length} 个实验设计完整`);
  }

  {
    const missing = experiments.filter((e) => Number(e.usable_dataset_count) === 0);
    missing.length
      ? block('G3-3', '至少有一份可用样本数据', `${missing.map((e) => `${e.opportunity_code} v${e.version}`).join('、')} 没有已批准/免申请样本`, missing)
      : ok('G3-3', '至少有一份可用样本数据', `${experiments.length} 个实验均有可用样本`);
  }

  {
    const missing = experiments.filter((e) => Number(e.run_count) === 0);
    missing.length
      ? block('G3-4', '至少有一次运行记录', `${missing.map((e) => `${e.opportunity_code} v${e.version}`).join('、')} 没有运行记录`, missing)
      : ok('G3-4', '至少有一次运行记录', `${experiments.length} 个实验均有运行记录`);
  }

  {
    const missing = experiments.filter((e) => Number(e.review_count) === 0);
    missing.length
      ? block('G3-5', '运行结果必须人工复核', `${missing.map((e) => `${e.opportunity_code} v${e.version}`).join('、')} 没有复核记录`, missing)
      : ok('G3-5', '运行结果必须人工复核', `${experiments.length} 个实验均有复核`);
  }

  {
    const missing = experiments.filter(
      (e) => !e.decision || !String(e.evidence ?? '').trim(),
    );
    missing.length
      ? block('G3-6', '必须有结论与证据', `${missing.map((e) => `${e.opportunity_code} v${e.version}`).join('、')} 缺少结论/证据`, missing)
      : ok('G3-6', '必须有结论与证据', `${experiments.length} 个实验均有结论`);
  }

  {
    const missing = experiments.filter((e) => e.decision === 'pending');
    missing.length
      ? block('G3-7', '决策不能停留在 pending', `${missing.map((e) => `${e.opportunity_code} v${e.version}`).join('、')} 仍是 pending`, missing)
      : ok('G3-7', '决策不能停留在 pending', '所有实验均已给出 Go / No-Go / 有条件');
  }

  {
    const missing = experiments.filter(
      (e) =>
        ['no_go', 'conditional'].includes(e.decision) &&
        !String(e.conditions ?? '').trim(),
    );
    missing.length
      ? warn('G3-8', '失败/有条件决策应写后续条件', `${missing.map((e) => `${e.opportunity_code} v${e.version}`).join('、')} 缺少后续条件`, missing)
      : ok('G3-8', '失败/有条件决策应写后续条件', '无需补充');
  }

  const summary = { pass: 0, warn: 0, block: 0 };
  for (const c of checks) summary[c.outcome as keyof typeof summary] += 1;
  return { summary, blocked: summary.block > 0, checks };
}

export async function s3Routes(app: FastifyInstance) {
  // ------------------------------------------------------------ G3
  app.get('/api/engagements/:id/g3-checks', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return runG3Checks(id);
  });

  // ------------------------------------------------------------ 实验
  app.get('/api/engagements/:id/poc-experiments', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const items = await query(
      `SELECT e.*, o.code AS opportunity_code, o.title AS opportunity_title,
              o.target_phase, o.stage,
              (SELECT count(*) FROM poc_datasets d WHERE d.experiment_id = e.id) AS dataset_count,
              (SELECT count(*) FROM poc_runs r WHERE r.experiment_id = e.id) AS run_count,
              (SELECT count(*) FROM poc_reviews rv JOIN poc_runs r ON r.id = rv.run_id
                WHERE r.experiment_id = e.id) AS review_count,
              c.decision
         FROM poc_experiments e
         JOIN opportunities o ON o.id = e.opportunity_id
         LEFT JOIN poc_conclusions c ON c.experiment_id = e.id
        WHERE o.engagement_id = $1
        ORDER BY o.code, e.version DESC`,
      [id],
    );
    return { items };
  });

  app.post('/api/opportunities/:id/poc-experiments', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = experimentCreate.parse(req.body);

    const created = await withTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
        id,
        'poc_experiments',
      ]);
      const v = await client.query<{ v: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM poc_experiments WHERE opportunity_id = $1`,
        [id],
      );
      const row = await client.query(
        `INSERT INTO poc_experiments
           (opportunity_id, version, hypothesis, method, sample_size, success_metric,
            threshold, start_date, end_date, owner, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          id, v.rows[0].v, body.hypothesis, body.method, body.sample_size ?? null,
          body.success_metric, body.threshold, body.start_date ?? null,
          body.end_date ?? null, body.owner ?? null, body.status,
        ],
      );
      return row.rows[0];
    });

    return reply.code(201).send({ item: created });
  });

  app.get('/api/poc-experiments/:id', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const item = await one(
      `SELECT e.*, o.code AS opportunity_code, o.title AS opportunity_title,
              o.engagement_id, o.target_phase, o.stage
         FROM poc_experiments e
         JOIN opportunities o ON o.id = e.opportunity_id
        WHERE e.id = $1`,
      [id],
    );
    if (!item) return reply.code(404).send({ error: 'NOT_FOUND', message: '实验不存在' });

    const [datasets, runs, reviews, conclusion] = await Promise.all([
      query(`SELECT * FROM poc_datasets WHERE experiment_id = $1 ORDER BY created_at`, [id]),
      query(
        `SELECT r.*, d.name AS dataset_name
           FROM poc_runs r LEFT JOIN poc_datasets d ON d.id = r.dataset_id
          WHERE r.experiment_id = $1 ORDER BY r.run_no DESC`,
        [id],
      ),
      query(
        `SELECT rv.*, u.name AS reviewer_name
           FROM poc_reviews rv
           JOIN poc_runs r ON r.id = rv.run_id
           LEFT JOIN users u ON u.id = rv.reviewer
          WHERE r.experiment_id = $1 ORDER BY rv.reviewed_at DESC`,
        [id],
      ),
      one(`SELECT * FROM poc_conclusions WHERE experiment_id = $1`, [id]),
    ]);

    return { item, datasets, runs, reviews, conclusion };
  });

  app.patch('/api/poc-experiments/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = experimentPatch.parse(req.body);
    return {
      item: await updateById(
        'poc_experiments',
        id,
        body,
        [
          'hypothesis', 'method', 'sample_size', 'success_metric', 'threshold',
          'start_date', 'end_date', 'owner', 'status',
        ],
        true,
      ),
    };
  });

  app.delete('/api/poc-experiments/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM poc_experiments WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '实验不存在');
    return { ok: true };
  });

  // ------------------------------------------------------------ 样本
  app.post('/api/poc-experiments/:id/datasets', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = datasetBody.parse(req.body);
    const row = await one(
      `INSERT INTO poc_datasets
         (experiment_id, name, source, sample_count, fields, access_status, version, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        id, body.name, body.source ?? null, body.sample_count ?? null,
        body.fields ?? null, body.access_status, body.version ?? null, body.note ?? null,
      ],
    );
    return reply.code(201).send({ item: row });
  });

  app.patch('/api/poc-datasets/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = datasetPatch.parse(req.body);
    return {
      item: await updateById('poc_datasets', id, body, [
        'name', 'source', 'sample_count', 'fields', 'access_status', 'version', 'note',
      ]),
    };
  });

  app.delete('/api/poc-datasets/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM poc_datasets WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '样本不存在');
    return { ok: true };
  });

  // ------------------------------------------------------------ 运行
  app.post('/api/poc-experiments/:id/runs', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = runBody.parse(req.body);

    const created = await withTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [id, 'poc_runs']);
      const n = await client.query<{ v: number }>(
        `SELECT COALESCE(MAX(run_no), 0) + 1 AS v FROM poc_runs WHERE experiment_id = $1`,
        [id],
      );
      const row = await client.query(
        `INSERT INTO poc_runs
           (experiment_id, run_no, dataset_id, config, started_at, finished_at, metrics, issues)
         VALUES ($1,$2,$3,$4,COALESCE($5::timestamptz, now()),$6,$7,$8) RETURNING *`,
        [
          id, n.rows[0].v, body.dataset_id ?? null, body.config ?? null,
          body.started_at ?? null, body.finished_at ?? null,
          JSON.stringify(body.metrics ?? {}), body.issues ?? null,
        ],
      );
      await client.query(
        `UPDATE poc_experiments SET status = 'reviewing', updated_at = now()
          WHERE id = $1 AND status IN ('planned','running')`,
        [id],
      );
      return row.rows[0];
    });

    return reply.code(201).send({ item: created });
  });

  app.patch('/api/poc-runs/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = runPatch.parse(req.body);
    return {
      item: await updateById('poc_runs', id, body, [
        'dataset_id', 'config', 'started_at', 'finished_at', 'metrics', 'issues',
      ]),
    };
  });

  app.delete('/api/poc-runs/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM poc_runs WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '运行记录不存在');
    return { ok: true };
  });

  // ------------------------------------------------------------ 复核
  app.post('/api/poc-runs/:id/reviews', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = reviewBody.parse(req.body);
    const row = await one(
      `INSERT INTO poc_reviews
         (run_id, reviewer, sample_count, accuracy, false_positive, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        id, body.reviewer, body.sample_count ?? null, body.accuracy ?? null,
        body.false_positive ?? null, body.notes ?? null,
      ],
    );
    return reply.code(201).send({ item: row });
  });

  app.delete('/api/poc-reviews/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM poc_reviews WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '复核记录不存在');
    return { ok: true };
  });

  // ------------------------------------------------------------ 结论
  app.put('/api/poc-experiments/:id/conclusion', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = conclusionBody.parse(req.body);

    const result = await withTransaction(async (client) => {
      const row = await client.query(
        `INSERT INTO poc_conclusions
           (experiment_id, decision, evidence, conditions, decided_by)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (experiment_id) DO UPDATE SET
           decision = EXCLUDED.decision,
           evidence = EXCLUDED.evidence,
           conditions = EXCLUDED.conditions,
           decided_by = EXCLUDED.decided_by,
           decided_at = now()
         RETURNING *`,
        [id, body.decision, body.evidence, body.conditions ?? null, body.decided_by ?? null],
      );
      const status =
        body.decision === 'go'
          ? 'passed'
          : body.decision === 'no_go'
            ? 'failed'
            : body.decision === 'conditional'
              ? 'reviewing'
              : 'reviewing';
      await client.query(
        `UPDATE poc_experiments SET status = $2, updated_at = now() WHERE id = $1`,
        [id, status],
      );

      // Go / No-Go 联动机会点阶段：不覆盖更靠后的阶段
      const opp = await client.query<{ id: string; stage: string }>(
        `UPDATE opportunities
            SET stage = CASE
                  WHEN $2 = 'go'
                       AND stage NOT IN ('validated','delivering','live','realized','closed')
                    THEN 'validated'
                  WHEN $2 = 'no_go'
                       AND stage NOT IN ('parked','killed','delivering','live','realized','closed')
                    THEN 'parked'
                  ELSE stage
                END
          WHERE id = (SELECT opportunity_id FROM poc_experiments WHERE id = $1)
          RETURNING id, stage`,
        [id, body.decision],
      );

      return {
        conclusion: row.rows[0],
        status,
        opportunity_stage: opp.rows[0]?.stage ?? null,
      };
    });

    return result;
  });
}
