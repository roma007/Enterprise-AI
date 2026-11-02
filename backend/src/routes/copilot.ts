import type { FastifyInstance, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { one, query, withTransaction } from '../db';
import { httpError } from '../services/s1';

/**
 * B4 · ai-copilot 评测结果回写
 *
 * 契约：
 *   POST /api/hooks/copilot/eval
 *   Header: x-copilot-token: <COPILOT_HOOK_TOKEN>
 *   Body:   { idempotency_key, experiment_id, dataset_name?, config?,
 *             metrics, issues?, started_at?, finished_at? }
 *
 * 行为：
 *   - 幂等键已存在 → 200 { duplicate: true }，不重复建 run
 *   - 否则在一次事务里：锁实验 → 分配 run_no → 写 poc_runs → 写同步表
 *
 * 为什么复用 poc_runs 而不是另建指标表：
 *   POC 页面本来就在看「运行记录」，回写直接出现在顾问每天看的界面里，
 *   不需要再做一套「同步结果」页面。
 *
 * 鉴权：这个路径不要求用户登录（机器到机器），但必须带共享 token；
 *       token 未配置时直接 503，避免"忘了配"变成"谁都能写"。
 */

const evalBody = z.object({
  idempotency_key: z.string().trim().min(8).max(128),
  experiment_id: z.uuid(),
  dataset_name: z.string().trim().max(200).optional(),
  config: z.string().trim().max(500).optional(),
  metrics: z.record(z.string(), z.unknown()),
  issues: z.string().max(4000).optional(),
  started_at: z.coerce.date().optional(),
  finished_at: z.coerce.date().optional(),
  source: z.string().trim().max(80).optional(),
});

const engagementParams = z.object({ id: z.uuid() });

function hookToken(): string {
  return (process.env.COPILOT_HOOK_TOKEN ?? '').trim();
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function assertHook(req: FastifyRequest): void {
  const expected = hookToken();
  if (!expected) {
    throw httpError(
      503,
      'HOOK_DISABLED',
      '未配置 COPILOT_HOOK_TOKEN，回写接口已关闭',
    );
  }
  const got = req.headers['x-copilot-token'];
  if (typeof got !== 'string' || !safeEqual(got, expected)) {
    throw httpError(401, 'INVALID_HOOK_TOKEN', '回写令牌不正确');
  }
}

export async function copilotRoutes(app: FastifyInstance) {
  app.post('/api/hooks/copilot/eval', async (req, reply) => {
    assertHook(req);
    const body = evalBody.parse(req.body);

    // metrics 必须是可序列化对象，防止把函数/循环引用塞进来
    let metricsJson: string;
    let payloadJson: string;
    try {
      metricsJson = JSON.stringify(body.metrics);
      payloadJson = JSON.stringify({
        ...body,
        started_at: body.started_at?.toISOString(),
        finished_at: body.finished_at?.toISOString(),
      });
    } catch {
      throw httpError(422, 'INVALID_METRICS', 'metrics 无法序列化为 JSON');
    }
    if (metricsJson.length > 64_000) {
      throw httpError(422, 'METRICS_TOO_LARGE', 'metrics 超过 64KB');
    }

    const result = await withTransaction(async (client) => {
      const dup = await client.query<{ id: string; poc_run_id: string | null }>(
        `SELECT id, poc_run_id FROM copilot_eval_syncs WHERE idempotency_key = $1`,
        [body.idempotency_key],
      );
      if (dup.rows[0]) {
        return {
          duplicate: true,
          sync_id: dup.rows[0].id,
          poc_run_id: dup.rows[0].poc_run_id,
          run_no: null as number | null,
        };
      }

      // 锁住实验行，保证并发回写时 run_no 不撞
      const exp = await client.query<{ id: string; org_id: string }>(
        `SELECT e.id, en.org_id
           FROM poc_experiments e
           JOIN opportunities o ON o.id = e.opportunity_id
           JOIN engagements en ON en.id = o.engagement_id
          WHERE e.id = $1
          FOR UPDATE OF e`,
        [body.experiment_id],
      );
      if (!exp.rows[0]) {
        throw httpError(404, 'EXPERIMENT_NOT_FOUND', 'POC 实验不存在');
      }

      const next = await client.query<{ n: number }>(
        `SELECT COALESCE(MAX(run_no), 0) + 1 AS n
           FROM poc_runs WHERE experiment_id = $1`,
        [body.experiment_id],
      );
      const runNo = next.rows[0]?.n ?? 1;

      const run = await client.query<{ id: string }>(
        `INSERT INTO poc_runs
           (experiment_id, run_no, config, started_at, finished_at, metrics, issues)
         VALUES ($1, $2, $3, COALESCE($4, now()), $5, $6::jsonb, $7)
         RETURNING id`,
        [
          body.experiment_id,
          runNo,
          body.config ?? `ai-copilot · ${body.dataset_name ?? 'eval'}`,
          body.started_at ?? null,
          body.finished_at ?? null,
          metricsJson,
          body.issues ?? null,
        ],
      );

      const sync = await client.query<{ id: string }>(
        `INSERT INTO copilot_eval_syncs
           (idempotency_key, org_id, experiment_id, poc_run_id,
            source, dataset_name, metrics, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
         RETURNING id`,
        [
          body.idempotency_key,
          exp.rows[0].org_id,
          body.experiment_id,
          run.rows[0].id,
          body.source ?? 'ai-copilot',
          body.dataset_name ?? null,
          metricsJson,
          payloadJson,
        ],
      );

      return {
        duplicate: false,
        sync_id: sync.rows[0].id,
        poc_run_id: run.rows[0].id,
        run_no: runNo,
      };
    });

    if (result.duplicate) {
      return reply.send({ ok: true, ...result });
    }
    return reply.code(201).send({ ok: true, ...result });
  });

  /** 顾问查看：某个项目下收到过哪些回写。正常登录 + 组织隔离。 */
  app.get('/api/engagements/:id/copilot-syncs', async (req) => {
    const { id } = engagementParams.parse(req.params);
    const engagement = await one(
      `SELECT id FROM engagements WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    if (!engagement) throw httpError(404, 'NOT_FOUND', '项目不存在');

    const items = await query(
      `SELECT s.id, s.idempotency_key, s.source, s.dataset_name,
              s.experiment_id, s.poc_run_id, s.received_at,
              s.metrics, r.run_no
         FROM copilot_eval_syncs s
         JOIN poc_experiments e ON e.id = s.experiment_id
         JOIN opportunities o ON o.id = e.opportunity_id
         JOIN poc_runs r ON r.id = s.poc_run_id
        WHERE o.engagement_id = $1
        ORDER BY s.received_at DESC
        LIMIT 100`,
      [id],
    );
    return { items };
  });
}
