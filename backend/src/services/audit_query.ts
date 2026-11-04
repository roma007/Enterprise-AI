import { httpError } from './s1';

export type AuditStatus = '2xx' | '3xx' | '4xx' | '5xx';

export interface AuditQuery {
  q?: string;
  action?: string;
  object_type?: string;
  status?: AuditStatus;
  from?: string;
  to?: string;
}

/** 列表、统计、归档、导出共用同一组筛选条件。 */
export function auditFilter(org: string, q: AuditQuery) {
  const where = `a.org_id = $1
        AND ($2::text IS NULL OR a.action ILIKE '%' || $2 || '%')
        AND ($3::text IS NULL OR a.object_type = $3)
        AND ($4::text IS NULL OR a.action ILIKE '%' || $4 || '%'
             OR a.object_type ILIKE '%' || $4 || '%'
             OR a.ip ILIKE '%' || $4 || '%'
             OR u.name ILIKE '%' || $4 || '%')
        AND ($5::text IS NULL
             OR ($5::text = '2xx' AND a.status_code >= 200 AND a.status_code < 300)
             OR ($5::text = '3xx' AND a.status_code >= 300 AND a.status_code < 400)
             OR ($5::text = '4xx' AND a.status_code >= 400 AND a.status_code < 500)
             OR ($5::text = '5xx' AND a.status_code >= 500 AND a.status_code < 600))
        AND ($6::date IS NULL OR a.created_at >= $6::date)
        AND ($7::date IS NULL OR a.created_at < ($7::date + interval '1 day'))`;
  return {
    where,
    params: [
      org,
      q.action ?? null,
      q.object_type ?? null,
      q.q ?? null,
      q.status ?? null,
      q.from ?? null,
      q.to ?? null,
    ],
  };
}

export const AUDIT_STATS_SQL = `SELECT count(*)::int AS total,
       count(*) FILTER (WHERE a.action LIKE 'DELETE%')::int AS deletes,
       count(*) FILTER (WHERE COALESCE(a.status_code, 0) >= 400)::int AS failures`;

export const AUDIT_EXPORT_COLUMNS: Record<string, string> = {
  time: '时间',
  action: '操作',
  object_type: '对象类型',
  object_id: '对象 ID',
  status: '状态码',
  user: '操作人',
  request_id: '请求 ID',
  ip: 'IP',
  user_agent: 'User-Agent',
  detail: '详情',
  archived_at: '归档时间',
};

export function normalizeAuditExportColumns(input?: string[]): string[] {
  const columns = Array.from(new Set(input ?? []));
  const bad = columns.filter(
    (key) => !Object.keys(AUDIT_EXPORT_COLUMNS).includes(key),
  );
  if (bad.length) {
    throw httpError(
      400,
      'INVALID_EXPORT_COLUMNS',
      `导出列不合法：${bad.join(', ')}`,
    );
  }
  return columns;
}

function csvCell(value: unknown): string {
  let text =
    value == null
      ? ''
      : typeof value === 'string'
        ? value
        : JSON.stringify(value);
  // 防止 Excel/Sheets 把单元格当公式执行
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function valueFor(row: any, key: string) {
  switch (key) {
    case 'time':
      return row.created_at ? new Date(row.created_at).toISOString() : '';
    case 'action':
      return row.action;
    case 'object_type':
      return row.object_type;
    case 'object_id':
      return row.object_id;
    case 'status':
      return row.status_code;
    case 'user':
      return row.user_name ?? row.user_id;
    case 'request_id':
      return row.request_id;
    case 'ip':
      return row.ip;
    case 'user_agent':
      return row.user_agent;
    case 'detail':
      return row.detail;
    case 'archived_at':
      return row.archived_at ? new Date(row.archived_at).toISOString() : '';
    default:
      return '';
  }
}

/** 生成带 BOM 的 CSV；columns 需按固定顺序传入。 */
export function buildAuditCsv(rows: any[], columns: string[]): string {
  const header = columns.map((key) => AUDIT_EXPORT_COLUMNS[key]);
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(columns.map((key) => csvCell(valueFor(row, key))).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}`;
}
