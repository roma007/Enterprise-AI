import type { FastifyInstance, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { one, query, withTransaction } from '../db';
import { httpError } from '../services/s1';
import { reapStaleBatches } from '../services/copilot_batches';
import { createZip } from '../services/zip';
import { csvCell } from '../services/csv';
import { buildDocx } from '../services/export';
import { DIFF_LABEL } from '../services/reconcile_labels';
import {
  generateReconcileDeliverable,
  listReconcileDocuments,
  loadReconcileBundle,
  renderReconcileDoc,
} from '../services/reconcile_docs';

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

const reviewBody = z.object({
  idempotency_key: z.string().trim().min(8).max(128),
  engagement_id: z.uuid().optional(),
  experiment_id: z.uuid().optional(),
  kind: z.enum(['statement', 'settlement']),
  document_id: z.string().trim().max(200).optional(),
  status: z.enum(['confirmed', 'revised']).default('confirmed'),
  summary: z.record(z.string(), z.unknown()).default({}),
  document: z.record(z.string(), z.unknown()),
  differences: z.array(z.record(z.string(), z.unknown())).default([]),
  decisions: z.array(z.record(z.string(), z.unknown())).default([]),
  source: z.string().trim().max(80).optional(),
});

const actionBody = z.object({
  type: z.enum(['risk', 'issue']),
  difference_id: z.string().trim().max(200).optional(),
  owner: z.uuid().nullable().optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  severity: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
  probability: z.coerce.number().int().min(1).max(5).optional(),
  impact: z.coerce.number().int().min(1).max(5).optional(),
  title: z.string().trim().min(1).max(200),
  detail: z.string().trim().max(12000).optional(),
  impact_text: z.string().trim().max(500).optional(),
});

const batchActionBody = z.object({
  type: z.enum(['risk', 'issue']),
  difference_ids: z.array(z.string().trim().min(1).max(200)).min(1).max(200),
  owner: z.uuid().nullable().optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  severity: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
});

const batchFilterViewBody = z.object({
  name: z.string().trim().min(1).max(80),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']).nullable().optional(),
  action_type: z.enum(['risk', 'issue']).nullable().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  shared: z.boolean().optional(),
  shared_role: z
    .enum(['admin', 'director', 'pm', 'consultant', 'tech_lead'])
    .nullable()
    .optional(),
  shared_user_ids: z.array(z.uuid()).max(50).optional(),
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


function docDisposition(title: string, ext: string, inline = false): string {
  const safe = `${title}.${ext}`;
  const ascii = `copilot-reconcile.${ext}`;
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

function localDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}


async function recordExportAudit(
  req: any,
  action: string,
  reviewId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const auth = req.authUser;
  try {
    await query(
      `INSERT INTO audit_logs
         (org_id, user_id, action, object_type, object_id, status_code,
          ip, user_agent, request_id, detail)
       VALUES ($1,$2,$3,'copilot_reconcile_review',$4,200,$5,$6,$7,$8::jsonb)`,
      [
        auth?.org_id ?? null,
        auth?.sub ?? null,
        action,
        reviewId,
        req.ip,
        String(req.headers['user-agent'] ?? '').slice(0, 500),
        req.id,
        JSON.stringify(detail),
      ],
    );
  } catch (err) {
    // 审计失败不影响导出
    req.log?.warn?.({ err }, 'export audit failed');
  }
}

async function batchViewRecipients(
  client: any,
  orgId: string,
  view: { shared?: boolean; shared_role?: string | null },
  explicitUserIds: string[],
): Promise<Set<string>> {
  const ids = new Set<string>();
  if (view.shared) {
    const rows = await client.query(
      `SELECT id FROM users WHERE org_id = $1 AND status = 'active'`,
      [orgId],
    );
    for (const row of rows.rows) ids.add(row.id);
  }
  if (view.shared_role) {
    const rows = await client.query(
      `SELECT u.id
         FROM users u
         JOIN memberships m ON m.user_id = u.id AND m.org_id = u.org_id
        WHERE u.org_id = $1 AND u.status = 'active' AND m.role = $2`,
      [orgId, view.shared_role],
    );
    for (const row of rows.rows) ids.add(row.id);
  }
  for (const userId of explicitUserIds) ids.add(userId);
  return ids;
}

async function recordViewAudit(
  req: any,
  action: string,
  viewId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const auth = req.authUser;
  try {
    await query(
      `INSERT INTO audit_logs
         (org_id, user_id, action, object_type, object_id, status_code,
          ip, user_agent, request_id, detail)
       VALUES ($1,$2,$3,'copilot_batch_filter_view',$4,200,$5,$6,$7,$8::jsonb)`,
      [
        auth?.org_id ?? null,
        auth?.sub ?? null,
        action,
        viewId,
        req.ip,
        String(req.headers['user-agent'] ?? '').slice(0, 500),
        req.id,
        JSON.stringify(detail),
      ],
    );
  } catch (err) {
    req.log?.warn?.({ err }, 'filter view audit failed');
  }
}

function dateOnly(value: any): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return localDate(new Date(value));
}

function addBusinessDays(start: Date, days: number, holidays: Set<string> = new Set()): Date {
  const d = new Date(start.getTime());
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const weekday = d.getDay();
    if (weekday !== 0 && weekday !== 6 && !holidays.has(localDate(d))) added += 1;
  }
  return d;
}

function slaDueDate(severity: string, holidays: Set<string> = new Set()): string {
  const days = severity === 'P0' ? 1 : severity === 'P1' ? 3 : severity === 'P2' ? 7 : 14;
  return localDate(addBusinessDays(new Date(), days, holidays));
}

async function nextIssueCode(client: any, engagementId: string): Promise<string> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
    engagementId,
    'delivery_issues',
  ]);
  const res = await client.query(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(code, '\\D', '', 'g'), '')::int), 0) + 1 AS n
       FROM delivery_issues
      WHERE engagement_id = $1 AND kind = 'issue'`,
    [engagementId],
  );
  return `ISS-${String(res.rows[0]?.n ?? 1).padStart(3, '0')}`;
}

interface DiffActionOptions {
  type: 'risk' | 'issue';
  owner: string | null;
  severity: string;
  dueDate: string | null;
  probability?: number;
  impact?: number;
  holidays: Set<string>;
  createdBy: string | null;
}

interface DiffActionResult {
  status: 'created' | 'duplicate';
  item_id: string;
  action_id: string | null;
  item_code?: string | null;
}

function impactSeverity(impact: number): string {
  return impact === 5 ? 'P0' : impact === 4 ? 'P1' : impact === 3 ? 'P2' : 'P3';
}

function diffDetailText(review: any, diff: any): string {
  const label = DIFF_LABEL[diff.type] ?? diff.type ?? '差异';
  const waybill = diff.waybill_no || diff.trip_no || '';
  const decisions = Array.isArray(review.decisions) ? review.decisions : [];
  const decision = decisions.find(
    (d: any) => String(d?.difference_id ?? '') === String(diff.difference_id ?? ''),
  );
  return [
    `关联复核记录 ${review.id}`,
    `- ${label} ${waybill} 差额 ${diff.delta ?? '—'}`,
    `可能原因：${Array.isArray(diff.possible_causes) ? diff.possible_causes.join('；') : '—'}`,
    `建议：${diff.suggested_action || '—'}`,
    `来源：${diff.source || '—'}${diff.confidence != null ? `（置信度 ${diff.confidence}）` : ''}`,
    `证据：${Array.isArray(diff.evidence) ? diff.evidence.join('；') : '—'}`,
    `决策：${decision?.decision || '—'}${decision?.note ? `（${decision.note}）` : ''}`,
  ].join('\n');
}

type DecisionValue = '采纳' | '忽略' | '待确认';

/** 合并单条差异决策：存在则覆盖，未传 note 时保留原备注。 */
function mergeDifferenceDecision(
  existing: any[],
  differenceId: string,
  decision: DecisionValue,
  note: string | null | undefined,
  auth: any,
): any[] {
  const index = existing.findIndex(
    (d) => String(d?.difference_id ?? '') === differenceId,
  );
  const previous = index >= 0 ? existing[index] : null;
  const entry = {
    ...(previous ?? {}),
    difference_id: differenceId,
    decision,
    note: note === undefined ? previous?.note ?? null : note,
    source: 'platform',
    decided_by: auth.sub,
    decided_by_name: auth.name ?? null,
    decided_at: new Date().toISOString(),
  };
  return index >= 0
    ? existing.map((d, i) => (i === index ? entry : d))
    : [...existing, entry];
}

function diffDocLabel(review: any): string {
  const doc = review.document ?? {};
  return String(doc.statement_no ?? doc.settlement_no ?? review.document_id ?? review.id);
}

/** 在已持有复核锁的事务里创建一条按差异的动作；重复直接返回已有记录。 */
async function insertDiffAction(
  client: any,
  review: any,
  diff: any,
  opts: DiffActionOptions,
): Promise<DiffActionResult> {
  const differenceId = String(diff.difference_id);
  const dup = await client.query(
    `SELECT id, target_id FROM copilot_reconcile_actions
      WHERE review_id = $1 AND difference_id = $2 AND action_type = $3`,
    [review.id, differenceId, opts.type],
  );
  if (dup.rows[0]) {
    return {
      status: 'duplicate',
      item_id: dup.rows[0].target_id,
      action_id: dup.rows[0].id,
    };
  }

  const delta = Math.abs(Number(diff.delta ?? 0)) || 0;
  const waybill = diff.waybill_no || diff.trip_no || diff.type || '';
  const kindLabel = review.kind === 'statement' ? '客户对账单' : '车队结算单';
  const docLabel = diffDocLabel(review);
  const detail = diffDetailText(review, diff);

  const record = async (targetId: string) => {
    const inserted = await client.query(
      `INSERT INTO copilot_reconcile_actions
         (review_id, difference_id, action_type, target_id, created_by)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id`,
      [review.id, differenceId, opts.type, targetId, opts.createdBy],
    );
    return inserted.rows[0].id as string;
  };

  if (opts.type === 'risk') {
    const probability = opts.probability ?? (delta >= 1000 ? 4 : 3);
    const impact = opts.impact ?? (delta >= 5000 ? 5 : delta >= 1000 ? 4 : 3);
    const due = opts.dueDate ?? slaDueDate(impactSeverity(impact), opts.holidays);
    const row = await client.query(
      `INSERT INTO risks
         (engagement_id, title, category, probability, impact, mitigation, status, owner, due_date)
       VALUES ($1,$2,'commercial',$3,$4,$5,'open',$6,$7)
       RETURNING id`,
      [
        review.engagement_id,
        `对账差异：${kindLabel} ${docLabel} / ${waybill}`,
        probability,
        impact,
        detail,
        opts.owner,
        due,
      ],
    );
    const actionId = await record(row.rows[0].id);
    return { status: 'created', item_id: row.rows[0].id, action_id: actionId };
  }

  const code = await nextIssueCode(client, review.engagement_id);
  const due = opts.dueDate ?? slaDueDate(opts.severity, opts.holidays);
  const row = await client.query(
    `INSERT INTO delivery_issues
       (engagement_id, code, kind, title, description, severity, status,
        owner, due_date, impact, approval_status)
     VALUES ($1,$2,'issue',$3,$4,$5,'open',$6,$7,$8,'not_required')
     RETURNING id, code`,
    [
      review.engagement_id,
      code,
      `对账差异跟进：${kindLabel} ${docLabel} / ${waybill}`,
      detail,
      opts.severity,
      opts.owner,
      due,
      `应收/应付差异 ${delta.toLocaleString()} 元`,
    ],
  );
  const actionId = await record(row.rows[0].id);
  return {
    status: 'created',
    item_id: row.rows[0].id,
    action_id: actionId,
    item_code: row.rows[0].code,
  };
}

async function loadHolidays(client: any, orgId: string): Promise<Set<string>> {
  const orgRow = await client.query(
    `SELECT settings FROM organizations WHERE id = $1`,
    [orgId],
  );
  const region = String(orgRow.rows[0]?.settings?.region || 'CN').toUpperCase();
  const rows = await client.query(
    `SELECT date::text AS date
       FROM holiday_calendar
      WHERE active
        AND (org_id IS NULL OR org_id = $1)
        AND (region = $2 OR region = 'ALL')
        AND date >= current_date
        AND date <= current_date + interval '365 days'`,
    [orgId, region],
  );
  return new Set<string>(rows.rows.map((r: any) => r.date));
}

/** 单条差异独立事务：流式批量逐条提交，失败只影响该条。 */
async function runBatchItem(
  reviewId: string,
  differenceId: string,
  type: 'risk' | 'issue',
  owner: string | null,
  severity: string,
  dueDate: string | null,
  createdBy: string | null,
): Promise<Record<string, unknown>> {
  try {
    return await withTransaction(async (client) => {
      const found = await client.query<any>(
        `SELECT * FROM copilot_reconcile_reviews WHERE id = $1 FOR UPDATE`,
        [reviewId],
      );
      const review = found.rows[0];
      if (!review) {
        return {
          difference_id: differenceId,
          status: 'failed',
          code: 'NOT_FOUND',
          error: '对账复核记录不存在',
        };
      }
      if (!review.engagement_id) {
        return {
          difference_id: differenceId,
          status: 'failed',
          code: 'NO_ENGAGEMENT',
          error: '复核记录未关联项目',
        };
      }
      const diffs = Array.isArray(review.differences) ? review.differences : [];
      const diff = diffs.find(
        (d: any) => String(d?.difference_id ?? '') === differenceId,
      );
      if (!diff) {
        return {
          difference_id: differenceId,
          status: 'failed',
          code: 'DIFFERENCE_NOT_FOUND',
          error: '差异不存在',
        };
      }
      const holidays = await loadHolidays(client, review.org_id);
      const result = await insertDiffAction(client, review, diff, {
        type,
        owner,
        severity,
        dueDate,
        holidays,
        createdBy,
      });
      return { difference_id: differenceId, ...result };
    });
  } catch (err: any) {
    return {
      difference_id: differenceId,
      status: 'failed',
      code: err?.code ?? 'ACTION_FAILED',
      error: err?.message ?? '生成失败',
    };
  }
}


interface BatchRecordOptions {
  reviewId: string;
  parentBatchId?: string | null;
  type: 'risk' | 'issue';
  requested: number;
  differenceIds: string[];
  owner: string | null;
  severity: string;
  dueDate: string | null;
  createdBy: string | null;
}

async function createBatchRecord(opts: BatchRecordOptions): Promise<string> {
  const row = await one<{ id: string }>(
    `INSERT INTO copilot_reconcile_batches
       (review_id, parent_batch_id, action_type, requested_count, owner, severity, due_date, created_by, difference_ids)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
     RETURNING id`,
    [
      opts.reviewId,
      opts.parentBatchId ?? null,
      opts.type,
      opts.requested,
      opts.owner,
      opts.severity,
      opts.dueDate,
      opts.createdBy,
      JSON.stringify(opts.differenceIds),
    ],
  );
  if (!row) throw httpError(500, 'BATCH_CREATE_FAILED', '批量任务创建失败');
  return row.id;
}

async function finishBatchRecord(
  batchId: string,
  counts: { created: number; skipped: number; failed: number },
): Promise<void> {
  const status =
    counts.created === 0 && counts.skipped === 0 && counts.failed > 0
      ? 'failed'
      : 'completed';
  await query(
    `UPDATE copilot_reconcile_batches
        SET status = CASE WHEN status = 'cancelled' THEN 'cancelled' ELSE $2 END,
            created_count = $3,
            skipped_count = $4,
            failed_count = CASE
              WHEN status = 'cancelled'
                THEN GREATEST(requested_count - $3 - $4, 0)
              ELSE $5
            END,
            finished_at = now()
      WHERE id = $1`,
    [batchId, status, counts.created, counts.skipped, counts.failed],
  );
}

async function recordBatchItem(
  batchId: string,
  differenceId: string,
  item: Record<string, any>,
): Promise<void> {
  await query(
    `INSERT INTO copilot_reconcile_batch_items
       (batch_id, difference_id, status, target_id, action_id, item_code, error_code, error_message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (batch_id, difference_id) DO NOTHING`,
    [
      batchId,
      differenceId,
      item.status,
      item.item_id ?? null,
      item.action_id ?? null,
      item.item_code ?? null,
      item.code ?? null,
      item.error ?? null,
    ],
  );
}

/** 批次及其所有后代已处理过的差异 ID。 */
async function descendantProcessedIds(batchId: string): Promise<Set<string>> {
  const rows = await query<{ difference_id: string }>(
    `WITH RECURSIVE tree AS (
       SELECT id FROM copilot_reconcile_batches WHERE id = $1
       UNION ALL
       SELECT c.id
         FROM copilot_reconcile_batches c
         JOIN tree t ON c.parent_batch_id = t.id
     )
     SELECT DISTINCT i.difference_id
       FROM copilot_reconcile_batch_items i
      WHERE i.batch_id IN (SELECT id FROM tree)`,
    [batchId],
  );
  return new Set(rows.map((r) => r.difference_id));
}

interface StreamBatchOptions {
  reviewId: string;
  batchId: string;
  differenceIds: string[];
  type: 'risk' | 'issue';
  owner: string | null;
  severity: string;
  dueDate: string | null;
  createdBy: string | null;
}

async function streamBatchResponse(
  reply: any,
  req: any,
  opts: StreamBatchOptions,
): Promise<void> {
  const seen = new Set<string>();
  async function* generate() {
    let created = 0;
    let skipped = 0;
    let failed = 0;
    let cancelled = false;
    try {
      for (const raw of opts.differenceIds) {
        const current = await one<{ status: string }>(
          `SELECT status FROM copilot_reconcile_batches WHERE id = $1`,
          [opts.batchId],
        );
        if (current?.status === 'cancelled') {
          cancelled = true;
          break;
        }
        const differenceId = raw.trim();
        let item: Record<string, unknown>;
        if (seen.has(differenceId)) {
          item = {
            difference_id: differenceId,
            status: 'failed',
            code: 'DUPLICATE_IN_REQUEST',
            error: '同一差异在请求中重复出现',
          };
        } else {
          seen.add(differenceId);
          item = await runBatchItem(
            opts.reviewId,
            differenceId,
            opts.type,
            opts.owner,
            opts.severity,
            opts.dueDate,
            opts.createdBy,
          );
        }
        if (item.status === 'created') created += 1;
        else if (item.status === 'duplicate') skipped += 1;
        else failed += 1;
        await recordBatchItem(opts.batchId, differenceId, item).catch(() => undefined);
        yield `${JSON.stringify(item)}\n`;
      }
      await finishBatchRecord(opts.batchId, { created, skipped, failed });
      const failedOut = cancelled
        ? Math.max(opts.differenceIds.length - created - skipped, 0)
        : failed;
      yield `${JSON.stringify({
        done: true,
        batch_id: opts.batchId,
        created,
        skipped,
        failed: failedOut,
        cancelled,
      })}\n`;
    } finally {
      // 客户端断开时也把已处理数量落库。
      await finishBatchRecord(opts.batchId, { created, skipped, failed }).catch(
        () => undefined,
      );
    }
  }

  // 全局 onSend 钩子会破坏 Fastify 的流式响应，这里直接接管 raw response；
  // onResponse 仍会执行，审计、指标与连接释放不受影响。
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
    'x-request-id': req.id,
  });
  try {
    for await (const line of generate()) {
      if (raw.destroyed || raw.writableEnded) break;
      raw.write(line);
    }
  } catch (err: any) {
    if (!raw.writableEnded) {
      raw.write(
        `${JSON.stringify({ done: true, error: err?.message ?? '批量处理失败' })}\n`,
      );
    }
  } finally {
    if (!raw.writableEnded) raw.end();
  }
}

interface BatchExportFilters {
  status?: 'running' | 'completed' | 'failed' | 'cancelled';
  action_type?: 'risk' | 'issue';
  from?: string;
  to?: string;
}

const BATCH_STATUS_LABEL: Record<string, string> = {
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const BATCH_TREE_CTE = `WITH RECURSIVE tree AS (
  SELECT b.id, b.id AS root_id, b.created_at AS root_created_at,
         b.parent_batch_id, b.status, b.action_type, b.created_at, 0 AS depth
    FROM copilot_reconcile_batches b
   WHERE b.review_id = $1 AND b.parent_batch_id IS NULL
  UNION ALL
  SELECT c.id, t.root_id, t.root_created_at,
         c.parent_batch_id, c.status, c.action_type, c.created_at, t.depth + 1
    FROM copilot_reconcile_batches c
    JOIN tree t ON c.parent_batch_id = t.id
   WHERE c.review_id = $1
)`;

const VIEW_ROLE_LABEL: Record<string, string> = {
  admin: '管理员',
  director: '总监',
  pm: '项目经理',
  consultant: '顾问',
  tech_lead: '技术负责人',
};

const ITEM_STATUS_LABEL: Record<string, string> = {
  created: '已生成',
  duplicate: '已跳过',
  failed: '失败',
};

function parseBatchExportFilters(input: any): BatchExportFilters {
  const filters = z
    .object({
      status: z.enum(['running', 'completed', 'failed', 'cancelled']).optional(),
      action_type: z.enum(['risk', 'issue']).optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    })
    .parse(input ?? {});
  if (filters.from && filters.to && filters.from > filters.to) {
    throw httpError(400, 'INVALID_DATE_RANGE', '开始日期不能晚于结束日期');
  }
  return filters;
}

function batchFilterSql(
  filters: BatchExportFilters,
  alias = 'b',
  startIndex = 2,
): { clause: string; values: unknown[] } {
  const clauses: string[] = [];
  const values: unknown[] = [];
  let n = startIndex;
  if (filters.status) {
    clauses.push(`${alias}.status = $${n++}`);
    values.push(filters.status);
  }
  if (filters.action_type) {
    clauses.push(`${alias}.action_type = $${n++}`);
    values.push(filters.action_type);
  }
  if (filters.from) {
    clauses.push(`${alias}.created_at >= $${n++}::date`);
    values.push(filters.from);
  }
  if (filters.to) {
    clauses.push(`${alias}.created_at < ($${n++}::date + interval '1 day')`);
    values.push(filters.to);
  }
  return { clause: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', values };
}

async function loadBatchSummaryRows(
  reviewId: string,
  filters: BatchExportFilters,
): Promise<any[]> {
  const { clause, values } = batchFilterSql(filters, 'tree', 2);
  return query<any>(
    `${BATCH_TREE_CTE},
     matched AS (
       SELECT DISTINCT root_id FROM tree WHERE 1=1 ${clause}
     )
     SELECT b.id, b.parent_batch_id, b.action_type, b.status,
            b.requested_count, b.created_count, b.skipped_count, b.failed_count,
            b.severity, b.due_date, b.cancel_reason, b.created_at, b.finished_at,
            t.depth, u.name AS created_by_name, cu.name AS cancelled_by_name
       FROM copilot_reconcile_batches b
       JOIN tree t ON t.id = b.id
       JOIN matched m ON m.root_id = t.root_id
       LEFT JOIN users u ON u.id = b.created_by
       LEFT JOIN users cu ON cu.id = b.cancelled_by
      ORDER BY t.root_created_at DESC, t.root_id, t.depth, b.created_at`,
    [reviewId, ...values],
  );
}

function buildBatchSummaryCsv(rows: any[]): string {
  const header = [
    '批次ID',
    '父批次ID',
    '类型',
    '状态',
    '请求数',
    '成功数',
    '跳过数',
    '失败数',
    '级别',
    '截止日期',
    '取消原因',
    '取消人',
    '创建人',
    '创建时间',
    '完成时间',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.parent_batch_id,
        r.action_type === 'risk' ? '风险' : '待办',
        BATCH_STATUS_LABEL[r.status] ?? r.status,
        r.requested_count,
        r.created_count,
        r.skipped_count,
        r.failed_count,
        r.severity,
        dateOnly(r.due_date),
        r.cancel_reason,
        r.cancelled_by_name,
        r.created_by_name,
        r.created_at ? new Date(r.created_at).toISOString() : '',
        r.finished_at ? new Date(r.finished_at).toISOString() : '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}`;
}

async function loadBatchItemRows(
  reviewId: string,
  filters: BatchExportFilters,
): Promise<any[]> {
  const { clause, values } = batchFilterSql(filters, 'tree', 2);
  return query<any>(
    `${BATCH_TREE_CTE},
     matched AS (
       SELECT DISTINCT root_id FROM tree WHERE 1=1 ${clause}
     )
     SELECT b.id AS batch_id, b.parent_batch_id, b.action_type,
            b.status AS batch_status, b.cancel_reason,
            i.difference_id, i.status AS item_status, i.target_id, i.action_id,
            i.item_code, i.error_code, i.error_message, i.created_at AS item_created_at,
            u.name AS created_by_name, cu.name AS cancelled_by_name
       FROM copilot_reconcile_batches b
       JOIN tree t ON t.id = b.id
       JOIN matched m ON m.root_id = t.root_id
       LEFT JOIN copilot_reconcile_batch_items i ON i.batch_id = b.id
       LEFT JOIN users u ON u.id = b.created_by
       LEFT JOIN users cu ON cu.id = b.cancelled_by
      ORDER BY t.root_created_at DESC, t.root_id, t.depth, b.created_at, i.created_at`,
    [reviewId, ...values],
  );
}

async function buildBatchItemsCsv(reviewId: string, rows: any[]): Promise<string> {
  const review = await one<any>(
    `SELECT differences, decisions FROM copilot_reconcile_reviews WHERE id = $1`,
    [reviewId],
  );
  if (!review) throw httpError(404, 'NOT_FOUND', '对账复核记录不存在');
  const diffIndex = new Map<string, any>();
  for (const d of Array.isArray(review.differences) ? review.differences : []) {
    if (d?.difference_id) diffIndex.set(String(d.difference_id), d);
  }
  const decisionIndex = new Map<string, any>();
  for (const d of Array.isArray(review.decisions) ? review.decisions : []) {
    if (d?.difference_id) decisionIndex.set(String(d.difference_id), d);
  }

  const header = [
    '批次ID',
    '父批次ID',
    '类型',
    '批次状态',
    '差异ID',
    '差异类型',
    '运单/趟次',
    '对账单金额',
    '系统金额',
    '差额',
    '来源',
    '置信度',
    '证据',
    '可能原因',
    '建议动作',
    '决策',
    '备注',
    '明细状态',
    '目标ID',
    '动作ID',
    '待办编号',
    '失败码',
    '失败原因',
    '明细时间',
    '取消原因',
    '取消人',
    '创建人',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    const differenceId = r.difference_id ? String(r.difference_id) : '';
    const diff = differenceId ? diffIndex.get(differenceId) : undefined;
    const decision = differenceId ? decisionIndex.get(differenceId) : undefined;
    lines.push(
      [
        r.batch_id,
        r.parent_batch_id,
        r.action_type === 'risk' ? '风险' : '待办',
        BATCH_STATUS_LABEL[r.batch_status] ?? r.batch_status,
        r.difference_id,
        diff ? DIFF_LABEL[diff.type] ?? diff.type : '',
        diff?.waybill_no || diff?.trip_no || '',
        diff?.statement_amount,
        diff?.system_amount,
        diff?.delta,
        diff?.source,
        diff?.confidence,
        Array.isArray(diff?.evidence) ? diff.evidence.join('；') : '',
        Array.isArray(diff?.possible_causes) ? diff.possible_causes.join('；') : '',
        diff?.suggested_action,
        decision?.decision,
        decision?.note,
        r.item_status ? ITEM_STATUS_LABEL[r.item_status] ?? r.item_status : '',
        r.target_id,
        r.action_id,
        r.item_code,
        r.error_code,
        r.error_message,
        r.item_created_at ? new Date(r.item_created_at).toISOString() : '',
        r.cancel_reason,
        r.cancelled_by_name,
        r.created_by_name,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}`;
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


  /**
   * 试点一：对账单/结算单复核结果回写。
   * 与评测回写共用 x-copilot-token；按 engagement_id 或 experiment_id 归属到组织/项目。
   */
  app.post('/api/hooks/copilot/reconcile', async (req, reply) => {
    assertHook(req);
    const body = reviewBody.parse(req.body);
    if (!body.engagement_id && !body.experiment_id) {
      throw httpError(422, 'TARGET_REQUIRED', 'engagement_id 或 experiment_id 至少填一个');
    }

    const payloadJson = JSON.stringify({
      ...body,
      received_at: new Date().toISOString(),
    });
    if (payloadJson.length > 256_000) {
      throw httpError(422, 'PAYLOAD_TOO_LARGE', '复核结果超过 256KB');
    }

    const result = await withTransaction(async (client) => {
      const dup = await client.query<{ id: string; engagement_id: string | null }>(
        `SELECT id, engagement_id FROM copilot_reconcile_reviews WHERE idempotency_key = $1`,
        [body.idempotency_key],
      );
      if (dup.rows[0]) {
        return {
          duplicate: true,
          review_id: dup.rows[0].id,
          engagement_id: dup.rows[0].engagement_id,
        };
      }

      let orgId: string;
      let engagementId: string;
      let experimentId: string | null = body.experiment_id ?? null;

      if (body.engagement_id) {
        const eng = await client.query<{ id: string; org_id: string }>(
          `SELECT id, org_id FROM engagements
            WHERE id = $1 AND deleted_at IS NULL`,
          [body.engagement_id],
        );
        if (!eng.rows[0]) throw httpError(404, 'ENGAGEMENT_NOT_FOUND', '项目不存在');
        orgId = eng.rows[0].org_id;
        engagementId = eng.rows[0].id;
      } else {
        const exp = await client.query<{
          id: string;
          org_id: string;
          engagement_id: string;
        }>(
          `SELECT e.id, en.org_id, en.id AS engagement_id
             FROM poc_experiments e
             JOIN opportunities o ON o.id = e.opportunity_id
             JOIN engagements en ON en.id = o.engagement_id
            WHERE e.id = $1`,
          [body.experiment_id],
        );
        if (!exp.rows[0]) throw httpError(404, 'EXPERIMENT_NOT_FOUND', 'POC 实验不存在');
        orgId = exp.rows[0].org_id;
        engagementId = exp.rows[0].engagement_id;
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO copilot_reconcile_reviews
           (idempotency_key, org_id, engagement_id, experiment_id, kind, document_id,
            status, summary, document, differences, decisions, payload, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13)
         RETURNING id`,
        [
          body.idempotency_key,
          orgId,
          engagementId,
          experimentId,
          body.kind,
          body.document_id ?? null,
          body.status,
          JSON.stringify(body.summary ?? {}),
          JSON.stringify(body.document ?? {}),
          JSON.stringify(body.differences ?? []),
          JSON.stringify(body.decisions ?? []),
          payloadJson,
          body.source ?? 'ai-copilot-pilot',
        ],
      );

      return {
        duplicate: false,
        review_id: inserted.rows[0].id,
        engagement_id: engagementId,
      };
    });

    return reply.code(result.duplicate ? 200 : 201).send({ ok: true, ...result });
  });

  /** 顾问查看：单条对账复核详情（含 document 与按差异生成的动作）。 */
  app.get('/api/copilot-reconcile-reviews/:id', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { review, actions } = await loadReconcileBundle(id);
    return { item: { ...review, actions } };
  });

  /** 复核报告过期时通知本组织管理员/总监/项目经理；同一未读提醒不重复。 */
  async function notifyStaleReconcileReports(
    reviewId: string,
    auth: any,
    log?: any,
  ): Promise<void> {
    try {
      const docs = await listReconcileDocuments(reviewId);
      if (!docs.some((doc) => doc.is_stale)) return;
      const review = await one<any>(
        `SELECT engagement_id, document_id
           FROM copilot_reconcile_reviews WHERE id = $1`,
        [reviewId],
      );
      if (!review?.engagement_id || !auth?.org_id) return;
      const recipients = await query<{ id: string }>(
        `SELECT u.id
           FROM users u
           JOIN memberships m ON m.user_id = u.id
          WHERE u.org_id = $1
            AND u.status = 'active'
            AND m.role IN ('admin', 'director', 'pm')
            AND u.id <> $2`,
        [auth.org_id, auth.sub],
      );
      for (const recipient of recipients) {
        await query(
          `INSERT INTO user_notifications
             (org_id, user_id, actor_id, kind, title, body, link, ref_type, ref_id)
           SELECT $1,$2,$3,'copilot_reconcile_report_stale',$4,$5,$6,
                  'copilot_reconcile_review',$7
            WHERE NOT EXISTS (
              SELECT 1 FROM user_notifications n
               WHERE n.user_id = $2
                 AND n.kind = 'copilot_reconcile_report_stale'
                 AND n.ref_id = $7
                 AND n.read_at IS NULL
                 AND n.deleted_at IS NULL
            )`,
          [
            auth.org_id,
            recipient.id,
            auth.sub,
            '复核报告已过期',
            `复核 ${review.document_id ?? reviewId} 的报告需要重新生成`,
            `#/engagements/${review.engagement_id}?tab=reports`,
            reviewId,
          ],
        );
      }
    } catch (err) {
      log?.warn?.({ err }, 'stale report notification failed');
    }
  }

  /** 在交付平台记录单条差异的决策（采纳 / 忽略 / 待确认）。 */
  app.put('/api/copilot-reconcile-reviews/:id/decisions', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z
      .object({
        difference_id: z.string().trim().min(1).max(200),
        decision: z.enum(['采纳', '忽略', '待确认']),
        note: z.string().trim().max(500).nullable().optional(),
      })
      .parse(req.body ?? {});
    const auth = (req as any).authUser;
    if (!auth?.sub) throw httpError(401, 'UNAUTHORIZED', '请先登录');

    const decisions = await withTransaction(async (client) => {
      const found = await client.query<any>(
        `SELECT differences, decisions
           FROM copilot_reconcile_reviews WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const review = found.rows[0];
      if (!review) throw httpError(404, 'NOT_FOUND', '对账复核记录不存在');
      const diffs = Array.isArray(review.differences) ? review.differences : [];
      if (
        !diffs.some(
          (d: any) => String(d?.difference_id ?? '') === body.difference_id,
        )
      ) {
        throw httpError(422, 'DIFFERENCE_NOT_FOUND', '差异不存在');
      }
      const existing = Array.isArray(review.decisions) ? review.decisions : [];
      const next = mergeDifferenceDecision(
        existing,
        body.difference_id,
        body.decision,
        body.note,
        auth,
      );
      await client.query(
        `UPDATE copilot_reconcile_reviews SET decisions = $2::jsonb WHERE id = $1`,
        [id, JSON.stringify(next)],
      );
      return next;
    });

    try {
      await query(
        `INSERT INTO audit_logs
           (org_id, user_id, action, object_type, object_id, status_code, detail)
         VALUES ($1,$2,'DECIDE copilot-reconcile-difference',
                 'copilot_reconcile_review',$3,200,$4::jsonb)`,
        [
          auth.org_id ?? null,
          auth.sub,
          id,
          JSON.stringify({
            difference_id: body.difference_id,
            decision: body.decision,
            note: body.note ?? null,
          }),
        ],
      );
    } catch (err) {
      req.log?.warn?.({ err }, 'decision audit failed');
    }
    await notifyStaleReconcileReports(id, auth, req.log);

    return { decisions };
  });

  /** 批量记录决策；任一差异不存在则整批不生效。 */
  app.post('/api/copilot-reconcile-reviews/:id/decisions/batch', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z
      .object({
        difference_ids: z
          .array(z.string().trim().min(1).max(200))
          .min(1)
          .max(500),
        decision: z.enum(['采纳', '忽略', '待确认']),
        note: z.string().trim().max(500).nullable().optional(),
      })
      .parse(req.body ?? {});
    const auth = (req as any).authUser;
    if (!auth?.sub) throw httpError(401, 'UNAUTHORIZED', '请先登录');
    const unique = Array.from(new Set(body.difference_ids));

    const decisions = await withTransaction(async (client) => {
      const found = await client.query<any>(
        `SELECT differences, decisions
           FROM copilot_reconcile_reviews WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const review = found.rows[0];
      if (!review) throw httpError(404, 'NOT_FOUND', '对账复核记录不存在');
      const diffs = Array.isArray(review.differences) ? review.differences : [];
      const known = new Set(
        diffs.map((d: any) => String(d?.difference_id ?? '')),
      );
      const missing = unique.filter((differenceId) => !known.has(differenceId));
      if (missing.length) {
        throw httpError(
          422,
          'DIFFERENCE_NOT_FOUND',
          `差异不存在：${missing.slice(0, 5).join('、')}`,
        );
      }
      let next = Array.isArray(review.decisions) ? review.decisions : [];
      for (const differenceId of unique) {
        next = mergeDifferenceDecision(
          next,
          differenceId,
          body.decision,
          body.note,
          auth,
        );
      }
      await client.query(
        `UPDATE copilot_reconcile_reviews SET decisions = $2::jsonb WHERE id = $1`,
        [id, JSON.stringify(next)],
      );
      return next;
    });

    try {
      await query(
        `INSERT INTO audit_logs
           (org_id, user_id, action, object_type, object_id, status_code, detail)
         VALUES ($1,$2,'DECIDE copilot-reconcile-difference',
                 'copilot_reconcile_review',$3,200,$4::jsonb)`,
        [
          auth.org_id ?? null,
          auth.sub,
          id,
          JSON.stringify({
            mode: 'batch',
            count: unique.length,
            decision: body.decision,
            difference_ids: unique.slice(0, 20),
          }),
        ],
      );
    } catch (err) {
      req.log?.warn?.({ err }, 'decision audit failed');
    }
    await notifyStaleReconcileReports(id, auth, req.log);

    return { decisions, updated: unique.length };
  });

  /** 复核记录 Markdown（便于排查与二次加工）。 */
  app.get('/api/copilot-reconcile-reviews/:id/document', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const bundle = await loadReconcileBundle(id);
    const rendered = renderReconcileDoc(bundle);
    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .send(rendered.markdown);
  });

  /** 该复核生成的报告交付物（含是否过期）。 */
  app.get('/api/copilot-reconcile-reviews/:id/documents', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const items = await listReconcileDocuments(id);
    return { items };
  });

  /** 生成复核报告交付物（data_report），审批后走现有分享流程外发。 */
  app.post('/api/copilot-reconcile-reviews/:id/documents', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const item = await generateReconcileDeliverable(id);
    const auth = (req as any).authUser;
    try {
      await query(
        `INSERT INTO audit_logs
           (org_id, user_id, action, object_type, object_id, status_code, detail)
         VALUES ($1,$2,'GENERATE copilot-reconcile-document',
                 'copilot_reconcile_review',$3,200,$4::jsonb)`,
        [
          auth?.org_id ?? null,
          auth?.sub ?? null,
          id,
          JSON.stringify({ deliverable_id: item.id, version: item.version }),
        ],
      );
    } catch (err) {
      req.log?.warn?.({ err }, 'reconcile document audit failed');
    }
    return reply.code(201).send({ item });
  });

  /** 复核记录 Word：含差异依据（来源、置信度、证据）。 */
  app.get('/api/copilot-reconcile-reviews/:id/document.docx', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const bundle = await loadReconcileBundle(id);
    const rendered = renderReconcileDoc(bundle);
    const buffer = await buildDocx(rendered.markdown, {
      title: rendered.title,
      client: rendered.meta.client,
      project: rendered.meta.project,
      version: rendered.meta.version,
    });
    await recordExportAudit(req, 'EXPORT copilot-reconcile-document', id, {
      format: 'docx',
      differences: Array.isArray(bundle.review.differences)
        ? bundle.review.differences.length
        : 0,
    });
    return reply
      .header(
        'content-type',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      )
      .header(
        'content-disposition',
        docDisposition(rendered.title, 'docx'),
      )
      .send(buffer);
  });

  /** 从对账复核记录生成风险/待办；可按单条差异生成，重复调用幂等。 */
  app.post('/api/copilot-reconcile-reviews/:id/actions', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = actionBody.parse(req.body);
    const auth = (req as any).authUser;
    const differenceId = body.difference_id?.trim() || null;

    const result = await withTransaction(async (client) => {
      const found = await client.query<any>(
        `SELECT * FROM copilot_reconcile_reviews WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const review = found.rows[0];
      if (!review) throw httpError(404, 'NOT_FOUND', '对账复核记录不存在');
      if (!review.engagement_id) throw httpError(422, 'NO_ENGAGEMENT', '复核记录未关联项目');

      if (differenceId) {
        const diffs = Array.isArray(review.differences) ? review.differences : [];
        if (!diffs.some((d: any) => String(d?.difference_id ?? '') === differenceId)) {
          throw httpError(422, 'DIFFERENCE_NOT_FOUND', '差异不存在');
        }
        const dup = await client.query<{ id: string; target_id: string }>(
          `SELECT id, target_id FROM copilot_reconcile_actions
            WHERE review_id = $1 AND difference_id = $2 AND action_type = $3`,
          [id, differenceId, body.type],
        );
        if (dup.rows[0]) {
          return {
            duplicate: true,
            type: body.type,
            item_id: dup.rows[0].target_id,
            action_id: dup.rows[0].id,
            difference_id: differenceId,
            engagement_id: review.engagement_id,
          };
        }
      } else {
        const existing = body.type === 'risk' ? review.risk_id : review.issue_id;
        if (existing) {
          return {
            duplicate: true,
            type: body.type,
            item_id: existing,
            difference_id: null,
            engagement_id: review.engagement_id,
          };
        }
      }

      const owner = body.owner ?? auth?.sub ?? null;
      if (owner) {
        const foundOwner = await client.query(
          `SELECT 1 FROM users WHERE id = $1 AND org_id = $2`,
          [owner, review.org_id],
        );
        if (!foundOwner.rows[0]) {
          throw httpError(422, 'OWNER_NOT_FOUND', '负责人不属于当前组织');
        }
      }
      const orgRow = await client.query<{ settings: any }>(
        `SELECT settings FROM organizations WHERE id = $1`,
        [review.org_id],
      );
      const region = String(orgRow.rows[0]?.settings?.region || 'CN').toUpperCase();
      const holidayRows = await client.query(
        `SELECT date::text AS date
           FROM holiday_calendar
          WHERE active
            AND (org_id IS NULL OR org_id = $1)
            AND (region = $2 OR region = 'ALL')
            AND date >= current_date
            AND date <= current_date + interval '365 days'`,
        [review.org_id, region],
      );
      const holidays = new Set<string>(holidayRows.rows.map((r: any) => r.date));

      const severity = body.severity ?? 'P2';
      const dueDate = body.due_date ?? slaDueDate(severity, holidays);
      const riskDue = body.due_date ?? slaDueDate(
        body.impact === 5 ? 'P0' : body.impact === 4 ? 'P1' : body.impact === 3 ? 'P2' : 'P3',
        holidays,
      );

      const recordAction = async (actionType: string, targetId: string) => {
        if (!differenceId) return null;
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO copilot_reconcile_actions
             (review_id, difference_id, action_type, target_id, created_by)
           VALUES ($1,$2,$3,$4,$5)
           RETURNING id`,
          [id, differenceId, actionType, targetId, auth?.sub ?? null],
        );
        return inserted.rows[0].id;
      };

      if (body.type === 'risk') {
        const row = await client.query<{ id: string }>(
          `INSERT INTO risks
             (engagement_id, title, category, probability, impact, mitigation, status, owner, due_date)
           VALUES ($1,$2,'commercial',$3,$4,$5,'open',$6,$7)
           RETURNING id`,
          [
            review.engagement_id,
            body.title,
            body.probability ?? 3,
            body.impact ?? 3,
            body.detail ?? null,
            owner,
            riskDue,
          ],
        );
        const actionId = await recordAction('risk', row.rows[0].id);
        if (!differenceId) {
          await client.query(
            `UPDATE copilot_reconcile_reviews SET risk_id = $2 WHERE id = $1`,
            [id, row.rows[0].id],
          );
        }
        return {
          duplicate: false,
          type: 'risk' as const,
          item_id: row.rows[0].id,
          action_id: actionId,
          difference_id: differenceId,
          engagement_id: review.engagement_id,
        };
      }

      const code = await nextIssueCode(client, review.engagement_id);
      const row = await client.query<{ id: string; code: string }>(
        `INSERT INTO delivery_issues
           (engagement_id, code, kind, title, description, severity, status,
            owner, due_date, impact, approval_status)
         VALUES ($1,$2,'issue',$3,$4,$5,'open',$6,$7,$8,'not_required')
         RETURNING id, code`,
        [
          review.engagement_id,
          code,
          body.title,
          body.detail ?? null,
          severity,
          owner,
          dueDate,
          body.impact_text ?? null,
        ],
      );
      const actionId = await recordAction('issue', row.rows[0].id);
      if (!differenceId) {
        await client.query(
          `UPDATE copilot_reconcile_reviews SET issue_id = $2 WHERE id = $1`,
          [id, row.rows[0].id],
        );
      }
      return {
        duplicate: false,
        type: 'issue' as const,
        item_id: row.rows[0].id,
        item_code: row.rows[0].code,
        action_id: actionId,
        difference_id: differenceId,
        engagement_id: review.engagement_id,
      };
    });

    return reply.code(result.duplicate ? 200 : 201).send({ ok: true, ...result });
  });


  /** 批量生成（NDJSON 流式）：逐条返回进度，单条独立事务。 */
  app.post('/api/copilot-reconcile-reviews/:id/actions/batch/stream', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = batchActionBody.parse(req.body);
    const auth = (req as any).authUser;
    const owner = body.owner ?? auth?.sub ?? null;
    const severity = body.severity ?? 'P2';
    const createdBy = auth?.sub ?? null;

    // 先做整批复核/负责人校验，避免流开始后才报错。
    await withTransaction(async (client) => {
      const found = await client.query<any>(
        `SELECT id, engagement_id, org_id FROM copilot_reconcile_reviews WHERE id = $1`,
        [id],
      );
      const review = found.rows[0];
      if (!review) throw httpError(404, 'NOT_FOUND', '对账复核记录不存在');
      if (!review.engagement_id) throw httpError(422, 'NO_ENGAGEMENT', '复核记录未关联项目');
      if (owner) {
        const foundOwner = await client.query(
          `SELECT 1 FROM users WHERE id = $1 AND org_id = $2`,
          [owner, review.org_id],
        );
        if (!foundOwner.rows[0]) {
          throw httpError(422, 'OWNER_NOT_FOUND', '负责人不属于当前组织');
        }
      }
    });

    const batchId = await createBatchRecord({
      reviewId: id,
      type: body.type,
      requested: body.difference_ids.length,
      differenceIds: body.difference_ids,
      owner,
      severity,
      dueDate: body.due_date ?? null,
      createdBy,
    });

    await streamBatchResponse(reply, req, {
      reviewId: id,
      batchId,
      differenceIds: body.difference_ids,
      type: body.type,
      owner,
      severity,
      dueDate: body.due_date ?? null,
      createdBy,
    });
  });

  /** 批量按差异生成风险/待办：逐条保存点，部分成功可返回失败明细。 */
  app.post('/api/copilot-reconcile-reviews/:id/actions/batch', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = batchActionBody.parse(req.body);
    const auth = (req as any).authUser;

    const result = await withTransaction(async (client) => {
      const found = await client.query<any>(
        `SELECT * FROM copilot_reconcile_reviews WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const review = found.rows[0];
      if (!review) throw httpError(404, 'NOT_FOUND', '对账复核记录不存在');
      if (!review.engagement_id) throw httpError(422, 'NO_ENGAGEMENT', '复核记录未关联项目');

      const owner = body.owner ?? auth?.sub ?? null;
      if (owner) {
        const foundOwner = await client.query(
          `SELECT 1 FROM users WHERE id = $1 AND org_id = $2`,
          [owner, review.org_id],
        );
        if (!foundOwner.rows[0]) {
          throw httpError(422, 'OWNER_NOT_FOUND', '负责人不属于当前组织');
        }
      }

      const severity = body.severity ?? 'P2';
      const batchId = await createBatchRecord({
        reviewId: id,
        type: body.type,
        requested: body.difference_ids.length,
        differenceIds: body.difference_ids,
        owner,
        severity,
        dueDate: body.due_date ?? null,
        createdBy: auth?.sub ?? null,
      });

      const diffList = Array.isArray(review.differences) ? review.differences : [];
      const diffIndex = new Map<string, any>();
      for (const d of diffList) {
        if (d?.difference_id) diffIndex.set(String(d.difference_id), d);
      }
      const holidays = await loadHolidays(client, review.org_id);

      const items: Array<Record<string, unknown>> = [];
      const seen = new Set<string>();
      for (const raw of body.difference_ids) {
        const differenceId = raw.trim();
        if (seen.has(differenceId)) {
          const item = {
            difference_id: differenceId,
            status: 'failed',
            code: 'DUPLICATE_IN_REQUEST',
            error: '同一差异在请求中重复出现',
          };
          items.push(item);
          await recordBatchItem(batchId, differenceId, item).catch(() => undefined);
          continue;
        }
        seen.add(differenceId);

        const diff = diffIndex.get(differenceId);
        if (!diff) {
          const item = {
            difference_id: differenceId,
            status: 'failed',
            code: 'DIFFERENCE_NOT_FOUND',
            error: '差异不存在',
          };
          items.push(item);
          await recordBatchItem(batchId, differenceId, item).catch(() => undefined);
          continue;
        }

        await client.query('SAVEPOINT batch_action');
        try {
          const created = await insertDiffAction(client, review, diff, {
            type: body.type,
            owner,
            severity,
            dueDate: body.due_date ?? null,
            holidays,
            createdBy: auth?.sub ?? null,
          });
          await client.query('RELEASE SAVEPOINT batch_action');
          const item = { difference_id: differenceId, ...created };
          items.push(item);
          await recordBatchItem(batchId, differenceId, item).catch(() => undefined);
        } catch (err: any) {
          await client.query('ROLLBACK TO SAVEPOINT batch_action');
          const item = {
            difference_id: differenceId,
            status: 'failed',
            code: err?.code ?? 'ACTION_FAILED',
            error: err?.message ?? '生成失败',
          };
          items.push(item);
          await recordBatchItem(batchId, differenceId, item).catch(() => undefined);
        }
      }

      const created = items.filter((i: any) => i.status === 'created').length;
      const skipped = items.filter((i: any) => i.status === 'duplicate').length;
      const failed = items.filter((i: any) => i.status === 'failed').length;
      await finishBatchRecord(batchId, { created, skipped, failed });

      return {
        batch_id: batchId,
        type: body.type,
        engagement_id: review.engagement_id,
        items,
      };
    });

    const created = result.items.filter((i: any) => i.status === 'created').length;
    const skipped = result.items.filter((i: any) => i.status === 'duplicate').length;
    const failed = result.items.filter((i: any) => i.status === 'failed').length;
    return reply
      .code(created ? 201 : 200)
      .send({ ok: true, ...result, created, skipped, failed });
  });

  /** 批量生成历史：按复核记录列出最近批次与失败差异。 */
  app.get('/api/copilot-reconcile-reviews/:id/action-batches', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { limit, offset } = z
      .object({
        limit: z.coerce.number().int().min(1).max(50).default(20),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
      })
      .parse(req.query ?? {});
    const filters = parseBatchExportFilters(req.query);

    // 懒回收：列表读取时把超时的 running 批次标记为失败。
    await reapStaleBatches();

    // 筛选按批次组：组内任一批次命中，就返回整棵树。
    const { clause, values } = batchFilterSql(filters, 'tree', 4);
    const rows = await query<any>(
      `${BATCH_TREE_CTE},
       matched AS (
         SELECT DISTINCT root_id, root_created_at
           FROM tree WHERE 1=1 ${clause}
       ),
       paged AS (
         SELECT root_id, root_created_at
           FROM matched
          ORDER BY root_created_at DESC
          LIMIT $2 OFFSET $3
       )
       SELECT b.*, t.depth,
              u.name AS created_by_name,
              cu.name AS cancelled_by_name,
              CASE
                WHEN b.parent_batch_id IS NULL THEN NULL
                WHEN pb.status = 'cancelled' THEN 'resume'
                ELSE 'retry'
              END AS parent_relation
         FROM paged p
         JOIN tree t ON t.root_id = p.root_id
         JOIN copilot_reconcile_batches b ON b.id = t.id
         LEFT JOIN users u ON u.id = b.created_by
         LEFT JOIN users cu ON cu.id = b.cancelled_by
         LEFT JOIN copilot_reconcile_batches pb ON pb.id = b.parent_batch_id
        ORDER BY p.root_created_at DESC, p.root_id, t.depth, b.created_at`,
      [id, limit, offset, ...values],
    );

    const { clause: countClause, values: countValues } = batchFilterSql(
      filters,
      'tree',
      2,
    );
    const countRows = await query<any>(
      `${BATCH_TREE_CTE},
       matched AS (
         SELECT DISTINCT root_id FROM tree WHERE 1=1 ${countClause}
       )
       SELECT
         (SELECT count(*) FROM matched) AS root_count,
         (SELECT count(*) FROM tree t
            JOIN matched m ON m.root_id = t.root_id) AS batch_count`,
      [id, ...countValues],
    );

    const batchIds = rows.map((r) => r.id);
    const itemRows = batchIds.length
      ? await query<{ batch_id: string; difference_id: string; status: string }>(
          `SELECT batch_id, difference_id, status
             FROM copilot_reconcile_batch_items
            WHERE batch_id = ANY($1::uuid[])
            ORDER BY created_at`,
          [batchIds],
        )
      : [];

    const itemsByBatch = new Map<string, Array<{ difference_id: string; status: string }>>();
    for (const item of itemRows) {
      const list = itemsByBatch.get(item.batch_id) ?? [];
      list.push({ difference_id: item.difference_id, status: item.status });
      itemsByBatch.set(item.batch_id, list);
    }

    const childrenByBatch = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.parent_batch_id) continue;
      const list = childrenByBatch.get(row.parent_batch_id) ?? [];
      list.push(row.id);
      childrenByBatch.set(row.parent_batch_id, list);
    }

    // 一次树遍历算好每个批次及其后代的已处理差异，避免逐行递归查询。
    const processedCache = new Map<string, Set<string>>();
    const processedSubtree = (batchId: string): Set<string> => {
      const cached = processedCache.get(batchId);
      if (cached) return cached;
      const processed = new Set<string>(
        (itemsByBatch.get(batchId) ?? []).map((i) => String(i.difference_id)),
      );
      for (const childId of childrenByBatch.get(batchId) ?? []) {
        for (const differenceId of processedSubtree(childId)) {
          processed.add(differenceId);
        }
      }
      processedCache.set(batchId, processed);
      return processed;
    };

    const items = rows.map((row) => {
      const processed = processedSubtree(row.id);
      const all = Array.isArray(row.difference_ids) ? row.difference_ids : [];
      const remaining = all
        .map((v: any) => String(v))
        .filter((differenceId: string) => !processed.has(differenceId));
      const failed = (itemsByBatch.get(row.id) ?? [])
        .filter((i) => i.status === 'failed')
        .map((i) => i.difference_id);
      return {
        ...row,
        has_child: (childrenByBatch.get(row.id)?.length ?? 0) > 0,
        failed_difference_ids: failed,
        remaining_difference_ids: remaining,
      };
    });

    return {
      items,
      total: Number(countRows[0]?.root_count ?? 0),
      batch_total: Number(countRows[0]?.batch_count ?? 0),
      roots_returned: rows.filter((r) => r.depth === 0).length,
      limit,
      offset,
    };
  });

  /** 命名筛选视图：只对当前用户可见。 */
  app.get(
    '/api/copilot-reconcile-reviews/:id/batch-filter-views',
    async (req) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const auth = (req as any).authUser;
      if (!auth?.sub) throw httpError(401, 'UNAUTHORIZED', '请先登录');
      const items = await query(
        `SELECT v.id, v.name, v.status, v.action_type,
                v.from_date::text AS "from", v.to_date::text AS "to",
                v.shared, v.shared_role, (v.user_id = $2) AS is_owner,
                u.name AS owner_name,
                COALESCE((
                  SELECT json_agg(s.user_id)
                    FROM copilot_batch_filter_view_shares s
                   WHERE s.view_id = v.id
                ), '[]'::json) AS shared_user_ids,
                v.created_at, v.updated_at
           FROM copilot_batch_filter_views v
           LEFT JOIN users u ON u.id = v.user_id
          WHERE v.review_id = $1
            AND (
              v.user_id = $2
              OR v.shared
              OR v.shared_role = $3
              OR EXISTS (
                SELECT 1 FROM copilot_batch_filter_view_shares s
                 WHERE s.view_id = v.id AND s.user_id = $2
              )
            )
          ORDER BY v.name`,
        [id, auth.sub, auth.role ?? ''],
      );
      return { items };
    },
  );

  /** 当前复核的筛选视图审计。 */
  app.get(
    '/api/copilot-reconcile-reviews/:id/batch-filter-view-audits',
    async (req) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const { limit, offset } = z
        .object({
          limit: z.coerce.number().int().min(1).max(100).default(20),
          offset: z.coerce.number().int().min(0).max(100000).default(0),
        })
        .parse(req.query ?? {});
      const [items, totals] = await Promise.all([
        query(
          `SELECT a.id, a.action, a.user_id, u.name AS actor_name,
                  a.detail, a.created_at
             FROM audit_logs a
             LEFT JOIN users u ON u.id = a.user_id
            WHERE a.object_type = 'copilot_batch_filter_view'
              AND a.detail->>'review_id' = $1
            ORDER BY a.created_at DESC
            LIMIT $2 OFFSET $3`,
          [id, limit, offset],
        ),
        query<{ count: string }>(
          `SELECT count(*)::text AS count FROM audit_logs
            WHERE object_type = 'copilot_batch_filter_view'
              AND detail->>'review_id' = $1`,
          [id],
        ),
      ]);
      return {
        items,
        total: Number(totals[0]?.count ?? 0),
        limit,
        offset,
      };
    },
  );

  /** 导出当前复核的筛选视图审计 CSV。 */
  app.get(
    '/api/copilot-reconcile-reviews/:id/batch-filter-view-audits/export.csv',
    async (req, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const rows = await query<any>(
        `SELECT a.id, a.action, a.user_id, u.name AS actor_name,
                a.detail, a.created_at
           FROM audit_logs a
           LEFT JOIN users u ON u.id = a.user_id
          WHERE a.object_type = 'copilot_batch_filter_view'
            AND a.detail->>'review_id' = $1
          ORDER BY a.created_at DESC
          LIMIT 5000`,
        [id],
      );

      const header = [
        '时间',
        '操作',
        '视图',
        '操作人',
        '全员共享',
        '共享角色',
        '指定人数',
        '筛选状态',
        '筛选类型',
        '开始日期',
        '结束日期',
      ];
      const lines = [header.join(',')];
      for (const row of rows) {
        const detail = row.detail ?? {};
        const filters = detail.filters ?? {};
        lines.push(
          [
            row.created_at ? new Date(row.created_at).toISOString() : '',
            String(row.action).startsWith('DELETE') ? '删除' : '保存',
            detail.name,
            row.actor_name,
            detail.shared ? '是' : '否',
            detail.shared_role
              ? VIEW_ROLE_LABEL[detail.shared_role] ?? detail.shared_role
              : '',
            Array.isArray(detail.shared_user_ids)
              ? detail.shared_user_ids.length
              : 0,
            filters.status,
            filters.action_type,
            filters.from,
            filters.to,
          ]
            .map(csvCell)
            .join(','),
        );
      }

      await recordExportAudit(
        req,
        'EXPORT copilot-batch-filter-view-audits',
        id,
        { format: 'csv', rows: rows.length },
      );

      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="copilot-batch-filter-view-audits-${id}.csv"`,
        )
        .send(`\uFEFF${lines.join('\r\n')}`);
    },
  );

  app.post(
    '/api/copilot-reconcile-reviews/:id/batch-filter-views',
    async (req, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const auth = (req as any).authUser;
      if (!auth?.sub || !auth?.org_id) {
        throw httpError(401, 'UNAUTHORIZED', '请先登录');
      }
      const body = batchFilterViewBody.parse(req.body ?? {});
      if (body.from && body.to && body.from > body.to) {
        throw httpError(400, 'INVALID_DATE_RANGE', '开始日期不能晚于结束日期');
      }
      const sharedUserIds = Array.from(new Set(body.shared_user_ids ?? []));

      const item = await withTransaction(async (client) => {
        const review = await client.query(
          `SELECT id, engagement_id FROM copilot_reconcile_reviews WHERE id = $1`,
          [id],
        );
        if (!review.rows[0]) throw httpError(404, 'NOT_FOUND', '对账复核记录不存在');
        const reviewEngagementId = review.rows[0].engagement_id as
          | string
          | null;
        const notificationLink = reviewEngagementId
          ? `#/engagements/${reviewEngagementId}?review=${id}`
          : '#/';

        if (sharedUserIds.length) {
          const found = await client.query(
            `SELECT id FROM users
              WHERE org_id = $1 AND id = ANY($2::uuid[])`,
            [auth.org_id, sharedUserIds],
          );
          if (found.rows.length !== sharedUserIds.length) {
            throw httpError(422, 'INVALID_SHARED_USERS', '共享对象不属于当前组织');
          }
        }

        const existingView = await client.query(
          `SELECT id, shared, shared_role
             FROM copilot_batch_filter_views
            WHERE review_id = $1 AND user_id = $2 AND name = $3`,
          [id, auth.sub, body.name],
        );
        let effectiveShareIds = sharedUserIds;
        let oldRecipients = new Set<string>();
        if (existingView.rows[0]) {
          const existingShares = await client.query(
            `SELECT user_id FROM copilot_batch_filter_view_shares WHERE view_id = $1`,
            [existingView.rows[0].id],
          );
          const existingShareIds = existingShares.rows.map(
            (row: any) => row.user_id as string,
          );
          if (body.shared_user_ids === undefined) {
            effectiveShareIds = existingShareIds;
          }
          oldRecipients = await batchViewRecipients(
            client,
            auth.org_id,
            existingView.rows[0],
            existingShareIds,
          );
        }

        const inserted = await client.query(
          `INSERT INTO copilot_batch_filter_views
             (org_id, review_id, user_id, name, status, action_type, from_date, to_date, shared, shared_role)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (review_id, user_id, name)
           DO UPDATE SET status = EXCLUDED.status,
                         action_type = EXCLUDED.action_type,
                         from_date = EXCLUDED.from_date,
                         to_date = EXCLUDED.to_date,
                         shared = EXCLUDED.shared,
                         shared_role = EXCLUDED.shared_role,
                         updated_at = now()
           RETURNING id`,
          [
            auth.org_id,
            id,
            auth.sub,
            body.name,
            body.status ?? null,
            body.action_type ?? null,
            body.from ?? null,
            body.to ?? null,
            body.shared ?? false,
            body.shared_role ?? null,
          ],
        );
        const viewId = inserted.rows[0].id as string;

        if (body.shared_user_ids !== undefined) {
          await client.query(
            `DELETE FROM copilot_batch_filter_view_shares WHERE view_id = $1`,
            [viewId],
          );
          if (sharedUserIds.length) {
            await client.query(
              `INSERT INTO copilot_batch_filter_view_shares (view_id, user_id)
               SELECT $1, unnest($2::uuid[])`,
              [viewId, sharedUserIds],
            );
          }
        }

        const newRecipients = await batchViewRecipients(
          client,
          auth.org_id,
          {
            shared: body.shared ?? false,
            shared_role: body.shared_role ?? null,
          },
          effectiveShareIds,
        );
        const recipients = [...newRecipients].filter(
          (userId) => userId !== auth.sub && !oldRecipients.has(userId),
        );
        if (recipients.length) {
          await client.query(
            `INSERT INTO user_notifications
               (org_id, user_id, actor_id, kind, title, body, link, ref_type, ref_id)
             SELECT $1, unnest($2::uuid[]), $3,
                    'copilot_batch_filter_view_shared',
                    $4, $5, $6, 'copilot_batch_filter_view', $7`,
            [
              auth.org_id,
              recipients,
              auth.sub,
              `筛选视图已共享：${body.name}`,
              `${auth.name ?? '同事'} 共享了筛选视图「${body.name}」`,
              reviewEngagementId
                ? `${notificationLink}&view=${viewId}`
                : '#/',
              viewId,
            ],
          );
        }

        const row = await client.query(
          `SELECT v.id, v.name, v.status, v.action_type,
                  v.from_date::text AS "from", v.to_date::text AS "to",
                  v.shared, v.shared_role, true AS is_owner,
                  (SELECT name FROM users WHERE id = v.user_id) AS owner_name,
                  COALESCE((
                    SELECT json_agg(s.user_id)
                      FROM copilot_batch_filter_view_shares s
                     WHERE s.view_id = v.id
                  ), '[]'::json) AS shared_user_ids,
                  v.created_at, v.updated_at
             FROM copilot_batch_filter_views v
            WHERE v.id = $1`,
          [viewId],
        );
        return row.rows[0];
      });

      await recordViewAudit(req, 'SAVE copilot-batch-filter-view', item.id, {
        review_id: id,
        name: item.name,
        shared: item.shared,
        shared_role: item.shared_role,
        shared_user_ids: item.shared_user_ids,
        filters: {
          status: item.status,
          action_type: item.action_type,
          from: item.from,
          to: item.to,
        },
      });

      return reply.code(201).send({ item });
    },
  );

  app.delete('/api/copilot-batch-filter-views/:id', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const auth = (req as any).authUser;
    if (!auth?.sub) throw httpError(401, 'UNAUTHORIZED', '请先登录');
    const existing = await one<{
      id: string;
      name: string;
      review_id: string;
    }>(
      `SELECT id, name, review_id FROM copilot_batch_filter_views
        WHERE id = $1 AND user_id = $2`,
      [id, auth.sub],
    );
    if (!existing) throw httpError(404, 'NOT_FOUND', '筛选视图不存在');
    await query(`DELETE FROM copilot_batch_filter_views WHERE id = $1`, [id]);
    await recordViewAudit(req, 'DELETE copilot-batch-filter-view', id, {
      review_id: existing.review_id,
      name: existing.name,
    });
    return { ok: true };
  });

  /** 导出预估：按当前筛选返回批次/明细数与大致体积。 */
  app.get(
    '/api/copilot-reconcile-reviews/:id/action-batches/export-estimate',
    async (req) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const filters = parseBatchExportFilters(req.query);
      const { clause, values } = batchFilterSql(filters, 'tree', 2);
      const rows = await query<any>(
        `${BATCH_TREE_CTE},
         matched AS (
           SELECT DISTINCT root_id FROM tree WHERE 1=1 ${clause}
         )
         SELECT
           (SELECT count(*) FROM tree t
              JOIN matched m ON m.root_id = t.root_id) AS batches,
           (SELECT count(*) FROM copilot_reconcile_batch_items i
              JOIN tree t ON t.id = i.batch_id
              JOIN matched m ON m.root_id = t.root_id) AS items`,
        [id, ...values],
      );
      const batches = Number(rows[0]?.batches ?? 0);
      const items = Number(rows[0]?.items ?? 0);
      const summary = 400 + batches * 260;
      const itemBytes = 800 + items * 900;
      return {
        batches,
        items,
        estimated_bytes: {
          summary,
          items: itemBytes,
          zip: summary + itemBytes + 300,
        },
        large: batches > 500 || items > 5000,
        filters,
      };
    },
  );

  /** 导出批量历史 CSV（支持状态/类型/日期筛选）。 */
  app.get(
    '/api/copilot-reconcile-reviews/:id/action-batches/export.csv',
    async (req, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const filters = parseBatchExportFilters(req.query);
      const rows = await loadBatchSummaryRows(id, filters);
      const csv = buildBatchSummaryCsv(rows);
      await recordExportAudit(req, 'EXPORT copilot-batch-summary', id, {
        format: 'csv',
        rows: rows.length,
        filters,
      });
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="copilot-batches-${id}.csv"`,
        )
        .send(csv);
    },
  );

  /** 导出复核差异 CSV（含来源、置信度与证据）。 */
  app.get(
    '/api/copilot-reconcile-reviews/:id/differences/export.csv',
    async (req, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const review = await one<any>(
        `SELECT differences, decisions FROM copilot_reconcile_reviews WHERE id = $1`,
        [id],
      );
      if (!review) {
        throw httpError(404, 'NOT_FOUND', '对账复核记录不存在');
      }
      const decisions = new Map<string, any>();
      for (const d of Array.isArray(review.decisions) ? review.decisions : []) {
        if (d?.difference_id) decisions.set(String(d.difference_id), d);
      }
      const diffs = Array.isArray(review.differences) ? review.differences : [];
      const header = [
        '差异ID',
        '类型',
        '运单/趟次',
        '对账单金额',
        '系统金额',
        '差额',
        '来源',
        '置信度',
        '证据',
        '可能原因',
        '建议动作',
        '决策',
        '备注',
      ];
      const lines = [header.join(',')];
      for (const diff of diffs) {
        const decision = diff?.difference_id
          ? decisions.get(String(diff.difference_id))
          : undefined;
        lines.push(
          [
            diff?.difference_id,
            DIFF_LABEL[diff?.type] ?? diff?.type,
            diff?.waybill_no || diff?.trip_no || '',
            diff?.statement_amount,
            diff?.system_amount,
            diff?.delta,
            diff?.source,
            diff?.confidence,
            Array.isArray(diff?.evidence) ? diff.evidence.join('；') : '',
            Array.isArray(diff?.possible_causes)
              ? diff.possible_causes.join('；')
              : '',
            diff?.suggested_action,
            decision?.decision,
            decision?.note,
          ]
            .map(csvCell)
            .join(','),
        );
      }
      await recordExportAudit(req, 'EXPORT copilot-reconcile-differences', id, {
        format: 'csv',
        rows: diffs.length,
      });
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="copilot-differences-${id}.csv"`,
        )
        .send(`\uFEFF${lines.join('\r\n')}`);
    },
  );

  /** 导出批量逐条明细 CSV（支持状态/类型/日期筛选）。 */
  app.get(
    '/api/copilot-reconcile-reviews/:id/action-batches/export-items.csv',
    async (req, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const filters = parseBatchExportFilters(req.query);
      const rows = await loadBatchItemRows(id, filters);
      const csv = await buildBatchItemsCsv(id, rows);
      await recordExportAudit(req, 'EXPORT copilot-batch-items', id, {
        format: 'csv',
        rows: rows.length,
        filters,
      });
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="copilot-batch-items-${id}.csv"`,
        )
        .send(csv);
    },
  );

  /** 导出 ZIP：汇总 CSV + 逐条明细 CSV，使用同一组筛选条件。 */
  app.get(
    '/api/copilot-reconcile-reviews/:id/action-batches/export.zip',
    async (req, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const filters = parseBatchExportFilters(req.query);
      const [summaryRows, itemRows] = await Promise.all([
        loadBatchSummaryRows(id, filters),
        loadBatchItemRows(id, filters),
      ]);
      const summaryCsv = buildBatchSummaryCsv(summaryRows);
      const itemsCsv = await buildBatchItemsCsv(id, itemRows);
      const zip = createZip([
        { name: 'batch-summary.csv', content: summaryCsv },
        { name: 'batch-items.csv', content: itemsCsv },
      ]);
      await recordExportAudit(req, 'EXPORT copilot-batch-zip', id, {
        format: 'zip',
        batches: summaryRows.length,
        items: itemRows.length,
        filters,
      });
      return reply
        .header('content-type', 'application/zip')
        .header(
          'content-disposition',
          `attachment; filename="copilot-batches-${id}.zip"`,
        )
        .send(zip);
    },
  );

  /** 单个批量任务详情（含逐条结果）。 */
  app.get('/api/copilot-reconcile-batches/:id', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const item = await one(`SELECT * FROM copilot_reconcile_batches WHERE id = $1`, [id]);
    if (!item) throw httpError(404, 'NOT_FOUND', '批量任务不存在');
    const items = await query(
      `SELECT * FROM copilot_reconcile_batch_items WHERE batch_id = $1 ORDER BY created_at`,
      [id],
    );
    const processed = await descendantProcessedIds(id);
    const all = Array.isArray(item.difference_ids) ? item.difference_ids : [];
    const remaining = all
      .map((v: any) => String(v))
      .filter((differenceId: string) => !processed.has(differenceId));
    return { item: { ...item, items, remaining_difference_ids: remaining } };
  });

  /** 取消运行中的批量任务；已生成的动作保留。 */
  app.post('/api/copilot-reconcile-batches/:id/cancel', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const auth = (req as any).authUser;
    const body = z
      .object({ reason: z.string().trim().max(500).nullable().optional() })
      .parse(req.body ?? {});
    const item = await one(
      `UPDATE copilot_reconcile_batches
          SET status = 'cancelled',
              failed_count = GREATEST(requested_count - created_count - skipped_count, 0),
              cancelled_by = $2,
              cancel_reason = $3,
              cancelled_at = now(),
              finished_at = now()
        WHERE id = $1 AND status = 'running'
        RETURNING *`,
      [id, auth?.sub ?? null, body.reason ?? null],
    );
    if (item) return { item };
    const existing = await one(`SELECT status FROM copilot_reconcile_batches WHERE id = $1`, [
      id,
    ]);
    if (!existing) throw httpError(404, 'NOT_FOUND', '批量任务不存在');
    throw httpError(409, 'BATCH_NOT_RUNNING', '批次不在运行中');
  });

  /** 继续已取消批次的剩余差异：创建子批次并流式返回进度。 */
  app.post('/api/copilot-reconcile-batches/:id/resume/stream', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const auth = (req as any).authUser;
    const body = z
      .object({
        owner: z.uuid().nullable().optional(),
        severity: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
        due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      })
      .parse(req.body ?? {});
    const parent = await one<any>(
      `SELECT * FROM copilot_reconcile_batches WHERE id = $1`,
      [id],
    );
    if (!parent) throw httpError(404, 'NOT_FOUND', '批量任务不存在');
    if (parent.status !== 'cancelled') {
      throw httpError(409, 'BATCH_NOT_CANCELLED', '只有已取消的批次可以继续');
    }

    const processed = await descendantProcessedIds(id);
    const all = Array.isArray(parent.difference_ids) ? parent.difference_ids : [];
    const remaining = all
      .map((v: any) => String(v))
      .filter((differenceId: string) => !processed.has(differenceId));
    if (!remaining.length) {
      throw httpError(422, 'NO_REMAINING_ITEMS', '该批次没有剩余差异');
    }

    const review = await one<any>(
      `SELECT id, engagement_id, org_id FROM copilot_reconcile_reviews WHERE id = $1`,
      [parent.review_id],
    );
    if (!review) throw httpError(404, 'NOT_FOUND', '对账复核记录不存在');
    if (!review.engagement_id) throw httpError(422, 'NO_ENGAGEMENT', '复核记录未关联项目');

    const owner =
      body.owner !== undefined ? body.owner : parent.owner ?? auth?.sub ?? null;
    if (owner) {
      const foundOwner = await one(
        `SELECT 1 FROM users WHERE id = $1 AND org_id = $2`,
        [owner, review.org_id],
      );
      if (!foundOwner) throw httpError(422, 'OWNER_NOT_FOUND', '负责人不属于当前组织');
    }

    const severity = body.severity ?? parent.severity ?? 'P2';
    const dueDate =
      body.due_date !== undefined ? body.due_date : dateOnly(parent.due_date);
    const batchId = await createBatchRecord({
      reviewId: parent.review_id,
      parentBatchId: parent.id,
      type: parent.action_type,
      requested: remaining.length,
      differenceIds: remaining,
      owner,
      severity,
      dueDate,
      createdBy: auth?.sub ?? null,
    });

    await streamBatchResponse(reply, req, {
      reviewId: parent.review_id,
      batchId,
      differenceIds: remaining,
      type: parent.action_type,
      owner,
      severity,
      dueDate,
      createdBy: auth?.sub ?? null,
    });
  });

  /** 重试某个批次的失败项：创建子批次并流式返回进度。 */
  app.post('/api/copilot-reconcile-batches/:id/retry/stream', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const auth = (req as any).authUser;
    const parent = await one<any>(
      `SELECT * FROM copilot_reconcile_batches WHERE id = $1`,
      [id],
    );
    if (!parent) throw httpError(404, 'NOT_FOUND', '批量任务不存在');

    const failedRows = await query<{ difference_id: string }>(
      `SELECT difference_id
         FROM copilot_reconcile_batch_items
        WHERE batch_id = $1 AND status = 'failed'
        ORDER BY created_at`,
      [id],
    );
    if (!failedRows.length) {
      throw httpError(422, 'NO_FAILED_ITEMS', '该批次没有失败项');
    }

    const review = await one<any>(
      `SELECT id, engagement_id, org_id FROM copilot_reconcile_reviews WHERE id = $1`,
      [parent.review_id],
    );
    if (!review) throw httpError(404, 'NOT_FOUND', '对账复核记录不存在');
    if (!review.engagement_id) throw httpError(422, 'NO_ENGAGEMENT', '复核记录未关联项目');

    const owner = parent.owner ?? auth?.sub ?? null;
    if (owner) {
      const foundOwner = await one(
        `SELECT 1 FROM users WHERE id = $1 AND org_id = $2`,
        [owner, review.org_id],
      );
      if (!foundOwner) throw httpError(422, 'OWNER_NOT_FOUND', '负责人不属于当前组织');
    }

    const severity = parent.severity ?? 'P2';
    const dueDate = dateOnly(parent.due_date);
    const batchId = await createBatchRecord({
      reviewId: parent.review_id,
      parentBatchId: parent.id,
      type: parent.action_type,
      requested: failedRows.length,
      differenceIds: failedRows.map((r) => r.difference_id),
      owner,
      severity,
      dueDate,
      createdBy: auth?.sub ?? null,
    });

    await streamBatchResponse(reply, req, {
      reviewId: parent.review_id,
      batchId,
      differenceIds: failedRows.map((r) => r.difference_id),
      type: parent.action_type,
      owner,
      severity,
      dueDate,
      createdBy: auth?.sub ?? null,
    });
  });

  /** 顾问查看：某个项目收到的对账复核记录。 */
  /** 项目内对账差异分布：类型、来源、置信度与决策。 */
  app.get(
    '/api/engagements/:id/copilot-reconcile-diff-stats',
    async (req) => {
      const { id } = engagementParams.parse(req.params);
      const engagement = await one(
        `SELECT id FROM engagements WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      if (!engagement) throw httpError(404, 'NOT_FOUND', '项目不存在');
      const rows = await query<any>(
        `SELECT differences, decisions
           FROM copilot_reconcile_reviews
          WHERE engagement_id = $1`,
        [id],
      );
      const typeCounts = new Map<string, number>();
      const sourceCounts = new Map<string, number>();
      const decisionCounts = new Map<string, number>();
      const confidence = { high: 0, medium: 0, low: 0, unknown: 0 };
      let total = 0;
      for (const row of rows) {
        const decisions = new Map<string, string>();
        for (const item of Array.isArray(row.decisions) ? row.decisions : []) {
          if (item?.difference_id) {
            decisions.set(String(item.difference_id), String(item.decision ?? ''));
          }
        }
        const diffs = Array.isArray(row.differences) ? row.differences : [];
        for (const diff of diffs) {
          total += 1;
          const type = String(diff?.type ?? 'unknown');
          typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
          const source = String(diff?.source ?? '未知');
          sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
          const value = Number(diff?.confidence);
          if (!Number.isFinite(value)) confidence.unknown += 1;
          else if (value >= 0.8) confidence.high += 1;
          else if (value >= 0.6) confidence.medium += 1;
          else confidence.low += 1;
          const decision = diff?.difference_id
            ? decisions.get(String(diff.difference_id))
            : undefined;
          const key =
            decision === '采纳' || decision === '忽略' || decision === '待确认'
              ? decision
              : '未决';
          decisionCounts.set(key, (decisionCounts.get(key) ?? 0) + 1);
        }
      }
      const toList = (map: Map<string, number>) =>
        [...map.entries()]
          .map(([key, count]) => ({ key, count }))
          .sort((a, b) => b.count - a.count);
      return {
        reviews: rows.length,
        differences: total,
        by_type: toList(typeCounts).map((row) => ({
          type: row.key,
          count: row.count,
        })),
        by_source: toList(sourceCounts).map((row) => ({
          source: row.key,
          count: row.count,
        })),
        by_confidence: [
          { bucket: 'high', count: confidence.high },
          { bucket: 'medium', count: confidence.medium },
          { bucket: 'low', count: confidence.low },
          { bucket: 'unknown', count: confidence.unknown },
        ],
        by_decision: toList(decisionCounts).map((row) => ({
          decision: row.key,
          count: row.count,
        })),
      };
    },
  );

  app.get('/api/engagements/:id/copilot-reconcile-reviews', async (req) => {
    const { id } = engagementParams.parse(req.params);
    const engagement = await one(
      `SELECT id FROM engagements WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    if (!engagement) throw httpError(404, 'NOT_FOUND', '项目不存在');

    const { decision_state } = z
      .object({
        decision_state: z
          .enum(['all', 'pending', 'ignored', 'decided'])
          .default('all'),
      })
      .parse(req.query ?? {});
    const items = await query(
      `SELECT x.*
         FROM (
           SELECT r.id, r.kind, r.document_id, r.status, r.summary,
                  r.differences, r.decisions, r.risk_id, r.issue_id,
                  r.source, r.received_at,
                  EXISTS (
                    SELECT 1
                      FROM jsonb_array_elements(COALESCE(r.differences, '[]'::jsonb)) d
                     WHERE NOT EXISTS (
                       SELECT 1
                         FROM jsonb_array_elements(COALESCE(r.decisions, '[]'::jsonb)) c
                        WHERE c->>'difference_id' = d->>'difference_id'
                          AND c->>'decision' IN ('采纳', '忽略')
                     )
                  ) AS has_pending,
                  EXISTS (
                    SELECT 1
                      FROM jsonb_array_elements(COALESCE(r.decisions, '[]'::jsonb)) c
                     WHERE c->>'decision' = '忽略'
                  ) AS has_ignored
             FROM copilot_reconcile_reviews r
            WHERE r.engagement_id = $1
         ) x
        WHERE ($2::text = 'all'
           OR ($2::text = 'pending' AND x.has_pending)
           OR ($2::text = 'ignored' AND x.has_ignored)
           OR ($2::text = 'decided' AND NOT x.has_pending
               AND jsonb_array_length(COALESCE(x.differences, '[]'::jsonb)) > 0))
        ORDER BY x.received_at DESC
        LIMIT 100`,
      [id, decision_state],
    );
    return { items };
  });
}
