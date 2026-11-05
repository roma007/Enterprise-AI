import Fastify, { LogController } from 'fastify';
import fastifyRequestContext, { requestContext } from '@fastify/request-context';
import { randomBytes, randomUUID } from 'node:crypto';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { z } from 'zod';
import { acquireScopedClient, one, pool, query, releaseScopedClient, withTransaction } from './db';
import { authRoutes } from './routes/auth';
import { benchmarkRoutes } from './routes/benchmarks';
import { confirmationRoutes } from './routes/confirmations';
import { s2DocRoutes } from './routes/s2_docs';
import { s2Routes } from './routes/s2';
import { s3Routes } from './routes/s3';
import { s4Routes } from './routes/s4';
import { s5Routes } from './routes/s5';
import { insightsRoutes } from './routes/insights';
import { r6Routes } from './routes/r6';
import { memberRoutes } from './routes/members';
import { publicRoutes } from './routes/public';
import { adminUserRoutes } from './routes/admin_users';
import { platformRoutes } from './routes/platform';
import { billingRoutes } from './routes/billing';
import { holidayRoutes } from './routes/holidays';
import { notificationRoutes } from './routes/notifications';
import { collabAuditRoutes } from './routes/collab_audits';
import { s5DocRoutes } from './routes/s5_docs';
import { s4DocRoutes } from './routes/s4_docs';
import { s3DocRoutes } from './routes/s3_docs';
import { systemRoutes } from './routes/system';
import { exportRoutes } from './routes/export';
import { importRoutes } from './routes/import';
import { copilotRoutes } from './routes/copilot';
import { s1Routes } from './routes/s1';
import { verifyToken } from './services/auth';
import { enforceRole } from './services/permissions';
import { sessionActive } from './services/sessions';
import { pageResult, parsePage } from './services/pagination';
import { observeRequest, renderPrometheus } from './services/metrics';
import { redisHealthy } from './services/redis';
import {
  loadReconcileBundle,
  reconcileMarkdownHash,
  renderReconcileDoc,
} from './services/reconcile_docs';
import { startPdfWorker } from './services/pdf_jobs';
import { cleanupShareViews } from './services/share_access';
import { guardResource, requestOrg } from './services/tenant';
import { softDeleteDeliverable } from './services/trash';
import { loadBundle, chainFor, derivedFor, roiFor } from './repo';
import { runChecks } from './rules/consistency';
import { chainProduct, stageImpacts, THRESHOLD_WARNING } from './rules/chain';
import { generateDeliverable } from './services/deliverables';

// 发布版本由镜像/部署注入；默认保持兼容
const APP_VERSION = (process.env.APP_VERSION ?? '0.1.0').trim() || '0.1.0';

export function buildApp() {
const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    // 不把 token / cookie 写进日志
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      censor: '[REDACTED]',
    },
  },
  // 统一 requestId：优先使用上游传入的 x-request-id，否则生成 UUID
  genReqId: (req) => {
    const incoming = req.headers['x-request-id'];
    if (typeof incoming === 'string' && /^[A-Za-z0-9._-]{8,128}$/.test(incoming)) {
      return incoming;
    }
    return randomUUID();
  },
  requestIdHeader: 'x-request-id',
  trustProxy: process.env.TRUST_PROXY === 'true',
  // 关闭默认请求日志，使用下面的结构化 onResponse 日志
  logController: new LogController({
    disableRequestLogging: true,
    requestIdLogLabel: 'requestId',
  }),
});

// 每个响应都带 x-request-id / x-app-version，便于前端、网关、日志与发布演练串联
app.addHook('onSend', async (req, reply, payload) => {
  reply.header('x-request-id', req.id);
  reply.header('x-app-version', APP_VERSION);
  return payload;
});

// 结构化访问日志：一条完成日志，包含耗时、状态、组织与用户
app.addHook('onResponse', async (req, reply) => {
  const durationMs = Math.round(reply.elapsedTime);
  const route = (req as any).routeOptions?.url ?? String(req.url ?? '').split('?')[0];
  if (route === '/metrics') return; // 指标抓取不计入自身
  const auth = (req as any).authUser;
  const base = {
    requestId: req.id,
    method: req.method,
    route,
    statusCode: reply.statusCode,
    durationMs,
    orgId: auth?.org_id ?? null,
    userId: auth?.sub ?? null,
  };
  req.log.info({ event: 'request_completed', ...base }, 'request completed');

  const slowMs = Number(process.env.SLOW_REQUEST_MS ?? 500);
  const slow = Number.isFinite(slowMs) && slowMs > 0 && durationMs > slowMs;
  if (slow) {
    req.log.warn({ event: 'slow_request', thresholdMs: slowMs, ...base }, 'slow request');
  }

  observeRequest({
    method: req.method,
    route,
    status: reply.statusCode,
    durationMs,
    slow,
  });
});

app.register(fastifyRequestContext);

// PDF 队列：默认随 API 进程内联运行；生产可设 PDF_WORKER_INLINE=false 并独立启动 worker
let stopPdfWorker: (() => void) | null = null;
if (process.env.PDF_WORKER_INLINE !== 'false') {
  stopPdfWorker = startPdfWorker();
}
app.addHook('onClose', async () => {
  stopPdfWorker?.();
});

// ------------------------------------------------------------ OpenAPI
app.register(swagger, {
  openapi: {
    info: {
      title: '企业 AI 化项目管理系统 API',
      version: APP_VERSION,
      description:
        'S1 诊断阶段 API。请求/响应体的完整 JSON Schema 仍在补齐，当前先提供路径、方法与标签导航。',
    },
    servers: [{ url: 'http://127.0.0.1:8788', description: '本地开发' }],
    tags: [
      { name: 'system', description: '健康检查与系统' },
      { name: 'auth', description: '登录与身份' },
      { name: 'clients', description: '客户与财务快照' },
      { name: 'engagements', description: '项目与门禁' },
      { name: 'opportunities', description: '机会点、ROI、传导链' },
      { name: 'deliverables', description: '交付物、导出、外发' },
      { name: 'import', description: 'CSV / Excel 导入' },
      { name: 'benchmarks', description: '行业对标' },
      { name: 'other', description: '其他' },
    ],
  },
});

app.register(swaggerUi, {
  routePrefix: '/docs',
  uiConfig: { docExpansion: 'list', deepLinking: true },
});

// 给所有路由自动打标签，避免为 60+ 条路由逐条写 schema
app.addHook('onRoute', (route) => {
  const schema = ((route as any).schema ??= {});
  if (!schema.tags) {
    const path = route.url;
    const tag = path.startsWith('/api/auth')
      ? 'auth'
      : path.startsWith('/api/engagements')
        ? 'engagements'
        : path.startsWith('/api/opportunities')
          ? 'opportunities'
          : path.startsWith('/api/deliverables')
              ? 'deliverables'
              : path.startsWith('/api/import')
                ? 'import'
                : path.startsWith('/api/benchmarks')
                  ? 'benchmarks'
                  : path.startsWith('/api/clients')
                    ? 'clients'
                    : path.startsWith('/api/health') || path.startsWith('/api/openapi')
                      ? 'system'
                      : 'other';
    schema.tags = [tag];
  }
  if (!schema.summary) {
    const method = Array.isArray(route.method) ? route.method.join('/') : route.method;
    schema.summary = `${method} ${route.url}`;
  }
});

// ---------------------------------------------------------------- 错误处理
app.setErrorHandler((err: any, req, reply) => {
  const requestId = (req as any).id;
  if (err instanceof z.ZodError) {
    return reply.code(400).send({
      error: 'VALIDATION_ERROR',
      requestId,
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }

  // 把数据库约束错误翻译成可用的 HTTP 语义，而不是一律 500
  const pgMap: Record<string, { status: number; code: string }> = {
    '23505': { status: 409, code: 'CONFLICT' },
    '23514': { status: 422, code: 'RULE_VIOLATION' },
    '23503': { status: 422, code: 'REFERENCE_NOT_FOUND' },
    '23502': { status: 400, code: 'MISSING_FIELD' },
    '22P02': { status: 400, code: 'INVALID_INPUT' },
    P0001: { status: 422, code: 'RULE_VIOLATION' },
  };
  const mapped = pgMap[err.code];
  if (mapped) {
    return reply.code(mapped.status).send({
      error: mapped.code,
      requestId,
      message: err.message,
      // detail 里可能带 SQL 片段，不返回给客户端
    });
  }

  if (err.statusCode && err.statusCode < 500) {
    return reply.code(err.statusCode).send({
      error: err.code ?? 'REQUEST_ERROR',
      requestId,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    });
  }

  req.log.error({ err, requestId }, 'unhandled request error');
  return reply.code(err.statusCode ?? 500).send({
    error: err.code ?? 'INTERNAL_ERROR',
    requestId,
    message: err.message,
  });
});

// ------------------------------------------------------------ 鉴权骨架
// AUTH_REQUIRED=false（默认）时仍允许匿名访问，方便本地开发和现有前端；
// 生产环境设为 true 后，除 health/login/docs 外都必须带 Bearer token。
app.addHook('onRequest', async (req, reply) => {
  const path = req.url.split('?')[0];
  const isPublic =
    path === '/api/health' ||
    path === '/api/auth/login' ||
    path === '/api/auth/register' ||
    path === '/api/auth/config' ||
    path === '/api/billing/callback' ||
    path === '/api/openapi.json' ||
    path === '/metrics' ||
    path.startsWith('/api/public/') ||
    path.startsWith('/api/billing/callback') ||
    path.startsWith('/api/hooks/') ||
    path.startsWith('/docs');

  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    if (process.env.AUTH_REQUIRED === 'true' && !isPublic) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: '请先登录' });
    }
    return;
  }

  const payload = verifyToken(header.slice(7));
  const active = payload ? await sessionActive(payload.jti) : false;
  if (payload && !active) {
    if (process.env.AUTH_REQUIRED === 'true') {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: '登录已失效，请重新登录' });
    }
    return;
  }
  if (!payload) {
    // 开发模式（AUTH_REQUIRED=false）下忽略过期 token，避免旧 token 把匿名访问卡死；
    // 生产模式必须重新登录。
    if (process.env.AUTH_REQUIRED === 'true') {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: '登录已失效，请重新登录' });
    }
    return;
  }
  (req as any).authUser = payload;
});

// 角色权限：只收口管理类动作；开发模式匿名访问不受影响
app.addHook('onRequest', enforceRole);

// 请求级租户上下文：供数据库 RLS 使用；登录/公开分享走服务角色
app.addHook('onRequest', async (req) => {
  const path = req.url.split('?')[0];
  const skip =
    path.startsWith('/api/auth/') ||
    path.startsWith('/api/public/') ||
    path.startsWith('/api/billing/callback') ||
    path === '/api/health' ||
    path === '/api/openapi.json' ||
    path === '/metrics' ||
    path.startsWith('/docs');
  if (skip) return;
  try {
    const org = await requestOrg(req);
    const auth = (req as any).authUser;
    requestContext.set('orgId', org);
    const platformAdmin = Boolean(auth?.platform_admin);
    requestContext.set('platformAdmin', platformAdmin);
    const client = await acquireScopedClient(org, platformAdmin);
    requestContext.set('dbClient', client);
    (req as any).__dbClient = client;
  } catch {
    // 未认证时由后续 guard 返回 401；无上下文时数据库走服务角色
  }
});

app.addHook('preHandler', guardResource);

// 写操作审计：不记录请求体，只记录谁在何时对哪个路由/对象做了什么、结果状态。
app.addHook('onResponse', async (req, reply) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
  const route = (req as any).routeOptions?.url ?? req.url;
  if (route.startsWith('/docs') || route === '/api/openapi.json') return;

  const auth = (req as any).authUser;
  let org: string | null = auth?.org_id ?? null;
  if (!org && process.env.AUTH_REQUIRED !== 'true') {
    try {
      org = await requestOrg(req);
    } catch {
      org = null;
    }
  }

  const parts = route.split('/').filter(Boolean);
  const objectType = parts[1] ?? null;
  const id = (req.params as any)?.id;
  const objectId =
    typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
      ? id
      : null;

  try {
    await query(
      `INSERT INTO audit_logs
         (org_id, user_id, action, object_type, object_id, status_code, ip, user_agent,
          request_id, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        org,
        auth?.sub ?? null,
        `${req.method} ${route}`,
        objectType,
        objectId,
        reply.statusCode,
        req.ip,
        String(req.headers['user-agent'] ?? '').slice(0, 500),
        req.id,
        JSON.stringify({ params: req.params, query: req.query }),
      ],
    );
  } catch {
    // 审计失败不能影响业务响应
  }
});

// 请求结束后释放复用连接并清理会话级 RLS 上下文
app.addHook('onResponse', async (req) => {
  const client = (req as any).__dbClient;
  if (client) {
    (req as any).__dbClient = null;
    await releaseScopedClient(client).catch(() => undefined);
  }
});

const engagementParams = z.object({ id: z.uuid() });

// ------------------------------------------------------------------ OpenAPI
app.get('/api/openapi.json', async () => app.swagger());

// ------------------------------------------------------------------ 指标
app.get('/metrics', async (req, reply) => {
  const required = (process.env.METRICS_TOKEN ?? '').trim();
  if (required) {
    const header = String(req.headers.authorization ?? '');
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const queryToken = String((req.query as any)?.token ?? '');
    if (bearer !== required && queryToken !== required) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: '指标访问需要 METRICS_TOKEN' });
    }
  }

  let dbUp = true;
  const pdfQueue = {
    pending: 0,
    running: 0,
    done24h: 0,
    failed24h: 0,
    oldestPendingSeconds: 0,
  };
  const auditExports = {
    pending: 0,
    running: 0,
    done24h: 0,
    failed24h: 0,
    oldestPendingSeconds: 0,
  };
  try {
    await one(`SELECT 1`);
    try {
      const row = await one<{
        pending: number;
        running: number;
        done_24h: number;
        failed_24h: number;
        oldest_pending_seconds: number;
      }>(
        `SELECT
           count(*) FILTER (WHERE status = 'queued')::int AS pending,
           count(*) FILTER (WHERE status = 'running')::int AS running,
           count(*) FILTER (WHERE status = 'done' AND finished_at > now() - interval '24 hours')::int AS done_24h,
           count(*) FILTER (WHERE status = 'failed' AND finished_at > now() - interval '24 hours')::int AS failed_24h,
           COALESCE(
             EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE status = 'queued'))),
             0
           )::int AS oldest_pending_seconds
         FROM pdf_jobs`,
      );
      if (row) {
        pdfQueue.pending = row.pending;
        pdfQueue.running = row.running;
        pdfQueue.done24h = row.done_24h;
        pdfQueue.failed24h = row.failed_24h;
        pdfQueue.oldestPendingSeconds = row.oldest_pending_seconds;
      }
      try {
        const row = await one<{
          pending: number;
          running: number;
          done_24h: number;
          failed_24h: number;
          oldest_pending_seconds: number;
        }>(
          `SELECT
             count(*) FILTER (WHERE status = 'pending')::int AS pending,
             count(*) FILTER (WHERE status = 'running')::int AS running,
             count(*) FILTER (WHERE status = 'done' AND finished_at > now() - interval '24 hours')::int AS done_24h,
             count(*) FILTER (WHERE status = 'failed' AND finished_at > now() - interval '24 hours')::int AS failed_24h,
             COALESCE(
               EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE status = 'pending'))),
               0
             )::int AS oldest_pending_seconds
           FROM audit_export_jobs`,
        );
        if (row) {
          auditExports.pending = row.pending;
          auditExports.running = row.running;
          auditExports.done24h = row.done_24h;
          auditExports.failed24h = row.failed_24h;
          auditExports.oldestPendingSeconds = row.oldest_pending_seconds;
        }
      } catch {
        // 迁移未完成时不阻断 /metrics
      }
    } catch {
      // 旧库/迁移未完成时不阻断 /metrics，队列指标保持 0
    }
  } catch {
    dbUp = false;
  }

  const redisConfigured = Boolean((process.env.REDIS_URL ?? '').trim());
  const redisUp = redisConfigured ? await redisHealthy() : false;

  return reply
    .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
    .send(
      renderPrometheus({
        dbUp,
        dbPool: {
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
          max: Number(process.env.PG_POOL_MAX ?? 20),
        },
        redisConfigured,
        redisUp,
        pdfQueue,
        auditExports,
      }),
    );
});

// ------------------------------------------------------------------ 健康
app.get('/api/health', async () => {
  const db = await one<{ now: string; tables: number; migrations: number }>(
    `SELECT now()::text AS now,
            (SELECT count(*) FROM information_schema.tables
              WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS tables,
            (SELECT count(*) FROM schema_migrations) AS migrations`,
  );
  return { ok: true, service: 'ai-delivery-backend', version: APP_VERSION, db };
});

// -------------------------------------------------------------- 项目列表
app.get('/api/engagements', async (req) => {
  const org = await requestOrg(req);
  const page = parsePage(req.query);
  const search = z.object({ q: z.string().trim().optional() }).parse(req.query).q ?? null;
  const auth = (req as any).authUser;
  const bypass = !auth || ['admin', 'director'].includes(auth.role);
  const userId = auth?.sub ?? null;
  // 项目配置成员后，非成员不再在列表中看到它；未配置成员的项目保持组织内可见。
  const visible = `($2::boolean
      OR NOT EXISTS (SELECT 1 FROM engagement_members m WHERE m.engagement_id = e.id)
      OR EXISTS (SELECT 1 FROM engagement_members m WHERE m.engagement_id = e.id AND m.user_id = $3::uuid))
    AND ($4::text IS NULL OR e.name ILIKE '%' || $4 || '%' OR c.name ILIKE '%' || $4 || '%')`;
  const total = await one<{ count: number }>(
    `SELECT count(*)::int AS count FROM engagements e
      JOIN clients c ON c.id = e.client_id
      WHERE e.org_id = $1 AND e.deleted_at IS NULL AND ${visible}`,
    [org, bypass, userId, search],
  );
  const rows = await query(
    `SELECT e.id, e.name, e.stage, e.status, e.type,
            e.start_date, e.target_end_date,
            c.name AS client_name, c.sub_industry,
            (SELECT count(*) FROM opportunities o WHERE o.engagement_id = e.id) AS opportunity_count,
            (SELECT count(*) FROM pain_points p WHERE p.engagement_id = e.id) AS pain_point_count,
            (SELECT count(*) FROM deliverables d WHERE d.engagement_id = e.id) AS deliverable_count
       FROM engagements e
       JOIN clients c ON c.id = e.client_id
      WHERE e.org_id = $1 AND e.deleted_at IS NULL AND ${visible}
      ORDER BY e.created_at DESC
      LIMIT $5 OFFSET $6`,
    [org, bypass, userId, search, page.limit, page.offset],
  );
  return pageResult(rows, total?.count ?? 0, page);
});

// -------------------------------------------------------------- 项目详情
app.get('/api/engagements/:id', async (req, reply) => {
  const { id } = engagementParams.parse(req.params);
  const bundle = await loadBundle(id, await requestOrg(req));
  if (!bundle) return reply.code(404).send({ error: 'NOT_FOUND', message: '项目不存在' });

  const reportable = bundle.opportunities.filter(
    (o) => (o.target_phase === 'phase1' || o.target_phase === 'phase2') && o.stage !== 'killed' && o.stage !== 'parked',
  );

  return {
    engagement: bundle.engagement,
    counts: {
      opportunities: bundle.opportunities.length,
      reportable: reportable.length,
      painPoints: bundle.painPoints.length,
      baselines: bundle.baselines.length,
      limitations: bundle.limitations.length,
      benchmarks: bundle.benchmarks.length,
      processNodes: bundle.processNodes.length,
    },
    opportunities: bundle.opportunities.map((o) => {
      const r = roiFor(bundle, o.id);
      return {
        id: o.id,
        code: o.code,
        title: o.title,
        score: o.score,
        priorityBand: o.priority_band,
        stage: o.stage,
        targetPhase: o.target_phase,
        dataStatus: o.data_status,
        hasTechBlocker: o.has_tech_blocker,
        roi: r
          ? {
              neutralValue: r.neutral_value,
              realizationFactor: r.realization_factor,
              realizedValue: r.realized_value,
              oneTimeCost: r.one_time_cost,
              annualCost: r.annual_cost,
              paybackMonths: r.payback_months,
              paybackMonthsWithOps: r.payback_months_with_ops,
              confidence: r.confidence,
            }
          : null,
      };
    }),
    gates: bundle.gates,
    limitations: bundle.limitations.map((l) => ({
      id: l.id,
      title: l.title,
      impactClass: l.impact_class,
      affectedRefs: l.affected_refs,
      severity: l.severity,
      inCustomerDoc: l.impact_class !== 'internal',
    })),
    template: bundle.template,
  };
});

// ------------------------------------------------------- 14 项校验（只读）
app.get('/api/engagements/:id/consistency-checks', async (req, reply) => {
  const { id } = engagementParams.parse(req.params);
  const bundle = await loadBundle(id, await requestOrg(req));
  if (!bundle) return reply.code(404).send({ error: 'NOT_FOUND', message: '项目不存在' });

  const result = runChecks(bundle);
  return {
    engagementId: result.engagementId,
    ranAt: result.ranAt,
    blocked: result.blocked,
    summary: result.summary,
    checks: result.checks.map((c) => ({
      code: c.code,
      title: c.title,
      level: c.level,
      outcome: c.outcome,
      message: c.message,
      evidence: c.evidence ?? null,
    })),
  };
});

// ----------------------------------------------------------- 报告预览
app.get('/api/engagements/:id/preview', async (req, reply) => {
  const { id } = engagementParams.parse(req.params);
  const q = z.object({ format: z.enum(['markdown', 'json']).default('markdown') }).parse(req.query);
  const bundle = await loadBundle(id, await requestOrg(req));
  if (!bundle) return reply.code(404).send({ error: 'NOT_FOUND', message: '项目不存在' });

  const checks = runChecks(bundle);
  if (q.format === 'json') {
    return {
      blocked: checks.blocked,
      summary: checks.summary,
      portfolio: checks.report.portfolio,
      sections: checks.report.sections.map((s) => ({
        key: s.key,
        kind: s.kind,
        ref: s.ref ?? null,
        limitationIds: s.limitationIds ?? [],
        body: s.body,
      })),
      excludedInternal: checks.report.excludedInternal.map((l) => l.title),
    };
  }
  return reply
    .header('content-type', 'text/markdown; charset=utf-8')
    .send(checks.report.markdown);
});

// --------------------------------------------------------- 生成交付物
const generateBody = z.object({
  engagementId: z.uuid(),
  type: z
    .enum([
      'charter',
      'one_pager',
      'diagnosis_report',
      'roadmap',
      'roi_sheet',
      'data_report',
      'prd',
      'architecture',
      'proposal',
      'poc_report',
      'uat_report',
      'value_report',
    ])
    .default('diagnosis_report'),
  title: z.string().min(1).max(200).optional(),
  requestedBy: z.uuid().optional(),
});

app.post('/api/deliverables/generate', async (req, reply) => {
  const body = generateBody.parse(req.body);
  const result = await generateDeliverable(body, await requestOrg(req));

  // 有 block 级失败时拒绝生成（422），并把失败项原样返回给前端
  if (result.blocked) {
    return reply.code(422).send({
      error: 'CONSISTENCY_BLOCKED',
      message: '生成前一致性校验未通过，交付物未生成',
      summary: result.checks.summary,
      failures: result.checks.checks
        .filter((c) => c.outcome === 'block')
        .map((c) => ({
          code: c.code,
          title: c.title,
          message: c.message,
          evidence: c.evidence ?? null,
        })),
    });
  }

  return reply.code(201).send({
    id: result.deliverable!.id,
    version: result.deliverable!.version,
    title: result.deliverable!.title,
    templateId: result.deliverable!.templateId,
    templateVersion: result.deliverable!.templateVersion,
    createdAt: result.deliverable!.createdAt,
    summary: result.checks.summary,
    portfolio: result.checks.report.portfolio,
  });
});

// --------------------------------------------------------- 交付物读取
const deliverableParams = z.object({ id: z.uuid() });

app.get('/api/deliverables/:id', async (req, reply) => {
  const { id } = deliverableParams.parse(req.params);
  const row = await one<any>(
    `SELECT id, engagement_id, type, title, version, status,
            template_id, template_version, content, generated_from,
            generated_snapshot, created_at
       FROM deliverables WHERE id = $1`,
    [id],
  );
  if (!row) return reply.code(404).send({ error: 'NOT_FOUND', message: '交付物不存在' });

  const shares = await query(
    `SELECT sh.id, sh.shared_to, s.name AS shared_to_name, s.title AS shared_to_title,
            sh.channel, sh.shared_at, sh.note,
            sh.token, sh.expires_at, sh.revoked_at, sh.view_count, sh.last_viewed_at
       FROM deliverable_shares sh
       JOIN stakeholders s ON s.id = sh.shared_to
      WHERE sh.deliverable_id = $1
      ORDER BY sh.shared_at DESC`,
    [id],
  );
  return { ...row, shares };
});

app.delete('/api/deliverables/:id', async (req) => {
  const { id } = deliverableParams.parse(req.params);
  const org = await requestOrg(req);
  const batch = await withTransaction(async (client) =>
    softDeleteDeliverable(client, id, org),
  );
  return { ok: true, batch };
});

app.get('/api/engagements/:id/deliverables', async (req, reply) => {
  const { id } = engagementParams.parse(req.params);
  const page = parsePage(req.query);
  const search = z.object({ q: z.string().trim().optional() }).parse(req.query).q ?? null;
  const total = await one<{ count: number }>(
    `SELECT count(*)::int AS count FROM deliverables
      WHERE engagement_id = $1 AND deleted_at IS NULL
        AND ($2::text IS NULL OR title ILIKE '%' || $2 || '%' OR type ILIKE '%' || $2 || '%')`,
    [id, search],
  );
  const rows = await query<any>(
    `SELECT d.id, d.type, d.title, d.version, d.status, d.template_id, d.template_version,
            length(d.content->>'markdown') AS chars, d.created_at, d.generated_from,
            (SELECT count(*) FROM deliverable_shares sh WHERE sh.deliverable_id = d.id) AS share_count,
            (SELECT max(sh.shared_at) FROM deliverable_shares sh WHERE sh.deliverable_id = d.id) AS last_shared_at
       FROM deliverables d
      WHERE d.engagement_id = $1 AND d.deleted_at IS NULL
        AND ($2::text IS NULL OR d.title ILIKE '%' || $2 || '%' OR d.type ILIKE '%' || $2 || '%')
      ORDER BY d.created_at DESC
      LIMIT $3 OFFSET $4`,
    [id, search, page.limit, page.offset],
  );

  // 复核报告：批量判断是否落后于当前复核内容。
  const currentHashByReview = new Map<string, string | null>();
  const staleByKey = new Map<string, boolean>();
  for (const row of rows) {
    const reviewId = row.generated_from?.reviewId as string | undefined;
    const storedHash = row.generated_from?.content_hash as string | undefined;
    if (!reviewId || !storedHash) continue;
    if (!currentHashByReview.has(reviewId)) {
      try {
        const bundle = await loadReconcileBundle(reviewId);
        currentHashByReview.set(
          reviewId,
          reconcileMarkdownHash(renderReconcileDoc(bundle).markdown),
        );
      } catch {
        currentHashByReview.set(reviewId, null);
      }
    }
    const current = currentHashByReview.get(reviewId) ?? null;
    staleByKey.set(`${reviewId}|${storedHash}`, current !== null && current !== storedHash);
  }
  const items = rows.map((row) => {
    const { generated_from, ...rest } = row;
    const reviewId = generated_from?.reviewId as string | undefined;
    const storedHash = generated_from?.content_hash as string | undefined;
    return {
      ...rest,
      review_id: reviewId ?? null,
      is_stale: Boolean(
        reviewId && storedHash
          ? staleByKey.get(`${reviewId}|${storedHash}`)
          : false,
      ),
    };
  });
  return pageResult(items, total?.count ?? 0, page);
});

app.get('/api/engagements/:id/shares', async (req, reply) => {
  const { id } = engagementParams.parse(req.params);
  const exists = await one(`SELECT id FROM engagements WHERE id = $1`, [id]);
  if (!exists) return reply.code(404).send({ error: 'NOT_FOUND', message: '项目不存在' });

  const rows = await query(
    `SELECT sh.id, sh.deliverable_id,
            d.title AS deliverable_title, d.type AS deliverable_type, d.version AS deliverable_version,
            sh.shared_to, s.name AS shared_to_name, s.title AS shared_to_title,
            sh.channel, sh.shared_at, sh.note,
            sh.token, sh.expires_at, sh.revoked_at, sh.view_count, sh.last_viewed_at
       FROM deliverable_shares sh
       JOIN deliverables d ON d.id = sh.deliverable_id
       JOIN stakeholders s ON s.id = sh.shared_to
      WHERE d.engagement_id = $1 AND d.deleted_at IS NULL
      ORDER BY sh.shared_at DESC`,
    [id],
  );
  return { items: rows };
});

/** 复核报告类交付物是否已落后于当前复核内容。 */
async function reconcileDeliverableStale(deliverableId: string): Promise<boolean> {
  const row = await one<{ generated_from: any }>(
    `SELECT generated_from FROM deliverables WHERE id = $1`,
    [deliverableId],
  );
  const reviewId = row?.generated_from?.reviewId;
  const storedHash = row?.generated_from?.content_hash;
  if (!reviewId || !storedHash) return false;
  try {
    const bundle = await loadReconcileBundle(reviewId);
    const current = reconcileMarkdownHash(renderReconcileDoc(bundle).markdown);
    return current !== storedHash;
  } catch {
    return false;
  }
}

function staleDeliverableReply(reply: any) {
  return reply.code(409).send({
    error: 'DELIVERABLE_STALE',
    message: '复核内容已变更，请重新生成报告后再审批或外发',
  });
}

app.patch('/api/deliverables/:id/status', async (req, reply) => {
  const { id } = deliverableParams.parse(req.params);
  const body = z
    .object({ status: z.enum(['draft', 'in_review', 'approved', 'shared', 'archived']) })
    .parse(req.body);
  if (body.status === 'approved' && (await reconcileDeliverableStale(id))) {
    return staleDeliverableReply(reply);
  }
  const row = await one(
    `UPDATE deliverables SET status = $2 WHERE id = $1 RETURNING id, status`,
    [id, body.status],
  );
  if (!row) return reply.code(404).send({ error: 'NOT_FOUND', message: '交付物不存在' });
  return { item: row };
});

const shareBody = z.object({
  shared_to: z.uuid(),
  channel: z.enum(['email', 'wechat', 'meeting', 'print']),
  note: z.string().max(500).optional(),
  expires_in_days: z.coerce.number().int().min(1).max(365).default(30),
});

app.post('/api/deliverables/:id/shares', async (req, reply) => {
  const { id } = deliverableParams.parse(req.params);
  const body = shareBody.parse(req.body);

  const deliverable = await one<any>(
    `SELECT d.id, d.status, e.client_id
       FROM deliverables d JOIN engagements e ON e.id = d.engagement_id
      WHERE d.id = $1`,
    [id],
  );
  if (!deliverable) return reply.code(404).send({ error: 'NOT_FOUND', message: '交付物不存在' });
  if (deliverable.status === 'archived') {
    return reply.code(422).send({ error: 'DELIVERABLE_ARCHIVED', message: '已归档的交付物不能外发' });
  }
  if (!['approved', 'shared'].includes(deliverable.status)) {
    return reply.code(422).send({
      error: 'DELIVERABLE_NOT_APPROVED',
      message: '交付物需先批准后再外发',
    });
  }
  if (await reconcileDeliverableStale(id)) {
    return staleDeliverableReply(reply);
  }

  const stakeholder = await one(
    `SELECT 1 FROM stakeholders WHERE id = $1 AND client_id = $2`,
    [body.shared_to, deliverable.client_id],
  );
  if (!stakeholder) {
    return reply.code(422).send({
      error: 'STAKEHOLDER_NOT_IN_CLIENT',
      message: '外发对象不属于该项目客户',
    });
  }

  const token = randomBytes(24).toString('base64url');
  const share = await one(
    `INSERT INTO deliverable_shares
       (deliverable_id, shared_to, channel, note, token, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + ($6::int * interval '1 day'))
     RETURNING id, deliverable_id, shared_to, channel, shared_at, note,
               token, expires_at, revoked_at, view_count, last_viewed_at`,
    [id, body.shared_to, body.channel, body.note ?? null, token, body.expires_in_days],
  );
  await query(`UPDATE deliverables SET status = 'shared' WHERE id = $1`, [id]);

  return reply.code(201).send({ item: share, deliverableStatus: 'shared' });
});

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function shareArchiveFilters(query: unknown) {
  const q = z
    .object({
      share_id: z.uuid().optional(),
      token: z.string().trim().optional(),
      kind: z.enum(['view', 'docx', 'pdf']).optional(),
      from: z.string().trim().optional(),
      to: z.string().trim().optional(),
    })
    .parse(query ?? {});
  const where = ['org_id = $1'];
  const params: any[] = [];
  return { q, where, params };
}

app.get('/api/share-views/archive', async (req) => {
  const org = await requestOrg(req);
  const page = parsePage(req.query, 100);
  const { q, where, params } = shareArchiveFilters(req.query);
  params.push(org);
  const orgIndex = params.length;
  where[0] = `org_id = $${orgIndex}`;
  if (q.share_id) {
    params.push(q.share_id);
    where.push(`share_id = $${params.length}`);
  }
  if (q.token) {
    params.push(`%${q.token}%`);
    where.push(`token ILIKE $${params.length}`);
  }
  if (q.kind) {
    params.push(q.kind);
    where.push(`kind = $${params.length}`);
  }
  if (q.from) {
    params.push(q.from);
    where.push(`viewed_at >= $${params.length}::timestamptz`);
  }
  if (q.to) {
    params.push(q.to);
    where.push(`viewed_at <= $${params.length}::timestamptz`);
  }

  const condition = where.join(' AND ');
  const total = await one<{ count: number }>(
    `SELECT count(*)::int AS count FROM share_views_archive WHERE ${condition}`,
    params,
  );
  const items = await query(
    `SELECT * FROM share_views_archive WHERE ${condition}
      ORDER BY viewed_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, page.limit, page.offset],
  );
  return pageResult(items, total?.count ?? 0, page);
});

app.get('/api/share-views/archive/export.csv', async (req, reply) => {
  const org = await requestOrg(req);
  const { q, where, params } = shareArchiveFilters(req.query);
  params.push(org);
  where[0] = `org_id = $${params.length}`;
  if (q.share_id) {
    params.push(q.share_id);
    where.push(`share_id = $${params.length}`);
  }
  if (q.token) {
    params.push(`%${q.token}%`);
    where.push(`token ILIKE $${params.length}`);
  }
  if (q.kind) {
    params.push(q.kind);
    where.push(`kind = $${params.length}`);
  }
  if (q.from) {
    params.push(q.from);
    where.push(`viewed_at >= $${params.length}::timestamptz`);
  }
  if (q.to) {
    params.push(q.to);
    where.push(`viewed_at <= $${params.length}::timestamptz`);
  }

  const rows = await query<any>(
    `SELECT viewed_at, archived_at, share_id, token, kind, ip, user_agent, referer
       FROM share_views_archive
      WHERE ${where.join(' AND ')}
      ORDER BY viewed_at DESC
      LIMIT 50000`,
    params,
  );
  const header = ['访问时间', '归档时间', '分享ID', 'Token', '类型', 'IP', 'User-Agent', '来源'];
  const lines = [
    header.map(csvCell).join(','),
    ...rows.map((r) =>
      [
        r.viewed_at,
        r.archived_at,
        r.share_id,
        r.token,
        r.kind,
        r.ip,
        r.user_agent,
        r.referer,
      ]
        .map(csvCell)
        .join(','),
    ),
  ];
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header(
      'content-disposition',
      `attachment; filename="share-views-archive.csv"; filename*=UTF-8''${encodeURIComponent('分享访问归档.csv')}`,
    )
    .send(`\uFEFF${lines.join('\n')}`);
});

async function archiveShareViewsHandler(req: any, reply: any) {
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
      message: '执行归档需要 confirm=CLEANUP',
    });
  }
  const org = await requestOrg(req);
  return cleanupShareViews({
    before: new Date(body.before).toISOString(),
    orgId: org,
    batchSize: body.batch_size,
    dryRun: body.dry_run,
  });
}

app.post('/api/share-views/archive', archiveShareViewsHandler);
app.post('/api/share-views/cleanup', archiveShareViewsHandler);

app.get('/api/shares/:id/views', async (req, reply) => {
  const { id } = z.object({ id: z.uuid() }).parse(req.params);
  const exists = await one(`SELECT id FROM deliverable_shares WHERE id = $1`, [id]);
  if (!exists) return reply.code(404).send({ error: 'NOT_FOUND', message: '外发记录不存在' });
  const items = await query(
    `SELECT id, share_id, kind, ip, user_agent, referer, viewed_at
       FROM share_views WHERE share_id = $1
      ORDER BY viewed_at DESC LIMIT 200`,
    [id],
  );
  const summary = await one<any>(
    `SELECT count(*) FILTER (WHERE kind = 'view')::int AS views,
            count(*) FILTER (WHERE kind = 'docx')::int AS docx,
            count(*) FILTER (WHERE kind = 'pdf')::int AS pdf
       FROM share_views WHERE share_id = $1`,
    [id],
  );
  return { items, summary: summary ?? { views: 0, docx: 0, pdf: 0 } };
});

app.post('/api/shares/:id/rotate', async (req, reply) => {
  const { id } = z.object({ id: z.uuid() }).parse(req.params);
  const body = z
    .object({ expires_in_days: z.coerce.number().int().min(1).max(365).default(30) })
    .parse(req.body ?? {});
  const token = randomBytes(24).toString('base64url');
  const row = await one(
    `UPDATE deliverable_shares
        SET token = $2, revoked_at = NULL,
            expires_at = now() + ($3::int * interval '1 day')
      WHERE id = $1
      RETURNING id, deliverable_id, shared_to, channel, shared_at, note,
                token, expires_at, revoked_at, view_count, last_viewed_at`,
    [id, token, body.expires_in_days],
  );
  if (!row) return reply.code(404).send({ error: 'NOT_FOUND', message: '外发记录不存在' });
  return { item: row };
});

app.post('/api/shares/:id/revoke', async (req, reply) => {
  const { id } = z.object({ id: z.uuid() }).parse(req.params);
  const row = await one(
    `UPDATE deliverable_shares SET revoked_at = now()
      WHERE id = $1
      RETURNING id, deliverable_id, shared_to, channel, shared_at, note,
                token, expires_at, revoked_at, view_count, last_viewed_at`,
    [id],
  );
  if (!row) return reply.code(404).send({ error: 'NOT_FOUND', message: '外发记录不存在' });
  return { item: row };
});

app.delete('/api/shares/:id', async (req, reply) => {
  const { id } = z.object({ id: z.uuid() }).parse(req.params);
  const row = await one(`DELETE FROM deliverable_shares WHERE id = $1 RETURNING id`, [id]);
  if (!row) return reply.code(404).send({ error: 'NOT_FOUND', message: '外发记录不存在' });
  return { ok: true };
});

app.get('/api/deliverables/:id/markdown', async (req, reply) => {
  const { id } = deliverableParams.parse(req.params);
  const row = await one<{ content: any }>(
    `SELECT content FROM deliverables WHERE id = $1`,
    [id],
  );
  if (!row) return reply.code(404).send({ error: 'NOT_FOUND', message: '交付物不存在' });
  return reply
    .header('content-type', 'text/markdown; charset=utf-8')
    .send(row.content?.markdown ?? '');
});

app.get('/api/deliverables/:id/checks', async (req, reply) => {
  const { id } = deliverableParams.parse(req.params);
  const exists = await one<{ id: string }>(`SELECT id FROM deliverables WHERE id = $1`, [id]);
  if (!exists) return reply.code(404).send({ error: 'NOT_FOUND', message: '交付物不存在' });

  const rows = await query(
    `SELECT check_code, level, passed, detail, checked_at
       FROM consistency_checks WHERE deliverable_id = $1
      ORDER BY check_code`,
    [id],
  );
  return { deliverableId: id, items: rows };
});

// ------------------------------------------------- 机会点 ROI + 传导链
app.get('/api/opportunities/:id/roi', async (req, reply) => {
  const { id } = engagementParams.parse(req.params);
  const opp = await one<any>(
    `SELECT id, engagement_id, code, title, stage, score, priority_band,
            target_phase, has_tech_blocker, data_status
       FROM opportunities WHERE id = $1`,
    [id],
  );
  if (!opp) return reply.code(404).send({ error: 'NOT_FOUND', message: '机会点不存在' });

  const bundle = await loadBundle(opp.engagement_id, await requestOrg(req));
  if (!bundle) return reply.code(404).send({ error: 'NOT_FOUND', message: '项目不存在' });

  const roi = roiFor(bundle, id) ?? null;
  const stages = chainFor(bundle, id);
  const derived = derivedFor(bundle, id);
  const product = chainProduct(stages);

  const baselines = bundle.baselines.filter((b) => b.opportunity_id === id);

  return {
    opportunity: opp,
    roi,
    chain: {
      product,
      matchesStoredFactor:
        roi?.realization_factor != null && product != null
          ? Math.abs(product - roi.realization_factor) <= 0.005
          : null,
      stages: stages.map((s) => ({
        stage: s.stage,
        variableKey: s.variable_key,
        variableLabel: s.variable_label,
        unit: s.unit,
        baseValue: s.base_value,
        lowValue: s.low_value,
        highValue: s.high_value,
        multBase: s.mult_base,
        multLow: s.mult_low,
        multHigh: s.mult_high,
        shape: s.shape,
        thresholdNote: s.threshold_note,
        controllable: s.controllable,
        ownerRole: s.owner_role,
        note: s.note,
      })),
      derived: derived.map((d) => ({
        variableKey: d.variable_key,
        variableLabel: d.variable_label,
        baseValue: d.base_value,
        unit: d.unit,
        dependsOn: d.depends_on,
        note: d.note,
      })),
      warning: stages.some((s) => s.shape === 'threshold') ? THRESHOLD_WARNING : null,
    },
    stageImpacts: roi ? stageImpacts(roi.neutral_value, stages) : [],
    baselines,
  };
});

// --------------------------------------------------- 行业对标定位
  app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  app.register(authRoutes);
  app.register(s1Routes);
  app.register(confirmationRoutes);
  app.register(benchmarkRoutes);
  app.register(s2Routes);
  app.register(s2DocRoutes);
  app.register(s3Routes);
  app.register(s3DocRoutes);
  app.register(s4Routes);
  app.register(s4DocRoutes);
  app.register(s5Routes);
  app.register(insightsRoutes);
  app.register(s5DocRoutes);
  app.register(r6Routes);
  app.register(memberRoutes);
  app.register(publicRoutes);
  app.register(adminUserRoutes);
  app.register(platformRoutes);
  app.register(billingRoutes);
  app.register(holidayRoutes);
  app.register(notificationRoutes);
  app.register(collabAuditRoutes);
  app.register(systemRoutes);
  app.register(exportRoutes);
  app.register(importRoutes);
  app.register(copilotRoutes);

  return app;
}
