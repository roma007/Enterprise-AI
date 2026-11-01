import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, query, withTransaction } from '../db';
import { httpError } from '../services/s1';

const uuid = z.uuid();
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
const text = z.string().trim().min(1);

const planCreate = z.object({
  name: text,
  start_date: dateStr,
  end_date: dateStr,
  status: z.enum(['draft', 'active', 'completed', 'on_hold', 'cancelled']).default('draft'),
  owner: uuid.nullish(),
  notes: z.string().nullish(),
});

const planPatch = z.object({
  name: text.optional(),
  start_date: dateStr.optional(),
  end_date: dateStr.optional(),
  status: z.enum(['draft', 'active', 'completed', 'on_hold', 'cancelled']).optional(),
  owner: uuid.nullish(),
  notes: z.string().nullish(),
});

const taskCreate = z.object({
  phase: text,
  name: text,
  owner: uuid.nullish(),
  start_date: dateStr.nullish(),
  end_date: dateStr.nullish(),
  status: z.enum(['todo', 'doing', 'done', 'blocked']).default('todo'),
  progress: z.coerce.number().int().min(0).max(100).default(0),
  is_milestone: z.boolean().default(false),
  dependency: z.string().nullish(),
  note: z.string().nullish(),
  sort_order: z.coerce.number().int().default(0),
});

const taskPatch = taskCreate.partial();

const uatCreate = z.object({
  acceptance_id: uuid.nullish(),
  code: z.string().nullish(),
  scenario: text,
  steps: text,
  expected: text,
  actual: z.string().nullish(),
  status: z.enum(['pending', 'passed', 'failed', 'blocked', 'skipped']).default('pending'),
  owner: uuid.nullish(),
  note: z.string().nullish(),
});

const uatPatch = z.object({
  acceptance_id: uuid.nullish(),
  scenario: text.optional(),
  steps: text.optional(),
  expected: text.optional(),
  actual: z.string().nullish(),
  status: z.enum(['pending', 'passed', 'failed', 'blocked', 'skipped']).optional(),
  owner: uuid.nullish(),
  note: z.string().nullish(),
});

const goLiveCreate = z.object({
  category: text,
  item: text,
  status: z.enum(['pending', 'passed', 'failed', 'waived']).default('pending'),
  blocking: z.boolean().default(true),
  owner: uuid.nullish(),
  evidence: z.string().nullish(),
  sort_order: z.coerce.number().int().default(0),
});

const goLivePatch = goLiveCreate.partial();

const trainingCreate = z.object({
  title: text,
  audience: z.string().nullish(),
  mode: z.enum(['onsite', 'video', 'online']).default('onsite'),
  trainer: uuid.nullish(),
  scheduled_at: dateStr.nullish(),
  attendees: z.coerce.number().int().min(0).nullish(),
  materials: z.string().nullish(),
  status: z.enum(['planned', 'done', 'cancelled']).default('planned'),
  feedback: z.string().nullish(),
});

const trainingPatch = trainingCreate.partial();

const issueCreate = z.object({
  kind: z.enum(['issue', 'change']).default('issue'),
  title: text,
  description: z.string().nullish(),
  severity: z.enum(['P0', 'P1', 'P2', 'P3']).default('P2'),
  status: z.enum(['open', 'in_progress', 'resolved', 'closed', 'rejected']).default('open'),
  owner: uuid.nullish(),
  due_date: dateStr.nullish(),
  resolution: z.string().nullish(),
  impact: z.string().nullish(),
  approval_status: z.enum(['not_required', 'pending', 'approved', 'rejected']).default('not_required'),
});

const issuePatch = issueCreate.partial().extend({
  approved_by: uuid.nullish(),
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

/** UAT-001 / ISS-001 / CHG-001 自动编号。 */
async function nextDeliveryCode(
  client: any,
  table: 'uat_cases' | 'delivery_issues',
  engagementId: string,
  prefix: string,
  where = '',
) {
  const r = await client.query(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(code, '\\D', '', 'g'), '')::int), 0) + 1 AS n
       FROM ${table} WHERE engagement_id = $1 ${where}`,
    [engagementId],
  );
  return `${prefix}-${String(r.rows[0].n).padStart(3, '0')}`;
}

/** 最新一版交付计划的 G4 校验。 */
async function runG4Checks(engagementId: string) {
  const plan = await one<any>(
    `SELECT p.*,
            (SELECT count(*) FROM delivery_tasks t WHERE t.plan_id = p.id) AS task_count,
            (SELECT count(*) FROM delivery_tasks t
              WHERE t.plan_id = p.id AND t.is_milestone) AS milestone_count
       FROM delivery_plans p
      WHERE p.engagement_id = $1 AND p.status <> 'cancelled'
      ORDER BY p.version DESC LIMIT 1`,
    [engagementId],
  );

  const tasks = plan
    ? await query<any>(`SELECT * FROM delivery_tasks WHERE plan_id = $1`, [plan.id])
    : [];
  const uat = await query<any>(`SELECT * FROM uat_cases WHERE engagement_id = $1`, [engagementId]);
  const goLive = await query<any>(
    `SELECT * FROM go_live_items WHERE engagement_id = $1`,
    [engagementId],
  );
  const trainings = await query<any>(
    `SELECT * FROM trainings WHERE engagement_id = $1 AND status <> 'cancelled'`,
    [engagementId],
  );
  const issues = await query<any>(
    `SELECT * FROM delivery_issues WHERE engagement_id = $1`,
    [engagementId],
  );
  const criteria = await query<any>(
    `SELECT a.* FROM acceptance_criteria a
       JOIN solutions s ON s.id = a.solution_id
       JOIN opportunities o ON o.id = s.opportunity_id
      WHERE o.engagement_id = $1 AND a.status <> 'waived'`,
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
    plan
      ? ok('G4-1', '必须有实施计划且起止日期完整', `当前计划 v${plan.version}：${plan.start_date} → ${plan.end_date}`)
      : block('G4-1', '必须有实施计划且起止日期完整', '还没有交付实施计划');
  }

  {
    const missing = tasks.filter((t) => !t.owner || !t.start_date || !t.end_date);
    missing.length
      ? block('G4-2', '任务必须有负责人与起止日期', `${missing.map((t) => t.name).join('、')} 信息不全`, missing)
      : ok('G4-2', '任务必须有负责人与起止日期', `${tasks.length} 个任务信息完整`);
  }

  {
    plan && Number(plan.milestone_count) > 0
      ? ok('G4-3', '计划必须有里程碑', `${plan.milestone_count} 个里程碑`)
      : block('G4-3', '计划必须有里程碑', '计划中没有标记里程碑');
  }

  {
    const covered = new Set(uat.map((u) => u.acceptance_id).filter(Boolean));
    const missing = criteria.filter((c) => !covered.has(c.id));
    !criteria.length
      ? block('G4-4', 'UAT 用例覆盖全部验收标准', '还没有方案验收标准，无法验收')
      : missing.length
        ? block('G4-4', 'UAT 用例覆盖全部验收标准', `${missing.map((c) => c.metric).join('、')} 没有对应用例`, missing)
        : ok('G4-4', 'UAT 用例覆盖全部验收标准', `${criteria.length} 项验收标准均有用例`);
  }

  {
    const bad = uat.filter((u) => u.status !== 'passed');
    uat.length && !bad.length
      ? ok('G4-5', 'UAT 用例全部通过', `${uat.length} 条用例全部通过`)
      : block(
          'G4-5',
          'UAT 用例全部通过',
          uat.length
            ? `${bad.map((u) => `${u.code} ${u.scenario}`).join('、')} 未通过`
            : '还没有 UAT 用例',
          bad,
        );
  }

  {
    const bad = goLive.filter((i) => i.blocking && !['passed', 'waived'].includes(i.status));
    goLive.length && !bad.length
      ? ok('G4-6', '上线检查阻断项全部通过', `${goLive.length} 项检查通过`)
      : block(
          'G4-6',
          '上线检查阻断项全部通过',
          goLive.length
            ? `${bad.map((i) => i.item).join('、')} 未通过`
            : '还没有上线检查项',
          bad,
        );
  }

  {
    const done = trainings.filter((t) => t.status === 'done');
    done.length
      ? ok('G4-7', '至少完成一场培训', `${done.length} 场培训已完成`)
      : block('G4-7', '至少完成一场培训', '还没有已完成的培训');
  }

  {
    const bad = issues.filter(
      (i) => ['P0', 'P1'].includes(i.severity) && !['closed', 'rejected', 'resolved'].includes(i.status),
    );
    bad.length
      ? block('G4-8', '无未关闭 P0/P1 问题', `${bad.map((i) => `${i.code} ${i.title}`).join('、')} 未关闭`, bad)
      : ok('G4-8', '无未关闭 P0/P1 问题', '无高优先级遗留问题');
  }

  {
    const bad = issues.filter((i) => i.kind === 'change' && i.approval_status === 'pending');
    bad.length
      ? block('G4-9', '变更请求均已审批', `${bad.map((i) => `${i.code} ${i.title}`).join('、')} 待审批`, bad)
      : ok('G4-9', '变更请求均已审批', '变更请求均已处理');
  }

  {
    const today = new Date().toISOString().slice(0, 10);
    const overdue = tasks.filter((t) => t.end_date && String(t.end_date) < today && t.status !== 'done');
    overdue.length
      ? warn('G4-10', '任务无逾期', `${overdue.map((t) => t.name).join('、')} 已逾期`, overdue)
      : ok('G4-10', '任务无逾期', '任务均在计划内');
  }

  {
    const signoffs = await query<any>(
      `SELECT c.id, c.confirmed_at, d.title, d.type
         FROM confirmations c
         JOIN deliverables d ON d.id = c.object_id
        WHERE c.engagement_id = $1
          AND c.object_type = 'deliverable'
          AND d.type IN ('uat_report','go_live_checklist')
        ORDER BY c.confirmed_at DESC`,
      [engagementId],
    );
    signoffs.length
      ? ok(
          'G4-11',
          'UAT / 上线检查表已获客户签收',
          `${signoffs[0].title} 已确认`,
          signoffs,
        )
      : block(
          'G4-11',
          'UAT / 上线检查表已获客户签收',
          '还没有 UAT 报告或上线检查表的客户确认记录',
        );
  }

  const summary = { pass: 0, warn: 0, block: 0 };
  for (const c of checks) summary[c.outcome as keyof typeof summary] += 1;
  return { summary, blocked: summary.block > 0, checks };
}

export async function s4Routes(app: FastifyInstance) {
  // ------------------------------------------------------------ G4
  app.get('/api/engagements/:id/g4-checks', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return runG4Checks(id);
  });

  // ------------------------------------------------------------ 总览
  app.get('/api/engagements/:id/delivery-overview', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const plans = await query<any>(
      `SELECT p.*, u.name AS owner_name,
              (SELECT count(*) FROM delivery_tasks t WHERE t.plan_id = p.id) AS task_count,
              (SELECT count(*) FROM delivery_tasks t WHERE t.plan_id = p.id AND t.is_milestone) AS milestone_count,
              (SELECT count(*) FROM delivery_tasks t WHERE t.plan_id = p.id AND t.status = 'done') AS done_count
         FROM delivery_plans p
         LEFT JOIN users u ON u.id = p.owner
        WHERE p.engagement_id = $1
        ORDER BY p.version DESC`,
      [id],
    );
    const active = plans.find((p) => p.status !== 'cancelled') ?? null;
    const [tasks, uat, goLive, trainings, issues, criteria] = await Promise.all([
      active
        ? query<any>(
            `SELECT t.*, u.name AS owner_name
               FROM delivery_tasks t LEFT JOIN users u ON u.id = t.owner
              WHERE t.plan_id = $1 ORDER BY t.sort_order, t.created_at`,
            [active.id],
          )
        : [],
      query<any>(
        `SELECT c.*, a.metric AS acceptance_metric, u.name AS owner_name
           FROM uat_cases c
           LEFT JOIN acceptance_criteria a ON a.id = c.acceptance_id
           LEFT JOIN users u ON u.id = c.owner
          WHERE c.engagement_id = $1 ORDER BY c.code`,
        [id],
      ),
      query<any>(
        `SELECT g.*, u.name AS owner_name
           FROM go_live_items g LEFT JOIN users u ON u.id = g.owner
          WHERE g.engagement_id = $1 ORDER BY g.sort_order, g.created_at`,
        [id],
      ),
      query<any>(
        `SELECT t.*, u.name AS trainer_name
           FROM trainings t LEFT JOIN users u ON u.id = t.trainer
          WHERE t.engagement_id = $1 ORDER BY t.scheduled_at DESC NULLS LAST, t.created_at DESC`,
        [id],
      ),
      query<any>(
        `SELECT i.*, u.name AS owner_name
           FROM delivery_issues i LEFT JOIN users u ON u.id = i.owner
          WHERE i.engagement_id = $1 ORDER BY i.raised_at DESC`,
        [id],
      ),
      query<any>(
        `SELECT a.*, s.version AS solution_version, s.opportunity_id
           FROM acceptance_criteria a
           JOIN solutions s ON s.id = a.solution_id
           JOIN opportunities o ON o.id = s.opportunity_id
          WHERE o.engagement_id = $1
          ORDER BY a.sort_order, a.metric`,
        [id],
      ),
    ]);
    return { plans, activePlan: active, tasks, uat, goLive, trainings, issues, criteria };
  });

  // ------------------------------------------------------------ 实施计划
  app.get('/api/engagements/:id/delivery-plans', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const items = await query(
      `SELECT p.*, u.name AS owner_name,
              (SELECT count(*) FROM delivery_tasks t WHERE t.plan_id = p.id) AS task_count
         FROM delivery_plans p LEFT JOIN users u ON u.id = p.owner
        WHERE p.engagement_id = $1 ORDER BY p.version DESC`,
      [id],
    );
    return { items };
  });

  app.post('/api/engagements/:id/delivery-plans', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = planCreate.parse(req.body);

    const created = await withTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
        id,
        'delivery_plans',
      ]);
      const v = await client.query<{ v: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM delivery_plans WHERE engagement_id = $1`,
        [id],
      );
      const row = await client.query(
        `INSERT INTO delivery_plans
           (engagement_id, version, name, start_date, end_date, status, owner, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          id, v.rows[0].v, body.name, body.start_date, body.end_date,
          body.status, body.owner ?? null, body.notes ?? null,
        ],
      );
      return row.rows[0];
    });

    return reply.code(201).send({ item: created });
  });

  app.get('/api/delivery-plans/:id', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const item = await one(
      `SELECT p.*, u.name AS owner_name FROM delivery_plans p
         LEFT JOIN users u ON u.id = p.owner WHERE p.id = $1`,
      [id],
    );
    if (!item) return reply.code(404).send({ error: 'NOT_FOUND', message: '计划不存在' });
    const tasks = await query(
      `SELECT t.*, u.name AS owner_name FROM delivery_tasks t
         LEFT JOIN users u ON u.id = t.owner
        WHERE t.plan_id = $1 ORDER BY t.sort_order, t.created_at`,
      [id],
    );
    return { item, tasks };
  });

  app.patch('/api/delivery-plans/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = planPatch.parse(req.body);
    return {
      item: await updateById(
        'delivery_plans', id, body,
        ['name', 'start_date', 'end_date', 'status', 'owner', 'notes'],
        true,
      ),
    };
  });

  app.delete('/api/delivery-plans/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM delivery_plans WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '计划不存在');
    return { ok: true };
  });

  // ------------------------------------------------------------ 任务
  app.post('/api/delivery-plans/:id/tasks', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = taskCreate.parse(req.body);
    const row = await one(
      `INSERT INTO delivery_tasks
         (plan_id, phase, name, owner, start_date, end_date, status, progress,
          is_milestone, dependency, note, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        id, body.phase, body.name, body.owner ?? null, body.start_date ?? null,
        body.end_date ?? null, body.status, body.progress, body.is_milestone,
        body.dependency ?? null, body.note ?? null, body.sort_order,
      ],
    );
    return reply.code(201).send({ item: row });
  });

  app.patch('/api/delivery-tasks/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = taskPatch.parse(req.body);
    return {
      item: await updateById(
        'delivery_tasks', id, body,
        ['phase', 'name', 'owner', 'start_date', 'end_date', 'status', 'progress',
          'is_milestone', 'dependency', 'note', 'sort_order'],
        true,
      ),
    };
  });

  app.delete('/api/delivery-tasks/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM delivery_tasks WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '任务不存在');
    return { ok: true };
  });

  // ------------------------------------------------------------ UAT
  app.get('/api/engagements/:id/uat-cases', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const items = await query(
      `SELECT c.*, a.metric AS acceptance_metric, u.name AS owner_name
         FROM uat_cases c
         LEFT JOIN acceptance_criteria a ON a.id = c.acceptance_id
         LEFT JOIN users u ON u.id = c.owner
        WHERE c.engagement_id = $1 ORDER BY c.code`,
      [id],
    );
    return { items };
  });

  app.post('/api/engagements/:id/uat-cases', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = uatCreate.parse(req.body);

    const row = await withTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
        id,
        'uat_cases',
      ]);
      const code = body.code?.trim() || (await nextDeliveryCode(client, 'uat_cases', id, 'UAT'));
      const ins = await client.query(
        `INSERT INTO uat_cases
           (engagement_id, acceptance_id, code, scenario, steps, expected, actual, status, owner, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          id, body.acceptance_id ?? null, code, body.scenario, body.steps,
          body.expected, body.actual ?? null, body.status, body.owner ?? null,
          body.note ?? null,
        ],
      );
      return ins.rows[0];
    });

    return reply.code(201).send({ item: row });
  });

  app.patch('/api/uat-cases/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = uatPatch.parse(req.body);
    return {
      item: await updateById(
        'uat_cases', id, body,
        ['acceptance_id', 'scenario', 'steps', 'expected', 'actual', 'status', 'owner', 'note'],
        true,
      ),
    };
  });

  app.delete('/api/uat-cases/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM uat_cases WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', 'UAT 用例不存在');
    return { ok: true };
  });

  // ------------------------------------------------------------ 上线检查
  app.get('/api/engagements/:id/go-live-items', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const items = await query(
      `SELECT g.*, u.name AS owner_name FROM go_live_items g
         LEFT JOIN users u ON u.id = g.owner
        WHERE g.engagement_id = $1 ORDER BY g.sort_order, g.created_at`,
      [id],
    );
    return { items };
  });

  app.post('/api/engagements/:id/go-live-items', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = goLiveCreate.parse(req.body);
    const row = await one(
      `INSERT INTO go_live_items
         (engagement_id, category, item, status, blocking, owner, evidence, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        id, body.category, body.item, body.status, body.blocking,
        body.owner ?? null, body.evidence ?? null, body.sort_order,
      ],
    );
    return reply.code(201).send({ item: row });
  });

  app.patch('/api/go-live-items/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = goLivePatch.parse(req.body);
    return {
      item: await updateById(
        'go_live_items', id, body,
        ['category', 'item', 'status', 'blocking', 'owner', 'evidence', 'sort_order'],
        true,
      ),
    };
  });

  app.delete('/api/go-live-items/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM go_live_items WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '检查项不存在');
    return { ok: true };
  });

  // ------------------------------------------------------------ 培训
  app.get('/api/engagements/:id/trainings', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const items = await query(
      `SELECT t.*, u.name AS trainer_name FROM trainings t
         LEFT JOIN users u ON u.id = t.trainer
        WHERE t.engagement_id = $1 ORDER BY t.scheduled_at DESC NULLS LAST, t.created_at DESC`,
      [id],
    );
    return { items };
  });

  app.post('/api/engagements/:id/trainings', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = trainingCreate.parse(req.body);
    const row = await one(
      `INSERT INTO trainings
         (engagement_id, title, audience, mode, trainer, scheduled_at, attendees,
          materials, status, feedback)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        id, body.title, body.audience ?? null, body.mode, body.trainer ?? null,
        body.scheduled_at ?? null, body.attendees ?? null, body.materials ?? null,
        body.status, body.feedback ?? null,
      ],
    );
    return reply.code(201).send({ item: row });
  });

  app.patch('/api/trainings/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = trainingPatch.parse(req.body);
    return {
      item: await updateById(
        'trainings', id, body,
        ['title', 'audience', 'mode', 'trainer', 'scheduled_at', 'attendees',
          'materials', 'status', 'feedback'],
        true,
      ),
    };
  });

  app.delete('/api/trainings/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM trainings WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '培训不存在');
    return { ok: true };
  });

  // ------------------------------------------------------------ 问题 / 变更
  app.get('/api/engagements/:id/delivery-issues', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const items = await query(
      `SELECT i.*, u.name AS owner_name, a.name AS approved_by_name
         FROM delivery_issues i
         LEFT JOIN users u ON u.id = i.owner
         LEFT JOIN users a ON a.id = i.approved_by
        WHERE i.engagement_id = $1 ORDER BY i.raised_at DESC`,
      [id],
    );
    return { items };
  });

  app.post('/api/engagements/:id/delivery-issues', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = issueCreate.parse(req.body);

    const row = await withTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
        id,
        'delivery_issues',
      ]);
      const prefix = body.kind === 'change' ? 'CHG' : 'ISS';
      const code = await nextDeliveryCode(
        client, 'delivery_issues', id, prefix,
        `AND kind = '${body.kind === 'change' ? 'change' : 'issue'}'`,
      );
      const ins = await client.query(
        `INSERT INTO delivery_issues
           (engagement_id, code, kind, title, description, severity, status, owner,
            due_date, resolution, impact, approval_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [
          id, code, body.kind, body.title, body.description ?? null, body.severity,
          body.status, body.owner ?? null, body.due_date ?? null,
          body.resolution ?? null, body.impact ?? null, body.approval_status,
        ],
      );
      return ins.rows[0];
    });

    return reply.code(201).send({ item: row });
  });

  app.patch('/api/delivery-issues/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = issuePatch.parse(req.body);
    const patch: Record<string, any> = { ...body };
    if (body.status === 'closed' || body.status === 'rejected') {
      patch.closed_at = new Date().toISOString();
    }
    if (body.approval_status === 'approved' || body.approval_status === 'rejected') {
      patch.approved_at = new Date().toISOString();
    }
    return {
      item: await updateById(
        'delivery_issues', id, patch,
        ['title', 'description', 'severity', 'status', 'owner', 'due_date',
          'resolution', 'impact', 'approval_status', 'approved_by', 'approved_at', 'closed_at'],
        true,
      ),
    };
  });

  app.delete('/api/delivery-issues/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM delivery_issues WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '问题不存在');
    return { ok: true };
  });
}
