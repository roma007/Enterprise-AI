import type { FastifyReply, FastifyRequest } from 'fastify';

export type Role = 'admin' | 'director' | 'pm' | 'consultant' | 'tech_lead';

const ALL: Role[] = ['admin', 'director', 'pm', 'consultant', 'tech_lead'];
const MANAGERS: Role[] = ['admin', 'director', 'pm'];

interface Policy {
  /** 不填表示所有方法 */
  methods?: string[];
  pattern: RegExp;
  roles: Role[];
  reason: string;
}

/**
 * 高风险操作的角色边界。普通业务录入（痛点/机会点/方案/POC/交付/UAT）
 * 所有角色都可以写；这里只收口“管理类动作”。
 */
const POLICIES: Policy[] = [
  {
    methods: ['GET'],
    pattern: /^\/api\/share-views\/archive(\/|$)/,
    roles: ['admin', 'director'],
    reason: '分享归档查询/导出仅管理员/总监可操作',
  },
  {
    methods: ['POST'],
    pattern: /^\/api\/share-views\/archive(\/|$)/,
    roles: ['admin', 'director'],
    reason: '分享访问归档仅管理员/总监可操作',
  },
  {
    methods: ['POST'],
    pattern: /^\/api\/share-views\/cleanup(\/|$)/,
    roles: ['admin', 'director'],
    reason: '分享访问清理仅管理员/总监可操作',
  },
  {
    methods: ['POST'],
    pattern: /^\/api\/pdf-jobs\/cleanup(\/|$)/,
    roles: ['admin', 'director'],
    reason: 'PDF 任务清理仅管理员/总监可操作',
  },
  {
    methods: ['POST'],
    pattern: /^\/api\/user-sessions\/cleanup(\/|$)/,
    roles: ['admin', 'director'],
    reason: '会话清理仅管理员/总监可操作',
  },
  {
    methods: ['GET', 'POST'],
    pattern: /^\/api\/users\/:id\/(sessions|revoke-sessions)(\/|$)/,
    roles: ['admin', 'director'],
    reason: '管理其他用户会话仅管理员/总监可操作',
  },
  {
    methods: ['GET', 'POST', 'PATCH'],
    pattern: /^\/api\/admin\/users(\/|$)/,
    roles: ['admin', 'director'],
    reason: '用户管理仅管理员/总监可操作',
  },
  {
    methods: ['GET'],
    pattern: /^\/api\/audit-logs\/archive(\/|$)/,
    roles: ['admin', 'director'],
    reason: '审计归档仅管理员/总监可查看',
  },
  {
    methods: ['POST'],
    pattern: /^\/api\/audit-logs\/archive(\/|$)/,
    roles: ['admin', 'director'],
    reason: '执行审计归档仅管理员/总监可操作',
  },
  {
    methods: ['GET'],
    pattern: /^\/api\/audit-logs(\/|$)/,
    roles: MANAGERS,
    reason: '审计日志仅管理员/总监/项目经理可查看',
  },
  {
    methods: ['GET'],
    pattern: /^\/api\/trash(\/|$)/,
    roles: MANAGERS,
    reason: '回收站仅管理员/总监/项目经理可查看',
  },
  {
    methods: ['DELETE'],
    pattern: /^\/api\/clients\/:id(\/|$)/,
    roles: MANAGERS,
    reason: '删除客户仅管理员/总监/项目经理可操作',
  },
  {
    methods: ['DELETE'],
    pattern: /^\/api\/engagements\/:id(\/|$)/,
    roles: MANAGERS,
    reason: '删除项目仅管理员/总监/项目经理可操作',
  },
  {
    methods: ['POST'],
    pattern: /^\/api\/trash\/:batch\/restore(\/|$)/,
    roles: MANAGERS,
    reason: '恢复回收站仅管理员/总监/项目经理可操作',
  },
  {
    methods: ['POST', 'PATCH', 'DELETE'],
    pattern: /^\/api\/benchmarks(\/|$)/,
    roles: ['admin', 'director'],
    reason: '行业标杆维护仅管理员/总监可操作',
  },
  {
    methods: ['POST', 'PATCH', 'DELETE'],
    pattern: /^\/api\/metric-definitions(\/|$)/,
    roles: ['admin', 'director'],
    reason: '指标字典维护仅管理员/总监可操作',
  },
  {
    methods: ['POST'],
    pattern: /^\/api\/knowledge\/:id\/review(\/|$)/,
    roles: MANAGERS,
    reason: '知识审批仅管理员/总监/项目经理可操作',
  },
  {
    methods: ['PATCH'],
    pattern: /^\/api\/deliverables\/:id\/status(\/|$)/,
    roles: MANAGERS,
    reason: '交付物审批仅管理员/总监/项目经理可操作',
  },
  {
    methods: ['POST'],
    pattern: /^\/api\/deliverables\/:id\/shares(\/|$)/,
    roles: MANAGERS,
    reason: '交付物外发仅管理员/总监/项目经理可操作',
  },
  {
    methods: ['POST'],
    pattern: /^\/api\/shares\/:id\/rotate(\/|$)/,
    roles: MANAGERS,
    reason: '分享链接轮换仅管理员/总监/项目经理可操作',
  },
  {
    methods: ['POST'],
    pattern: /^\/api\/shares\/:id\/revoke(\/|$)/,
    roles: MANAGERS,
    reason: '撤销分享链接仅管理员/总监/项目经理可操作',
  },
  {
    methods: ['DELETE'],
    pattern: /^\/api\/shares\/:id(\/|$)/,
    roles: MANAGERS,
    reason: '撤销外发仅管理员/总监/项目经理可操作',
  },
  {
    methods: ['DELETE'],
    pattern: /^\/api\/deliverables\/:id(\/|$)/,
    roles: MANAGERS,
    reason: '删除交付物仅管理员/总监/项目经理可操作',
  },
];

export function requiredPolicy(
  method: string,
  route: string,
): Policy | null {
  const m = method.toUpperCase();
  for (const policy of POLICIES) {
    if (policy.methods && !policy.methods.includes(m)) continue;
    if (policy.pattern.test(route)) return policy;
  }
  return null;
}

export function roleAllowed(role: string | undefined, policy: Policy | null): boolean {
  if (!policy) return true;
  if (!role) return true; // 未认证由 AUTH_REQUIRED 控制；开发模式保持可用
  return (ALL as string[]).includes(role) && policy.roles.includes(role as Role);
}

export function forbidden(reason: string): Error {
  const err: any = new Error(reason);
  err.statusCode = 403;
  err.code = 'FORBIDDEN';
  return err;
}

/** 在鉴权钩子之后调用；只在有登录态时做角色校验。 */
export async function enforceRole(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (req.method === 'OPTIONS') return;
  const auth = (req as any).authUser;
  if (!auth) return;

  const route =
    (req as any).routeOptions?.url ??
    String(req.url ?? '').split('?')[0];
  const policy = requiredPolicy(req.method, route);
  if (!roleAllowed(auth.role, policy)) {
    throw forbidden(policy?.reason ?? '当前角色无权执行该操作');
  }
}
