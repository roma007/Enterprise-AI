import type { FastifyReply, FastifyRequest } from 'fastify';
import { one } from '../db';
import { defaultOrgId, httpError } from './s1';

let cachedDefaultOrg: string | null = null;

/** 当前请求所属组织。
 *  - 有 token：用 token 里的 org_id；
 *  - 无 token 且 AUTH_REQUIRED=false（本地开发）：回退到第一个组织；
 *  - 无 token 且 AUTH_REQUIRED=true：401。
 */
export async function requestOrg(req: FastifyRequest): Promise<string> {
  const auth = (req as any).authUser;
  if (auth?.org_id) return auth.org_id;

  if (process.env.AUTH_REQUIRED === 'true') {
    throw httpError(401, 'UNAUTHORIZED', '请先登录');
  }

  if (!cachedDefaultOrg) cachedDefaultOrg = await defaultOrgId();
  return cachedDefaultOrg;
}

/** 单资源归属校验：不属于当前组织时统一返回 404，避免泄露资源是否存在。 */
export async function assertOrg(req: FastifyRequest, orgId: string): Promise<void> {
  const current = await requestOrg(req);
  if (current !== orgId) throw httpError(404, 'NOT_FOUND', '资源不存在');
}

interface ResourceRule {
  pattern: RegExp;
  sql: string;
}

/** preHandler 用：根据路由模板找到资源所属组织。 */
const RESOURCE_RULES: ResourceRule[] = [
  { pattern: /^\/api\/clients\/:id(\/|$)/, sql: `SELECT org_id, NULL::uuid AS engagement_id, deleted_at FROM clients WHERE id = $1` },
  { pattern: /^\/api\/engagements\/:id(\/|$)/, sql: `SELECT org_id, id AS engagement_id, deleted_at FROM engagements WHERE id = $1` },
  {
    pattern: /^\/api\/opportunities\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM opportunities o JOIN engagements e ON e.id = o.engagement_id WHERE o.id = $1`,
  },
  {
    pattern: /^\/api\/deliverables\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, COALESCE(d.deleted_at, e.deleted_at) AS deleted_at FROM deliverables d JOIN engagements e ON e.id = d.engagement_id WHERE d.id = $1`,
  },
  {
    pattern: /^\/api\/pain-points\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM pain_points p JOIN engagements e ON e.id = p.engagement_id WHERE p.id = $1`,
  },
  {
    pattern: /^\/api\/inventory\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM inventory_items i JOIN engagements e ON e.id = i.engagement_id WHERE i.id = $1`,
  },
  {
    pattern: /^\/api\/stakeholders\/:id(\/|$)/,
    sql: `SELECT c.org_id, NULL::uuid AS engagement_id, c.deleted_at FROM stakeholders s JOIN clients c ON c.id = s.client_id WHERE s.id = $1`,
  },
  {
    pattern: /^\/api\/interviews\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM interviews i JOIN engagements e ON e.id = i.engagement_id WHERE i.id = $1`,
  },
  {
    pattern: /^\/api\/baselines\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM baselines b
            JOIN opportunities o ON o.id = b.opportunity_id
            JOIN engagements e ON e.id = o.engagement_id
           WHERE b.id = $1`,
  },
  {
    pattern: /^\/api\/limitations\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM limitations l JOIN engagements e ON e.id = l.engagement_id WHERE l.id = $1`,
  },
  {
    pattern: /^\/api\/risks\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM risks r JOIN engagements e ON e.id = r.engagement_id WHERE r.id = $1`,
  },
  {
    pattern: /^\/api\/dependencies\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM opportunity_dependencies d
            JOIN opportunities o ON o.id = d.from_id
            JOIN engagements e ON e.id = o.engagement_id
           WHERE d.id = $1`,
  },
  {
    pattern: /^\/api\/confirmations\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM confirmations c
            JOIN engagements e ON e.id = c.engagement_id
           WHERE c.id = $1`,
  },
  {
    pattern: /^\/api\/solutions\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM solutions s
            JOIN opportunities o ON o.id = s.opportunity_id
            JOIN engagements e ON e.id = o.engagement_id
           WHERE s.id = $1`,
  },
  {
    pattern: /^\/api\/components\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM solution_components c
            JOIN solutions s ON s.id = c.solution_id
            JOIN opportunities o ON o.id = s.opportunity_id
            JOIN engagements e ON e.id = o.engagement_id
           WHERE c.id = $1`,
  },
  {
    pattern: /^\/api\/integrations\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM integrations i
            JOIN solutions s ON s.id = i.solution_id
            JOIN opportunities o ON o.id = s.opportunity_id
            JOIN engagements e ON e.id = o.engagement_id
           WHERE i.id = $1`,
  },
  {
    pattern: /^\/api\/acceptance-criteria\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM acceptance_criteria a
            JOIN solutions s ON s.id = a.solution_id
            JOIN opportunities o ON o.id = s.opportunity_id
            JOIN engagements e ON e.id = o.engagement_id
           WHERE a.id = $1`,
  },
  {
    pattern: /^\/api\/quotes\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM quotes q
            JOIN engagements e ON e.id = q.engagement_id
           WHERE q.id = $1`,
  },
  {
    pattern: /^\/api\/quote-items\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM quote_items qi
            JOIN quotes q ON q.id = qi.quote_id
            JOIN engagements e ON e.id = q.engagement_id
           WHERE qi.id = $1`,
  },
  {
    pattern: /^\/api\/poc-experiments\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM poc_experiments p
            JOIN opportunities o ON o.id = p.opportunity_id
            JOIN engagements e ON e.id = o.engagement_id
           WHERE p.id = $1`,
  },
  {
    pattern: /^\/api\/poc-datasets\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM poc_datasets d
            JOIN poc_experiments p ON p.id = d.experiment_id
            JOIN opportunities o ON o.id = p.opportunity_id
            JOIN engagements e ON e.id = o.engagement_id
           WHERE d.id = $1`,
  },
  {
    pattern: /^\/api\/poc-runs\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM poc_runs r
            JOIN poc_experiments p ON p.id = r.experiment_id
            JOIN opportunities o ON o.id = p.opportunity_id
            JOIN engagements e ON e.id = o.engagement_id
           WHERE r.id = $1`,
  },
  {
    pattern: /^\/api\/poc-reviews\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM poc_reviews rv
            JOIN poc_runs r ON r.id = rv.run_id
            JOIN poc_experiments p ON p.id = r.experiment_id
            JOIN opportunities o ON o.id = p.opportunity_id
            JOIN engagements e ON e.id = o.engagement_id
           WHERE rv.id = $1`,
  },
  {
    pattern: /^\/api\/delivery-plans\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM delivery_plans p
            JOIN engagements e ON e.id = p.engagement_id
           WHERE p.id = $1`,
  },
  {
    pattern: /^\/api\/delivery-tasks\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM delivery_tasks t
            JOIN delivery_plans p ON p.id = t.plan_id
            JOIN engagements e ON e.id = p.engagement_id
           WHERE t.id = $1`,
  },
  {
    pattern: /^\/api\/uat-cases\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM uat_cases c
            JOIN engagements e ON e.id = c.engagement_id
           WHERE c.id = $1`,
  },
  {
    pattern: /^\/api\/go-live-items\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM go_live_items g
            JOIN engagements e ON e.id = g.engagement_id
           WHERE g.id = $1`,
  },
  {
    pattern: /^\/api\/trainings\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM trainings t
            JOIN engagements e ON e.id = t.engagement_id
           WHERE t.id = $1`,
  },
  {
    pattern: /^\/api\/delivery-issues\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM delivery_issues i
            JOIN engagements e ON e.id = i.engagement_id
           WHERE i.id = $1`,
  },
  {
    pattern: /^\/api\/metric-targets\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM metric_targets t
            JOIN opportunities o ON o.id = t.opportunity_id
            JOIN engagements e ON e.id = o.engagement_id
           WHERE t.id = $1`,
  },
  {
    pattern: /^\/api\/metric-snapshots\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM metric_snapshots s
            JOIN metric_targets t ON t.id = s.target_id
            JOIN opportunities o ON o.id = t.opportunity_id
            JOIN engagements e ON e.id = o.engagement_id
           WHERE s.id = $1`,
  },
  {
    pattern: /^\/api\/value-records\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM value_records v
            JOIN engagements e ON e.id = v.engagement_id
           WHERE v.id = $1`,
  },
  {
    pattern: /^\/api\/usage-records\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM usage_records u
            JOIN engagements e ON e.id = u.engagement_id
           WHERE u.id = $1`,
  },
  {
    pattern: /^\/api\/renewal-risks\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM renewal_risks r
            JOIN engagements e ON e.id = r.engagement_id
           WHERE r.id = $1`,
  },
  {
    pattern: /^\/api\/engagement-members\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM engagement_members m
            JOIN engagements e ON e.id = m.engagement_id
           WHERE m.id = $1`,
  },
  {
    pattern: /^\/api\/knowledge\/:id(\/|$)/,
    sql: `SELECT org_id, NULL::uuid AS engagement_id, NULL::timestamptz AS deleted_at FROM knowledge_items WHERE id = $1`,
  },
  {
    pattern: /^\/api\/ai-drafts\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM ai_drafts d
            JOIN engagements e ON e.id = d.engagement_id
           WHERE d.id = $1`,
  },
  {
    pattern: /^\/api\/pdf-jobs\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, e.deleted_at FROM pdf_jobs j
            JOIN deliverables d ON d.id = j.deliverable_id
            JOIN engagements e ON e.id = d.engagement_id
           WHERE j.id = $1`,
  },
  {
    pattern: /^\/api\/shares\/:id(\/|$)/,
    sql: `SELECT e.org_id, e.id AS engagement_id, COALESCE(d.deleted_at, e.deleted_at) AS deleted_at FROM deliverable_shares sh
            JOIN deliverables d ON d.id = sh.deliverable_id
            JOIN engagements e ON e.id = d.engagement_id
           WHERE sh.id = $1`,
  },
];

export async function guardResource(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const route = (req as any).routeOptions?.url ?? (req as any).routerPath;
  if (typeof route !== 'string' || !route.startsWith('/api/')) return;

  const id = (req.params as any)?.id;
  if (!id) return;

  const rule = RESOURCE_RULES.find((r) => r.pattern.test(route));
  if (!rule) return;

  const row = await one<{
    org_id: string;
    engagement_id: string | null;
    deleted_at: string | null;
  }>(rule.sql, [id]);
  if (!row) return; // 交给 handler 返回 404

  const org = await requestOrg(req);
  if (row.org_id !== org || row.deleted_at) {
    return reply.code(404).send({ error: 'NOT_FOUND', message: '资源不存在' });
  }

  // 项目级成员权限：项目一旦配置成员，非成员不可访问。
  // 管理员/总监保留组织级可见性；匿名开发模式（无 authUser）不做限制。
  const auth = (req as any).authUser;
  if (!auth || !row.engagement_id) return;
  if (['admin', 'director'].includes(auth.role)) return;

  // 成员管理允许项目经理在未入组时先配置成员（handler 会再校验）
  const managingMembers =
    /^\/api\/engagements\/:id\/members(\/|$)/.test(route) ||
    /^\/api\/engagement-members\/:id(\/|$)/.test(route);
  if (managingMembers && auth.role === 'pm') return;

  const member = await one<{ role: string }>(
    `SELECT role FROM engagement_members
      WHERE engagement_id = $1 AND user_id = $2`,
    [row.engagement_id, auth.sub],
  );
  if (!member) {
    const hasMembers = await one<{ count: number }>(
      `SELECT count(*)::int AS count FROM engagement_members WHERE engagement_id = $1`,
      [row.engagement_id],
    );
    if ((hasMembers?.count ?? 0) === 0) return; // 未配置成员的项目对组织内开放
    return reply.code(403).send({
      error: 'PROJECT_FORBIDDEN',
      message: '你不是该项目成员，无法访问',
    });
  }
  if (member.role === 'viewer' && req.method !== 'GET' && req.method !== 'HEAD') {
    return reply.code(403).send({
      error: 'PROJECT_READONLY',
      message: '你在该项目中是只读成员，不能执行写操作',
    });
  }
}
