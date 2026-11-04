import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, query } from '../db';
import { POSITION_LABEL, positionOf } from '../rules/benchmark';
import { httpError } from '../services/s1';
import { requirePlatformAdmin } from '../services/permissions';
import type { Benchmark } from '../types';
import { queryBool } from '../utils/query';

const uuid = z.uuid();

const benchmarkCreate = z.object({
  industry: z.string().trim().min(1).default('logistics'),
  sub_industry: z.string().default(''),
  metric_key: z.string().trim().min(1),
  metric_name: z.string().trim().min(1),
  unit: z.string().trim().min(1),
  direction: z.enum(['higher_better', 'lower_better']),
  p25: z.coerce.number(),
  p50: z.coerce.number(),
  p75: z.coerce.number(),
  source: z.string().trim().min(1),
  source_url: z.url().nullish(),
  sample_size: z.coerce.number().int().positive().nullish(),
  year: z.coerce.number().int().min(2000).max(2100),
  region: z.string().trim().min(1).default('CN'),
  calibrated: z.boolean().default(false),
});

const benchmarkPatch = z.object({
  industry: z.string().trim().min(1).optional(),
  sub_industry: z.string().optional(),
  metric_key: z.string().trim().min(1).optional(),
  metric_name: z.string().trim().min(1).optional(),
  unit: z.string().trim().min(1).optional(),
  direction: z.enum(['higher_better', 'lower_better']).optional(),
  p25: z.coerce.number().optional(),
  p50: z.coerce.number().optional(),
  p75: z.coerce.number().optional(),
  source: z.string().trim().min(1).optional(),
  source_url: z.url().nullish(),
  sample_size: z.coerce.number().int().positive().nullish(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  region: z.string().trim().min(1).optional(),
  calibrated: z.boolean().optional(),
});

const positionQuery = z.object({
  industry: z.string().default('logistics'),
  metric: z.string().min(1),
  value: z.coerce.number().optional(),
});

const listQuery = z.object({
  industry: z.string().default('logistics'),
  all: queryBool(false),
});

function validatePercentiles(p25: number, p50: number, p75: number) {
  if (!(p25 <= p50 && p50 <= p75)) {
    throw httpError(422, 'INVALID_PERCENTILES', '必须满足 p25 ≤ p50 ≤ p75');
  }
}

export async function benchmarkRoutes(app: FastifyInstance) {
  app.get('/api/benchmarks/position', async (req, reply) => {
    const q = positionQuery.parse(req.query);
    const bench = await one<Benchmark>(
      `SELECT id, industry, metric_key, metric_name, unit, direction,
              p25, p50, p75, year, calibrated, source
         FROM benchmarks
        WHERE industry = $1 AND metric_key = $2
        ORDER BY year DESC, (sub_industry = '') DESC
        LIMIT 1`,
      [q.industry, q.metric],
    );
    if (!bench) return reply.code(404).send({ error: 'NOT_FOUND', message: '该指标无基准数据' });

    const pos = positionOf(bench, q.value ?? null);
    return {
      benchmark: bench,
      value: q.value ?? null,
      position: pos,
      positionLabel: POSITION_LABEL[pos],
      rule:
        bench.direction === 'lower_better'
          ? '<=p25 优秀 | <=p50 良好 | <p75 中位 | >=p75 落后'
          : '>=p75 优秀 | >=p50 良好 | >p25 中位 | <=p25 落后',
    };
  });

  app.get('/api/benchmarks', async (req) => {
    const q = listQuery.parse(req.query);
    if (q.all) {
      const rows = await query<Benchmark>(
        `SELECT * FROM benchmarks
          WHERE industry = $1
          ORDER BY metric_key, year DESC, region`,
        [q.industry],
      );
      return { items: rows };
    }

    const rows = await query<Benchmark>(
      `SELECT DISTINCT ON (metric_key) id, industry, sub_industry, metric_key, metric_name,
              unit, direction, p25, p50, p75, source, source_url, sample_size,
              year, region, calibrated, created_at
         FROM benchmarks
        WHERE industry = $1
        ORDER BY metric_key, year DESC`,
      [q.industry],
    );
    return { items: rows };
  });

  app.get('/api/benchmarks/:id', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`SELECT * FROM benchmarks WHERE id = $1`, [id]);
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND', message: '标杆不存在' });
    return { item: row };
  });

  app.post('/api/benchmarks', async (req, reply) => {
    requirePlatformAdmin(req);
    const body = benchmarkCreate.parse(req.body);
    validatePercentiles(body.p25, body.p50, body.p75);

    const row = await one(
      `INSERT INTO benchmarks
         (industry, sub_industry, metric_key, metric_name, unit, direction,
          p25, p50, p75, source, source_url, sample_size, year, region, calibrated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        body.industry,
        body.sub_industry,
        body.metric_key,
        body.metric_name,
        body.unit,
        body.direction,
        body.p25,
        body.p50,
        body.p75,
        body.source,
        body.source_url ?? null,
        body.sample_size ?? null,
        body.year,
        body.region,
        body.calibrated,
      ],
    );
    return reply.code(201).send({ item: row });
  });

  app.patch('/api/benchmarks/:id', async (req, reply) => {
    requirePlatformAdmin(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const patch = benchmarkPatch.parse(req.body);
    const existing = await one<any>(`SELECT * FROM benchmarks WHERE id = $1`, [id]);
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: '标杆不存在' });

    const merged = { ...existing, ...patch };
    validatePercentiles(Number(merged.p25), Number(merged.p50), Number(merged.p75));

    const keys = Object.keys(patch).filter(
      (k) => (patch as any)[k] !== undefined,
    );
    if (!keys.length) throw httpError(400, 'EMPTY_UPDATE', '没有可更新字段');

    const values = keys.map((k) => (patch as any)[k]);
    values.push(id);
    const row = await one(
      `UPDATE benchmarks
          SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}
        WHERE id = $${values.length}
        RETURNING *`,
      values,
    );
    return { item: row };
  });

  app.delete('/api/benchmarks/:id', async (req, reply) => {
    requirePlatformAdmin(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await one(`DELETE FROM benchmarks WHERE id = $1 RETURNING id`, [id]);
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND', message: '标杆不存在' });
    return { ok: true };
  });
}
