import type pg from 'pg';
import { one, withTransaction } from '../db';

export function httpError(statusCode: number, code: string, message: string): Error {
  const err: any = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

/** 单租户 MVP：所有新客户/项目都挂到第一个组织。多租户接入时从登录态取。 */
export async function defaultOrgId(): Promise<string> {
  const row = await one<{ id: string }>(`SELECT id FROM organizations ORDER BY created_at LIMIT 1`);
  if (!row) {
    throw httpError(500, 'NO_ORGANIZATION', '数据库中没有组织，先跑 npm run db:reset');
  }
  return row.id;
}

/** S1 门禁初始清单：新项目一律从「全部未通过」开始，由数据写入后自动刷新。 */
export function initialG1Checklist() {
  return [
    { item: '业务流程图经业务负责人确认', passed: false },
    { item: '访谈 ≥5 人，纪要已归档', passed: false },
    { item: '四维盘点完成度 ≥80%', passed: false, actual: 0, required: 80 },
    { item: '痛点 ≥10 条且全部有来源', passed: false, actual: 0, required: 10 },
    { item: '机会点 ≥3 个且均有评分理由', passed: false },
    { item: '至少 1 个机会点有真实基线', passed: false },
    { item: '技术阻断项已识别', passed: false },
    { item: '一页纸简报已生成并通过 PM 审核', passed: false },
  ];
}

const GATE_SEED: Array<{ code: string; checklist: any[] }> = [
  { code: 'G0', checklist: [] },
  { code: 'G1', checklist: initialG1Checklist() },
  { code: 'G2', checklist: [] },
  { code: 'G3', checklist: [] },
  { code: 'G4', checklist: [] },
  { code: 'G5', checklist: [] },
];

/** 自动编号：P-001 / OP-01。表名与列名来自内部常量，不接用户输入。 */
export async function nextCode(
  client: pg.PoolClient,
  table: 'pain_points' | 'opportunities',
  engagementId: string,
  prefix: string,
  pad: number,
): Promise<string> {
  const r = await client.query<{ n: number }>(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(code, '\\D', '', 'g'), '')::int), 0) + 1 AS n
       FROM ${table} WHERE engagement_id = $1`,
    [engagementId],
  );
  return `${prefix}-${String(r.rows[0].n).padStart(pad, '0')}`;
}

/** 新建项目时初始化 G0–G5；已有则跳过。 */
export async function ensureGates(client: pg.PoolClient, engagementId: string): Promise<void> {
  for (const g of GATE_SEED) {
    await client.query(
      `INSERT INTO gates (engagement_id, code, status, checklist)
       VALUES ($1,$2,'pending',$3)
       ON CONFLICT (engagement_id, code) DO NOTHING`,
      [engagementId, g.code, JSON.stringify(g.checklist)],
    );
  }
}

interface GateMetrics {
  pains: number;
  inventory_avg: number;
  interviews: number;
  baselines: number;
  opportunities: number;
  opportunities_with_rationale: number;
  confirmed_models: number;
  one_pagers: number;
}

/** 把可从数据直接算出的 G1 量化项刷新到 checklist，避免顾问手抄。 */
export async function refreshGateMetrics(
  client: pg.PoolClient,
  engagementId: string,
): Promise<void> {
  const gate = await client.query<{ id: string; checklist: any[] }>(
    `SELECT id, checklist FROM gates WHERE engagement_id = $1 AND code = 'G1' FOR UPDATE`,
    [engagementId],
  );
  if (!gate.rows.length) return;

  const r = await client.query<GateMetrics>(
    `SELECT
       (SELECT count(*) FROM pain_points WHERE engagement_id = $1 AND status <> 'merged') AS pains,
       (SELECT COALESCE(round(avg(completeness)), 0) FROM inventory_items WHERE engagement_id = $1) AS inventory_avg,
       (SELECT count(*) FROM interviews WHERE engagement_id = $1 AND status <> 'archived') AS interviews,
       (SELECT count(*) FROM baselines b JOIN opportunities o ON o.id = b.opportunity_id
         WHERE o.engagement_id = $1) AS baselines,
       (SELECT count(*) FROM opportunities WHERE engagement_id = $1) AS opportunities,
       (SELECT count(*) FROM opportunities WHERE engagement_id = $1
         AND length(btrim(score_rationale)) > 0) AS opportunities_with_rationale,
       (SELECT count(*) FROM process_models WHERE engagement_id = $1 AND status = 'confirmed') AS confirmed_models,
       (SELECT count(*) FROM deliverables WHERE engagement_id = $1 AND type = 'one_pager') AS one_pagers`,
    [engagementId],
  );
  const m = r.rows[0];

  const checklist = (gate.rows[0].checklist ?? []).map((item: any) => {
    const text = String(item.item ?? '');
    if (text.includes('痛点')) {
      const required = Number(item.required ?? 10);
      return {
        ...item,
        actual: m.pains,
        passed: m.pains >= required,
        note: `${m.pains}/${required}`,
      };
    }
    if (text.includes('盘点完成度')) {
      const required = Number(item.required ?? 80);
      return {
        ...item,
        actual: m.inventory_avg,
        passed: m.inventory_avg >= required,
        note: `${m.inventory_avg}%/${required}%`,
      };
    }
    if (text.includes('访谈')) return { ...item, passed: m.interviews >= 5 };
    if (text.includes('基线')) return { ...item, passed: m.baselines > 0 };
    if (text.includes('业务流程图')) return { ...item, passed: m.confirmed_models > 0 };
    if (text.includes('一页纸')) return { ...item, passed: m.one_pagers > 0 };
    if (text.includes('机会点') && text.includes('评分理由')) {
      return {
        ...item,
        passed: m.opportunities >= 3 && m.opportunities === m.opportunities_with_rationale,
      };
    }
    return item;
  });

  await client.query(`UPDATE gates SET checklist = $2 WHERE id = $1`, [
    gate.rows[0].id,
    JSON.stringify(checklist),
  ]);
}

/** 保存传导链：整链替换。返回链条乘积。 */
export async function replaceChain(
  client: pg.PoolClient,
  opportunityId: string,
  stages: Array<Record<string, any>>,
): Promise<number | null> {
  const roi = await client.query(`SELECT opportunity_id FROM roi_models WHERE opportunity_id = $1`, [
    opportunityId,
  ]);
  if (!roi.rows.length) {
    throw httpError(422, 'ROI_REQUIRED', '请先保存 ROI 卡，再录入传导链');
  }

  await client.query(`DELETE FROM roi_sensitivity WHERE opportunity_id = $1`, [opportunityId]);

  for (const s of stages) {
    await client.query(
      `INSERT INTO roi_sensitivity
         (opportunity_id, stage, variable_key, variable_label, unit, base_value, low_value, high_value,
          mult_base, mult_low, mult_high, shape, threshold_note, controllable, owner_role,
          is_derived, depends_on, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        opportunityId,
        s.stage,
        s.variable_key,
        s.variable_label,
        s.unit ?? null,
        s.base_value ?? null,
        s.low_value ?? null,
        s.high_value ?? null,
        s.mult_base,
        s.mult_low ?? null,
        s.mult_high ?? null,
        s.shape ?? 'linear',
        s.threshold_note ?? null,
        s.controllable ?? true,
        s.owner_role ?? null,
        s.is_derived ?? false,
        s.depends_on ?? [],
        s.note ?? null,
      ],
    );
  }

  const gaps = await client.query(`SELECT expected, actual FROM chain_stage_gaps($1)`, [opportunityId]);
  if (gaps.rows.length) {
    throw httpError(
      422,
      'CHAIN_STAGE_GAP',
      `传导链段号必须从 1 连续：${gaps.rows.map((g) => `第 ${g.expected} 段实际是 ${g.actual}`).join('；')}`,
    );
  }

  // ROI 已确认时，系数必须跟着链条走（C12）
  const confirmed = await client.query<{ ok: boolean }>(
    `SELECT (realization_confirmed_at IS NOT NULL) AS ok FROM roi_models WHERE opportunity_id = $1`,
    [opportunityId],
  );
  if (confirmed.rows[0]?.ok) {
    await client.query(`SELECT sync_realization_factor($1)`, [opportunityId]);
  }

  const product = await client.query<{ p: number | null }>(`SELECT chain_product($1) AS p`, [
    opportunityId,
  ]);
  return product.rows[0]?.p ?? null;
}

/** 收益形态确认：系数由链条乘积写回，不接受手填。 */
export async function confirmRealization(
  client: pg.PoolClient,
  opportunityId: string,
  mode: string,
  note: string,
  confirmedBy: string,
): Promise<{ roi: any; product: number }> {
  const productRow = await client.query<{ p: number | null }>(`SELECT chain_product($1) AS p`, [
    opportunityId,
  ]);
  const product = productRow.rows[0]?.p;
  if (product === null || product === undefined) {
    throw httpError(422, 'CHAIN_REQUIRED', '请先录入传导链，再确认收益实现形态');
  }

  const gaps = await client.query(`SELECT expected, actual FROM chain_stage_gaps($1)`, [opportunityId]);
  if (gaps.rows.length) {
    throw httpError(422, 'CHAIN_STAGE_GAP', '传导链段号不连续，不能确认收益形态');
  }

  const updated = await client.query(
    `UPDATE roi_models
        SET realization_mode = $2,
            realization_factor = $3,
            realization_note = $4,
            realization_confirmed_by = $5,
            realization_confirmed_at = now(),
            updated_at = now()
      WHERE opportunity_id = $1
      RETURNING *`,
    [opportunityId, mode, product, note, confirmedBy],
  );
  if (!updated.rows.length) throw httpError(404, 'NOT_FOUND', 'ROI 卡不存在');
  return { roi: updated.rows[0], product };
}

/** 整张业务流程替换：旧模型归档，新模型带版本号。edges 的 from/to 可以是节点下标或 key。 */
export async function replaceProcessModel(
  client: pg.PoolClient,
  engagementId: string,
  nodes: Array<Record<string, any>>,
  edges: Array<Record<string, any>>,
  confirmedBy?: string,
): Promise<{ id: string; version: number }> {
  await client.query(
    `UPDATE process_models SET status = 'archived'
      WHERE engagement_id = $1 AND status <> 'archived'`,
    [engagementId],
  );

  const versionRow = await client.query<{ version: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM process_models WHERE engagement_id = $1`,
    [engagementId],
  );
  const version = versionRow.rows[0].version;
  const model = await client.query<{ id: string }>(
    `INSERT INTO process_models (engagement_id, version, status, confirmed_by, confirmed_at)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id`,
    [
      engagementId,
      version,
      confirmedBy ? 'confirmed' : 'draft',
      confirmedBy ?? null,
      confirmedBy ? new Date().toISOString() : null,
    ],
  );
  const modelId = model.rows[0].id;

  const ids: string[] = [];
  const keyMap = new Map<string, string>();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const ins = await client.query<{ id: string }>(
      `INSERT INTO process_nodes
         (model_id, lane, name, node_type, owner_role, duration_min, abnormal_rate,
          is_implicit, discovered_by, pos_x, pos_y, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id`,
      [
        modelId,
        n.lane,
        n.name,
        n.node_type,
        n.owner_role ?? null,
        n.duration_min ?? null,
        n.abnormal_rate ?? null,
        n.is_implicit ?? false,
        n.discovered_by ?? null,
        n.pos_x ?? null,
        n.pos_y ?? null,
        n.sort_order ?? i + 1,
      ],
    );
    const id = ins.rows[0].id;
    ids.push(id);
    if (n.key) keyMap.set(String(n.key), id);
  }

  const resolve = (ref: unknown): string => {
    if (typeof ref === 'number' && Number.isInteger(ref) && ids[ref]) return ids[ref];
    if (typeof ref === 'string') {
      if (keyMap.has(ref)) return keyMap.get(ref)!;
      const asIndex = Number(ref);
      if (Number.isInteger(asIndex) && ids[asIndex]) return ids[asIndex];
    }
    throw httpError(400, 'EDGE_NODE_NOT_FOUND', `连线引用了不存在的节点：${String(ref)}`);
  };

  for (const e of edges) {
    const from = resolve(e.from);
    const to = resolve(e.to);
    if (from === to) throw httpError(400, 'EDGE_SELF_LOOP', '连线不能指向自己');
    await client.query(
      `INSERT INTO process_edges (model_id, from_node_id, to_node_id, label, condition)
       VALUES ($1,$2,$3,$4,$5)`,
      [modelId, from, to, e.label ?? null, e.condition ?? null],
    );
  }

  return { id: modelId, version };
}
