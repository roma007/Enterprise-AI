/**
 * verify-write.ts · S1 录入闭环端到端回归
 *
 *   npm run verify:write
 *
 * 不依赖 seed 里的宏远项目：从空客户开始，通过 HTTP 接口建项目、录诊断数据，
 * 最后生成诊断报告与一页纸，再清理掉测试数据。
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import ExcelJS from 'exceljs';
import { buildApp } from '../src/app';
import { closePool, one, pool, query } from '../src/db';
import { hashPassword } from '../src/services/auth';
import { findPdfBrowser } from '../src/services/pdf';
import { resetShareRateLimit } from '../src/services/share_access';
import { resetLoginGuard } from '../src/services/login_guard';
import {
  localDateInTimezone,
  snapshotCollabAudits,
} from '../src/services/collab_audit_snapshot';
import { sendCollabAuditDigest } from '../src/services/collab_audit_digest';

process.env.LOG_LEVEL = 'silent';
process.env.PAYMENT_PROVIDER = 'mock';
process.env.BILLING_WEBHOOK_SECRET = 'test-billing-secret';
const app = buildApp();

const C = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

let passes = 0;
let failures = 0;

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passes += 1;
    console.log(`  ${C.green('PASS')}  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.log(`  ${C.red('FAIL')}  ${name}`);
    console.log(C.dim(`        ${err?.message ?? err}`));
  }
}

interface Res {
  status: number;
  body: any;
}

async function req(method: any, url: string, payload?: any): Promise<Res> {
  const res = await app.inject({
    method,
    url,
    headers: payload === undefined ? {} : { 'content-type': 'application/json' },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  });
  let body: any = null;
  try {
    body = res.body ? res.json() : null;
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body };
}

function ok(res: Res, status: number, label: string): any {
  assert.equal(res.status, status, `${label}：期望 ${status}，实际 ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

const BOUNDARY = '----ai-delivery-test-boundary';

function multipart(filename: string, content: string | Buffer, mime = 'text/csv') {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const head = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: Buffer.concat([head, body, tail]),
  };
}

const stamp = Date.now();
const testStartedAt = new Date().toISOString();
let clientId: string | null = null;
let engagementId: string | null = null;
let diagnosisDeliverableId: string | null = null;
let onePagerDeliverableId: string | null = null;
let isolatedOrgId: string | null = null;
let testBenchmarkId: string | null = null;
let solutionId: string | null = null;

async function main() {
  console.log('');
  console.log(C.bold('  S1 录入闭环（从空客户开始）'));

  const health = ok(await req('GET', '/api/health'), 200, '健康检查');
  assert.ok(health.db.tables >= 30, `应用表数量应 ≥30，实际 ${health.db.tables}`);
  assert.ok(health.db.migrations >= 3, `迁移数量应 ≥3，实际 ${health.db.migrations}`);

  await check('登录、/api/me 与 AUTH_REQUIRED 开关', async () => {
    const config = ok(await req('GET', '/api/auth/config'), 200, 'auth config');
    assert.equal(config.required, false, '本地默认不应强制登录');

    const login = ok(
      await req('POST', '/api/auth/login', {
        email: 'zhang@hengzhi.ai',
        password: 'demo1234',
      }),
      200,
      '登录',
    );
    assert.ok(login.token, '登录未返回 token');
    assert.equal(login.user.email, 'zhang@hengzhi.ai');
    assert.equal(login.user.role, 'consultant');

    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${login.token}` },
    });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.email, 'zhang@hengzhi.ai');

    const anonymousMe = await app.inject({ method: 'GET', url: '/api/me' });
    assert.equal(anonymousMe.statusCode, 401);

    const badLogin = await req('POST', '/api/auth/login', {
      email: 'zhang@hengzhi.ai',
      password: 'wrong',
    });
    assert.equal(badLogin.status, 401);

    const previous = process.env.AUTH_REQUIRED;
    process.env.AUTH_REQUIRED = 'true';
    try {
      const blocked = await app.inject({ method: 'GET', url: '/api/engagements' });
      assert.equal(blocked.statusCode, 401, 'AUTH_REQUIRED=true 时匿名应被拒绝');
      const allowed = await app.inject({
        method: 'GET',
        url: '/api/engagements',
        headers: { authorization: `Bearer ${login.token}` },
      });
      assert.equal(allowed.statusCode, 200, '带 token 应放行');
    } finally {
      if (previous === undefined) delete process.env.AUTH_REQUIRED;
      else process.env.AUTH_REQUIRED = previous;
    }
  });

  await check('跨组织隔离：列表、单资源、生成接口', async () => {
    const orgB = await one<{ id: string }>(
      `INSERT INTO organizations (name, plan) VALUES ('隔离测试组织', 'free') RETURNING id`,
    );
    isolatedOrgId = orgB!.id;
    const clientB = await one<{ id: string }>(
      `INSERT INTO clients (org_id, name, industry) VALUES ($1, '隔离测试客户', 'logistics') RETURNING id`,
      [orgB!.id],
    );
    const engB = await one<{ id: string }>(
      `INSERT INTO engagements (client_id, org_id, name) VALUES ($1,$2,'隔离测试项目') RETURNING id`,
      [clientB!.id, orgB!.id],
    );
    const oppB = await one<{ id: string }>(
      `INSERT INTO opportunities
         (engagement_id, code, title, value_score, feasibility_score, urgency, score_rationale)
       VALUES ($1,'OP-01','隔离测试机会点',3,3,1,'隔离测试') RETURNING id`,
      [engB!.id],
    );
    await query(
      `INSERT INTO users (org_id, name, email, status, password_hash)
       VALUES ($1,'隔离用户','iso@example.com','active',$2)`,
      [orgB!.id, hashPassword('demo1234')],
    );

    const loginA = ok(
      await req('POST', '/api/auth/login', {
        email: 'zhang@hengzhi.ai',
        password: 'demo1234',
      }),
      200,
      '登录组织 A',
    );
    const loginB = ok(
      await req('POST', '/api/auth/login', {
        email: 'iso@example.com',
        password: 'demo1234',
      }),
      200,
      '登录组织 B',
    );
    const authA = { authorization: `Bearer ${loginA.token}` };
    const authB = { authorization: `Bearer ${loginB.token}` };

    const ctxA = await app.inject({
      method: 'GET',
      url: '/api/system/db-context',
      headers: authA,
    });
    assert.equal(ctxA.statusCode, 200);
    assert.equal(ctxA.json().current_user, 'ai_delivery_app', 'API 未切换到受限数据库角色');
    assert.equal(ctxA.json().org_id, 'a0000000-0000-4000-8000-000000000001');
    assert.equal(ctxA.json().connection_reused, true, '请求内未复用数据库连接');

    const ctxB = await app.inject({
      method: 'GET',
      url: '/api/system/db-context',
      headers: authB,
    });
    assert.equal(ctxB.json().current_user, 'ai_delivery_app');
    assert.equal(ctxB.json().org_id, orgB!.id);

    const rlsClient = await pool.connect();
    try {
      await rlsClient.query('BEGIN');
      await rlsClient.query('SET LOCAL ROLE ai_delivery_app');
      await rlsClient.query(`SELECT set_config('app.org_id', $1, true)`, [orgB!.id]);
      const own = await rlsClient.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM clients WHERE name = '隔离测试客户'`,
      );
      const other = await rlsClient.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM clients WHERE name LIKE '宏远%'`,
      );
      assert.equal(own.rows[0].count, 1, 'RLS 看不到本组织数据');
      assert.equal(other.rows[0].count, 0, 'RLS 未拦截其他组织数据');
    } finally {
      await rlsClient.query('ROLLBACK').catch(() => undefined);
      rlsClient.release();
    }

    const listA = await app.inject({ method: 'GET', url: '/api/engagements', headers: authA });
    assert.equal(listA.statusCode, 200);
    assert.ok(
      listA.json().items.every((e: any) => e.id !== engB!.id),
      '组织 A 的项目列表出现了组织 B 的项目',
    );

    const listB = await app.inject({ method: 'GET', url: '/api/engagements', headers: authB });
    assert.equal(listB.statusCode, 200);
    assert.ok(
      listB.json().items.some((e: any) => e.id === engB!.id),
      '组织 B 看不到自己的项目',
    );

    const clientsA = await app.inject({ method: 'GET', url: '/api/clients', headers: authA });
    assert.equal(clientsA.statusCode, 200);
    assert.ok(
      clientsA.json().items.every((c: any) => c.id !== clientB!.id),
      '组织 A 的客户列表出现了组织 B 的客户',
    );

    const readB = await app.inject({
      method: 'GET',
      url: `/api/engagements/${engB!.id}`,
      headers: authA,
    });
    assert.equal(readB.statusCode, 404, '组织 A 读组织 B 项目应 404');

    const readOppB = await app.inject({
      method: 'GET',
      url: `/api/opportunities/${oppB!.id}`,
      headers: authA,
    });
    assert.equal(readOppB.statusCode, 404, '组织 A 读组织 B 机会点应 404');

    const generateAsA = await app.inject({
      method: 'POST',
      url: '/api/deliverables/generate',
      headers: { ...authA, 'content-type': 'application/json' },
      payload: JSON.stringify({ engagementId: engB!.id, type: 'diagnosis_report' }),
    });
    assert.equal(generateAsA.statusCode, 404, '组织 A 为组织 B 生成报告应 404');

    const anonB = await app.inject({
      method: 'GET',
      url: `/api/engagements/${engB!.id}`,
    });
    assert.equal(anonB.statusCode, 404, '匿名开发模式也只能看到默认组织');
  });

  // ------------------------------------------------------------ 客户与项目
  const client = ok(
    await req('POST', '/api/clients', {
      name: `回归测试客户-${stamp}`,
      annual_revenue: 1000,
      tags: ['regression'],
    }),
    201,
    '创建客户',
  ).item;
  clientId = client.id;

  ok(
    await req('POST', `/api/clients/${clientId}/financials`, {
      metric_key: 'net_margin',
      value: 5,
      unit: '%',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
      source_type: 'management',
      confidence: 'high',
    }),
    201,
    '录入财务快照',
  );

  const created = ok(
    await req('POST', '/api/engagements', {
      client_id: clientId,
      name: '回归测试诊断项目',
      start_date: '2026-10-01',
      target_end_date: '2026-11-01',
    }),
    201,
    '创建项目',
  );
  engagementId = created.item.id;

  await check('新项目自动初始化 G0–G5，G1 带标准清单', () => {
    assert.equal(created.gates.length, 6, `门禁数量 ${created.gates.length}`);
    const g1 = created.gates.find((g: any) => g.code === 'G1');
    assert.ok(g1, '缺少 G1');
    assert.equal(g1.checklist.length, 8, `G1 清单 ${g1.checklist.length} 项`);
    assert.equal(g1.checklist.filter((i: any) => i.passed).length, 0, '新项目不应有已通过项');
  });

  // ------------------------------------------------------------ 干系人与访谈
  const roles = [
    ['张总', 'decision_maker'],
    ['李强', 'project_owner'],
    ['王敏', 'business_owner'],
    ['陈磊', 'it_data'],
    ['刘芳', 'frontline'],
  ] as const;
  const stakeholders: Record<string, any> = {};
  for (const [name, role] of roles) {
    stakeholders[name] = ok(
      await req('POST', `/api/engagements/${engagementId}/stakeholders`, {
        name,
        role_type: role,
        title: role === 'decision_maker' ? '总经理' : '负责人',
        influence: 4,
        attitude: 'supporter',
        is_key: role === 'decision_maker' || role === 'project_owner',
      }),
      201,
      `创建干系人 ${name}`,
    ).item;
  }

  for (let i = 0; i < roles.length; i++) {
    ok(
      await req('POST', `/api/engagements/${engagementId}/interviews`, {
        stakeholder_id: stakeholders[roles[i][0]].id,
        date: `2026-10-0${i + 1}`,
        duration_min: 40,
        mode: 'onsite',
        ai_summary: `与${roles[i][0]}的访谈摘要`,
        status: 'confirmed',
      }),
      201,
      `创建访谈 ${roles[i][0]}`,
    );
  }

  const userId = (await one<{ id: string }>(`SELECT id FROM users ORDER BY created_at LIMIT 1`))!.id;

  // ------------------------------------------------------------ 痛点与盘点
  const painIds: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const p = ok(
      await req('POST', `/api/engagements/${engagementId}/pain-points`, {
        description: `回归测试痛点 ${i}：某环节每天重复手工操作`,
        channel: '单证录入',
        frequency: 'daily',
        severity: 3,
        quantified_impact: `日均 ${i * 10} 分钟`,
        source_type: 'interview',
        source_ref: `访谈#${i} · 回归测试`,
      }),
      201,
      `创建痛点 ${i}`,
    ).item;
    painIds.push(p.id);
  }

  ok(
    await req('POST', `/api/engagements/${engagementId}/inventory/bulk`, {
      items: [
        {
          dimension: 'business', category: '单证', name: '订单录入',
          attributes: { roles: ['单证员'], daily_volume: 100, minutes_per_case: 8 },
          completeness: 100, verified: true,
        },
        {
          dimension: 'data', category: '订单数据', name: 'TMS 订单数据',
          attributes: { system: 'TMS', history_years: 3, completeness: 95 },
          completeness: 100, verified: true,
        },
        {
          dimension: 'system', category: 'TMS', name: 'TMS 系统',
          attributes: { vendor: '某厂商', api: true, export: true },
          completeness: 100, verified: true,
        },
        {
          dimension: 'org', category: '单证组', name: '单证组',
          attributes: { headcount: 5, digital_skill: 3, change_willingness: 4 },
          completeness: 100, verified: true,
        },
      ],
    }),
    201,
    '批量录入四维盘点',
  );

  // ------------------------------------------------------------ 业务流程
  ok(
    await req('PUT', `/api/engagements/${engagementId}/process-model`, {
      confirmed_by: stakeholders['李强'].id,
      nodes: [
        { key: 'recv', lane: '客户', name: '接单', node_type: 'start', duration_min: 1, is_implicit: false, sort_order: 1 },
        { key: 'entry', lane: '单证组', name: '人工录入', node_type: 'manual', duration_min: 8, abnormal_rate: 5, is_implicit: false, sort_order: 2 },
        { key: 'check', lane: '单证组', name: '字段核对', node_type: 'decision', is_implicit: false, sort_order: 3 },
        { key: 'fix', lane: '单证组', name: '补字段', node_type: 'action', duration_min: 3, is_implicit: true, discovered_by: 'observation', sort_order: 4 },
      ],
      edges: [
        { from: 0, to: 1 },
        { from: 1, to: 2 },
        { from: 'check', to: 'fix', condition: '缺字段' },
      ],
    }),
    201,
    '保存业务流程',
  );

  // ------------------------------------------------------------ 机会点 + 基线 + ROI
  const oppSpecs = [
    { title: '订单自动录入', phase: 'phase1', v: 5, f: 4, u: 1 },
    { title: '异常费用追收', phase: 'phase2', v: 4, f: 4, u: 1 },
    { title: '单证自动核对', phase: 'phase1', v: 4, f: 4, u: 1 },
  ];
  const opps: any[] = [];
  for (const spec of oppSpecs) {
    const o = ok(
      await req('POST', `/api/engagements/${engagementId}/opportunities`, {
        title: spec.title,
        stage: 'scored',
        value_score: spec.v,
        feasibility_score: spec.f,
        urgency: spec.u,
        data_readiness: 4,
        score_rationale: `${spec.title}：回归测试评分理由`,
        data_status: 'ready',
        has_tech_blocker: false,
        target_phase: spec.phase,
      }),
      201,
      `创建机会点 ${spec.title}`,
    ).item;
    opps.push(o);

    ok(
      await req('PUT', `/api/opportunities/${o.id}/pain-points`, {
        pain_point_ids: painIds.slice(0, 4),
      }),
      200,
      `关联痛点 ${o.code}`,
    );

    ok(
      await req('POST', `/api/opportunities/${o.id}/baselines`, {
        metric: `${spec.title}基线`,
        value: 100,
        unit: '单/日',
        source: '回归测试抽样',
        confidence: 'high',
      }),
      201,
      `录入基线 ${o.code}`,
    );

    ok(
      await req('PUT', `/api/opportunities/${o.id}/roi`, {
        benefit_type: 'efficiency',
        neutral_value: 20,
        one_time_cost: 10,
        annual_cost: 2,
        confidence: 'high',
        assumptions_note: '回归测试口径',
      }),
      200,
      `保存 ROI ${o.code}`,
    );

    const chain = ok(
      await req('PUT', `/api/opportunities/${o.id}/chain`, {
        stages: [
          {
            stage: 1, variable_key: 'coverage', variable_label: '渠道覆盖', unit: '%',
            base_value: 100, low_value: 60, mult_base: 1, mult_low: 0.6,
            shape: 'linear', controllable: true, owner_role: '客户运营', is_derived: false,
          },
          {
            stage: 2, variable_key: 'adoption', variable_label: '实际采用率', unit: '%',
            base_value: 100, low_value: 60, mult_base: 0.8, mult_low: 0.5,
            shape: 'linear', controllable: true, owner_role: '客户单证组', is_derived: false,
          },
        ],
      }),
      200,
      `保存传导链 ${o.code}`,
    );
    assert.equal(Number(chain.product), 0.8, `链条乘积应为 0.8，实际 ${chain.product}`);

    const confirmed = ok(
      await req('POST', `/api/opportunities/${o.id}/roi/confirm`, {
        mode: 'no_headcount_growth',
        note: '回归测试：按不增人口径确认，理由长度足够十个字',
        confirmed_by: userId,
      }),
      200,
      `确认收益形态 ${o.code}`,
    );
    assert.equal(Number(confirmed.product), 0.8);
    assert.equal(Number(confirmed.roi.realization_factor), 0.8);
  }

  // ------------------------------------------------------------ 局限、依赖、风险
  ok(
    await req('POST', `/api/engagements/${engagementId}/limitations`, {
      source_type: 'manual',
      title: '回归测试方法局限',
      detail: '这是回归测试写入的方法类局限，不应影响金额判断。',
      affected_refs: [],
      impact_class: 'method',
      severity: 1,
    }),
    201,
    '录入局限',
  );

  ok(
    await req('POST', `/api/engagements/${engagementId}/dependencies`, {
      from_id: opps[1].id,
      to_id: opps[0].id,
      type: 'requires',
      note: '回归测试依赖',
    }),
    201,
    '录入依赖',
  );

  ok(
    await req('POST', `/api/engagements/${engagementId}/risks`, {
      title: '回归测试风险：一线抵触',
      category: 'org',
      probability: 3,
      impact: 4,
      mitigation: '先做单证组试点',
    }),
    201,
    '录入风险',
  );

  // ------------------------------------------------------------ 规则与门禁
  await check('R3：有技术阻断且未指定承担人，禁止进入 designed', async () => {
    const blockedOpp = ok(
      await req('POST', `/api/engagements/${engagementId}/opportunities`, {
        title: '带回程货源匹配',
        stage: 'scored',
        value_score: 3,
        feasibility_score: 2,
        urgency: 1,
        score_rationale: '回归测试：数据不可得',
        data_status: 'unavailable',
        has_tech_blocker: true,
        tech_blocker_note: '回程货源平台不开放接口',
        target_phase: 'watch',
      }),
      201,
      '创建阻断机会点',
    ).item;

    const fail = await req('PATCH', `/api/opportunities/${blockedOpp.id}`, { stage: 'designed' });
    assert.equal(fail.status, 422, `应被 R3 拒绝，实际 ${fail.status}`);
    assert.match(String(fail.body.message), /R3/, '错误信息应包含 R3');

    const pass = await req('PATCH', `/api/opportunities/${blockedOpp.id}`, {
      stage: 'designed',
      blocker_owner: userId,
    });
    assert.equal(pass.status, 200, `指定承担人后应允许，实际 ${pass.status}`);
  });

  await check('门禁：checklist 未全通过时不能标记 passed', async () => {
    const res = await req('PUT', `/api/engagements/${engagementId}/gates/G1`, { status: 'passed' });
    assert.equal(res.status, 422, `应被拒绝，实际 ${res.status}`);
  });

  await check('G1 量化项按数据自动刷新（痛点 10/10、盘点 100/80）', async () => {
    ok(await req('POST', `/api/engagements/${engagementId}/gates/refresh`, {}), 200, '刷新门禁');
    const gates = ok(await req('GET', `/api/engagements/${engagementId}/gates`), 200, '读取门禁');
    const g1 = gates.items.find((g: any) => g.code === 'G1');
    const pains = g1.checklist.find((i: any) => i.item.includes('痛点'));
    const inventory = g1.checklist.find((i: any) => i.item.includes('盘点完成度'));
    assert.equal(pains.actual, 10, `痛点 actual=${pains.actual}`);
    assert.equal(pains.passed, true, '痛点应通过');
    assert.equal(inventory.actual, 100, `盘点 actual=${inventory.actual}`);
    assert.equal(inventory.passed, true, '盘点应通过');
  });

  await check('错误语义：校验失败 400、唯一冲突 409、规则违反 422', async () => {
    const missingSource = await req('POST', `/api/engagements/${engagementId}/pain-points`, {
      description: '缺来源的痛点',
      source_type: 'interview',
    });
    assert.equal(missingSource.status, 400, `缺来源应 400，实际 ${missingSource.status}`);
    assert.equal(missingSource.body.error, 'VALIDATION_ERROR');

    const duplicate = await req('POST', `/api/engagements/${engagementId}/pain-points`, {
      code: 'P-001',
      description: '重复编号的痛点',
      source_type: 'interview',
      source_ref: '访谈#1',
    });
    assert.equal(duplicate.status, 409, `重复编号应 409，实际 ${duplicate.status}`);
    assert.equal(duplicate.body.error, 'CONFLICT');

    const merged = ok(
      await req('POST', `/api/engagements/${engagementId}/pain-points`, {
        code: 'P-099',
        description: '已归并的痛点',
        source_type: 'interview',
        source_ref: '访谈#2',
        status: 'merged',
      }),
      201,
      '创建已归并痛点',
    ).item;

    const r1 = await req('PUT', `/api/opportunities/${opps[0].id}/pain-points`, {
      pain_point_ids: [merged.id],
    });
    assert.equal(r1.status, 422, `R1 应 422，实际 ${r1.status}`);
    assert.match(String(r1.body.message), /R1/, '错误信息应包含 R1');

    const detail = ok(await req('GET', `/api/opportunities/${opps[0].id}`), 200, '读取机会点');
    assert.equal(detail.painPoints.length, 4, 'R1 失败后原有的 4 条关联应被回滚保留');
  });

  await check('14 项一致性校验无 block', async () => {
    const res = ok(
      await req('GET', `/api/engagements/${engagementId}/consistency-checks`),
      200,
      '读取一致性校验',
    );
    assert.equal(res.summary.block, 0, `存在 block：${JSON.stringify(res.summary)}`);
    assert.equal(res.blocked, false);
  });

  // ------------------------------------------------------------ 生成
  await check('生成诊断报告：包含新项目、流程、四维、风险', async () => {
    const res = ok(
      await req('POST', '/api/deliverables/generate', {
        engagementId,
        type: 'diagnosis_report',
      }),
      201,
      '生成诊断报告',
    );
    assert.equal(res.summary.block, 0);
    diagnosisDeliverableId = res.id;
    const mdRes = await app.inject({
      method: 'GET',
      url: `/api/deliverables/${res.id}/markdown`,
    });
    const md = mdRes.body;
    assert.ok(md.includes(`回归测试客户-${stamp}`), '缺少客户名');
    for (const code of opps.map((o) => o.code)) {
      assert.ok(md.includes(code), `缺少机会点编号 ${code}`);
    }
    assert.ok(md.includes('## 3. 业务现状'), '缺少业务现状');
    assert.ok(md.includes('人工录入'), '流程节点未渲染');
    assert.ok(md.includes('## 4. 四维诊断'), '缺少四维诊断');
    assert.ok(md.includes('## 9. 风险与阻断'), '缺少风险章节');
    assert.ok(md.includes('回归测试风险：一线抵触'), '风险未渲染');
  });

  await check('生成一页纸：独立文档、行数受控', async () => {
    const res = ok(
      await req('POST', '/api/deliverables/generate', {
        engagementId,
        type: 'one_pager',
      }),
      201,
      '生成一页纸',
    );
    onePagerDeliverableId = res.id;
    const mdRes = await app.inject({ method: 'GET', url: `/api/deliverables/${res.id}/markdown` });
    const lines = mdRes.body.split('\n').length;
    assert.ok(lines <= 70, `一页纸 ${lines} 行`);
    assert.ok(mdRes.body.includes(`回归测试客户-${stamp}`), '缺少客户名');
    assert.ok(!mdRes.body.includes('## 7. ROI 测算'), '一页纸混入了完整报告');
  });

  await check('交付物审批与外发留痕', async () => {
    assert.ok(diagnosisDeliverableId, '没有诊断报告 id');
    assert.ok(onePagerDeliverableId, '没有一页纸 id');

    // 草稿不能外发
    const blocked = await req('POST', `/api/deliverables/${onePagerDeliverableId}/shares`, {
      shared_to: stakeholders['李强'].id,
      channel: 'email',
    });
    assert.equal(blocked.status, 422, `草稿外发应 422，实际 ${blocked.status}`);
    assert.equal(blocked.body.error, 'DELIVERABLE_NOT_APPROVED');

    // 批准后外发
    ok(
      await req('PATCH', `/api/deliverables/${diagnosisDeliverableId}/status`, { status: 'approved' }),
      200,
      '批准交付物',
    );
    const share = ok(
      await req('POST', `/api/deliverables/${diagnosisDeliverableId}/shares`, {
        shared_to: stakeholders['李强'].id,
        channel: 'email',
        note: '回归测试：外发给客户项目负责人',
      }),
      201,
      '记录外发',
    ).item;
    assert.ok(share.id, '外发记录缺少 id');
    assert.ok(share.token, '外发记录缺少分享 token');
    assert.ok(share.expires_at, '外发记录缺少有效期');

    const pub = ok(
      await req('GET', `/api/public/shares/${share.token}`),
      200,
      '客户只读分享访问',
    );
    assert.equal(pub.share.view_count, 1);
    assert.ok(pub.deliverable.markdown.includes(`回归测试客户-${stamp}`), '分享内容缺少客户');
    assert.equal(pub.project.client, `回归测试客户-${stamp}`);

    const pubAgain = ok(
      await req('GET', `/api/public/shares/${share.token}`),
      200,
      '客户只读分享再次访问',
    );
    assert.equal(pubAgain.share.view_count, 2, '访问计数未累加');

    const pubDocx = await app.inject({
      method: 'GET',
      url: `/api/public/shares/${share.token}/export.docx`,
    });
    assert.equal(pubDocx.statusCode, 200);
    assert.equal(pubDocx.rawPayload.subarray(0, 2).toString(), 'PK');

    const views = ok(
      await req('GET', `/api/shares/${share.id}/views`),
      200,
      '分享访问明细',
    );
    assert.ok(views.items.length >= 3, `访问明细只有 ${views.items.length} 条`);
    assert.ok(views.summary.views >= 2, `浏览数 ${views.summary.views}`);
    assert.ok(views.summary.docx >= 1, `Word 下载数 ${views.summary.docx}`);
    assert.ok(views.items.some((v: any) => v.ip), '访问明细缺少 IP');

    const previousLimit = process.env.PUBLIC_SHARE_RATE_LIMIT;
    try {
      process.env.PUBLIC_SHARE_RATE_LIMIT = '2';
      resetShareRateLimit();
      for (let i = 0; i < 2; i += 1) {
        const allowed = await app.inject({
          method: 'GET',
          url: `/api/public/shares/${share.token}`,
        });
        assert.equal(allowed.statusCode, 200, `第 ${i + 1} 次访问应放行`);
      }
      const limited = await app.inject({
        method: 'GET',
        url: `/api/public/shares/${share.token}`,
      });
      assert.equal(limited.statusCode, 429, '超过频率限制应 429');
      assert.equal(limited.json().error, 'RATE_LIMITED');
      assert.ok(limited.headers['retry-after'], '429 缺少 retry-after');
    } finally {
      if (previousLimit === undefined) delete process.env.PUBLIC_SHARE_RATE_LIMIT;
      else process.env.PUBLIC_SHARE_RATE_LIMIT = previousLimit;
      resetShareRateLimit();
    }

    const list = ok(
      await req('GET', `/api/engagements/${engagementId}/deliverables`),
      200,
      '交付物列表',
    );
    const target = list.items.find((x: any) => x.id === diagnosisDeliverableId);
    assert.equal(target.status, 'shared', `外发后状态应为 shared，实际 ${target.status}`);
    assert.equal(Number(target.share_count), 1, `share_count=${target.share_count}`);

    const sharesRes = ok(
      await req('GET', `/api/engagements/${engagementId}/shares`),
      200,
      '外发记录列表',
    );
    assert.equal(sharesRes.items.length, 1, `外发记录 ${sharesRes.items.length} 条`);
    assert.equal(sharesRes.items[0].shared_to_name, '李强');
    assert.equal(sharesRes.items[0].channel, 'email');

    const orgRow = await one<{ org_id: string }>(
      `SELECT org_id FROM engagements WHERE id = $1`,
      [engagementId],
    );
    assert.ok(orgRow, '没有项目组织');
    const oldView = await one<{ id: string }>(
      `INSERT INTO share_views (share_id, token, kind, ip, viewed_at)
       VALUES ($1, $2, 'view', '10.0.0.1', now() - interval '90 days')
       RETURNING id`,
      [share.id, share.token],
    );
    assert.ok(oldView, '插入旧分享访问失败');
    const beforeCleanup = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

    const dryViews = ok(
      await req('POST', '/api/share-views/archive', {
        before: beforeCleanup,
        dry_run: true,
      }),
      200,
      '分享访问归档预演',
    );
    assert.equal(dryViews.deleted, 0);
    assert.ok(dryViews.candidates >= 1, `预演候选数 ${dryViews.candidates}`);

    const noConfirmViews = await req('POST', '/api/share-views/archive', {
      before: beforeCleanup,
      dry_run: false,
    });
    assert.equal(noConfirmViews.status, 422);
    assert.equal(noConfirmViews.body.error, 'CLEANUP_CONFIRM_REQUIRED');

    const cleanedViews = ok(
      await req('POST', '/api/share-views/archive', {
        before: beforeCleanup,
        dry_run: false,
        confirm: 'CLEANUP',
        batch_size: 10,
      }),
      200,
      '执行分享访问归档',
    );
    assert.ok(cleanedViews.archived >= 1, `实际归档 ${cleanedViews.archived} 条`);
    const oldGone = await one(`SELECT id FROM share_views WHERE id = $1`, [oldView.id]);
    assert.equal(oldGone, null, '旧访问记录仍在热表');
    const archivedView = await one<{ archived_at: string }>(
      `SELECT archived_at FROM share_views_archive WHERE id = $1`,
      [oldView.id],
    );
    assert.ok(archivedView, '旧访问记录未进入归档表');
    assert.ok(archivedView.archived_at, '归档记录缺少 archived_at');

    const archiveQuery = ok(
      await req(
        'GET',
        `/api/share-views/archive?token=${encodeURIComponent(share.token)}`,
      ),
      200,
      '分享归档查询',
    );
    assert.ok(
      archiveQuery.items.some((v: any) => v.id === oldView.id),
      '归档查询未命中旧记录',
    );
    const archivedRow = archiveQuery.items.find((v: any) => v.id === oldView.id);
    assert.equal(archivedRow.org_id, orgRow.org_id, '归档记录缺少组织');
    assert.equal(archivedRow.ip, '10.0.0.1');

    const csv = await app.inject({
      method: 'GET',
      url: `/api/share-views/archive/export.csv?token=${encodeURIComponent(share.token)}`,
    });
    assert.equal(csv.statusCode, 200);
    assert.match(String(csv.headers['content-type']), /text\/csv/);
    assert.ok(csv.body.includes(share.token), 'CSV 缺少 token');
    assert.ok(csv.body.includes('10.0.0.1'), 'CSV 缺少 IP');
    assert.ok(csv.body.includes('访问时间'), 'CSV 缺少表头');

    const pmArchive = await app.inject({
      method: 'GET',
      url: '/api/share-views/archive',
      headers: {
        authorization: `Bearer ${
          (
            await app.inject({
              method: 'POST',
              url: '/api/auth/login',
              payload: { email: 'wang@hengzhi.ai', password: 'demo1234' },
            })
          ).json().token
        }`,
      },
    });
    assert.equal(pmArchive.statusCode, 403, '项目经理不应查看分享归档');

    const revoked = ok(
      await req('POST', `/api/shares/${share.id}/revoke`, {}),
      200,
      '撤销分享链接',
    );
    assert.ok(revoked.item.revoked_at, '撤销时间未写入');
    const revokedCheck = await req('GET', `/api/public/shares/${share.token}`);
    assert.equal(revokedCheck.status, 410, '撤销后分享应 410');
    assert.equal(revokedCheck.body.error, 'SHARE_REVOKED');

    ok(await req('DELETE', `/api/shares/${share.id}`), 200, '删除外发记录');
    const after = ok(
      await req('GET', `/api/engagements/${engagementId}/shares`),
      200,
      '外发记录列表 2',
    );
    assert.equal(after.items.length, 0, '外发记录未删除');
  });

  await check('导出 Word 与打印 HTML', async () => {
    assert.ok(diagnosisDeliverableId, '没有诊断报告 id');

    const docx = await app.inject({
      method: 'GET',
      url: `/api/deliverables/${diagnosisDeliverableId}/export.docx`,
    });
    assert.equal(docx.statusCode, 200, `docx 导出失败：${docx.statusCode}`);
    assert.match(String(docx.headers['content-type']), /wordprocessingml/);
    assert.ok(docx.rawPayload.length > 5000, `docx 只有 ${docx.rawPayload.length} 字节`);
    assert.equal(docx.rawPayload.subarray(0, 2).toString(), 'PK', 'docx 不是 ZIP 格式');

    const html = await app.inject({
      method: 'GET',
      url: `/api/deliverables/${diagnosisDeliverableId}/export.html`,
    });
    assert.equal(html.statusCode, 200, `HTML 导出失败：${html.statusCode}`);
    assert.match(String(html.headers['content-type']), /text\/html/);
    assert.ok(html.body.includes(`回归测试客户-${stamp}`), 'HTML 缺少客户名');
    assert.ok(html.body.includes('<table'), 'HTML 缺少表格');
    assert.ok(html.body.includes('mermaid-note'), 'Mermaid 块未替换为打印占位');

    const pdf = await app.inject({
      method: 'GET',
      url: `/api/deliverables/${diagnosisDeliverableId}/export.pdf`,
    });
    if (findPdfBrowser()) {
      assert.equal(pdf.statusCode, 200, `PDF 导出失败：${pdf.statusCode}`);
      assert.match(String(pdf.headers['content-type']), /application\/pdf/);
      assert.equal(pdf.rawPayload.subarray(0, 5).toString(), '%PDF-', 'PDF 文件头不正确');
      assert.ok(pdf.rawPayload.length > 20_000, `PDF 只有 ${pdf.rawPayload.length} 字节`);
      assert.equal(pdf.headers['x-pdf-cache'], 'MISS', '首次导出应为 MISS');

      const cached = await app.inject({
        method: 'GET',
        url: `/api/deliverables/${diagnosisDeliverableId}/export.pdf`,
      });
      assert.equal(cached.statusCode, 200);
      assert.equal(cached.headers['x-pdf-cache'], 'HIT', '第二次导出应命中缓存');

      const refreshed = await app.inject({
        method: 'GET',
        url: `/api/deliverables/${diagnosisDeliverableId}/export.pdf?refresh=1`,
      });
      assert.equal(refreshed.statusCode, 200);
      assert.equal(refreshed.headers['x-pdf-cache'], 'MISS', 'refresh=1 应重新渲染');

      const jobCreated = await app.inject({
        method: 'POST',
        url: `/api/deliverables/${diagnosisDeliverableId}/pdf-jobs`,
      });
      assert.equal(jobCreated.statusCode, 202, `创建 PDF 任务失败：${jobCreated.statusCode}`);
      const jobId = jobCreated.json().item.id;

      let job: any = null;
      for (let i = 0; i < 80; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        job = (await app.inject({ method: 'GET', url: `/api/pdf-jobs/${jobId}` })).json().item;
        if (job.status === 'done' || job.status === 'failed') break;
      }
      assert.equal(job?.status, 'done', `PDF 任务状态 ${job?.status}：${job?.error ?? ''}`);
      assert.ok(job.cache_key, 'PDF 任务缺少 cache_key');
      assert.ok(job.attempts >= 1, 'PDF 任务未经过队列认领');
      assert.ok(job.locked_by, 'PDF 任务缺少 worker 标识');

      const jobFile = await app.inject({
        method: 'GET',
        url: `/api/pdf-jobs/${jobId}/file`,
      });
      assert.equal(jobFile.statusCode, 200);
      assert.equal(jobFile.rawPayload.subarray(0, 5).toString(), '%PDF-');
    } else {
      assert.equal(pdf.statusCode, 503, '无浏览器时应返回 503');
      assert.equal(pdf.json().error, 'PDF_ENGINE_UNAVAILABLE');
    }
  });

  await check('PDF 任务清理：预演、确认执行与权限', async () => {
    assert.ok(diagnosisDeliverableId, '没有诊断报告 id');
    const old = await one<{ id: string }>(
      `INSERT INTO pdf_jobs (deliverable_id, status, cache_key, finished_at, created_at)
       VALUES ($1, 'done', 'test-old-key', now() - interval '90 days', now() - interval '90 days')
       RETURNING id`,
      [diagnosisDeliverableId],
    );
    assert.ok(old, '插入旧 PDF 任务失败');

    const before = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const dry = ok(
      await req('POST', '/api/pdf-jobs/cleanup', { before, dry_run: true }),
      200,
      'PDF 任务清理预演',
    );
    assert.equal(dry.dryRun, true);
    assert.equal(dry.deleted, 0);
    assert.ok(dry.candidates >= 1, `预演候选数 ${dry.candidates}`);

    const noConfirm = await req('POST', '/api/pdf-jobs/cleanup', {
      before,
      dry_run: false,
    });
    assert.equal(noConfirm.status, 422);
    assert.equal(noConfirm.body.error, 'CLEANUP_CONFIRM_REQUIRED');

    const cleaned = ok(
      await req('POST', '/api/pdf-jobs/cleanup', {
        before,
        dry_run: false,
        confirm: 'CLEANUP',
        batch_size: 10,
      }),
      200,
      '执行 PDF 任务清理',
    );
    assert.equal(cleaned.dryRun, false);
    assert.ok(cleaned.deleted >= 1, `实际清理 ${cleaned.deleted} 条`);

    const gone = await one(`SELECT id FROM pdf_jobs WHERE id = $1`, [old.id]);
    assert.equal(gone, null, '旧任务未被清理');

    const pmLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'wang@hengzhi.ai', password: 'demo1234' },
    });
    const denied = await app.inject({
      method: 'POST',
      url: '/api/pdf-jobs/cleanup',
      headers: { authorization: `Bearer ${pmLogin.json().token}` },
      payload: { before, dry_run: true },
    });
    assert.equal(denied.statusCode, 403, '项目经理不应能清理 PDF 任务');
  });

  await check('客户确认与签收留痕', async () => {
    assert.ok(diagnosisDeliverableId, '没有诊断报告 id');

    const created = ok(
      await req('POST', `/api/engagements/${engagementId}/confirmations`, {
        object_type: 'deliverable',
        object_id: diagnosisDeliverableId,
        confirmed_by: stakeholders['李强'].id,
        method: 'meeting',
        evidence: '回归测试：客户周会确认诊断报告 v1',
      }),
      201,
      '新增交付物确认',
    ).item;
    assert.ok(created.id, '确认记录缺少 id');

    ok(
      await req('POST', `/api/engagements/${engagementId}/confirmations`, {
        object_type: 'opportunity',
        object_id: opps[0].id,
        confirmed_by: stakeholders['张总'].id,
        method: 'email',
        evidence: '回归测试：邮件确认一期机会点',
      }),
      201,
      '新增机会点确认',
    );

    const list = ok(
      await req('GET', `/api/engagements/${engagementId}/confirmations`),
      200,
      '确认记录列表',
    );
    assert.equal(list.items.length, 2, `确认记录 ${list.items.length} 条`);
    const deliverable = list.items.find((c: any) => c.object_type === 'deliverable');
    assert.ok(String(deliverable.object_label).includes('诊断报告'), '交付物标签不正确');
    assert.equal(deliverable.confirmed_by_name, '李强');
    assert.equal(deliverable.method, 'meeting');

    const invalid = await req('POST', `/api/engagements/${engagementId}/confirmations`, {
      object_type: 'deliverable',
      object_id: '00000000-0000-4000-8000-000000000000',
      confirmed_by: stakeholders['李强'].id,
      method: 'email',
    });
    assert.equal(invalid.status, 422, `不存在的对象应 422，实际 ${invalid.status}`);

    for (const c of list.items) {
      ok(await req('DELETE', `/api/confirmations/${c.id}`), 200, '删除确认记录');
    }
    const after = ok(
      await req('GET', `/api/engagements/${engagementId}/confirmations`),
      200,
      '确认记录列表 2',
    );
    assert.equal(after.items.length, 0, '确认记录未删除');
  });

  await check('CSV / Excel 批量导入并刷新门禁', async () => {
    const painBefore = ok(
      await req('GET', `/api/engagements/${engagementId}/pain-points`),
      200,
      '痛点列表（导入前）',
    ).items.length;
    const inventoryBefore = ok(
      await req('GET', `/api/engagements/${engagementId}/inventory`),
      200,
      '盘点列表（导入前）',
    ).items.length;
    const oppBefore = ok(
      await req('GET', `/api/engagements/${engagementId}/opportunities`),
      200,
      '机会点列表（导入前）',
    ).items.length;

    const painsCsv = [
      '编号,描述,环节,频次,严重度,量化影响,来源类型,来源说明,状态',
      ',导入痛点 A,单证,每天,3,日均 10 分钟,访谈,访谈#导入 A,开放',
      ',导入痛点 B,调度,每周,2,每周 2 小时,观察,现场观察 10-20,开放',
    ].join('\n');
    const painsRes = await app.inject({
      method: 'POST',
      url: `/api/engagements/${engagementId}/import?kind=pains`,
      ...multipart('pains.csv', painsCsv),
    });
    assert.equal(painsRes.statusCode, 201, `CSV 导入失败：${painsRes.body}`);
    assert.equal(painsRes.json().inserted, 2, 'CSV 痛点应导入 2 条');

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('盘点');
    ws.addRow(['维度', '类别', '名称', '属性(JSON)', '完整度', '已核实', '隐性', '发现方式']);
    ws.addRow(['data', '测试', 'Excel 导入的数据', '{"system":"TMS"}', 90, '是', '否', '数据']);
    const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
    const inventoryRes = await app.inject({
      method: 'POST',
      url: `/api/engagements/${engagementId}/import?kind=inventory`,
      ...multipart(
        'inventory.xlsx',
        xlsx,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    });
    assert.equal(inventoryRes.statusCode, 201, `Excel 导入失败：${inventoryRes.body}`);
    assert.equal(inventoryRes.json().inserted, 1, 'Excel 盘点应导入 1 条');

    const oppCsv = [
      '编号,名称,描述,价值,可行性,紧迫度,评分理由,数据状态,目标期,阶段,技术阻断,阻断说明',
      ',导入机会点,测试导入,3,3,1.0,导入测试理由,就绪,,已评估,否,',
    ].join('\n');
    const oppRes = await app.inject({
      method: 'POST',
      url: `/api/engagements/${engagementId}/import?kind=opportunities`,
      ...multipart('opportunities.csv', oppCsv),
    });
    assert.equal(oppRes.statusCode, 201, `机会点导入失败：${oppRes.body}`);
    assert.equal(oppRes.json().inserted, 1, '机会点应导入 1 条');

    const pains = ok(
      await req('GET', `/api/engagements/${engagementId}/pain-points`),
      200,
      '痛点列表（导入后）',
    );
    const inventory = ok(
      await req('GET', `/api/engagements/${engagementId}/inventory`),
      200,
      '盘点列表（导入后）',
    );
    const opps = ok(
      await req('GET', `/api/engagements/${engagementId}/opportunities`),
      200,
      '机会点列表（导入后）',
    );
    assert.equal(pains.items.length, painBefore + 2, '痛点数量未增加 2');
    assert.equal(inventory.items.length, inventoryBefore + 1, '盘点数量未增加 1');
    assert.equal(opps.items.length, oppBefore + 1, '机会点数量未增加 1');

    const gates = ok(
      await req('GET', `/api/engagements/${engagementId}/gates`),
      200,
      '门禁（导入后）',
    );
    const g1 = gates.items.find((g: any) => g.code === 'G1');
    const painItem = g1.checklist.find((i: any) => i.item.includes('痛点'));
    const nonMerged = pains.items.filter((p: any) => p.status !== 'merged').length;
    assert.equal(Number(painItem.actual), nonMerged, 'G1 痛点 actual 未刷新');
  });

  await check('导入校验失败 422、不写库、模板可下载', async () => {
    const before = ok(
      await req('GET', `/api/engagements/${engagementId}/pain-points`),
      200,
      '痛点列表（失败导入前）',
    ).items.length;

    const badCsv = [
      '编号,描述,环节,频次,严重度,量化影响,来源类型,来源说明,状态',
      ',缺来源痛点,单证,每天,3,10 分钟,访谈,,开放',
    ].join('\n');
    const bad = await app.inject({
      method: 'POST',
      url: `/api/engagements/${engagementId}/import?kind=pains`,
      ...multipart('bad-pains.csv', badCsv),
    });
    assert.equal(bad.statusCode, 422, `缺来源应 422，实际 ${bad.statusCode}`);
    const body = bad.json();
    assert.equal(body.error, 'IMPORT_VALIDATION_FAILED');
    assert.equal(body.errors[0].row, 2, '错误行号应为 2');
    assert.match(String(body.errors[0].message), /必填/);

    const after = ok(
      await req('GET', `/api/engagements/${engagementId}/pain-points`),
      200,
      '痛点列表（失败导入后）',
    ).items.length;
    assert.equal(after, before, '校验失败时不应写入任何数据');

    const schema = ok(
      await req('GET', '/api/import/schema/pains'),
      200,
      '导入 schema',
    );
    assert.ok(schema.columns.includes('描述'), 'schema 缺少描述列');

    const template = await app.inject({
      method: 'GET',
      url: '/api/import/templates/pains.csv',
    });
    assert.equal(template.statusCode, 200, '模板下载失败');
    assert.ok(template.body.startsWith('\uFEFF'), '模板缺少 UTF-8 BOM');
    assert.ok(template.body.includes('描述'), '模板缺少中文表头');
  });

  await check('行业标杆维护与校准', async () => {
    const before = ok(
      await req('GET', '/api/benchmarks?all=1'),
      200,
      '标杆列表',
    );
    assert.ok(before.items.length >= 20, `标杆数量 ${before.items.length} < 20`);

    const created = ok(
      await req('POST', '/api/benchmarks', {
        industry: 'logistics',
        sub_industry: 'regression',
        metric_key: `test_metric_${stamp}`,
        metric_name: '回归测试指标',
        unit: '%',
        direction: 'lower_better',
        p25: 10,
        p50: 20,
        p75: 30,
        source: '回归测试经验值',
        year: 2026,
        region: 'CN',
        calibrated: false,
      }),
      201,
      '新增标杆',
    ).item;
    testBenchmarkId = created.id;
    assert.equal(created.calibrated, false);

    const calibrated = ok(
      await req('PATCH', `/api/benchmarks/${created.id}`, {
        calibrated: true,
        source: '回归测试校准来源',
        sample_size: 20,
      }),
      200,
      '校准标杆',
    ).item;
    assert.equal(calibrated.calibrated, true);
    assert.equal(calibrated.sample_size, 20);

    const position = ok(
      await req(
        'GET',
        `/api/benchmarks/position?metric=${encodeURIComponent(`test_metric_${stamp}`)}&value=25`,
      ),
      200,
      '标杆定位',
    );
    assert.equal(position.position, 'median', `分位结果 ${position.position}`);

    const invalid = await req('POST', '/api/benchmarks', {
      industry: 'logistics',
      sub_industry: 'regression',
      metric_key: `bad_metric_${stamp}`,
      metric_name: '非法顺序指标',
      unit: '%',
      direction: 'lower_better',
      p25: 30,
      p50: 20,
      p75: 10,
      source: '回归测试',
      year: 2026,
      region: 'CN',
      calibrated: false,
    });
    assert.equal(invalid.status, 422, `p25>p50 应 422，实际 ${invalid.status}`);

    ok(await req('DELETE', `/api/benchmarks/${created.id}`), 200, '删除标杆');
    testBenchmarkId = null;

    const after = ok(await req('GET', '/api/benchmarks?all=1'), 200, '标杆列表 2');
    assert.equal(
      after.items.length,
      before.items.length,
      '删除后标杆数量未恢复',
    );
  });

  await check('S2 方案、组件、集成、工作量、验收、评审与报价', async () => {
    const solution = ok(
      await req('POST', `/api/opportunities/${opps[0].id}/solutions`, {
        scope: '订单/托书自动结构化录入一期试点',
        approach: 'OCR + 规则引擎 + 人工复核',
        architecture: 'TMS 前置解析服务，异步回调',
        deployment: '客户内网私有化',
        security: '数据不出内网，日志脱敏',
        assumptions: '托书 95% 字段可结构化',
        exclusions: '不覆盖手写体托书',
      }),
      201,
      '创建方案',
    ).item;
    solutionId = solution.id;
    assert.equal(solution.version, 1);

    const solutionV2 = ok(
      await req('POST', `/api/opportunities/${opps[0].id}/solutions`, {
        scope: '第二版方案（回归测试）',
      }),
      201,
      '创建方案 v2',
    ).item;
    assert.equal(solutionV2.version, 2);

    // G2 检查最新版本；v2 也要有完整内容，否则会被正确 block
    ok(
      await req('POST', `/api/solutions/${solutionV2.id}/components`, {
        name: 'v2 回归组件',
        type: 'build',
        effort_days: 1,
      }),
      201,
      '添加 v2 组件',
    );
    ok(
      await req('PUT', `/api/solutions/${solutionV2.id}/workload`, {
        items: [{ role: '顾问', days: 1, rate: 0.2 }],
      }),
      200,
      '添加 v2 工作量',
    );
    ok(
      await req('POST', `/api/solutions/${solutionV2.id}/acceptance-criteria`, {
        metric: 'v2 回归指标',
        target: '达标',
        method: '抽样',
      }),
      201,
      '添加 v2 验收',
    );
    ok(
      await req('POST', `/api/solutions/${solutionV2.id}/reviews`, {
        reviewer: userId,
        decision: 'approved',
        comments: 'v2 回归评审通过',
      }),
      201,
      'v2 评审',
    );

    ok(
      await req('POST', `/api/solutions/${solution.id}/components`, {
        name: 'OCR 识别服务',
        type: 'buy',
        description: '托书/装箱单字段识别',
        effort_days: 5,
        sort_order: 1,
      }),
      201,
      '添加方案组件',
    );

    ok(
      await req('POST', `/api/solutions/${solution.id}/integrations`, {
        system: 'TMS',
        direction: 'outbound',
        protocol: 'REST',
        fields: '托书号、箱号、封号、客户、目的港',
        frequency: '实时',
        owner: '客户 IT 陈磊',
        risk: 'TMS 接口文档不全',
      }),
      201,
      '添加集成',
    );

    const workload = ok(
      await req('PUT', `/api/solutions/${solution.id}/workload`, {
        items: [
          { role: '算法', days: 5, rate: 0.3 },
          { role: '前端', days: 3, rate: 0.2 },
        ],
      }),
      200,
      '保存工作量',
    );
    assert.equal(workload.total, 2.1, `工作量合计 ${workload.total}`);

    const acceptance = ok(
      await req('POST', `/api/solutions/${solution.id}/acceptance-criteria`, {
        metric: '单均录入耗时',
        baseline: '10 分钟',
        target: '≤3 分钟',
        method: '抽 100 单现场计时',
        owner: '单证组',
        sort_order: 1,
      }),
      201,
      '添加验收标准',
    ).item;

    const review = ok(
      await req('POST', `/api/solutions/${solution.id}/reviews`, {
        reviewer: userId,
        decision: 'approved',
        comments: '回归测试评审通过',
      }),
      201,
      '方案评审',
    );
    assert.equal(review.status, 'approved');

    const detail = ok(
      await req('GET', `/api/solutions/${solution.id}`),
      200,
      '方案详情',
    );
    assert.equal(detail.components.length, 1);
    assert.equal(detail.integrations.length, 1);
    assert.equal(detail.workload.length, 2);
    assert.equal(detail.workloadTotal, 2.1);
    assert.equal(detail.acceptanceCriteria.length, 1);
    assert.equal(detail.reviews.length, 1);
    assert.equal(detail.item.status, 'approved');

    const list = ok(
      await req('GET', `/api/engagements/${engagementId}/solutions`),
      200,
      '方案列表',
    );
    assert.ok(
      list.items.some((s: any) => s.id === solution.id && s.version === 1),
      '方案列表缺少 v1',
    );
    assert.ok(
      list.items.some((s: any) => s.id === solutionV2.id && s.version === 2),
      '方案列表缺少 v2',
    );

    const quote = ok(
      await req('POST', `/api/engagements/${engagementId}/quotes`, {
        payment_terms: '3:4:3 付款',
        valid_until: '2026-12-31',
        notes: '回归测试报价',
      }),
      201,
      '创建报价',
    ).item;

    ok(
      await req('POST', `/api/quotes/${quote.id}/items`, {
        solution_id: solution.id,
        kind: 'one_time',
        description: '一期方案实施',
        qty: 1,
        unit_price: 50,
        sort_order: 1,
      }),
      201,
      '添加一次性报价行',
    );
    ok(
      await req('POST', `/api/quotes/${quote.id}/items`, {
        kind: 'annual_ops',
        description: '年运维',
        qty: 1,
        unit_price: 8,
        sort_order: 2,
      }),
      201,
      '添加年运维报价行',
    );

    const quoteDetail = ok(
      await req('GET', `/api/quotes/${quote.id}`),
      200,
      '报价详情',
    );
    assert.equal(quoteDetail.totals.oneTime, 50, `一次性合计 ${quoteDetail.totals.oneTime}`);
    assert.equal(quoteDetail.totals.annualOps, 8, `年运维合计 ${quoteDetail.totals.annualOps}`);
    assert.equal(quoteDetail.items.length, 2);

    const quotes = ok(
      await req('GET', `/api/engagements/${engagementId}/quotes`),
      200,
      '报价列表',
    );
    assert.ok(quotes.items.some((q: any) => q.id === quote.id && Number(q.one_time) === 50));

    const proposal = ok(
      await req('POST', `/api/solutions/${solution.id}/documents`, { type: 'proposal' }),
      201,
      '生成方案说明书',
    ).item;
    const proposalMd = await app.inject({
      method: 'GET',
      url: `/api/deliverables/${proposal.id}/markdown`,
    });
    assert.equal(proposalMd.statusCode, 200);
    assert.ok(proposalMd.body.includes('方案范围'), '方案书缺少范围');
    assert.ok(proposalMd.body.includes('OCR 识别服务'), '方案书缺少组件');

    const architectureMd = await app.inject({
      method: 'GET',
      url: `/api/solutions/${solution.id}/document?type=architecture`,
    });
    assert.equal(architectureMd.statusCode, 200);
    assert.ok(architectureMd.body.includes('总体架构'), '架构文档缺少总体架构');

    const proposalDocx = await app.inject({
      method: 'GET',
      url: `/api/solutions/${solution.id}/document.docx?type=proposal`,
    });
    assert.equal(proposalDocx.statusCode, 200);
    assert.equal(proposalDocx.rawPayload.subarray(0, 2).toString(), 'PK');

    const quoteDoc = ok(
      await req('POST', `/api/quotes/${quote.id}/documents`, {}),
      201,
      '生成报价单',
    ).item;
    const quoteMd = await app.inject({
      method: 'GET',
      url: `/api/deliverables/${quoteDoc.id}/markdown`,
    });
    assert.equal(quoteMd.statusCode, 200);
    assert.ok(quoteMd.body.includes('一次性投入'), '报价单缺少汇总');
    assert.ok(quoteMd.body.includes('年运维'), '报价单缺少年运维');
  });

  await check('G2 方案门禁：覆盖缺口 block 与补齐后 pass', async () => {
    const before = ok(
      await req('GET', `/api/engagements/${engagementId}/g2-checks`),
      200,
      'G2 校验（补齐前）',
    );
    assert.equal(before.blocked, true, '机会点未全覆盖时应 block');
    const coverage = before.checks.find((c: any) => c.code === 'G2-1');
    assert.equal(coverage.outcome, 'block');
    assert.match(String(coverage.message), new RegExp(opps[1].code));

    for (const o of opps.slice(1)) {
      const sol = ok(
        await req('POST', `/api/opportunities/${o.id}/solutions`, {
          scope: `G2 回归方案：${o.title}`,
          approach: '标准方案',
        }),
        201,
        `创建 G2 补齐方案 ${o.code}`,
      ).item;
      ok(
        await req('POST', `/api/solutions/${sol.id}/components`, {
          name: '回归组件',
          type: 'build',
          effort_days: 1,
        }),
        201,
        `添加 G2 组件 ${o.code}`,
      );
      ok(
        await req('PUT', `/api/solutions/${sol.id}/workload`, {
          items: [{ role: '顾问', days: 1, rate: 0.2 }],
        }),
        200,
        `添加 G2 工作量 ${o.code}`,
      );
      ok(
        await req('POST', `/api/solutions/${sol.id}/acceptance-criteria`, {
          metric: '回归指标',
          target: '达标',
          method: '抽样',
        }),
        201,
        `添加 G2 验收 ${o.code}`,
      );
      ok(
        await req('POST', `/api/solutions/${sol.id}/reviews`, {
          reviewer: userId,
          decision: 'approved',
          comments: 'G2 回归评审通过',
        }),
        201,
        `G2 评审 ${o.code}`,
      );
    }

    const after = ok(
      await req('GET', `/api/engagements/${engagementId}/g2-checks`),
      200,
      'G2 校验（补齐后）',
    );
    assert.equal(after.blocked, false, `G2 仍有 block：${JSON.stringify(after.summary)}`);
    assert.equal(after.summary.block, 0);
    assert.equal(after.summary.pass, 9, `G2 pass 数 ${after.summary.pass}`);
  });

  await check('S3 POC：实验、样本、运行、复核、结论与 G3', async () => {
    const experiment = ok(
      await req('POST', `/api/opportunities/${opps[0].id}/poc-experiments`, {
        hypothesis: '托书字段 OCR 准确率可达 95% 以上',
        method: '抽 100 份历史托书，与人工录入结果比对',
        sample_size: 100,
        success_metric: '托书字段准确率',
        threshold: '≥95%',
        start_date: '2026-11-01',
        end_date: '2026-11-14',
      }),
      201,
      '创建 POC 实验',
    ).item;
    assert.equal(experiment.version, 1);
    assert.equal(experiment.status, 'planned');

    const dataset = ok(
      await req('POST', `/api/poc-experiments/${experiment.id}/datasets`, {
        name: '托书样本 100 份',
        source: 'TMS 2026 Q3',
        sample_count: 100,
        fields: '箱号/封号/客户/目的港',
        access_status: 'approved',
        version: 'v1',
      }),
      201,
      '添加 POC 样本',
    ).item;

    const run = ok(
      await req('POST', `/api/poc-experiments/${experiment.id}/runs`, {
        dataset_id: dataset.id,
        config: 'OCR 模型 v1 + 规则引擎',
        metrics: { accuracy: 0.96, false_positive: 3 },
        issues: '手写体托书识别率偏低',
      }),
      201,
      '添加 POC 运行',
    ).item;
    assert.equal(run.run_no, 1);

    ok(
      await req('POST', `/api/poc-runs/${run.id}/reviews`, {
        reviewer: userId,
        sample_count: 100,
        accuracy: 0.96,
        false_positive: 3,
        notes: '人工复核 100 份，3 份箱号识别错误',
      }),
      201,
      '添加 POC 复核',
    );

    const conclusion = ok(
      await req('PUT', `/api/poc-experiments/${experiment.id}/conclusion`, {
        decision: 'go',
        evidence: '100 份样本准确率 96%，达到 ≥95% 阈值；3 份错误集中在手写体。',
        decided_by: userId,
      }),
      200,
      '提交 POC 结论',
    );
    assert.equal(conclusion.status, 'passed');

    const detail = ok(
      await req('GET', `/api/poc-experiments/${experiment.id}`),
      200,
      'POC 实验详情',
    );
    assert.equal(detail.datasets.length, 1);
    assert.equal(detail.runs.length, 1);
    assert.equal(detail.reviews.length, 1);
    assert.equal(detail.conclusion.decision, 'go');
    assert.equal(detail.item.status, 'passed');
    assert.equal(conclusion.opportunity_stage, 'validated', `机会点阶段 ${conclusion.opportunity_stage}`);

    const pocDoc = ok(
      await req('POST', `/api/poc-experiments/${experiment.id}/documents`),
      201,
      '生成 POC 报告交付物',
    ).item;
    assert.equal(pocDoc.type, 'poc_report');
    assert.equal(pocDoc.version, 1);

    const md = await app.inject({
      method: 'GET',
      url: `/api/poc-experiments/${experiment.id}/document`,
    });
    assert.equal(md.statusCode, 200, `POC Markdown 失败：${md.statusCode}`);
    assert.match(md.body, /实验设计/);
    assert.match(md.body, /托书字段 OCR 准确率/);
    assert.match(md.body, /人工复核/);
    assert.match(md.body, /Go（通过）/);
    assert.match(md.body, /96\.0%/);

    const pocDocx = await app.inject({
      method: 'GET',
      url: `/api/poc-experiments/${experiment.id}/document.docx`,
    });
    assert.equal(pocDocx.statusCode, 200, `POC Word 失败：${pocDocx.statusCode}`);
    assert.match(String(pocDocx.headers['content-type']), /wordprocessingml/);
    assert.equal(pocDocx.rawPayload.subarray(0, 2).toString(), 'PK', 'POC docx 不是 ZIP');
    assert.ok(pocDocx.rawPayload.length > 5000, `POC docx 只有 ${pocDocx.rawPayload.length} 字节`);

    const g3 = ok(
      await req('GET', `/api/engagements/${engagementId}/g3-checks`),
      200,
      'G3 校验',
    );
    assert.equal(g3.blocked, false, `G3 仍有 block：${JSON.stringify(g3.summary)}`);
    assert.equal(g3.summary.pass, 8, `G3 pass 数 ${g3.summary.pass}`);
  });

  await check('S4 交付：实施计划、UAT、上线检查、培训、问题/变更与 G4', async () => {
    const plan = ok(
      await req('POST', `/api/engagements/${engagementId}/delivery-plans`, {
        name: '订单结构化一期实施计划',
        start_date: '2026-11-01',
        end_date: '2026-12-31',
        status: 'active',
        owner: userId,
        notes: '回归测试计划',
      }),
      201,
      '创建实施计划',
    ).item;
    assert.equal(plan.version, 1);
    assert.equal(plan.status, 'active');

    ok(
      await req('POST', `/api/delivery-plans/${plan.id}/tasks`, {
        phase: '准备',
        name: '环境与接口准备',
        owner: userId,
        start_date: '2026-11-01',
        end_date: '2026-11-10',
        status: 'done',
        progress: 100,
        sort_order: 1,
      }),
      201,
      '添加交付任务',
    );

    const milestone = ok(
      await req('POST', `/api/delivery-plans/${plan.id}/tasks`, {
        phase: '上线',
        name: '一期上线',
        owner: userId,
        start_date: '2026-12-20',
        end_date: '2026-12-31',
        status: 'todo',
        is_milestone: true,
        sort_order: 2,
      }),
      201,
      '添加里程碑',
    ).item;
    assert.equal(milestone.is_milestone, true);

    const overview = ok(
      await req('GET', `/api/engagements/${engagementId}/delivery-overview`),
      200,
      '交付总览',
    );
    assert.equal(overview.activePlan.id, plan.id);
    assert.equal(overview.tasks.length, 2);
    assert.ok(overview.criteria.length >= 1, '没有验收标准可用于 UAT 覆盖');
    assert.equal(overview.criteria.length, 4, `验收标准数量 ${overview.criteria.length}`);

    // 每条验收标准建一条已通过的 UAT 用例
    for (const c of overview.criteria) {
      const uat = ok(
        await req('POST', `/api/engagements/${engagementId}/uat-cases`, {
          acceptance_id: c.id,
          scenario: `${c.metric} 验收`,
          steps: '按验收方法抽样执行',
          expected: `达到 ${c.target}`,
          actual: `达到 ${c.target}`,
          status: 'passed',
          owner: userId,
        }),
        201,
        `添加 UAT：${c.metric}`,
      ).item;
      assert.match(uat.code, /^UAT-\d{3}$/);
    }

    ok(
      await req('POST', `/api/engagements/${engagementId}/go-live-items`, {
        category: '技术',
        item: '生产环境账号与网络开通',
        status: 'passed',
        blocking: true,
        owner: userId,
        evidence: '变更单 CHG-2026-001',
        sort_order: 1,
      }),
      201,
      '添加上线检查项',
    );

    const training = ok(
      await req('POST', `/api/engagements/${engagementId}/trainings`, {
        title: '单证组操作培训',
        audience: '单证组 8 人',
        mode: 'onsite',
        trainer: userId,
        scheduled_at: '2026-12-15',
        attendees: 8,
        materials: '操作手册 v1',
        status: 'done',
        feedback: '满意度 4.6/5',
      }),
      201,
      '添加培训',
    ).item;
    assert.equal(training.status, 'done');

    const issue = ok(
      await req('POST', `/api/engagements/${engagementId}/delivery-issues`, {
        kind: 'issue',
        title: '测试环境 OCR 偶发超时',
        description: '压测时出现两次 3s 超时',
        severity: 'P2',
        status: 'open',
        owner: userId,
        due_date: '2026-11-20',
      }),
      201,
      '登记交付问题',
    ).item;
    assert.equal(issue.code, 'ISS-001');

    const change = ok(
      await req('POST', `/api/engagements/${engagementId}/delivery-issues`, {
        kind: 'change',
        title: '新增目的港字段校验',
        impact: '增加 2 人天，不影响上线日期',
        severity: 'P2',
        approval_status: 'pending',
        owner: userId,
      }),
      201,
      '登记变更请求',
    ).item;
    assert.equal(change.code, 'CHG-001');

    const approved = ok(
      await req('PATCH', `/api/delivery-issues/${change.id}`, {
        approval_status: 'approved',
        approved_by: userId,
      }),
      200,
      '审批变更请求',
    ).item;
    assert.equal(approved.approval_status, 'approved');
    assert.ok(approved.approved_at, '审批时间未写入');

    const g4 = ok(
      await req('GET', `/api/engagements/${engagementId}/g4-checks`),
      200,
      'G4 校验',
    );
    assert.equal(g4.blocked, true, '未签收时 G4-11 应阻断');
    assert.equal(g4.summary.pass, 10, `G4 pass 数 ${g4.summary.pass}`);
    assert.equal(g4.checks.find((c: any) => c.code === 'G4-11').outcome, 'block');

    const docs: Array<[string, string, string, string]> = [
      ['plan', 'delivery_plan', '阶段与任务', '一期上线'],
      ['uat', 'uat_report', '通过率', '单均录入耗时'],
      ['go_live', 'go_live_checklist', '阻断项', '生产环境账号'],
      ['training', 'training_materials', '培训大纲', '单证组操作培训'],
    ];
    let goLiveDocId: string | null = null;
    for (const [type, deliverableType, marker, marker2] of docs) {
      const doc = ok(
        await req('POST', `/api/engagements/${engagementId}/delivery-documents`, { type }),
        201,
        `生成交付文档：${type}`,
      ).item;
      assert.equal(doc.type, deliverableType);
      assert.equal(doc.version, 1);
      if (type === 'go_live') goLiveDocId = doc.id;

      const md = await app.inject({
        method: 'GET',
        url: `/api/engagements/${engagementId}/delivery-document?type=${type}`,
      });
      assert.equal(md.statusCode, 200, `${type} Markdown 失败：${md.statusCode}`);
      assert.ok(md.body.includes(marker), `${type} 缺少「${marker}」`);
      assert.ok(md.body.includes(marker2), `${type} 缺少「${marker2}」`);

      const docx = await app.inject({
        method: 'GET',
        url: `/api/engagements/${engagementId}/delivery-document.docx?type=${type}`,
      });
      assert.equal(docx.statusCode, 200, `${type} Word 失败：${docx.statusCode}`);
      assert.match(String(docx.headers['content-type']), /wordprocessingml/);
      assert.equal(docx.rawPayload.subarray(0, 2).toString(), 'PK', `${type} docx 不是 ZIP`);
      assert.ok(docx.rawPayload.length > 5000, `${type} docx 只有 ${docx.rawPayload.length} 字节`);
    }

    // G4-11：没有客户签收时应 block，签收上线检查表后应放行
    const g4BeforeSignoff = ok(
      await req('GET', `/api/engagements/${engagementId}/g4-checks`),
      200,
      'G4 校验（签收前）',
    );
    assert.equal(g4BeforeSignoff.blocked, true, '未签收时 G4-11 应 block');
    const signoffCheck = g4BeforeSignoff.checks.find((c: any) => c.code === 'G4-11');
    assert.equal(signoffCheck.outcome, 'block');

    assert.ok(goLiveDocId, '没有上线检查表交付物');
    const signer = await one<{ id: string }>(
      `SELECT s.id FROM stakeholders s
         JOIN engagements e ON e.client_id = s.client_id
        WHERE e.id = $1 ORDER BY s.is_key DESC LIMIT 1`,
      [engagementId],
    );
    assert.ok(signer, '没有客户干系人可签收');
    ok(
      await req('POST', `/api/engagements/${engagementId}/confirmations`, {
        object_type: 'deliverable',
        object_id: goLiveDocId,
        confirmed_by: signer.id,
        method: 'signature',
        evidence: '客户签字版上线检查表',
      }),
      201,
      '客户签收上线检查表',
    );

    const g4AfterSignoff = ok(
      await req('GET', `/api/engagements/${engagementId}/g4-checks`),
      200,
      'G4 校验（签收后）',
    );
    assert.equal(g4AfterSignoff.blocked, false, `签收后 G4 仍有 block：${JSON.stringify(g4AfterSignoff.summary)}`);
    assert.equal(g4AfterSignoff.summary.pass, 11);

    // 再生成一次同类型文档，验证版本递增
    const uatV2 = ok(
      await req('POST', `/api/engagements/${engagementId}/delivery-documents`, { type: 'uat' }),
      201,
      '再次生成 UAT 报告',
    ).item;
    assert.equal(uatV2.version, 2);
  });

  await check('S5 运营：指标目标、快照、价值记录、使用数据、续约风险与 G5', async () => {
    const metrics = ok(
      await req('GET', `/api/metric-definitions`),
      200,
      '指标字典',
    ).items;
    assert.ok(metrics.length >= 6, `指标字典只有 ${metrics.length} 项`);
    const timeMetric = metrics.find((m: any) => m.key === 'doc_entry_time');
    const costMetric = metrics.find((m: any) => m.key === 'annual_cost_saved');
    assert.ok(timeMetric && costMetric, '缺少默认指标定义');

    const target = ok(
      await req('POST', `/api/engagements/${engagementId}/metric-targets`, {
        opportunity_id: opps[0].id,
        metric_id: timeMetric.id,
        baseline: 10,
        target: 3,
        target_date: '2026-12-31',
        owner: userId,
        note: '一期上线后 30 天达成',
      }),
      201,
      '创建指标目标',
    ).item;

    const costTarget = ok(
      await req('POST', `/api/engagements/${engagementId}/metric-targets`, {
        opportunity_id: opps[0].id,
        metric_id: costMetric.id,
        baseline: 0,
        target: 50,
        target_date: '2026-12-31',
        owner: userId,
      }),
      201,
      '创建成本指标目标',
    ).item;

    const snapshot = ok(
      await req('POST', `/api/metric-targets/${target.id}/snapshots`, {
        period: '2026-11',
        value: 2.8,
        source: 'TMS 埋点 / 周报',
        confidence: 'high',
        recorded_by: userId,
      }),
      201,
      '记录指标快照',
    ).item;
    assert.equal(snapshot.period, '2026-11');

    ok(
      await req('POST', `/api/metric-targets/${costTarget.id}/snapshots`, {
        period: '2026-11',
        value: 52,
        source: '财务确认单',
        confidence: 'high',
        recorded_by: userId,
      }),
      201,
      '记录成本快照',
    );

    const value1 = ok(
      await req('POST', `/api/engagements/${engagementId}/value-records`, {
        opportunity_id: opps[0].id,
        target_id: target.id,
        metric_id: timeMetric.id,
        period: '2026-11',
        realized_value: 2.8,
        method: '上线前后各抽 100 单现场计时，取中位数',
        evidence: '计时表 + TMS 日志',
        confidence: 'high',
        verified_by: userId,
      }),
      201,
      '登记价值记录',
    ).item;
    ok(
      await req('POST', `/api/engagements/${engagementId}/value-records`, {
        opportunity_id: opps[0].id,
        target_id: costTarget.id,
        metric_id: costMetric.id,
        period: '2026-11',
        realized_value: 50,
        method: '节省工时 × 人工成本，财务口径确认',
        evidence: '财务确认邮件 2026-11-30',
        confidence: 'medium',
        verified_by: userId,
      }),
      201,
      '登记成本价值记录',
    );
    assert.equal(value1.confidence, 'high');

    ok(
      await req('POST', `/api/engagements/${engagementId}/usage-records`, {
        solution_id: solutionId,
        period: '2026-11',
        active_users: 12,
        volume: 1000,
        errors: 12,
        source: '系统埋点',
        note: '上线首月',
      }),
      201,
      '登记使用数据',
    );

    ok(
      await req('POST', `/api/engagements/${engagementId}/renewal-risks`, {
        kind: 'renewal',
        title: '二期预算尚未确认',
        probability: 'medium',
        impact: '影响二期启动时间',
        action: '12 月经营会评审一期价值报告',
        owner: userId,
        due_date: '2026-12-15',
        value_potential: 80,
        status: 'open',
      }),
      201,
      '登记续约风险',
    );

    const overview = ok(
      await req('GET', `/api/engagements/${engagementId}/value-overview`),
      200,
      '价值总览',
    );
    assert.equal(overview.targets.length, 2);
    assert.equal(overview.snapshots.length, 2);
    assert.equal(overview.values.length, 2);
    assert.equal(overview.usage.length, 1);
    assert.equal(overview.risks.length, 1);
    assert.equal(overview.totals.realizedValue, 50);

    const g5 = ok(
      await req('GET', `/api/engagements/${engagementId}/g5-checks`),
      200,
      'G5 校验',
    );
    assert.equal(g5.blocked, false, `G5 仍有 block：${JSON.stringify(g5.summary)}`);
    assert.equal(g5.summary.pass, 9, `G5 pass 数 ${g5.summary.pass}`);

    const docs: Array<[string, string, string, string]> = [
      ['value', 'value_report', '执行摘要', '已兑现财务价值'],
      ['renewal', 'renewal_recommendation', '判断依据', '二期预算尚未确认'],
    ];
    for (const [type, deliverableType, marker, marker2] of docs) {
      const doc = ok(
        await req('POST', `/api/engagements/${engagementId}/value-documents`, { type }),
        201,
        `生成价值文档：${type}`,
      ).item;
      assert.equal(doc.type, deliverableType);
      assert.equal(doc.version, 1);

      const md = await app.inject({
        method: 'GET',
        url: `/api/engagements/${engagementId}/value-document?type=${type}`,
      });
      assert.equal(md.statusCode, 200, `${type} Markdown 失败：${md.statusCode}`);
      assert.ok(md.body.includes(marker), `${type} 缺少「${marker}」`);
      assert.ok(md.body.includes(marker2), `${type} 缺少「${marker2}」`);

      const docx = await app.inject({
        method: 'GET',
        url: `/api/engagements/${engagementId}/value-document.docx?type=${type}`,
      });
      assert.equal(docx.statusCode, 200, `${type} Word 失败：${docx.statusCode}`);
      assert.match(String(docx.headers['content-type']), /wordprocessingml/);
      assert.equal(docx.rawPayload.subarray(0, 2).toString(), 'PK', `${type} docx 不是 ZIP`);
      assert.ok(docx.rawPayload.length > 5000, `${type} docx 只有 ${docx.rawPayload.length} 字节`);
    }

    const valueV2 = ok(
      await req('POST', `/api/engagements/${engagementId}/value-documents`, { type: 'value' }),
      201,
      '再次生成价值报告',
    ).item;
    assert.equal(valueV2.version, 2);
  });

  await check('R6 知识库与 AI 草稿：检索、相似推荐、生成与人工确认', async () => {
    const seeded = ok(
      await req('GET', `/api/knowledge?q=${encodeURIComponent('托书')}`),
      200,
      '知识库检索',
    ).items;
    assert.ok(seeded.length >= 1, '知识库没有匹配「托书」的条目');
    const tagged = ok(
      await req('GET', `/api/knowledge?tag=OCR`),
      200,
      '知识库标签筛选',
    ).items;
    assert.ok(tagged.length >= 1, '知识库没有 OCR 标签条目');

    const created = ok(
      await req('POST', '/api/knowledge', {
        industry: 'logistics',
        category: 'pattern',
        title: '回归测试：托书 OCR 异常复核模式',
        summary: '低置信度字段进入人工复核队列，避免错误直接进入业务系统。',
        content: '识别 → 校验 → 复核 → 回写；每个环节保留操作日志与样本回流。',
        tags: ['托书', 'OCR', '复核'],
        source: '回归测试',
      }),
      201,
      '创建知识条目',
    ).item;
    assert.ok(created.id);

    const patched = ok(
      await req('PATCH', `/api/knowledge/${created.id}`, {
        summary: '低置信度字段进入人工复核队列，并保留样本回流。',
      }),
      200,
      '更新知识条目',
    ).item;
    assert.match(patched.summary, /样本回流/);

    const rejectedReview = ok(
      await req('POST', `/api/knowledge/${created.id}/review`, {
        decision: 'reject',
        note: '补充适用边界后再发布',
      }),
      200,
      '知识条目退回',
    ).item;
    assert.equal(rejectedReview.status, 'draft');
    assert.ok(rejectedReview.reviewed_at, '退回未记录审批时间');

    const approvedReview = ok(
      await req('POST', `/api/knowledge/${created.id}/review`, {
        decision: 'approve',
        note: '补充完成，同意发布',
      }),
      200,
      '知识条目审批通过',
    ).item;
    assert.equal(approvedReview.status, 'published');

    ok(
      await req('PATCH', `/api/knowledge/${created.id}`, { expires_at: '2026-11-20' }),
      200,
      '设置知识有效期（即将过期）',
    );
    const expiring = ok(
      await req('GET', '/api/knowledge?expiring=1'),
      200,
      '即将过期知识筛选',
    ).items;
    assert.ok(expiring.some((x: any) => x.id === created.id), '即将过期列表没有命中');

    ok(
      await req('PATCH', `/api/knowledge/${created.id}`, { expires_at: '2026-09-01' }),
      200,
      '设置知识有效期（已过期）',
    );
    const expired = ok(
      await req('GET', '/api/knowledge?expired=1'),
      200,
      '已过期知识筛选',
    ).items;
    assert.ok(expired.some((x: any) => x.id === created.id), '已过期列表没有命中');

    const similar = ok(
      await req('GET', `/api/engagements/${engagementId}/similar-knowledge`),
      200,
      '相似知识推荐',
    ).items;
    assert.ok(similar.length >= 1, '相似推荐为空');
    assert.ok(
      similar.some((x: any) => x.item.id === created.id),
      '相似推荐没有命中新建知识条目',
    );

    const aiConfig = ok(
      await req('GET', '/api/ai/config'),
      200,
      'AI 配置',
    );
    assert.equal(aiConfig.configured, false, '测试环境不应配置外部大模型');
    assert.equal(aiConfig.model, 'rule-based-v1');

    const reportDraft = ok(
      await req('POST', `/api/engagements/${engagementId}/ai-drafts`, {
        kind: 'report_draft',
      }),
      201,
      '生成诊断报告草稿',
    ).item;
    assert.equal(reportDraft.model, 'rule-based-v1');
    assert.match(reportDraft.content, /关键发现/);
    assert.match(reportDraft.content, /人工确认/);

    const solutionDraft = ok(
      await req('POST', `/api/engagements/${engagementId}/ai-drafts`, {
        kind: 'solution_skeleton',
        source_id: opps[0].id,
      }),
      201,
      '生成方案骨架草稿',
    ).item;
    assert.match(solutionDraft.content, /目标与范围/);

    const prdDraft = ok(
      await req('POST', `/api/engagements/${engagementId}/ai-drafts`, {
        kind: 'prd_skeleton',
        source_id: opps[0].id,
      }),
      201,
      '生成 PRD 骨架草稿',
    ).item;
    assert.match(prdDraft.content, /功能需求/);

    const interview = await one<{ id: string }>(
      `SELECT id FROM interviews
        WHERE engagement_id = $1 AND transcript IS NOT NULL AND btrim(transcript) <> ''
        ORDER BY date DESC LIMIT 1`,
      [engagementId],
    );
    const interviewDraft = ok(
      await req('POST', `/api/engagements/${engagementId}/ai-drafts`, {
        kind: 'interview_summary',
        source_id: interview?.id,
      }),
      201,
      '生成访谈摘要草稿',
    ).item;
    assert.match(interviewDraft.content, /纪要要点/);

    const answerDraft = ok(
      await req('POST', `/api/engagements/${engagementId}/ai-drafts`, {
        kind: 'answer',
        prompt: '托书识别怎么做 POC？',
      }),
      201,
      '生成问答草稿',
    ).item;
    assert.match(answerDraft.content, /回答要点/);
    assert.match(answerDraft.content, /参考来源/);

    const edited = ok(
      await req('PATCH', `/api/ai-drafts/${reportDraft.id}`, {
        content: `${reportDraft.content}\n\n## 8. 顾问补充\n\n人工补充的结论。`,
      }),
      200,
      '编辑草稿',
    ).item;
    assert.match(edited.content, /顾问补充/);

    const confirmed = ok(
      await req('POST', `/api/ai-drafts/${reportDraft.id}/confirm`, {}),
      200,
      '确认草稿',
    ).item;
    assert.equal(confirmed.status, 'confirmed');
    assert.ok(confirmed.confirmed_at, '确认时间未写入');

    const rejected = ok(
      await req('POST', `/api/ai-drafts/${solutionDraft.id}/reject`, {}),
      200,
      '拒绝草稿',
    ).item;
    assert.equal(rejected.status, 'rejected');

    const list = ok(
      await req('GET', `/api/engagements/${engagementId}/ai-drafts`),
      200,
      '草稿列表',
    ).items;
    assert.ok(list.length >= 5, `草稿列表只有 ${list.length} 条`);

    ok(await req('DELETE', `/api/knowledge/${created.id}`), 200, '删除知识条目');
  });

  await check('角色权限：技术负责人/顾问不能执行管理类动作', async () => {
    const login = async (email: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password: 'demo1234' },
      });
      assert.equal(res.statusCode, 200, `登录失败：${email}`);
      return res.json().token as string;
    };
    const techToken = await login('liu@hengzhi.ai');
    const pmToken = await login('wang@hengzhi.ai');
    const consultantToken = await login('zhang@hengzhi.ai');

    const authHeaders = (token: string) => ({ authorization: `Bearer ${token}` });

    const auditForbidden = await app.inject({
      method: 'GET',
      url: '/api/audit-logs',
      headers: authHeaders(techToken),
    });
    assert.equal(auditForbidden.statusCode, 403, '技术负责人不应能看审计日志');
    assert.equal(auditForbidden.json().error, 'FORBIDDEN');

    const auditForPm = await app.inject({
      method: 'GET',
      url: '/api/audit-logs',
      headers: authHeaders(pmToken),
    });
    assert.equal(auditForPm.statusCode, 200, '项目经理应能看审计日志');

    const benchmarkForbidden = await app.inject({
      method: 'DELETE',
      url: '/api/benchmarks/00000000-0000-4000-8000-000000000000',
      headers: authHeaders(techToken),
    });
    assert.equal(benchmarkForbidden.statusCode, 403, '技术负责人不应能维护行业标杆');

    const benchmarkForPm = await app.inject({
      method: 'DELETE',
      url: '/api/benchmarks/00000000-0000-4000-8000-000000000000',
      headers: authHeaders(pmToken),
    });
    assert.equal(benchmarkForPm.statusCode, 403, '项目经理也不应维护行业标杆（仅管理员/总监）');

    const metricForConsultant = await app.inject({
      method: 'POST',
      url: '/api/metric-definitions',
      headers: authHeaders(consultantToken),
      payload: { key: 'forbidden_metric', name: '越权指标', unit: '%' },
    });
    assert.equal(metricForConsultant.statusCode, 403, '顾问不应能改指标字典');

    const reviewForPm = await app.inject({
      method: 'POST',
      url: '/api/knowledge/00000000-0000-4000-8000-000000000000/review',
      headers: authHeaders(pmToken),
      payload: { decision: 'approve' },
    });
    assert.equal(reviewForPm.statusCode, 404, '项目经理应通过知识审批角色校验（记录不存在→404）');

    const reviewForConsultant = await app.inject({
      method: 'POST',
      url: '/api/knowledge/00000000-0000-4000-8000-000000000000/review',
      headers: authHeaders(consultantToken),
      payload: { decision: 'approve' },
    });
    assert.equal(reviewForConsultant.statusCode, 403, '顾问不应能审批知识条目');

    const shareForTech = await app.inject({
      method: 'POST',
      url: '/api/deliverables/00000000-0000-4000-8000-000000000000/shares',
      headers: authHeaders(techToken),
      payload: { shared_to: '00000000-0000-4000-8000-000000000000', channel: 'email' },
    });
    assert.equal(shareForTech.statusCode, 403, '技术负责人不应能外发交付物');
  });

  await check('登录失败限流：连续失败 429、正确密码也需等待', async () => {
    const previousMax = process.env.LOGIN_MAX_FAILURES;
    const previousWindow = process.env.LOGIN_WINDOW_MS;
    try {
      process.env.LOGIN_MAX_FAILURES = '2';
      process.env.LOGIN_WINDOW_MS = '60000';
      await resetLoginGuard();

      const attempt = (password: string) =>
        app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: 'zhang@hengzhi.ai', password },
        });

      const first = await attempt('wrong-password');
      assert.equal(first.statusCode, 401);
      const second = await attempt('wrong-password');
      assert.equal(second.statusCode, 401);

      const third = await attempt('wrong-password');
      assert.equal(third.statusCode, 429, '第三次失败应触发 429');
      assert.equal(third.json().error, 'LOGIN_RATE_LIMITED');
      assert.ok(third.headers['retry-after'], '429 缺少 retry-after');

      const correctButBlocked = await attempt('demo1234');
      assert.equal(correctButBlocked.statusCode, 429, '限流期间正确密码也应被拦截');

      await resetLoginGuard();
      const afterReset = await attempt('demo1234');
      assert.equal(afterReset.statusCode, 200, '重置后正确密码应放行');
    } finally {
      if (previousMax === undefined) delete process.env.LOGIN_MAX_FAILURES;
      else process.env.LOGIN_MAX_FAILURES = previousMax;
      if (previousWindow === undefined) delete process.env.LOGIN_WINDOW_MS;
      else process.env.LOGIN_WINDOW_MS = previousWindow;
      await resetLoginGuard();
    }
  });

  await check('会话撤销：单会话、强制下线与管理员权限', async () => {
    const login = async (email: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password: 'demo1234' },
      });
      assert.equal(res.statusCode, 200, `登录失败：${email}`);
      const body = res.json();
      return { token: body.token as string, userId: body.user.id as string };
    };
    const headers = (token: string) => ({ authorization: `Bearer ${token}` });

    const a1 = await login('admin@hengzhi.ai');
    const a2 = await login('admin@hengzhi.ai');
    const meA1 = await app.inject({ method: 'GET', url: '/api/me', headers: headers(a1.token) });
    assert.equal(meA1.statusCode, 200);

    const sessions = await app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: headers(a1.token),
    });
    assert.equal(sessions.statusCode, 200);
    const items = sessions.json().items;
    assert.ok(items.length >= 2, `会话数 ${items.length}`);
    assert.ok(items.some((x: any) => x.current), '缺少当前会话标记');
    const other = items.find((x: any) => !x.current && x.active);
    assert.ok(other, '没有可撤销的其它会话');

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/auth/sessions/${other.id}`,
      headers: headers(a1.token),
    });
    assert.equal(revoked.statusCode, 200);

    const meA2 = await app.inject({ method: 'GET', url: '/api/me', headers: headers(a2.token) });
    assert.equal(meA2.statusCode, 401, '被撤销会话不应继续访问');
    const meA1Again = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: headers(a1.token),
    });
    assert.equal(meA1Again.statusCode, 200, '未撤销会话应保持有效');

    const zhang = await login('zhang@hengzhi.ai');
    const revokeAll = await app.inject({
      method: 'POST',
      url: `/api/users/${zhang.userId}/revoke-sessions`,
      headers: headers(a1.token),
    });
    assert.equal(revokeAll.statusCode, 200, `强制下线失败：${revokeAll.body}`);
    assert.ok(revokeAll.json().revoked >= 1, '未撤销任何会话');
    const zhangMe = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: headers(zhang.token),
    });
    assert.equal(zhangMe.statusCode, 401, '被强制下线的用户仍可访问');

    const wang = await login('wang@hengzhi.ai');
    const pmDenied = await app.inject({
      method: 'POST',
      url: `/api/users/${zhang.userId}/revoke-sessions`,
      headers: headers(wang.token),
    });
    assert.equal(pmDenied.statusCode, 403, '项目经理不应能强制下线其他用户');

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: headers(a1.token),
    });
    assert.equal(logout.statusCode, 200);
    const afterLogout = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: headers(a1.token),
    });
    assert.equal(afterLogout.statusCode, 401, '退出后 token 应失效');
  });

  await check('会话清理：预演、确认执行与权限', async () => {
    const userId = 'a1000000-0000-4000-8000-000000000001';
    const orgId = 'a0000000-0000-4000-8000-000000000001';
    const inserted = await query<{ id: string }>(
      `INSERT INTO user_sessions
         (jti, user_id, org_id, expires_at, revoked_at, created_at)
       VALUES
         (gen_random_uuid(), $1, $2, now() - interval '90 days', now() - interval '90 days', now() - interval '120 days'),
         (gen_random_uuid(), $1, $2, now() - interval '90 days', NULL, now() - interval '120 days')
       RETURNING id`,
      [userId, orgId],
    );
    assert.equal(inserted.length, 2);

    const before = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const dry = ok(
      await req('POST', '/api/user-sessions/cleanup', { before, dry_run: true }),
      200,
      '会话清理预演',
    );
    assert.equal(dry.deleted, 0);
    assert.ok(dry.candidates >= 2, `预演候选数 ${dry.candidates}`);

    const noConfirm = await req('POST', '/api/user-sessions/cleanup', {
      before,
      dry_run: false,
    });
    assert.equal(noConfirm.status, 422);
    assert.equal(noConfirm.body.error, 'CLEANUP_CONFIRM_REQUIRED');

    const cleaned = ok(
      await req('POST', '/api/user-sessions/cleanup', {
        before,
        dry_run: false,
        confirm: 'CLEANUP',
        batch_size: 10,
      }),
      200,
      '执行会话清理',
    );
    assert.ok(cleaned.deleted >= 2, `实际清理 ${cleaned.deleted} 条`);

    const remaining = await one<{ count: number }>(
      `SELECT count(*)::int AS count FROM user_sessions WHERE id = ANY($1::uuid[])`,
      [inserted.map((x) => x.id)],
    );
    assert.equal(remaining?.count, 0, '旧会话未清理');

    const wangLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'wang@hengzhi.ai', password: 'demo1234' },
    });
    const denied = await app.inject({
      method: 'POST',
      url: '/api/user-sessions/cleanup',
      headers: { authorization: `Bearer ${wangLogin.json().token}` },
      payload: { before, dry_run: true },
    });
    assert.equal(denied.statusCode, 403, '项目经理不应能清理会话');
  });

  await check('用户管理：创建、改角色、重置密码、禁用与权限', async () => {
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@hengzhi.ai', password: 'demo1234' },
    });
    assert.equal(adminLogin.statusCode, 200);
    const adminToken = adminLogin.json().token;
    const headers = { authorization: `Bearer ${adminToken}` };
    const email = `qa-${stamp}@hengzhi.ai`;

    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers,
      payload: {
        name: `回归用户-${stamp}`,
        email,
        role: 'consultant',
        password: 'TempPass123',
      },
    });
    assert.equal(created.statusCode, 201, `创建用户失败：${created.body}`);
    const user = created.json().item;
    assert.equal(user.role, 'consultant');
    assert.equal(user.status, 'active');

    const list = await app.inject({ method: 'GET', url: '/api/admin/users', headers });
    assert.equal(list.statusCode, 200);
    assert.ok(list.json().items.some((u: any) => u.id === user.id), '用户列表缺少新用户');

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${user.id}`,
      headers,
      payload: { name: `回归用户-改名-${stamp}`, role: 'pm' },
    });
    assert.equal(patched.statusCode, 200, `修改用户失败：${patched.body}`);
    assert.equal(patched.json().item.role, 'pm');
    assert.match(patched.json().item.name, /改名/);

    const reset = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${user.id}/reset-password`,
      headers,
      payload: { password: 'NewPass123' },
    });
    assert.equal(reset.statusCode, 200);

    const oldLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: 'TempPass123' },
    });
    assert.equal(oldLogin.statusCode, 401, '旧密码应失效');
    const newLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: 'NewPass123' },
    });
    assert.equal(newLogin.statusCode, 200, '新密码应可登录');
    const userToken = newLogin.json().token;

    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${user.id}`,
      headers,
      payload: { status: 'disabled' },
    });
    assert.equal(disabled.statusCode, 200);
    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${userToken}` },
    });
    assert.equal(me.statusCode, 401, '禁用后会话应立即失效');
    const disabledLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: 'NewPass123' },
    });
    assert.equal(disabledLogin.statusCode, 401, '禁用用户不应能登录');

    const pmLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'wang@hengzhi.ai', password: 'demo1234' },
    });
    const pmDenied = await app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { authorization: `Bearer ${pmLogin.json().token}` },
    });
    assert.equal(pmDenied.statusCode, 403, '项目经理不应能管理用户');

    await query(`DELETE FROM users WHERE id = $1`, [user.id]);
  });

  await check('自助改密：旧密码校验、撤销其他会话、旧密码失效', async () => {
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@hengzhi.ai', password: 'demo1234' },
    });
    const adminToken = adminLogin.json().token;
    const email = `pw-${stamp}@hengzhi.ai`;

    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: `改密用户-${stamp}`,
        email,
        role: 'consultant',
        password: 'OldPass123',
      },
    });
    assert.equal(created.statusCode, 201, `创建改密用户失败：${created.body}`);
    const userId = created.json().item.id;

    const login = async (password: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password },
      });

    const first = await login('OldPass123');
    const second = await login('OldPass123');
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    const token1 = first.json().token;
    const token2 = second.json().token;

    const wrongOld = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { authorization: `Bearer ${token1}` },
      payload: { old_password: 'WrongPass123', new_password: 'NewPass456' },
    });
    assert.equal(wrongOld.statusCode, 401, '旧密码错误应 401');
    assert.equal(wrongOld.json().error, 'INVALID_OLD_PASSWORD');

    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { authorization: `Bearer ${token1}` },
      payload: { old_password: 'OldPass123', new_password: 'NewPass456' },
    });
    assert.equal(changed.statusCode, 200, `改密失败：${changed.body}`);
    assert.ok(changed.json().revoked_others >= 1, '未撤销其他会话');

    const otherMe = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${token2}` },
    });
    assert.equal(otherMe.statusCode, 401, '其他会话应被撤销');
    const currentMe = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${token1}` },
    });
    assert.equal(currentMe.statusCode, 200, '当前会话应保留');

    const oldLogin = await login('OldPass123');
    assert.equal(oldLogin.statusCode, 401, '旧密码应失效');
    const newLogin = await login('NewPass456');
    assert.equal(newLogin.statusCode, 200, '新密码应可登录');

    await query(`DELETE FROM users WHERE id = $1`, [userId]);
  });

  await check('供应商租户：自助注册、组织标识登录与数据隔离', async () => {
    const slugB = `tenant-${stamp}`.slice(0, 32);
    const slugC = `tenant-c-${stamp}`.slice(0, 32);
    const email = `owner-${stamp}@vendor.test`;
    const password = 'TenantPass1';

    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        org_name: `供应商B-${stamp}`,
        org_slug: slugB,
        name: `管理员B-${stamp}`,
        email,
        password,
      },
    });
    assert.equal(registered.statusCode, 201, `注册失败：${registered.body}`);
    const reg = registered.json();
    assert.equal(reg.user.org_slug, slugB);
    assert.equal(reg.user.role, 'admin');
    const tokenB = reg.token;

    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.org_slug, slugB);

    const clientB = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { name: `租户B客户-${stamp}`, industry: 'logistics' },
    });
    assert.equal(clientB.statusCode, 201, `创建租户B客户失败：${clientB.body}`);

    const zhangLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'zhang@hengzhi.ai', password: 'demo1234' },
    });
    const tokenA = zhangLogin.json().token;
    const listA = await app.inject({
      method: 'GET',
      url: '/api/clients?limit=500',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.ok(
      !listA.json().items.some((c: any) => c.name === `租户B客户-${stamp}`),
      '租户 A 看到了租户 B 的客户',
    );
    const listB = await app.inject({
      method: 'GET',
      url: '/api/clients?limit=500',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.ok(listB.json().items.some((c: any) => c.name === `租户B客户-${stamp}`));

    const duplicateSlug = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        org_name: '重复标识组织',
        org_slug: slugB,
        name: '重复管理员',
        email: `dup-${stamp}@vendor.test`,
        password: 'TenantPass2',
      },
    });
    assert.equal(duplicateSlug.statusCode, 409, '重复组织标识应 409');
    assert.equal(duplicateSlug.json().error, 'ORG_SLUG_EXISTS');

    const registeredC = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        org_name: `供应商C-${stamp}`,
        org_slug: slugC,
        name: `管理员C-${stamp}`,
        email,
        password: 'TenantPass2',
      },
    });
    assert.equal(registeredC.statusCode, 201, `注册租户C失败：${registeredC.body}`);

    const ambiguous = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
    });
    assert.equal(ambiguous.statusCode, 400, '同邮箱多组织未填标识应 400');
    assert.equal(ambiguous.json().error, 'ORG_REQUIRED');

    for (const slug of [slugB, slugC]) {
      const scoped = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password: slug === slugB ? password : 'TenantPass2', org_slug: slug },
      });
      assert.equal(scoped.statusCode, 200, `组织标识 ${slug} 登录失败`);
    }

    await query(`DELETE FROM organizations WHERE lower(slug) = ANY($1::text[])`, [
      [slugB, slugC],
    ]);
  });

  await check('平台租户：列表、组织设置、暂停/恢复与权限', async () => {
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@hengzhi.ai', password: 'demo1234' },
    });
    assert.equal(adminLogin.statusCode, 200);
    const admin = adminLogin.json();
    assert.equal(admin.user.platform_admin, true, '平台管理员标记缺失');
    const adminHeaders = { authorization: `Bearer ${admin.token}` };

    const zhangLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'zhang@hengzhi.ai', password: 'demo1234' },
    });
    assert.equal(zhangLogin.json().user.platform_admin, false);
    const zhangHeaders = { authorization: `Bearer ${zhangLogin.json().token}` };

    const tenants = await app.inject({
      method: 'GET',
      url: '/api/platform/tenants',
      headers: adminHeaders,
    });
    assert.equal(tenants.statusCode, 200);
    assert.ok(tenants.json().items.some((t: any) => t.slug === 'hengzhi'));

    const storage = await app.inject({
      method: 'GET',
      url: '/api/system/storage',
      headers: adminHeaders,
    });
    assert.equal(storage.statusCode, 200);
    assert.equal(storage.json().driver, 'local', '测试环境应为 local 存储');

    const cache = await app.inject({
      method: 'GET',
      url: '/api/system/cache',
      headers: adminHeaders,
    });
    assert.equal(cache.statusCode, 200);
    if (process.env.REDIS_URL) {
      assert.equal(cache.json().driver, 'redis', '配置 REDIS_URL 时应使用 Redis');
    } else {
      assert.equal(cache.json().driver, 'memory', '未配置 Redis 时应回退内存');
    }

    const denied = await app.inject({
      method: 'GET',
      url: '/api/platform/tenants',
      headers: zhangHeaders,
    });
    assert.equal(denied.statusCode, 403, '非平台管理员不应查看租户列表');

    const slug = `platform-${stamp}`.slice(0, 32);
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        org_name: `平台测试供应商-${stamp}`,
        org_slug: slug,
        name: `租户管理员-${stamp}`,
        email: `platform-${stamp}@vendor.test`,
        password: 'PlatformPass1',
      },
    });
    assert.equal(registered.statusCode, 201, registered.body);
    const tenant = registered.json();
    const tenantHeaders = { authorization: `Bearer ${tenant.token}` };

    const org = await app.inject({
      method: 'GET',
      url: '/api/org',
      headers: tenantHeaders,
    });
    assert.equal(org.statusCode, 200);
    assert.equal(org.json().item.slug, slug);
    assert.equal(org.json().item.status, 'active');

    const renamed = await app.inject({
      method: 'PATCH',
      url: '/api/org',
      headers: tenantHeaders,
      payload: { name: `平台测试供应商-改名-${stamp}` },
    });
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.match(renamed.json().item.name, /改名/);

    const consultant = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: tenantHeaders,
      payload: {
        name: '租户顾问',
        email: `tenant-cons-${stamp}@vendor.test`,
        role: 'consultant',
        password: 'Consultant1',
      },
    });
    assert.equal(consultant.statusCode, 201, consultant.body);
    const consultantLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `tenant-cons-${stamp}@vendor.test`, password: 'Consultant1' },
    });
    const consultantDenied = await app.inject({
      method: 'PATCH',
      url: '/api/org',
      headers: { authorization: `Bearer ${consultantLogin.json().token}` },
      payload: { name: '越权改名' },
    });
    assert.equal(consultantDenied.statusCode, 403, '顾问不应修改组织设置');

    const tenantBenchmarkDenied = await app.inject({
      method: 'POST',
      url: '/api/benchmarks',
      headers: tenantHeaders,
      payload: {
        metric_key: 'tenant_metric',
        metric_name: '租户越权指标',
        unit: '%',
        direction: 'higher_better',
        p25: 1,
        p50: 2,
        p75: 3,
        source: 'tenant',
        year: 2026,
      },
    });
    assert.equal(tenantBenchmarkDenied.statusCode, 403, '租户不应修改平台标杆字典');

    const suspended = await app.inject({
      method: 'PATCH',
      url: `/api/platform/tenants/${tenant.user.org_id}`,
      headers: adminHeaders,
      payload: { status: 'suspended' },
    });
    assert.equal(suspended.statusCode, 200, suspended.body);
    assert.equal(suspended.json().item.status, 'suspended');

    const tenantMe = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: tenantHeaders,
    });
    assert.equal(tenantMe.statusCode, 401, '暂停租户后现有会话应失效');
    const suspendedLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: tenant.user.email, password: 'PlatformPass1' },
    });
    assert.equal(suspendedLogin.statusCode, 401, '暂停租户不应能登录');

    const activated = await app.inject({
      method: 'PATCH',
      url: `/api/platform/tenants/${tenant.user.org_id}`,
      headers: adminHeaders,
      payload: { status: 'active' },
    });
    assert.equal(activated.statusCode, 200);
    const reactivatedLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: tenant.user.email, password: 'PlatformPass1' },
    });
    assert.equal(reactivatedLogin.statusCode, 200, '恢复后应可登录');

    const selfSuspend = await app.inject({
      method: 'PATCH',
      url: `/api/platform/tenants/${admin.user.org_id}`,
      headers: adminHeaders,
      payload: { status: 'suspended' },
    });
    assert.equal(selfSuspend.statusCode, 422, '平台管理员不应暂停自己所属组织');

    await query(`DELETE FROM organizations WHERE id = $1`, [tenant.user.org_id]);
  });

  await check('租户套餐：试用期、配额与升级', async () => {
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@hengzhi.ai', password: 'demo1234', org_slug: 'hengzhi' },
    });
    assert.equal(adminLogin.statusCode, 200);
    const adminHeaders = { authorization: `Bearer ${adminLogin.json().token}` };

    const zhangLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'zhang@hengzhi.ai', password: 'demo1234' },
    });
    const zhangHeaders = { authorization: `Bearer ${zhangLogin.json().token}` };

    const plans = await app.inject({
      method: 'GET',
      url: '/api/platform/plans',
      headers: adminHeaders,
    });
    assert.equal(plans.statusCode, 200);
    assert.ok(plans.json().items.some((p: any) => p.code === 'trial'));
    assert.ok(plans.json().items.some((p: any) => p.code === 'pro'));

    const deniedPlans = await app.inject({
      method: 'GET',
      url: '/api/platform/plans',
      headers: zhangHeaders,
    });
    assert.equal(deniedPlans.statusCode, 403, '非平台管理员不应查看套餐目录');

    const billing = await app.inject({
      method: 'GET',
      url: '/api/org/billing',
      headers: zhangHeaders,
    });
    assert.equal(billing.statusCode, 200);
    assert.equal(billing.json().item.plan, 'pro');
    assert.equal(billing.json().item.plan_status, 'active');
    assert.ok(billing.json().item.limits.clients >= 1);
    assert.ok(billing.json().item.usage.users >= 1);

    const slug = `billing-${stamp}`.slice(0, 32);
    const password = 'BillingPass1';
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        org_name: `套餐测试供应商-${stamp}`,
        org_slug: slug,
        name: `套餐管理员-${stamp}`,
        email: `billing-${stamp}@vendor.test`,
        password,
      },
    });
    assert.equal(registered.statusCode, 201, registered.body);
    const tenant = registered.json();
    const tenantHeaders = { authorization: `Bearer ${tenant.token}` };
    const orgId = tenant.user.org_id;

    const trialBilling = await app.inject({
      method: 'GET',
      url: '/api/org/billing',
      headers: tenantHeaders,
    });
    assert.equal(trialBilling.statusCode, 200);
    assert.equal(trialBilling.json().item.plan, 'trial');
    assert.equal(trialBilling.json().item.plan_status, 'trialing');
    assert.ok(trialBilling.json().item.days_left > 0, '新租户应有试用剩余天数');

    const userLimit = trialBilling.json().item.limits.users;
    for (let i = 1; i < userLimit; i += 1) {
      const created = await app.inject({
        method: 'POST',
        url: '/api/admin/users',
        headers: tenantHeaders,
        payload: {
          name: `试用用户${i}`,
          email: `trial-user-${i}-${stamp}@vendor.test`,
          role: 'consultant',
          password: 'TrialUser1',
        },
      });
      assert.equal(created.statusCode, 201, created.body);
    }
    const overUser = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: tenantHeaders,
      payload: {
        name: '超额用户',
        email: `trial-over-${stamp}@vendor.test`,
        role: 'consultant',
        password: 'TrialUser1',
      },
    });
    assert.equal(overUser.statusCode, 403, overUser.body);
    assert.equal(overUser.json().error, 'QUOTA_EXCEEDED');
    assert.equal(overUser.json().details.resource, 'users');
    assert.equal(overUser.json().details.limit, userLimit);

    const clientLimit = trialBilling.json().item.limits.clients;
    for (let i = 0; i < clientLimit; i += 1) {
      const created = await app.inject({
        method: 'POST',
        url: '/api/clients',
        headers: tenantHeaders,
        payload: { name: `试用客户${i}` },
      });
      assert.equal(created.statusCode, 201, created.body);
    }
    const overClient = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: tenantHeaders,
      payload: { name: '超额客户' },
    });
    assert.equal(overClient.statusCode, 403, overClient.body);
    assert.equal(overClient.json().error, 'QUOTA_EXCEEDED');
    assert.equal(overClient.json().details.resource, 'clients');
    assert.equal(overClient.json().details.limit, clientLimit);

    const upgraded = await app.inject({
      method: 'PATCH',
      url: `/api/platform/tenants/${orgId}`,
      headers: adminHeaders,
      payload: { plan: 'pro' },
    });
    assert.equal(upgraded.statusCode, 200, upgraded.body);
    assert.equal(upgraded.json().item.plan, 'pro');
    assert.equal(upgraded.json().item.plan_name, '专业版');

    const afterUpgrade = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: tenantHeaders,
      payload: { name: '升级后客户' },
    });
    assert.equal(afterUpgrade.statusCode, 201, afterUpgrade.body);

    const expired = await app.inject({
      method: 'PATCH',
      url: `/api/platform/tenants/${orgId}`,
      headers: adminHeaders,
      payload: { plan: 'trial', trial_ends_at: '2020-01-01T00:00:00.000Z' },
    });
    assert.equal(expired.statusCode, 200, expired.body);
    assert.equal(expired.json().item.trial_days_left, 0);

    const expiredLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: tenant.user.email, password, org_slug: slug },
    });
    assert.equal(expiredLogin.statusCode, 403, expiredLogin.body);
    assert.equal(expiredLogin.json().error, 'TRIAL_EXPIRED');

    const extended = await app.inject({
      method: 'PATCH',
      url: `/api/platform/tenants/${orgId}`,
      headers: adminHeaders,
      payload: {
        plan: 'trial',
        trial_ends_at: new Date(Date.now() + 14 * 86400000).toISOString(),
      },
    });
    assert.equal(extended.statusCode, 200, extended.body);
    const loginAgain = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: tenant.user.email, password, org_slug: slug },
    });
    assert.equal(loginAgain.statusCode, 200, '延长试用后应可重新登录');

    const invalidPlan = await app.inject({
      method: 'PATCH',
      url: `/api/platform/tenants/${orgId}`,
      headers: adminHeaders,
      payload: { plan: 'not-a-plan' },
    });
    assert.equal(invalidPlan.statusCode, 400, '非法套餐应在校验层拒绝');

    await query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
  });

  await check('租户账单：生成、模拟支付、手动确认、回调与订阅到期', async () => {
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@hengzhi.ai', password: 'demo1234', org_slug: 'hengzhi' },
    });
    const adminHeaders = { authorization: `Bearer ${adminLogin.json().token}` };

    const slug = `invoice-${stamp}`.slice(0, 32);
    const password = 'InvoicePass1';
    const email = `invoice-${stamp}@vendor.test`;
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        org_name: `账单支付供应商-${stamp}`,
        org_slug: slug,
        name: `账单支付管理员-${stamp}`,
        email,
        password,
      },
    });
    assert.equal(registered.statusCode, 201, registered.body);
    const tenant = registered.json();
    const tenantHeaders = { authorization: `Bearer ${tenant.token}` };
    const orgId = tenant.user.org_id;

    const checkout = await app.inject({
      method: 'POST',
      url: '/api/org/billing/checkout',
      headers: tenantHeaders,
      payload: { plan: 'pro', cycle: 'monthly' },
    });
    assert.equal(checkout.statusCode, 201, checkout.body);
    const invoice = checkout.json().item;
    assert.equal(invoice.status, 'pending');
    assert.equal(invoice.plan, 'pro');
    assert.equal(invoice.cycle, 'monthly');
    assert.equal(Number(invoice.amount), 2999);
    assert.equal(checkout.json().provider, 'mock');
    assert.equal(checkout.json().mock, true);

    const invoices = await app.inject({
      method: 'GET',
      url: '/api/org/billing/invoices',
      headers: tenantHeaders,
    });
    assert.equal(invoices.statusCode, 200);
    assert.ok(invoices.json().items.some((i: any) => i.id === invoice.id));

    const platformInvoices = await app.inject({
      method: 'GET',
      url: '/api/platform/invoices',
      headers: adminHeaders,
    });
    assert.equal(platformInvoices.statusCode, 200);
    assert.ok(
      platformInvoices.json().items.some((i: any) => i.id === invoice.id && i.org_slug === slug),
    );

    const paid = await app.inject({
      method: 'POST',
      url: `/api/org/billing/invoices/${invoice.id}/pay`,
      headers: tenantHeaders,
    });
    assert.equal(paid.statusCode, 200, paid.body);
    assert.equal(paid.json().item.status, 'paid');
    assert.equal(paid.json().billing.plan, 'pro');
    assert.ok(paid.json().billing.plan_expires_at, '支付后应有订阅到期日');

    const paidAgain = await app.inject({
      method: 'POST',
      url: `/api/org/billing/invoices/${invoice.id}/pay`,
      headers: tenantHeaders,
    });
    assert.equal(paidAgain.statusCode, 200);
    assert.equal(paidAgain.json().item.status, 'paid', '重复支付应幂等');

    const billing = await app.inject({
      method: 'GET',
      url: '/api/org/billing',
      headers: tenantHeaders,
    });
    assert.equal(billing.json().item.plan_status, 'active');
    assert.equal(billing.json().item.limits.clients, 50);

    const expired = await app.inject({
      method: 'PATCH',
      url: `/api/platform/tenants/${orgId}`,
      headers: adminHeaders,
      payload: { plan_expires_at: '2020-01-01T00:00:00.000Z' },
    });
    assert.equal(expired.statusCode, 200, expired.body);
    const expiredLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password, org_slug: slug },
    });
    assert.equal(expiredLogin.statusCode, 403, expiredLogin.body);
    assert.equal(expiredLogin.json().error, 'SUBSCRIPTION_EXPIRED');

    const extended = await app.inject({
      method: 'PATCH',
      url: `/api/platform/tenants/${orgId}`,
      headers: adminHeaders,
      payload: { plan_expires_at: new Date(Date.now() + 30 * 86400000).toISOString() },
    });
    assert.equal(extended.statusCode, 200, extended.body);
    const loginAgain = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password, org_slug: slug },
    });
    assert.equal(loginAgain.statusCode, 200, '续费后应可重新登录');

    // 平台手动确认收款
    const yearly = await app.inject({
      method: 'POST',
      url: '/api/org/billing/checkout',
      headers: tenantHeaders,
      payload: { cycle: 'yearly' },
    });
    assert.equal(yearly.statusCode, 201, yearly.body);
    const manualPaid = await app.inject({
      method: 'POST',
      url: `/api/platform/invoices/${yearly.json().item.id}/mark-paid`,
      headers: adminHeaders,
      payload: { external_id: 'bank-transfer-1' },
    });
    assert.equal(manualPaid.statusCode, 200, manualPaid.body);
    assert.equal(manualPaid.json().item.status, 'paid');
    assert.equal(manualPaid.json().item.provider, 'manual');

    // 作废
    const pending = await app.inject({
      method: 'POST',
      url: '/api/org/billing/checkout',
      headers: tenantHeaders,
      payload: { cycle: 'monthly' },
    });
    const voided = await app.inject({
      method: 'POST',
      url: `/api/platform/invoices/${pending.json().item.id}/void`,
      headers: adminHeaders,
    });
    assert.equal(voided.statusCode, 200, voided.body);
    assert.equal(voided.json().item.status, 'void');

    // 支付回调：签名校验 + 入账
    const callbackInvoice = await app.inject({
      method: 'POST',
      url: '/api/org/billing/checkout',
      headers: tenantHeaders,
      payload: { cycle: 'monthly' },
    });
    const callbackBody = {
      invoice_id: callbackInvoice.json().item.id,
      status: 'paid',
      external_id: 'gateway-1',
    };
    const signature = createHmac('sha256', 'test-billing-secret')
      .update(`${callbackBody.invoice_id}:${callbackBody.status}:${callbackBody.external_id}`)
      .digest('hex');

    const badCallback = await app.inject({
      method: 'POST',
      url: '/api/billing/callback',
      headers: { 'x-billing-signature': 'bad-signature' },
      payload: callbackBody,
    });
    assert.equal(badCallback.statusCode, 401);

    const callback = await app.inject({
      method: 'POST',
      url: '/api/billing/callback',
      headers: { 'x-billing-signature': signature },
      payload: callbackBody,
    });
    assert.equal(callback.statusCode, 200, callback.body);
    assert.equal(callback.json().item.status, 'paid');
    assert.equal(callback.json().item.provider, 'callback');

    await query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
  });

  await check('租户导出与删除：影响评估、权限与级联清理', async () => {
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@hengzhi.ai', password: 'demo1234' },
    });
    const adminToken = adminLogin.json().token;
    const adminHeaders = { authorization: `Bearer ${adminToken}` };

    const slug = `lifecycle-${stamp}`.slice(0, 32);
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        org_name: `生命周期租户-${stamp}`,
        org_slug: slug,
        name: `生命周期管理员-${stamp}`,
        email: `lifecycle-${stamp}@vendor.test`,
        password: 'LifecyclePass1',
      },
    });
    assert.equal(registered.statusCode, 201, registered.body);
    const tenant = registered.json();
    const tenantHeaders = { authorization: `Bearer ${tenant.token}` };
    const tenantId = tenant.user.org_id;

    const client = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: tenantHeaders,
      payload: { name: `生命周期客户-${stamp}`, industry: 'logistics' },
    });
    assert.equal(client.statusCode, 201, client.body);

    const impact = await app.inject({
      method: 'GET',
      url: `/api/platform/tenants/${tenantId}/impact`,
      headers: adminHeaders,
    });
    assert.equal(impact.statusCode, 200);
    assert.ok(impact.json().counts.users >= 1);
    assert.ok(impact.json().counts.clients >= 1);

    const exported = await app.inject({
      method: 'GET',
      url: `/api/platform/tenants/${tenantId}/export`,
      headers: adminHeaders,
    });
    assert.equal(exported.statusCode, 200);
    assert.match(String(exported.headers['content-type']), /application\/json/);
    const exportData = JSON.parse(exported.body);
    assert.equal(exportData.organization.slug, slug);
    assert.ok(exportData.users.some((u: any) => u.email === `lifecycle-${stamp}@vendor.test`));
    assert.ok(exportData.clients.some((c: any) => c.name === `生命周期客户-${stamp}`));

    const zhangLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'zhang@hengzhi.ai', password: 'demo1234' },
    });
    const denied = await app.inject({
      method: 'GET',
      url: `/api/platform/tenants/${tenantId}/export`,
      headers: { authorization: `Bearer ${zhangLogin.json().token}` },
    });
    assert.equal(denied.statusCode, 403, '非平台管理员不应导出租户');

    const noConfirm = await app.inject({
      method: 'DELETE',
      url: `/api/platform/tenants/${tenantId}`,
      headers: adminHeaders,
    });
    assert.equal(noConfirm.statusCode, 422);
    assert.equal(noConfirm.json().error, 'DELETE_CONFIRM_REQUIRED');

    const selfDelete = await app.inject({
      method: 'DELETE',
      url: `/api/platform/tenants/${adminLogin.json().user.org_id}?confirm=hengzhi`,
      headers: adminHeaders,
    });
    assert.equal(selfDelete.statusCode, 422, '平台管理员不应删除自己所属组织');

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/platform/tenants/${tenantId}?confirm=${encodeURIComponent(slug)}`,
      headers: adminHeaders,
    });
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.equal(deleted.json().deleted, slug);

    const remaining = await one(`SELECT id FROM organizations WHERE id = $1`, [tenantId]);
    assert.equal(remaining, null, '租户未删除');
    const tenantLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `lifecycle-${stamp}@vendor.test`, password: 'LifecyclePass1' },
    });
    assert.equal(tenantLogin.statusCode, 401, '删除后租户不应能登录');
  });

  await check('密码策略：复杂度、历史密码与管理员重置', async () => {
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@hengzhi.ai', password: 'demo1234' },
    });
    const adminToken = adminLogin.json().token;
    const adminHeaders = { authorization: `Bearer ${adminToken}` };
    const email = `policy-${stamp}@hengzhi.ai`;

    const weak = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: adminHeaders,
      payload: {
        name: `弱密码用户-${stamp}`,
        email,
        role: 'consultant',
        password: 'abc123',
      },
    });
    assert.equal(weak.statusCode, 422, '弱密码应被拒绝');
    assert.equal(weak.json().error, 'WEAK_PASSWORD');

    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: adminHeaders,
      payload: {
        name: `密码策略用户-${stamp}`,
        email,
        role: 'consultant',
        password: 'PolicyPass1',
      },
    });
    assert.equal(created.statusCode, 201, `创建用户失败：${created.body}`);
    const userId = created.json().item.id;

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: 'PolicyPass1' },
    });
    const token = login.json().token;
    const headers = { authorization: `Bearer ${token}` };

    const same = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers,
      payload: { old_password: 'PolicyPass1', new_password: 'PolicyPass1' },
    });
    assert.equal(same.statusCode, 422);
    assert.equal(same.json().error, 'SAME_PASSWORD');

    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers,
      payload: { old_password: 'PolicyPass1', new_password: 'PolicyPass2' },
    });
    assert.equal(changed.statusCode, 200, `改密失败：${changed.body}`);

    const reuseSelf = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers,
      payload: { old_password: 'PolicyPass2', new_password: 'PolicyPass1' },
    });
    assert.equal(reuseSelf.statusCode, 422, '历史密码应被拒绝');
    assert.equal(reuseSelf.json().error, 'PASSWORD_REUSED');

    const reuseAdmin = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${userId}/reset-password`,
      headers: adminHeaders,
      payload: { password: 'PolicyPass2' },
    });
    assert.equal(reuseAdmin.statusCode, 422, '管理员重置也不能复用历史密码');
    assert.equal(reuseAdmin.json().error, 'PASSWORD_REUSED');

    await query(`DELETE FROM users WHERE id = $1`, [userId]);
  });

  await check('请求 ID：响应头透传、错误体携带、审计日志关联', async () => {
    const rid = 'test-trace-20261101';
    const traced = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-request-id': rid },
    });
    assert.equal(traced.statusCode, 200);
    assert.equal(traced.headers['x-request-id'], rid, '响应头未透传 x-request-id');

    const auto = await app.inject({ method: 'GET', url: '/api/health' });
    assert.match(
      String(auto.headers['x-request-id']),
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      '未生成 UUID requestId',
    );

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/benchmarks',
      headers: { 'x-request-id': rid },
      payload: {},
    });
    assert.equal(invalid.statusCode, 400, `非法标杆应 400，实际 ${invalid.statusCode}`);
    assert.equal(invalid.json().requestId, rid, '错误响应体未携带 requestId');

    // 审计日志是 onResponse 异步写入，等一小会儿再查
    await new Promise((resolve) => setTimeout(resolve, 250));
    const audit = await one<{ request_id: string }>(
      `SELECT request_id FROM audit_logs WHERE request_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [rid],
    );
    assert.ok(audit, '审计日志没有记录 request_id');
    assert.equal(audit.request_id, rid);
  });

  await check('分页：total / limit / offset 与上限校验', async () => {
    const first = ok(
      await req('GET', '/api/engagements?limit=1&offset=0'),
      200,
      '项目列表第一页',
    );
    assert.equal(first.limit, 1);
    assert.equal(first.offset, 0);
    assert.equal(first.items.length, 1);
    assert.ok(first.total >= 2, `项目总数 ${first.total}`);

    const second = ok(
      await req('GET', '/api/engagements?limit=1&offset=1'),
      200,
      '项目列表第二页',
    );
    assert.equal(second.items.length, 1);
    assert.notEqual(second.items[0].id, first.items[0].id, '分页未生效，两页返回同一条');

    const tooLarge = await req('GET', '/api/engagements?limit=501');
    assert.equal(tooLarge.status, 400, 'limit 超过 500 应 400');
    assert.equal(tooLarge.body.error, 'VALIDATION_ERROR');

    const pains = ok(
      await req('GET', `/api/engagements/${engagementId}/pain-points?limit=2&offset=0`),
      200,
      '痛点分页',
    );
    assert.equal(pains.items.length, 2);
    assert.equal(pains.limit, 2);
    assert.ok(pains.total >= 2, `痛点总数 ${pains.total}`);

    const knowledge = ok(
      await req('GET', '/api/knowledge?limit=2&offset=0'),
      200,
      '知识库分页',
    );
    assert.equal(knowledge.items.length, 2);
    assert.ok(knowledge.total >= 5, `知识总数 ${knowledge.total}`);

    const audits = ok(
      await req('GET', '/api/audit-logs?limit=1&offset=0'),
      200,
      '审计日志分页',
    );
    assert.equal(audits.items.length, 1);
    assert.ok(audits.total >= 1, `审计总数 ${audits.total}`);
  });

  await check('列表搜索：项目/客户/痛点/机会点/交付物/审计', async () => {
    const projects = ok(
      await req('GET', `/api/engagements?q=${encodeURIComponent('宏远')}`),
      200,
      '项目搜索',
    );
    assert.ok(projects.total >= 1, '项目搜索未命中 seed 项目');
    const noProject = ok(
      await req('GET', `/api/engagements?q=${encodeURIComponent('不存在的项目-xyz')}`),
      200,
      '项目搜索空结果',
    );
    assert.equal(noProject.total, 0);

    const clients = ok(
      await req('GET', `/api/clients?q=${encodeURIComponent('回归测试客户')}`),
      200,
      '客户搜索',
    );
    assert.ok(clients.total >= 1, '客户搜索未命中测试客户');

    const pains = ok(
      await req('GET', `/api/engagements/${engagementId}/pain-points?q=${encodeURIComponent('P-00')}`),
      200,
      '痛点搜索',
    );
    assert.ok(pains.total >= 1, '痛点搜索未命中编号');
    assert.ok(
      pains.items.every((p: any) => /P-00/.test(`${p.code} ${p.description}`)),
      '痛点搜索结果包含不匹配记录',
    );

    const opps = ok(
      await req('GET', `/api/engagements/${engagementId}/opportunities?q=${encodeURIComponent('订单')}`),
      200,
      '机会点搜索',
    );
    assert.ok(opps.total >= 1, '机会点搜索未命中');

    const docs = ok(
      await req('GET', `/api/engagements/${engagementId}/deliverables?q=poc_report`),
      200,
      '交付物搜索',
    );
    assert.ok(docs.total >= 1, '交付物搜索未命中类型');
    assert.ok(docs.items.every((d: any) => /poc_report/.test(`${d.type} ${d.title}`)));

    const audit = ok(
      await req('GET', '/api/audit-logs?q=POST'),
      200,
      '审计日志搜索',
    );
    assert.ok(audit.total >= 1, '审计日志搜索未命中写操作');
  });

  await check('项目成员：非成员拒绝、viewer 只读、列表过滤与最后负责人保护', async () => {
    const login = async (email: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password: 'demo1234' },
      });
      assert.equal(res.statusCode, 200, `登录失败：${email}`);
      const body = res.json();
      return { token: body.token as string, userId: body.user.id as string };
    };
    const wang = await login('wang@hengzhi.ai');
    const zhang = await login('zhang@hengzhi.ai');
    const liu = await login('liu@hengzhi.ai');
    const headers = (token: string) => ({ authorization: `Bearer ${token}` });

    // 未配置成员时，组织内成员可访问
    const before = await app.inject({
      method: 'GET',
      url: `/api/engagements/${engagementId}`,
      headers: headers(zhang.token),
    });
    assert.equal(before.statusCode, 200, '未配置成员的项目应对组织内开放');

    // 项目经理先把自己设为负责人，再添加 viewer / member
    const wangMember = await app.inject({
      method: 'POST',
      url: `/api/engagements/${engagementId}/members`,
      headers: headers(wang.token),
      payload: { user_id: wang.userId, role: 'manager' },
    });
    assert.equal(wangMember.statusCode, 201, `添加负责人失败：${wangMember.body}`);

    const zhangMember = await app.inject({
      method: 'POST',
      url: `/api/engagements/${engagementId}/members`,
      headers: headers(wang.token),
      payload: { user_id: zhang.userId, role: 'viewer' },
    });
    assert.equal(zhangMember.statusCode, 201, `添加只读成员失败：${zhangMember.body}`);
    const zhangMemberId = zhangMember.json().item.id;

    const liuMember = await app.inject({
      method: 'POST',
      url: `/api/engagements/${engagementId}/members`,
      headers: headers(wang.token),
      payload: { user_id: liu.userId, role: 'member' },
    });
    assert.equal(liuMember.statusCode, 201, `添加成员失败：${liuMember.body}`);

    const viewerRead = await app.inject({
      method: 'GET',
      url: `/api/engagements/${engagementId}`,
      headers: headers(zhang.token),
    });
    assert.equal(viewerRead.statusCode, 200, '只读成员应能读项目');

    const viewerWrite = await app.inject({
      method: 'POST',
      url: `/api/engagements/${engagementId}/pain-points`,
      headers: headers(zhang.token),
      payload: {
        description: '只读成员不应能写痛点',
        source_type: 'interview',
        source_ref: '权限回归',
      },
    });
    assert.equal(viewerWrite.statusCode, 403, 'viewer 写操作应 403');
    assert.equal(viewerWrite.json().error, 'PROJECT_READONLY');

    const memberWrite = await app.inject({
      method: 'POST',
      url: `/api/engagements/${engagementId}/pain-points`,
      headers: headers(liu.token),
      payload: {
        description: '项目成员可以录入痛点',
        source_type: 'interview',
        source_ref: '成员权限回归',
      },
    });
    assert.equal(memberWrite.statusCode, 201, `member 应能写：${memberWrite.body}`);

    const lastManager = await app.inject({
      method: 'DELETE',
      url: `/api/engagement-members/${wangMember.json().item.id}`,
      headers: headers(wang.token),
    });
    assert.equal(lastManager.statusCode, 422, '最后一名负责人不应被删除');
    assert.equal(lastManager.json().error, 'LAST_MANAGER');

    // 移除 viewer 后，该用户不再是成员
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/engagement-members/${zhangMemberId}`,
      headers: headers(wang.token),
    });
    assert.equal(removed.statusCode, 200);

    const afterRemove = await app.inject({
      method: 'GET',
      url: `/api/engagements/${engagementId}`,
      headers: headers(zhang.token),
    });
    assert.equal(afterRemove.statusCode, 403, '非成员访问应 403');
    assert.equal(afterRemove.json().error, 'PROJECT_FORBIDDEN');

    const zhangList = await app.inject({
      method: 'GET',
      url: '/api/engagements?limit=100',
      headers: headers(zhang.token),
    });
    assert.equal(zhangList.statusCode, 200);
    assert.ok(
      !zhangList.json().items.some((e: any) => e.id === engagementId),
      '非成员的项目不应出现在列表中',
    );

    const wangList = await app.inject({
      method: 'GET',
      url: '/api/engagements?limit=100',
      headers: headers(wang.token),
    });
    assert.ok(
      wangList.json().items.some((e: any) => e.id === engagementId),
      '项目负责人应能在列表中看到项目',
    );
  });

  await check('筛选视图：全员/角色/指定用户共享与仅创建者可删', async () => {
    const login = async (email: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password: 'demo1234' },
      });
      assert.equal(res.statusCode, 200, `登录失败：${email}`);
      return res.json().token as string;
    };
    const adminToken = await login('admin@hengzhi.ai');
    const zhangToken = await login('zhang@hengzhi.ai');
    const wangToken = await login('wang@hengzhi.ai');

    const users = await query<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE email = ANY($1::text[])`,
      [['zhang@hengzhi.ai', 'wang@hengzhi.ai']],
    );
    const zhangId = users.find((u) => u.email === 'zhang@hengzhi.ai')!.id;

    const eng = await one<{ org_id: string }>(
      `SELECT org_id FROM engagements WHERE id = $1`,
      [engagementId],
    );
    const review = await one<{ id: string }>(
      `INSERT INTO copilot_reconcile_reviews
         (idempotency_key, org_id, engagement_id, kind, document_id, status, source)
       VALUES ($1,$2,$3,'statement',$4,'confirmed','verify-write')
       RETURNING id`,
      [`verify-fv-${stamp}`, eng!.org_id, engagementId, `FV-${stamp}`],
    );
    const reviewId = review!.id;
    const allViewIds: string[] = [];

    const call = (
      token: string,
      method: any,
      url: string,
      payload?: any,
    ) =>
      app.inject({
        method,
        url,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload === undefined
            ? {}
            : { 'content-type': 'application/json' }),
        },
        payload: payload === undefined ? undefined : JSON.stringify(payload),
      });

    const createView = async (payload: Record<string, unknown>) => {
      const res = await call(
        adminToken,
        'POST',
        `/api/copilot-reconcile-reviews/${reviewId}/batch-filter-views`,
        payload,
      );
      assert.equal(res.statusCode, 201, `创建视图失败：${res.body}`);
      const item = res.json().item;
      if (!allViewIds.includes(item.id)) allViewIds.push(item.id);
      return item;
    };

    const listViews = async (token: string) => {
      const res = await call(
        token,
        'GET',
        `/api/copilot-reconcile-reviews/${reviewId}/batch-filter-views`,
      );
      assert.equal(res.statusCode, 200, `查询视图失败：${res.body}`);
      return res.json().items as any[];
    };

    const outsiderEmail = `verify-fv-outsider-${stamp}@example.com`;

    try {
      const privateView = await createView({
        name: '私密视图',
        status: 'completed',
      });
      assert.equal(privateView.shared, false, '默认应为不共享');
      assert.ok(
        !(await listViews(zhangToken)).some((v) => v.id === privateView.id),
        '未共享视图不应被他人看到',
      );

      const shared = await createView({ name: '私密视图', shared: true });
      assert.equal(shared.id, privateView.id, '同名保存应复用同一视图');
      const seenByZhang = (await listViews(zhangToken)).find(
        (v) => v.id === privateView.id,
      );
      assert.ok(seenByZhang, '全员共享后顾问应能看到');
      assert.equal(seenByZhang.is_owner, false, '共享视图不应标记为他人所有');

      const roleView = await createView({ name: '角色视图', shared_role: 'pm' });
      assert.ok(
        !(await listViews(zhangToken)).some((v) => v.id === roleView.id),
        '角色外用户不应看到角色共享视图',
      );
      assert.ok(
        (await listViews(wangToken)).some((v) => v.id === roleView.id),
        '同角色用户应看到角色共享视图',
      );

      const targeted = await createView({
        name: '指定视图',
        shared_user_ids: [zhangId],
      });
      assert.ok(
        (await listViews(zhangToken)).some((v) => v.id === targeted.id),
        '被指定用户应看到视图',
      );
      assert.ok(
        !(await listViews(wangToken)).some((v) => v.id === targeted.id),
        '未被指定用户不应看到视图',
      );

      const linkedNotification = await one<{ link: string }>(
        `SELECT link FROM user_notifications
          WHERE ref_type = 'copilot_batch_filter_view'
            AND ref_id = $1 AND user_id = $2
          ORDER BY created_at DESC LIMIT 1`,
        [targeted.id, zhangId],
      );
      assert.equal(
        linkedNotification?.link,
        `#/engagements/${engagementId}?review=${reviewId}&view=${targeted.id}`,
        '共享通知应直达复核并套用视图',
      );

      const resaved = await createView({ name: '指定视图', status: 'failed' });
      assert.equal(resaved.id, targeted.id, '重新保存应复用同一视图');
      assert.deepEqual(
        resaved.shared_user_ids,
        [zhangId],
        '未传 shared_user_ids 时应保留原共享对象',
      );

      const outsider = await one<{ id: string }>(
        `INSERT INTO users (org_id, name, email, password_hash)
         VALUES ($1,'外部组织用户',$2,$3) RETURNING id`,
        [isolatedOrgId, outsiderEmail, hashPassword('demo1234')],
      );
      const crossOrg = await call(
        adminToken,
        'POST',
        `/api/copilot-reconcile-reviews/${reviewId}/batch-filter-views`,
        { name: '跨组织视图', shared_user_ids: [outsider!.id] },
      );
      assert.equal(crossOrg.statusCode, 422, '跨组织共享应被拒绝');
      assert.equal(crossOrg.json().error, 'INVALID_SHARED_USERS');

      const deleteAsZhang = await call(
        zhangToken,
        'DELETE',
        `/api/copilot-batch-filter-views/${targeted.id}`,
      );
      assert.equal(deleteAsZhang.statusCode, 404, '非创建者不能删除视图');

      const deleteAsAdmin = await call(
        adminToken,
        'DELETE',
        `/api/copilot-batch-filter-views/${targeted.id}`,
      );
      assert.equal(deleteAsAdmin.statusCode, 200, '创建者应能删除视图');
      assert.ok(
        !(await listViews(zhangToken)).some((v) => v.id === targeted.id),
        '删除后不应再出现在列表',
      );
    } finally {
      if (allViewIds.length) {
        await query(
          `DELETE FROM user_notifications
            WHERE ref_type = 'copilot_batch_filter_view'
              AND ref_id = ANY($1::uuid[])`,
          [allViewIds],
        );
      }
      await query(
        `DELETE FROM audit_logs
          WHERE object_type = 'copilot_batch_filter_view'
            AND detail->>'review_id' = $1`,
        [reviewId],
      );
      await query(`DELETE FROM copilot_batch_filter_views WHERE review_id = $1`, [
        reviewId,
      ]);
      await query(`DELETE FROM copilot_reconcile_reviews WHERE id = $1`, [reviewId]);
      await query(`DELETE FROM users WHERE email = $1`, [outsiderEmail]);
    }
  });

  await check('通知：只看自己的、回收站流程与审计权限', async () => {
    const login = async (email: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password: 'demo1234' },
      });
      assert.equal(res.statusCode, 200, `登录失败：${email}`);
      return res.json().token as string;
    };
    const adminToken = await login('admin@hengzhi.ai');
    const zhangToken = await login('zhang@hengzhi.ai');
    const wangToken = await login('wang@hengzhi.ai');

    const users = await query<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE email = ANY($1::text[])`,
      [['zhang@hengzhi.ai', 'wang@hengzhi.ai']],
    );
    const zhangId = users.find((u) => u.email === 'zhang@hengzhi.ai')!.id;
    const wangId = users.find((u) => u.email === 'wang@hengzhi.ai')!.id;
    const eng = await one<{ org_id: string }>(
      `SELECT org_id FROM engagements WHERE id = $1`,
      [engagementId],
    );
    const orgId = eng!.org_id;

    const createNotification = async (
      userId: string,
      kind: string,
      title: string,
      opts: { read?: boolean; deleted?: boolean } = {},
    ) =>
      (
        await one<{ id: string }>(
          `INSERT INTO user_notifications
             (org_id, user_id, kind, title, body, read_at, deleted_at)
           VALUES ($1,$2,$3,$4,$5,
                   CASE WHEN $6::boolean THEN now() ELSE NULL END,
                   CASE WHEN $7::boolean THEN now() ELSE NULL END)
           RETURNING id`,
          [orgId, userId, kind, title, '回归测试通知', opts.read ?? false, opts.deleted ?? false],
        )
      )!.id;

    const n1 = await createNotification(zhangId, 'verify_notice', '通知一');
    const n2 = await createNotification(zhangId, 'verify_notice', '通知二', { read: true });
    const n3 = await createNotification(zhangId, 'verify_other', '通知三');
    const w1 = await createNotification(wangId, 'verify_notice', '王通知');
    const createdIds = [n1, n2, n3, w1];

    const call = (token: string, method: any, url: string, payload?: any) =>
      app.inject({
        method,
        url,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        payload: payload === undefined ? undefined : JSON.stringify(payload),
      });

    const list = async (token: string, qs = '') => {
      const res = await call(token, 'GET', `/api/notifications${qs}`);
      assert.equal(res.statusCode, 200, `查询通知失败：${res.body}`);
      return res.json();
    };
    const unread = async (token: string) => {
      const res = await call(token, 'GET', '/api/notifications/unread-count');
      assert.equal(res.statusCode, 200);
      return res.json().count as number;
    };

    try {
      assert.equal(await unread(zhangToken), 2, '张应只有自己的 2 条未读');
      assert.equal(await unread(wangToken), 1, '王应只有自己的 1 条未读');

      const zhangList = await list(zhangToken, '?limit=100');
      assert.equal(zhangList.total, 3, '张应只看到自己的 3 条');
      assert.ok(
        !zhangList.items.some((n: any) => n.id === w1),
        '不应看到他人的通知',
      );

      const unreadOnly = await list(zhangToken, '?unread=1');
      assert.equal(unreadOnly.total, 2, '未读筛选应只返回 2 条');

      const kindFiltered = await list(zhangToken, '?kind=verify_notice');
      assert.equal(kindFiltered.total, 2, '类型筛选应只返回 2 条');

      const badRange = await call(zhangToken, 'GET', '/api/notifications?from=2026-12-31&to=2026-01-01');
      assert.equal(badRange.statusCode, 400);
      assert.equal(badRange.json().error, 'INVALID_DATE_RANGE');

      const readOther = await call(zhangToken, 'POST', `/api/notifications/${w1}/read`);
      assert.equal(readOther.statusCode, 404, '不能标记他人通知已读');

      const deleteOther = await call(zhangToken, 'POST', '/api/notifications/delete', { ids: [w1] });
      assert.equal(deleteOther.statusCode, 200);
      assert.equal(deleteOther.json().deleted, 0, '不能删除他人通知');
      assert.equal(await unread(wangToken), 1, '他人未读数不应变化');

      const trashFlow = await call(wangToken, 'POST', '/api/notifications/delete', { ids: [w1] });
      assert.equal(trashFlow.json().deleted, 1);
      const wangTrash = await list(wangToken, '?trash=1');
      assert.ok(
        wangTrash.items.some((n: any) => n.id === w1),
        '软删除后应出现在回收站',
      );
      const wangMain = await list(wangToken);
      assert.ok(!wangMain.items.some((n: any) => n.id === w1), '回收站中的通知不应出现在主列表');

      const restored = await call(wangToken, 'POST', '/api/notifications/restore', { ids: [w1] });
      assert.equal(restored.json().restored, 1);
      assert.equal(await unread(wangToken), 1, '恢复后未读数应回到 1');

      await call(wangToken, 'POST', '/api/notifications/delete', { ids: [w1] });
      const purged = await call(wangToken, 'POST', '/api/notifications/purge', { ids: [w1] });
      assert.equal(purged.json().deleted, 1, '回收站通知应能彻底删除');
      const wangAfterPurge = await list(wangToken);
      assert.equal(wangAfterPurge.total, 0, '彻底删除后列表应为空');

      const readAll = await call(zhangToken, 'POST', '/api/notifications/read-all');
      assert.equal(readAll.json().updated, 2, '一键已读只影响自己的未读');
      assert.equal(await unread(zhangToken), 0);

      const deleteUnread = await call(zhangToken, 'POST', '/api/notifications/delete', {
        all: true,
        unread: true,
      });
      assert.equal(deleteUnread.json().deleted, 0, '没有未读时按筛选删除应为 0');
      const zhangAfter = await list(zhangToken);
      assert.equal(zhangAfter.total, 3, '已读通知不应被未读筛选删除');

      const bulkIds = [
        await createNotification(zhangId, 'verify_bulk', '批量通知一'),
        await createNotification(zhangId, 'verify_bulk', '批量通知二'),
        await createNotification(zhangId, 'verify_bulk', '批量通知三', {
          read: true,
        }),
      ];
      createdIds.push(...bulkIds);

      const page1 = await list(zhangToken, '?limit=2&offset=0');
      assert.equal(page1.total, 6, '分页 total 应包含新增通知');
      assert.equal(page1.items.length, 2, 'limit 应生效');
      const page3 = await list(zhangToken, '?limit=2&offset=4');
      assert.equal(page3.items.length, 2);
      assert.equal(page3.total, 6, '跨页 total 应一致');

      const bulkDelete = await call(zhangToken, 'POST', '/api/notifications/delete', {
        all: true,
        kind: 'verify_bulk',
        unread: true,
      });
      assert.equal(
        bulkDelete.json().deleted,
        2,
        '按类型 + 未读批量删除应只命中 2 条',
      );
      const bulkLeft = await list(zhangToken, '?kind=verify_bulk');
      assert.equal(bulkLeft.total, 1, '同类型已读通知应保留');

      const tooMany = await call(zhangToken, 'POST', '/api/notifications/delete', {
        ids: Array.from(
          { length: 101 },
          (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        ),
      });
      assert.equal(tooMany.statusCode, 400, '超过 100 条 ID 应拒绝');

      const readIds = [
        await createNotification(zhangId, 'verify_read', '批量已读一'),
        await createNotification(zhangId, 'verify_read', '批量已读二'),
      ];
      createdIds.push(...readIds);
      const readOne = await call(zhangToken, 'POST', '/api/notifications/read', {
        ids: [readIds[0]],
      });
      assert.equal(readOne.statusCode, 200);
      assert.equal(readOne.json().updated, 1, '按 ID 标为已读只命中未读');
      const readAgain = await call(zhangToken, 'POST', '/api/notifications/read', {
        ids: [readIds[0]],
      });
      assert.equal(readAgain.json().updated, 0, '重复标为已读应为 0');
      const readByFilter = await call(
        zhangToken,
        'POST',
        '/api/notifications/read',
        { all: true, kind: 'verify_read' },
      );
      assert.equal(
        readByFilter.json().updated,
        1,
        '按类型批量已读应命中剩余 1 条',
      );
      const readTooMany = await call(zhangToken, 'POST', '/api/notifications/read', {
        ids: Array.from(
          { length: 101 },
          (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        ),
      });
      assert.equal(readTooMany.statusCode, 400, '批量已读超过 100 条应拒绝');

      const auditForbidden = await call(zhangToken, 'GET', '/api/notification-audits');
      assert.equal(auditForbidden.statusCode, 403, '顾问不应查看通知审计');
      const auditForAdmin = await call(adminToken, 'GET', '/api/notification-audits?limit=5');
      assert.equal(auditForAdmin.statusCode, 200, '管理员应能查看通知审计');
    } finally {
      await query(`DELETE FROM user_notifications WHERE id = ANY($1::uuid[])`, [
        createdIds,
      ]);
      await query(
        `DELETE FROM audit_logs
          WHERE object_type = 'user_notification'
            AND (object_id = ANY($1::uuid[])
              OR EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(detail->'ids') x
                 WHERE x = ANY($1::text[])
              ))`,
        [createdIds],
      );
    }
  });

  await check('对账复核 Word：含差异依据并写导出审计', async () => {
    const login = async (email: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password: 'demo1234' },
      });
      assert.equal(res.statusCode, 200, `登录失败：${email}`);
      return res.json().token as string;
    };
    const token = await login('zhang@hengzhi.ai');
    const adminToken = await login('admin@hengzhi.ai');
    const eng = await one<{ org_id: string }>(
      `SELECT org_id FROM engagements WHERE id = $1`,
      [engagementId],
    );
    const differences = [
      {
        difference_id: `WORD-${stamp}-1`,
        type: 'amount_mismatch',
        waybill_no: 'HY-WORD-1',
        statement_amount: 1200,
        system_amount: 1000,
        delta: 200,
        source: 'llm+rule',
        confidence: 0.6,
        evidence: ['对账单第 1 行', '系统金额 1000.0'],
        possible_causes: ['附加费未计入'],
        suggested_action: '核对运单费用明细',
      },
    ];
    const review = await one<{ id: string }>(
      `INSERT INTO copilot_reconcile_reviews
         (idempotency_key, org_id, engagement_id, kind, document_id, status,
          source, document, differences, decisions)
       VALUES ($1,$2,$3,'statement',$4,'confirmed','verify-write',$5::jsonb,$6::jsonb,'[]'::jsonb)
       RETURNING id`,
      [
        `verify-word-${stamp}`,
        eng!.org_id,
        engagementId,
        `WORD-${stamp}`,
        JSON.stringify({
          statement_no: `WORD-${stamp}`,
          customer_name: '回归测试客户',
          period_start: '2026-09-01',
          period_end: '2026-09-30',
          total_amount: 1200,
        }),
        JSON.stringify(differences),
      ],
    );
    const reviewId = review!.id;

    try {
      const md = await app.inject({
        method: 'GET',
        url: `/api/copilot-reconcile-reviews/${reviewId}/document`,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(md.statusCode, 200, `Markdown 生成失败：${md.body}`);
      assert.ok(md.body.includes('差异依据'), 'Markdown 应包含差异依据章节');
      assert.ok(md.body.includes('模型 + 规则'), 'Markdown 应标注解释来源');
      assert.ok(md.body.includes('对账单第 1 行'), 'Markdown 应包含证据');

      const docx = await app.inject({
        method: 'GET',
        url: `/api/copilot-reconcile-reviews/${reviewId}/document.docx`,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(docx.statusCode, 200, `Word 生成失败：${docx.body}`);
      assert.equal(
        docx.headers['content-type'],
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
      assert.equal(
        docx.rawPayload.slice(0, 2).toString('utf8'),
        'PK',
        'Word 应为 zip 容器',
      );
      assert.ok(docx.rawPayload.length > 2000, 'Word 内容不应为空');

      const audit = await one<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_logs
          WHERE action = 'EXPORT copilot-reconcile-document' AND object_id = $1`,
        [reviewId],
      );
      assert.equal(Number(audit!.count), 1, '应写一条 Word 导出审计');

      const generate = async () =>
        app.inject({
          method: 'POST',
          url: `/api/copilot-reconcile-reviews/${reviewId}/documents`,
          headers: { authorization: `Bearer ${token}` },
        });
      const first = await generate();
      assert.equal(first.statusCode, 201, `生成交付物失败：${first.body}`);
      const firstItem = first.json().item;
      assert.equal(firstItem.type, 'data_report');
      assert.equal(firstItem.version, 1);
      assert.equal(firstItem.status, 'draft');
      assert.ok(firstItem.title.includes('对账复核报告'), '标题应含报告名');

      const listDocuments = async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/copilot-reconcile-reviews/${reviewId}/documents`,
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(res.statusCode, 200, `查询交付物失败：${res.body}`);
        return res.json().items as any[];
      };
      const freshDocs = await listDocuments();
      assert.equal(freshDocs.length, 1);
      assert.equal(freshDocs[0].is_stale, false, '刚生成的交付物不应过期');

      const decisionChange = await app.inject({
        method: 'PUT',
        url: `/api/copilot-reconcile-reviews/${reviewId}/decisions`,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        payload: JSON.stringify({
          difference_id: `WORD-${stamp}-1`,
          decision: '忽略',
          note: '回归测试',
        }),
      });
      assert.equal(decisionChange.statusCode, 200, `决策变更失败：${decisionChange.body}`);
      const staleDocs = await listDocuments();
      assert.equal(staleDocs[0].is_stale, true, '复核变更后交付物应标记过期');

      const staleNoticeCount = async () =>
        Number(
          (
            await one<{ count: string }>(
              `SELECT count(*)::text AS count FROM user_notifications
                WHERE user_id = (SELECT id FROM users WHERE email = 'admin@hengzhi.ai')
                  AND kind = 'copilot_reconcile_report_stale'
                  AND ref_id = $1
                  AND read_at IS NULL
                  AND deleted_at IS NULL`,
              [reviewId],
            )
          )!.count,
        );
      assert.equal(await staleNoticeCount(), 1, '报告过期应通知管理员');

      await app.inject({
        method: 'PUT',
        url: `/api/copilot-reconcile-reviews/${reviewId}/decisions`,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        payload: JSON.stringify({
          difference_id: `WORD-${stamp}-1`,
          decision: '待确认',
          note: '第二次变更',
        }),
      });
      assert.equal(await staleNoticeCount(), 1, '未读过期提醒不应重复堆积');

      const listedDeliverables = await app.inject({
        method: 'GET',
        url: `/api/engagements/${engagementId}/deliverables?limit=50`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      assert.equal(listedDeliverables.statusCode, 200);
      const listedReport = (
        listedDeliverables.json().items as any[]
      ).find((d) => d.id === firstItem.id);
      assert.ok(listedReport, '交付物列表应包含复核报告');
      assert.equal(listedReport.review_id, reviewId, '列表应返回复核 ID');
      assert.equal(listedReport.is_stale, true, '列表应标记过期');

      const approveStale = await app.inject({
        method: 'PATCH',
        url: `/api/deliverables/${firstItem.id}/status`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ status: 'approved' }),
      });
      assert.equal(approveStale.statusCode, 409, '过期报告不应允许审批');
      assert.equal(approveStale.json().error, 'DELIVERABLE_STALE');

      const second = await generate();
      assert.equal(second.statusCode, 201);
      assert.equal(second.json().item.version, 2, '再次生成应递增版本');
      const refreshedDocs = await listDocuments();
      assert.equal(refreshedDocs[0].version, 2);
      assert.equal(refreshedDocs[0].is_stale, false, '重新生成后应恢复最新');

      const approveFresh = await app.inject({
        method: 'PATCH',
        url: `/api/deliverables/${second.json().item.id}/status`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ status: 'approved' }),
      });
      assert.equal(approveFresh.statusCode, 200, '最新报告应允许审批');
      assert.equal(approveFresh.json().item.status, 'approved');

      const stored = await one<{ markdown: string }>(
        `SELECT content->>'markdown' AS markdown FROM deliverables WHERE id = $1`,
        [firstItem.id],
      );
      assert.ok(stored?.markdown.includes('差异依据'), '交付物内容应含差异依据');
      assert.ok(stored?.markdown.includes('模型 + 规则'), '交付物内容应标注来源');

      const generateAudit = await one<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_logs
          WHERE action = 'GENERATE copilot-reconcile-document' AND object_id = $1`,
        [reviewId],
      );
      assert.equal(Number(generateAudit!.count), 2, '每次生成都应写审计');
    } finally {
      await query(
        `DELETE FROM user_notifications
          WHERE kind = 'copilot_reconcile_report_stale' AND ref_id = $1`,
        [reviewId],
      );
      await query(
        `DELETE FROM deliverables WHERE generated_from->>'reviewId' = $1`,
        [reviewId],
      );
      await query(`DELETE FROM audit_logs WHERE object_id = $1 AND object_type = 'copilot_reconcile_review'`, [
        reviewId,
      ]);
      await query(`DELETE FROM copilot_reconcile_reviews WHERE id = $1`, [reviewId]);
    }
  });

  await check('对账决策：平台可改、覆盖保留备注与校验', async () => {
    const login = async (email: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password: 'demo1234' },
      });
      assert.equal(res.statusCode, 200, `登录失败：${email}`);
      return res.json().token as string;
    };
    const token = await login('zhang@hengzhi.ai');
    const adminToken = await login('admin@hengzhi.ai');
    const authHeaders = { authorization: `Bearer ${token}` };
    const eng = await one<{ org_id: string }>(
      `SELECT org_id FROM engagements WHERE id = $1`,
      [engagementId],
    );
    const differenceId = `DECIDE-${stamp}-1`;
    const secondDifferenceId = `DECIDE-${stamp}-2`;
    const review = await one<{ id: string }>(
      `INSERT INTO copilot_reconcile_reviews
         (idempotency_key, org_id, engagement_id, kind, document_id, status,
          source, differences, decisions)
       VALUES ($1,$2,$3,'statement',$4,'confirmed','verify-write',$5::jsonb,'[]'::jsonb)
       RETURNING id`,
      [
        `verify-decide-${stamp}`,
        eng!.org_id,
        engagementId,
        `DECIDE-${stamp}`,
        JSON.stringify([
          {
            difference_id: differenceId,
            type: 'amount_mismatch',
            waybill_no: 'HY-DECIDE-1',
            delta: 10,
            source: 'rule',
          },
          {
            difference_id: secondDifferenceId,
            type: 'rounding',
            waybill_no: 'HY-DECIDE-2',
            delta: 0.5,
            source: 'rule',
          },
        ]),
      ],
    );
    const reviewId = review!.id;

    const decide = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'PUT',
        url: `/api/copilot-reconcile-reviews/${reviewId}/decisions`,
        headers: { ...authHeaders, 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });

    try {
      const ignored = await decide({
        difference_id: differenceId,
        decision: '忽略',
        note: '重复计费，已确认',
      });
      assert.equal(ignored.statusCode, 200, `决策保存失败：${ignored.body}`);
      assert.equal(ignored.json().decisions.length, 1);
      const first = ignored.json().decisions[0];
      assert.equal(first.decision, '忽略');
      assert.equal(first.note, '重复计费，已确认');
      assert.equal(first.source, 'platform');
      assert.ok(first.decided_by, '应记录决策人');

      const accepted = await decide({
        difference_id: differenceId,
        decision: '采纳',
      });
      assert.equal(accepted.statusCode, 200);
      assert.equal(accepted.json().decisions.length, 1, '同一差异不应重复追加');
      assert.equal(accepted.json().decisions[0].decision, '采纳');
      assert.equal(
        accepted.json().decisions[0].note,
        '重复计费，已确认',
        '未传备注时应保留原备注',
      );

      const batch = await app.inject({
        method: 'POST',
        url: `/api/copilot-reconcile-reviews/${reviewId}/decisions/batch`,
        headers: { ...authHeaders, 'content-type': 'application/json' },
        payload: JSON.stringify({
          difference_ids: [differenceId, secondDifferenceId],
          decision: '待确认',
        }),
      });
      assert.equal(batch.statusCode, 200, `批量决策失败：${batch.body}`);
      assert.equal(batch.json().updated, 2);
      assert.equal(batch.json().decisions.length, 2);
      assert.ok(
        batch.json().decisions.every((d: any) => d.decision === '待确认'),
        '批量决策应覆盖选中差异',
      );
      assert.equal(
        batch.json().decisions[0].note,
        '重复计费，已确认',
        '批量决策未传备注时应保留原备注',
      );

      const batchInvalid = await app.inject({
        method: 'POST',
        url: `/api/copilot-reconcile-reviews/${reviewId}/decisions/batch`,
        headers: { ...authHeaders, 'content-type': 'application/json' },
        payload: JSON.stringify({
          difference_ids: [differenceId, 'NOT-EXIST'],
          decision: '采纳',
        }),
      });
      assert.equal(batchInvalid.statusCode, 422);
      assert.equal(batchInvalid.json().error, 'DIFFERENCE_NOT_FOUND');

      const detail = await app.inject({
        method: 'GET',
        url: `/api/copilot-reconcile-reviews/${reviewId}`,
        headers: authHeaders,
      });
      assert.equal(detail.statusCode, 200);
      assert.equal(detail.json().item.decisions.length, 2, '无效批量不应部分生效');
      assert.equal(detail.json().item.decisions[0].decision, '待确认');

      const listByDecisionState = async (state: string) => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/engagements/${engagementId}/copilot-reconcile-reviews?decision_state=${state}`,
          headers: { authorization: `Bearer ${adminToken}` },
        });
        assert.equal(res.statusCode, 200, `决策筛选失败：${res.body}`);
        return res.json().items as any[];
      };
      const hasReview = (items: any[]) => items.some((item) => item.id === reviewId);

      assert.ok(
        hasReview(await listByDecisionState('pending')),
        '存在待确认差异时应出现在未决筛选',
      );
      assert.ok(
        !hasReview(await listByDecisionState('decided')),
        '存在待确认差异时不应出现在已决筛选',
      );
      assert.ok(
        !hasReview(await listByDecisionState('ignored')),
        '没有忽略决策时不应出现在忽略筛选',
      );

      const batchAccept = await app.inject({
        method: 'POST',
        url: `/api/copilot-reconcile-reviews/${reviewId}/decisions/batch`,
        headers: { ...authHeaders, 'content-type': 'application/json' },
        payload: JSON.stringify({
          difference_ids: [differenceId, secondDifferenceId],
          decision: '采纳',
        }),
      });
      assert.equal(batchAccept.statusCode, 200);
      assert.ok(
        !hasReview(await listByDecisionState('pending')),
        '全部采纳后不应再出现在未决筛选',
      );
      assert.ok(
        hasReview(await listByDecisionState('decided')),
        '全部采纳后应出现在已决筛选',
      );

      const batchIgnore = await app.inject({
        method: 'POST',
        url: `/api/copilot-reconcile-reviews/${reviewId}/decisions/batch`,
        headers: { ...authHeaders, 'content-type': 'application/json' },
        payload: JSON.stringify({
          difference_ids: [differenceId, secondDifferenceId],
          decision: '忽略',
        }),
      });
      assert.equal(batchIgnore.statusCode, 200);
      assert.ok(
        hasReview(await listByDecisionState('ignored')),
        '批量忽略后应出现在忽略筛选',
      );
      assert.equal(
        batchIgnore.json().decisions[0].note,
        '重复计费，已确认',
        '批量忽略仍应保留原备注',
      );

      const missing = await decide({
        difference_id: 'NOT-EXIST',
        decision: '采纳',
      });
      assert.equal(missing.statusCode, 422);
      assert.equal(missing.json().error, 'DIFFERENCE_NOT_FOUND');

      const invalid = await decide({
        difference_id: differenceId,
        decision: '通过',
      });
      assert.equal(invalid.statusCode, 400);

      const audits = await one<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_logs
          WHERE action = 'DECIDE copilot-reconcile-difference' AND object_id = $1`,
        [reviewId],
      );
      assert.equal(Number(audits!.count), 5, '单条与每次批量决策都应写审计');
    } finally {
      await query(
        `DELETE FROM audit_logs WHERE object_id = $1 AND object_type = 'copilot_reconcile_review'`,
        [reviewId],
      );
      await query(`DELETE FROM copilot_reconcile_reviews WHERE id = $1`, [reviewId]);
    }
  });

  await check('快照：归档后累计不下降且同日只留一条', async () => {
    const org = await one<{ id: string }>(
      `INSERT INTO organizations (name, plan) VALUES ('快照回归组织','free') RETURNING id`,
    );
    const orgId = org!.id;
    const date = localDateInTimezone('Asia/Shanghai');

    try {
      const inserted = await query<{ id: string }>(
        `INSERT INTO audit_logs (org_id, action, object_type, status_code, detail)
         VALUES ($1,'DELETE copilot-notification','user_notification',200,'{}'::jsonb),
                ($1,'RESTORE copilot-notification','user_notification',200,'{}'::jsonb),
                ($1,'EXPORT copilot-collab-audits','copilot_reconcile_review',200,$2::jsonb),
                ($1,'DECIDE copilot-reconcile-difference','copilot_reconcile_review',200,$3::jsonb)
         RETURNING id`,
        [
          orgId,
          JSON.stringify({ rows: 1 }),
          JSON.stringify({
            difference_id: 'SNAP-1',
            decision: '忽略',
            note: '回归',
          }),
        ],
      );
      const ids = inserted.map((row) => row.id);

      await snapshotCollabAudits(orgId);
      const first = await one<any>(
        `SELECT total, notification_count, filter_view_count, export_count, decision_count
           FROM collab_audit_snapshots
          WHERE org_id = $1 AND snapshot_date = $2`,
        [orgId, date],
      );
      assert.ok(first, '应生成当天快照');
      assert.equal(first.total, 4, '快照应统计 4 条协作审计');
      assert.equal(first.notification_count, 2);
      assert.equal(first.filter_view_count, 0);
      assert.equal(first.export_count, 1);
      assert.equal(first.decision_count, 1, '快照应统计差异决策');

      await query(
        `WITH moved AS (
           DELETE FROM audit_logs WHERE id = ANY($1::uuid[])
           RETURNING id, org_id, user_id, action, object_type, object_id,
                     status_code, ip, user_agent, request_id, detail, created_at
         )
         INSERT INTO audit_logs_archive
           (id, org_id, user_id, action, object_type, object_id,
            status_code, ip, user_agent, request_id, detail, created_at)
         SELECT id, org_id, user_id, action, object_type, object_id,
                status_code, ip, user_agent, request_id, detail, created_at
           FROM moved`,
        [ids],
      );

      await snapshotCollabAudits(orgId);
      const after = await one<any>(
        `SELECT total, notification_count, filter_view_count, export_count, decision_count
           FROM collab_audit_snapshots
          WHERE org_id = $1 AND snapshot_date = $2`,
        [orgId, date],
      );
      assert.equal(after.total, 4, '归档后累计不应下降');
      assert.equal(after.notification_count, 2);
      assert.equal(after.export_count, 1);
      assert.equal(after.decision_count, 1, '归档后决策计数不应下降');

      const snapshotRows = await query(
        `SELECT id FROM collab_audit_snapshots WHERE org_id = $1`,
        [orgId],
      );
      assert.equal(snapshotRows.length, 1, '同一天只应保留一条快照');
    } finally {
      await query(`DELETE FROM collab_audit_snapshots WHERE org_id = $1`, [orgId]);
      await query(`DELETE FROM audit_logs_archive WHERE org_id = $1`, [orgId]);
      await query(`DELETE FROM audit_logs WHERE org_id = $1`, [orgId]);
      await query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    }
  });

  await check('协作审计周报：按角色发送且 6 天内不重复', async () => {
    await query(
      `DELETE FROM user_notifications WHERE kind = 'copilot_collab_audit_digest'`,
    );
    try {
      const first = await sendCollabAuditDigest();
      assert.ok(first >= 1, '应向管理员/总监/项目经理发送周报');

      const countFor = async (email: string) =>
        Number(
          (
            await one<{ count: string }>(
              `SELECT count(*)::text AS count
                 FROM user_notifications n
                 JOIN users u ON u.id = n.user_id
                WHERE n.kind = 'copilot_collab_audit_digest'
                  AND u.email = $1`,
              [email],
            )
          )!.count,
        );
      assert.equal(await countFor('admin@hengzhi.ai'), 1, '管理员应收到 1 条');
      assert.equal(await countFor('zhang@hengzhi.ai'), 0, '顾问不应收到周报');

      const notice = await one<{ body: string; link: string }>(
        `SELECT n.body, n.link
           FROM user_notifications n
           JOIN users u ON u.id = n.user_id
          WHERE n.kind = 'copilot_collab_audit_digest'
            AND u.email = 'admin@hengzhi.ai'
          LIMIT 1`,
      );
      assert.ok(notice?.body.includes('最近 7 天协作审计'), '周报正文应含统计');
      assert.ok(
        notice?.link.startsWith('?collab_from=') &&
          notice?.link.includes('&collab_to=') &&
          notice?.link.endsWith('#/collab-audits'),
        '周报链接应带日期范围',
      );

      const second = await sendCollabAuditDigest();
      assert.equal(second, 0, '6 天内不应重复发送');
      const total = await one<{ count: string }>(
        `SELECT count(*)::text AS count FROM user_notifications
          WHERE kind = 'copilot_collab_audit_digest'`,
      );
      assert.equal(Number(total!.count), first, '重复调用不应增加通知');
    } finally {
      await query(
        `DELETE FROM user_notifications WHERE kind = 'copilot_collab_audit_digest'`,
      );
    }
  });

  await check('指标：Prometheus 输出、数据库状态与访问令牌', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(health.statusCode, 200);
    assert.ok(health.headers['x-app-version'], '响应应带 x-app-version');
    assert.match(String(health.headers['x-request-id']), /[A-Za-z0-9._-]{8,128}/);

    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    assert.equal(metrics.statusCode, 200);
    assert.match(String(metrics.headers['content-type']), /text\/plain/);
    assert.match(metrics.body, /# TYPE http_requests_total counter/);
    assert.match(metrics.body, /http_requests_total\{method="GET",route="\/api\/health",status="200"\}/);
    assert.match(metrics.body, /http_request_duration_ms_bucket\{le="\+Inf"\}/);
    assert.match(metrics.body, /slow_requests_total \d+/);
    assert.match(metrics.body, /db_up 1/);
    assert.match(metrics.body, /process_uptime_seconds \d+/);
    assert.match(metrics.body, /db_pool_total_connections \d+/);
    assert.match(metrics.body, /db_pool_max_connections \d+/);
    assert.match(metrics.body, /redis_configured [01]/);
    assert.match(metrics.body, /pdf_jobs_pending \d+/);
    assert.match(metrics.body, /pdf_jobs_oldest_pending_seconds \d+/);

    process.env.METRICS_TOKEN = 'test-metrics-token';
    try {
      const denied = await app.inject({ method: 'GET', url: '/metrics' });
      assert.equal(denied.statusCode, 401, '设置 METRICS_TOKEN 后未带令牌应 401');

      const viaHeader = await app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: 'Bearer test-metrics-token' },
      });
      assert.equal(viaHeader.statusCode, 200, 'Bearer 令牌应放行');

      const viaQuery = await app.inject({
        method: 'GET',
        url: '/metrics?token=test-metrics-token',
      });
      assert.equal(viaQuery.statusCode, 200, '查询参数令牌应放行');
    } finally {
      delete process.env.METRICS_TOKEN;
    }
  });

  await check('审计归档：预演、确认执行、归档查询与权限', async () => {
    const eng = await one<{ org_id: string }>(
      `SELECT org_id FROM engagements WHERE id = $1`,
      [engagementId],
    );
    assert.ok(eng, '没有项目组织');
    await query(
      `INSERT INTO audit_logs (org_id, action, status_code, created_at) VALUES
         ($1, 'TEST archive old A', 200, now() - interval '400 days'),
         ($1, 'TEST archive old B', 200, now() - interval '390 days')`,
      [eng.org_id],
    );

    const before = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const dryRun = ok(
      await req('POST', '/api/audit-logs/archive', {
        before,
        dry_run: true,
        batch_size: 1,
      }),
      200,
      '归档预演',
    );
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.moved, 0);
    assert.ok(dryRun.candidates >= 2, `预演候选数 ${dryRun.candidates}`);

    const noConfirm = await req('POST', '/api/audit-logs/archive', {
      before,
      dry_run: false,
    });
    assert.equal(noConfirm.status, 422, '未确认执行应 422');
    assert.equal(noConfirm.body.error, 'ARCHIVE_CONFIRM_REQUIRED');

    const archived = ok(
      await req('POST', '/api/audit-logs/archive', {
        before,
        dry_run: false,
        confirm: 'ARCHIVE',
        batch_size: 1,
      }),
      200,
      '执行归档',
    );
    assert.equal(archived.dryRun, false);
    assert.ok(archived.moved >= 2, `实际归档 ${archived.moved} 条`);

    const live = ok(
      await req(
        'GET',
        `/api/audit-logs?action=${encodeURIComponent('TEST archive old')}`,
      ),
      200,
      '归档后热表查询',
    );
    assert.equal(live.items.length, 0, '旧日志仍在热表');

    const archiveList = ok(
      await req(
        'GET',
        `/api/audit-logs/archive?action=${encodeURIComponent('TEST archive old')}`,
      ),
      200,
      '归档表查询',
    );
    assert.ok(archiveList.items.length >= 2, `归档表只有 ${archiveList.items.length} 条`);
    assert.ok(archiveList.items[0].archived_at, '归档记录缺少 archived_at');

    const pmLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'wang@hengzhi.ai', password: 'demo1234' },
    });
    const pmToken = pmLogin.json().token;
    const pmDenied = await app.inject({
      method: 'GET',
      url: '/api/audit-logs/archive',
      headers: { authorization: `Bearer ${pmToken}` },
    });
    assert.equal(pmDenied.statusCode, 403, '项目经理不应查看审计归档');

    await query(`DELETE FROM audit_logs_archive WHERE action LIKE 'TEST archive old%'`);
  });

  await check('软删除、回收站恢复与审计日志', async () => {
    assert.ok(diagnosisDeliverableId, '没有诊断报告 id');

    const deleted = ok(
      await req('DELETE', `/api/deliverables/${diagnosisDeliverableId}`),
      200,
      '软删除交付物',
    );
    const batch = deleted.batch as string;
    assert.ok(batch, '软删除未返回 batch');

    const gone = await req('GET', `/api/deliverables/${diagnosisDeliverableId}`);
    assert.equal(gone.status, 404, `软删除后应 404，实际 ${gone.status}`);

    const list = ok(
      await req('GET', `/api/engagements/${engagementId}/deliverables`),
      200,
      '交付物列表（软删除后）',
    );
    assert.ok(
      list.items.every((d: any) => d.id !== diagnosisDeliverableId),
      '软删除后列表仍出现交付物',
    );

    const trash = ok(await req('GET', '/api/trash'), 200, '回收站');
    const batchRow = trash.items.find((b: any) => b.batch === batch);
    assert.ok(batchRow, '回收站没有对应 batch');
    assert.ok(
      batchRow.items.some((i: any) => i.id === diagnosisDeliverableId),
      '回收站 batch 里没有交付物',
    );

    const restored = ok(
      await req('POST', `/api/trash/${batch}/restore`),
      200,
      '恢复交付物',
    );
    assert.ok(restored.restored.deliverables >= 1, '恢复数量为 0');

    const back = await req('GET', `/api/deliverables/${diagnosisDeliverableId}`);
    assert.equal(back.status, 200, `恢复后应 200，实际 ${back.status}`);

    const audit = ok(
      await req('GET', '/api/audit-logs?limit=200'),
      200,
      '审计日志',
    );
    assert.ok(audit.items.length > 0, '审计日志为空');
    assert.ok(
      audit.items.some((a: any) => String(a.action).includes('DELETE /api/deliverables')),
      '没有记录交付物删除审计',
    );
  });

  await check('删除客户进入回收站并级联项目/交付物', async () => {
    const deleted = ok(
      await req('DELETE', `/api/clients/${clientId}`),
      200,
      '软删除客户',
    );
    assert.ok(deleted.batch, '软删除客户未返回 batch');

    const clientGone = await req('GET', `/api/clients/${clientId}`);
    assert.equal(clientGone.status, 404, `软删除后客户应 404，实际 ${clientGone.status}`);
    const engagementGone = await req('GET', `/api/engagements/${engagementId}`);
    assert.equal(
      engagementGone.status,
      404,
      `客户软删除后项目应 404，实际 ${engagementGone.status}`,
    );

    const trash = ok(await req('GET', '/api/trash'), 200, '回收站');
    const batch = trash.items.find((b: any) => b.batch === deleted.batch);
    assert.ok(batch, '回收站没有客户 batch');
    const types = new Set(batch.items.map((i: any) => i.object_type));
    assert.ok(types.has('client'), '回收站缺少客户');
    assert.ok(types.has('engagement'), '回收站缺少项目');
    assert.ok(types.has('deliverable'), '回收站缺少交付物');
  });
}

main()
  .catch((err) => {
    failures += 1;
    console.error(C.red('  FAIL  未捕获异常'));
    console.error(err);
  })
  .finally(async () => {
    // 等 onResponse 审计写入完成，再清理测试数据
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      if (clientId) await query(`DELETE FROM clients WHERE id = $1`, [clientId]);
      if (isolatedOrgId) await query(`DELETE FROM organizations WHERE id = $1`, [isolatedOrgId]);
      if (testBenchmarkId) await query(`DELETE FROM benchmarks WHERE id = $1`, [testBenchmarkId]);
      await query(`DELETE FROM audit_logs WHERE created_at >= $1`, [testStartedAt]);
    } catch (err) {
      console.error(C.dim(`  清理失败：${(err as Error).message}`));
    }
    await app.close();
    await closePool();

    console.log('');
    console.log(
      failures === 0
        ? C.green(`  全部 ${passes} 项通过`)
        : C.red(`  ${failures} 项失败 / ${passes} 项通过`),
    );
    console.log('');
    if (failures > 0) process.exitCode = 1;
  });
