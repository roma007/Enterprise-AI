import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, query } from '../db';
import { httpError } from '../services/s1';

const uuid = z.uuid();
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
const periodStr = z.string().regex(/^\d{4}-\d{2}$/, '周期格式应为 YYYY-MM');
const text = z.string().trim().min(1);

const metricDefCreate = z.object({
  key: text.regex(/^[a-z][a-z0-9_]*$/, '指标 key 只能用小写字母、数字和下划线'),
  name: text,
  unit: z.string().default(''),
  direction: z.enum(['higher_better', 'lower_better']).default('higher_better'),
  category: z.string().default('value'),
  formula: z.string().nullish(),
  source: z.string().nullish(),
  description: z.string().nullish(),
});

const metricDefPatch = metricDefCreate.partial().omit({ key: true });

const targetCreate = z.object({
  opportunity_id: uuid,
  metric_id: uuid,
  baseline: z.coerce.number().nullish(),
  target: z.coerce.number().nullish(),
  target_date: dateStr.nullish(),
  owner: uuid.nullish(),
  note: z.string().nullish(),
});

const targetPatch = z.object({
  baseline: z.coerce.number().nullish(),
  target: z.coerce.number().nullish(),
  target_date: dateStr.nullish(),
  owner: uuid.nullish(),
  note: z.string().nullish(),
});

const snapshotCreate = z.object({
  period: periodStr,
  value: z.coerce.number(),
  source: text,
  confidence: z.enum(['high', 'medium', 'low']).default('low'),
  note: z.string().nullish(),
  recorded_by: uuid.nullish(),
});

const snapshotPatch = z.object({
  value: z.coerce.number().optional(),
  source: text.optional(),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  note: z.string().nullish(),
});

const valueCreate = z.object({
  opportunity_id: uuid,
  target_id: uuid.nullish(),
  metric_id: uuid,
  period: periodStr,
  realized_value: z.coerce.number(),
  method: text,
  evidence: text,
  confidence: z.enum(['high', 'medium', 'low']).default('low'),
  variance_note: z.string().nullish(),
  verified_by: uuid.nullish(),
});

const valuePatch = z.object({
  realized_value: z.coerce.number().optional(),
  method: text.optional(),
  evidence: text.optional(),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  variance_note: z.string().nullish(),
  verified_by: uuid.nullish(),
});

const usageCreate = z.object({
  solution_id: uuid.nullish(),
  period: periodStr,
  active_users: z.coerce.number().int().min(0).default(0),
  volume: z.coerce.number().min(0).default(0),
  errors: z.coerce.number().int().min(0).default(0),
  source: text,
  note: z.string().nullish(),
});

const usagePatch = usageCreate.partial().omit({ period: true });

const renewalCreate = z.object({
  kind: z.enum(['renewal', 'expansion']).default('renewal'),
  title: text,
  probability: z.enum(['high', 'medium', 'low']).default('medium'),
  impact: z.string().nullish(),
  action: z.string().nullish(),
  owner: uuid.nullish(),
  due_date: dateStr.nullish(),
  value_potential: z.coerce.number().nullish(),
  status: z.enum(['open', 'mitigating', 'closed']).default('open'),
  note: z.string().nullish(),
});

const renewalPatch = renewalCreate.partial();

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

async function assertOpportunityInEngagement(opportunityId: string, engagementId: string) {
  const row = await one(
    `SELECT id FROM opportunities WHERE id = $1 AND engagement_id = $2`,
    [opportunityId, engagementId],
  );
  if (!row) throw httpError(422, 'OPPORTUNITY_MISMATCH', '机会点不属于该项目');
}

/** G5 价值实现门禁。 */
async function runG5Checks(engagementId: string) {
  const targets = await query<any>(
    `SELECT t.*, m.name AS metric_name, m.unit, m.direction,
            o.code AS opportunity_code, o.title AS opportunity_title,
            (SELECT count(*) FROM metric_snapshots s WHERE s.target_id = t.id) AS snapshot_count,
            (SELECT count(*) FROM value_records v WHERE v.target_id = t.id) AS value_count
       FROM metric_targets t
       JOIN metric_definitions m ON m.id = t.metric_id
       JOIN opportunities o ON o.id = t.opportunity_id
      WHERE t.engagement_id = $1
      ORDER BY o.code, m.name`,
    [engagementId],
  );
  const snapshots = await query<any>(
    `SELECT s.*, t.target, t.opportunity_id, m.name AS metric_name
       FROM metric_snapshots s
       JOIN metric_targets t ON t.id = s.target_id
       JOIN metric_definitions m ON m.id = t.metric_id
      WHERE t.engagement_id = $1`,
    [engagementId],
  );
  const values = await query<any>(
    `SELECT v.*, m.name AS metric_name, m.unit, o.code AS opportunity_code,
            t.target, t.target_date
       FROM value_records v
       JOIN metric_definitions m ON m.id = v.metric_id
       JOIN opportunities o ON o.id = v.opportunity_id
       LEFT JOIN metric_targets t ON t.id = v.target_id
      WHERE v.engagement_id = $1`,
    [engagementId],
  );
  const usage = await query<any>(
    `SELECT * FROM usage_records WHERE engagement_id = $1`,
    [engagementId],
  );
  const risks = await query<any>(
    `SELECT * FROM renewal_risks WHERE engagement_id = $1`,
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
    targets.length
      ? ok('G5-1', '至少有一个指标目标', `${targets.length} 个指标目标`)
      : block('G5-1', '至少有一个指标目标', '还没有定义任何收益指标目标');
  }

  {
    const missing = targets.filter(
      (t) => t.baseline == null || t.target == null || !t.target_date,
    );
    missing.length
      ? block(
          'G5-2',
          '目标必须有基线、目标值与目标日期',
          `${missing.map((t) => `${t.opportunity_code} ${t.metric_name}`).join('、')} 不完整`,
          missing,
        )
      : ok('G5-2', '目标必须有基线、目标值与目标日期', `${targets.length} 个目标完整`);
  }

  {
    const missing = targets.filter((t) => Number(t.snapshot_count) === 0);
    missing.length
      ? block(
          'G5-3',
          '每个目标至少有一个周期快照',
          `${missing.map((t) => `${t.opportunity_code} ${t.metric_name}`).join('、')} 没有快照`,
          missing,
        )
      : ok('G5-3', '每个目标至少有一个周期快照', `${targets.length} 个目标均有快照`);
  }

  {
    const bad = snapshots.filter((s) => !String(s.source ?? '').trim());
    bad.length
      ? block('G5-4', '快照必须有来源与置信度', `${bad.length} 条快照缺少来源`, bad)
      : ok('G5-4', '快照必须有来源与置信度', `${snapshots.length} 条快照来源完整`);
  }

  {
    const missing = targets.filter((t) => Number(t.value_count) === 0);
    missing.length
      ? block(
          'G5-5',
          '每个目标必须有价值记录',
          `${missing.map((t) => `${t.opportunity_code} ${t.metric_name}`).join('、')} 没有价值记录`,
          missing,
        )
      : ok('G5-5', '每个目标必须有价值记录', `${targets.length} 个目标均有价值记录`);
  }

  {
    const bad = values.filter(
      (v) => !String(v.method ?? '').trim() || !String(v.evidence ?? '').trim() || !v.verified_by,
    );
    bad.length
      ? block(
          'G5-6',
          '价值记录必须有方法、证据与确认人',
          `${bad.map((v) => `${v.opportunity_code} ${v.metric_name} ${v.period}`).join('、')} 不完整`,
          bad,
        )
      : ok('G5-6', '价值记录必须有方法、证据与确认人', `${values.length} 条价值记录完整`);
  }

  {
    const bad = values.filter((v) => {
      if (v.target == null || Number(v.target) === 0) return false;
      const diff = Math.abs(Number(v.realized_value) - Number(v.target)) / Math.abs(Number(v.target));
      return diff > 0.1 && !String(v.variance_note ?? '').trim();
    });
    bad.length
      ? warn(
          'G5-7',
          '价值差异超过 10% 必须有解释',
          `${bad.map((v) => `${v.opportunity_code} ${v.metric_name} ${v.period}`).join('、')} 缺少差异说明`,
          bad,
        )
      : ok('G5-7', '价值差异超过 10% 必须有解释', '无未解释的重大差异');
  }

  {
    const totalVolume = usage.reduce((s, u) => s + Number(u.volume ?? 0), 0);
    const totalErrors = usage.reduce((s, u) => s + Number(u.errors ?? 0), 0);
    const rate = totalVolume > 0 ? totalErrors / totalVolume : 0;
    !usage.length
      ? block('G5-8', '使用数据已登记且错误率可控', '还没有使用数据')
      : rate > 0.05
        ? warn('G5-8', '使用数据已登记且错误率可控', `错误率 ${(rate * 100).toFixed(1)}% 超过 5%`, usage)
        : ok('G5-8', '使用数据已登记且错误率可控', `错误率 ${(rate * 100).toFixed(2)}%`);
  }

  {
    const open = risks.filter((r) => r.status !== 'closed');
    const bad = open.filter((r) => !String(r.action ?? '').trim() || !r.owner || !r.due_date);
    bad.length
      ? block(
          'G5-9',
          '未关闭续约/二期风险必须有动作、负责人与截止日期',
          `${bad.map((r) => r.title).join('、')} 不完整`,
          bad,
        )
      : ok('G5-9', '未关闭续约/二期风险必须有动作、负责人与截止日期', `${open.length} 条风险有应对`);
  }

  const summary = { pass: 0, warn: 0, block: 0 };
  for (const c of checks) summary[c.outcome as keyof typeof summary] += 1;
  return { summary, blocked: summary.block > 0, checks };
}

export async function s5Routes(app: FastifyInstance) {
  // ------------------------------------------------------------ 指标字典
  app.get('/api/metric-definitions', async () => {
    const items = await query(`SELECT * FROM metric_definitions ORDER BY category, name`);
    return { items };
  });

  app.post('/api/metric-definitions', async (req, reply) => {
    const body = metricDefCreate.parse(req.body);
    const row = await one(
      `INSERT INTO metric_definitions (key, name, unit, direction, category, formula, source, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        body.key, body.name, body.unit, body.direction, body.category,
        body.formula ?? null, body.source ?? null, body.description ?? null,
      ],
    );
    return reply.code(201).send({ item: row });
  });

  app.patch('/api/metric-definitions/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = metricDefPatch.parse(req.body);
    return {
      item: await updateById(
        'metric_definitions', id, body,
        ['name', 'unit', 'direction', 'category', 'formula', 'source', 'description'],
        true,
      ),
    };
  });

  app.delete('/api/metric-definitions/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM metric_definitions WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '指标不存在');
    return { ok: true };
  });

  // ------------------------------------------------------------ 总览
  app.get('/api/engagements/:id/value-overview', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const [metrics, targets, snapshots, values, usage, risks] = await Promise.all([
      query(`SELECT * FROM metric_definitions ORDER BY category, name`),
      query(
        `SELECT t.*, m.name AS metric_name, m.unit, m.direction,
                o.code AS opportunity_code, o.title AS opportunity_title,
                u.name AS owner_name,
                (SELECT count(*) FROM metric_snapshots s WHERE s.target_id = t.id) AS snapshot_count,
                (SELECT count(*) FROM value_records v WHERE v.target_id = t.id) AS value_count
           FROM metric_targets t
           JOIN metric_definitions m ON m.id = t.metric_id
           JOIN opportunities o ON o.id = t.opportunity_id
           LEFT JOIN users u ON u.id = t.owner
          WHERE t.engagement_id = $1
          ORDER BY o.code, m.name`,
        [id],
      ),
      query(
        `SELECT s.*, t.target, t.opportunity_id, m.name AS metric_name, m.unit,
                o.code AS opportunity_code,
                su.name AS recorded_by_name
           FROM metric_snapshots s
           JOIN metric_targets t ON t.id = s.target_id
           JOIN metric_definitions m ON m.id = t.metric_id
           JOIN opportunities o ON o.id = t.opportunity_id
           LEFT JOIN users su ON su.id = s.recorded_by
          WHERE t.engagement_id = $1
          ORDER BY s.period DESC, m.name`,
        [id],
      ),
      query(
        `SELECT v.*, m.name AS metric_name, m.unit, o.code AS opportunity_code,
                o.title AS opportunity_title, t.target, u.name AS verified_by_name
           FROM value_records v
           JOIN metric_definitions m ON m.id = v.metric_id
           JOIN opportunities o ON o.id = v.opportunity_id
           LEFT JOIN metric_targets t ON t.id = v.target_id
           LEFT JOIN users u ON u.id = v.verified_by
          WHERE v.engagement_id = $1
          ORDER BY v.period DESC, o.code, m.name`,
        [id],
      ),
      query(
        `SELECT u.*, s.version AS solution_version
           FROM usage_records u LEFT JOIN solutions s ON s.id = u.solution_id
          WHERE u.engagement_id = $1
          ORDER BY u.period DESC, u.created_at DESC`,
        [id],
      ),
      query(
        `SELECT r.*, u.name AS owner_name
           FROM renewal_risks r LEFT JOIN users u ON u.id = r.owner
          WHERE r.engagement_id = $1
          ORDER BY r.status, r.due_date NULLS LAST, r.created_at DESC`,
        [id],
      ),
    ]);

    return {
      metrics,
      targets,
      snapshots,
      values,
      usage,
      risks,
      totals: {
        targets: targets.length,
        snapshots: snapshots.length,
        values: values.length,
        activeUsers: usage.reduce((s, u) => s + Number(u.active_users ?? 0), 0),
        openRisks: risks.filter((r) => r.status !== 'closed').length,
        realizedValue: values
          .filter((v) => v.unit === '万元')
          .reduce((s, v) => s + Number(v.realized_value ?? 0), 0),
      },
    };
  });

  // ------------------------------------------------------------ G5
  app.get('/api/engagements/:id/g5-checks', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return runG5Checks(id);
  });

  // ------------------------------------------------------------ 指标目标
  app.get('/api/engagements/:id/metric-targets', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const items = await query(
      `SELECT t.*, m.name AS metric_name, m.unit, o.code AS opportunity_code
         FROM metric_targets t
         JOIN metric_definitions m ON m.id = t.metric_id
         JOIN opportunities o ON o.id = t.opportunity_id
        WHERE t.engagement_id = $1 ORDER BY o.code, m.name`,
      [id],
    );
    return { items };
  });

  app.post('/api/engagements/:id/metric-targets', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = targetCreate.parse(req.body);
    await assertOpportunityInEngagement(body.opportunity_id, id);
    const row = await one(
      `INSERT INTO metric_targets
         (engagement_id, opportunity_id, metric_id, baseline, target, target_date, owner, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        id, body.opportunity_id, body.metric_id, body.baseline ?? null,
        body.target ?? null, body.target_date ?? null, body.owner ?? null, body.note ?? null,
      ],
    );
    return reply.code(201).send({ item: row });
  });

  app.patch('/api/metric-targets/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = targetPatch.parse(req.body);
    return {
      item: await updateById(
        'metric_targets', id, body,
        ['baseline', 'target', 'target_date', 'owner', 'note'],
        true,
      ),
    };
  });

  app.delete('/api/metric-targets/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM metric_targets WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '指标目标不存在');
    return { ok: true };
  });

  // ------------------------------------------------------------ 快照
  app.get('/api/metric-targets/:id/snapshots', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const items = await query(
      `SELECT s.*, u.name AS recorded_by_name FROM metric_snapshots s
         LEFT JOIN users u ON u.id = s.recorded_by
        WHERE s.target_id = $1 ORDER BY s.period DESC`,
      [id],
    );
    return { items };
  });

  app.post('/api/metric-targets/:id/snapshots', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = snapshotCreate.parse(req.body);
    const row = await one(
      `INSERT INTO metric_snapshots
         (target_id, period, value, source, confidence, note, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        id, body.period, body.value, body.source, body.confidence,
        body.note ?? null, body.recorded_by ?? null,
      ],
    );
    return reply.code(201).send({ item: row });
  });

  app.patch('/api/metric-snapshots/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = snapshotPatch.parse(req.body);
    return {
      item: await updateById(
        'metric_snapshots', id, body,
        ['value', 'source', 'confidence', 'note'],
      ),
    };
  });

  app.delete('/api/metric-snapshots/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM metric_snapshots WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '快照不存在');
    return { ok: true };
  });

  // ------------------------------------------------------------ 价值记录
  app.get('/api/engagements/:id/value-records', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const items = await query(
      `SELECT v.*, m.name AS metric_name, m.unit, o.code AS opportunity_code
         FROM value_records v
         JOIN metric_definitions m ON m.id = v.metric_id
         JOIN opportunities o ON o.id = v.opportunity_id
        WHERE v.engagement_id = $1 ORDER BY v.period DESC, o.code`,
      [id],
    );
    return { items };
  });

  app.post('/api/engagements/:id/value-records', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = valueCreate.parse(req.body);
    await assertOpportunityInEngagement(body.opportunity_id, id);
    const row = await one(
      `INSERT INTO value_records
         (engagement_id, opportunity_id, target_id, metric_id, period, realized_value,
          method, evidence, confidence, variance_note, verified_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        id, body.opportunity_id, body.target_id ?? null, body.metric_id, body.period,
        body.realized_value, body.method, body.evidence, body.confidence,
        body.variance_note ?? null, body.verified_by ?? null,
      ],
    );
    return reply.code(201).send({ item: row });
  });

  app.patch('/api/value-records/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = valuePatch.parse(req.body);
    return {
      item: await updateById(
        'value_records', id, body,
        ['realized_value', 'method', 'evidence', 'confidence', 'variance_note', 'verified_by'],
        true,
      ),
    };
  });

  app.delete('/api/value-records/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM value_records WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '价值记录不存在');
    return { ok: true };
  });

  // ------------------------------------------------------------ 使用数据
  app.get('/api/engagements/:id/usage-records', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const items = await query(
      `SELECT u.*, s.version AS solution_version FROM usage_records u
         LEFT JOIN solutions s ON s.id = u.solution_id
        WHERE u.engagement_id = $1 ORDER BY u.period DESC, u.created_at DESC`,
      [id],
    );
    return { items };
  });

  app.post('/api/engagements/:id/usage-records', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = usageCreate.parse(req.body);
    const row = await one(
      `INSERT INTO usage_records
         (engagement_id, solution_id, period, active_users, volume, errors, source, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        id, body.solution_id ?? null, body.period, body.active_users,
        body.volume, body.errors, body.source, body.note ?? null,
      ],
    );
    return reply.code(201).send({ item: row });
  });

  app.patch('/api/usage-records/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = usagePatch.parse(req.body);
    return {
      item: await updateById(
        'usage_records', id, body,
        ['solution_id', 'active_users', 'volume', 'errors', 'source', 'note'],
        true,
      ),
    };
  });

  app.delete('/api/usage-records/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM usage_records WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '使用数据不存在');
    return { ok: true };
  });

  // ------------------------------------------------------------ 续约 / 二期
  app.get('/api/engagements/:id/renewal-risks', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const items = await query(
      `SELECT r.*, u.name AS owner_name FROM renewal_risks r
         LEFT JOIN users u ON u.id = r.owner
        WHERE r.engagement_id = $1
        ORDER BY r.status, r.due_date NULLS LAST, r.created_at DESC`,
      [id],
    );
    return { items };
  });

  app.post('/api/engagements/:id/renewal-risks', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = renewalCreate.parse(req.body);
    const row = await one(
      `INSERT INTO renewal_risks
         (engagement_id, kind, title, probability, impact, action, owner, due_date,
          value_potential, status, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        id, body.kind, body.title, body.probability, body.impact ?? null,
        body.action ?? null, body.owner ?? null, body.due_date ?? null,
        body.value_potential ?? null, body.status, body.note ?? null,
      ],
    );
    return reply.code(201).send({ item: row });
  });

  app.patch('/api/renewal-risks/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = renewalPatch.parse(req.body);
    return {
      item: await updateById(
        'renewal_risks', id, body,
        ['kind', 'title', 'probability', 'impact', 'action', 'owner', 'due_date',
          'value_potential', 'status', 'note'],
        true,
      ),
    };
  });

  app.delete('/api/renewal-risks/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM renewal_risks WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw httpError(404, 'NOT_FOUND', '风险记录不存在');
    return { ok: true };
  });
}
