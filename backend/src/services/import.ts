import ExcelJS from 'exceljs';
import type pg from 'pg';
import { nextCode, refreshGateMetrics } from './s1';

export type ImportKind = 'pains' | 'inventory' | 'opportunities';

export interface ImportRowError {
  row: number;
  field: string;
  message: string;
}

export class RowError extends Error {
  info: ImportRowError;
  constructor(info: ImportRowError) {
    super(info.message);
    this.info = info;
  }
}

const norm = (s: string) =>
  s
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');

const ALIASES: Record<ImportKind, Record<string, string[]>> = {
  pains: {
    code: ['编号', 'code'],
    description: ['描述', '痛点', '痛点描述', 'description'],
    channel: ['环节', '渠道', 'channel'],
    frequency: ['频次', '频率', 'frequency'],
    severity: ['严重度', 'severity'],
    quantified_impact: ['量化影响', 'quantified_impact', 'impact'],
    current_workaround: ['当前做法', 'current_workaround'],
    source_type: ['来源类型', 'source_type'],
    source_ref: ['来源说明', '来源', 'source_ref'],
    status: ['状态', 'status'],
  },
  inventory: {
    dimension: ['维度', 'dimension'],
    category: ['类别', 'category'],
    name: ['名称', '对象', 'name'],
    attributes: ['属性', '属性(json)', 'attributes', 'json'],
    completeness: ['完整度', 'completeness'],
    verified: ['已核实', 'verified'],
    verified_note: ['核实说明', 'verified_note'],
    is_implicit: ['隐性', 'is_implicit'],
    discovered_by: ['发现方式', 'discovered_by'],
  },
  opportunities: {
    code: ['编号', 'code'],
    title: ['名称', '机会点', 'title'],
    description: ['描述', 'description'],
    stage: ['阶段', 'stage'],
    value_score: ['价值', '价值分', 'value', 'value_score'],
    feasibility_score: ['可行性', '可行性分', 'feasibility', 'feasibility_score'],
    urgency: ['紧迫度', 'urgency'],
    data_readiness: ['数据就绪度', 'data_readiness'],
    score_rationale: ['评分理由', '理由', 'score_rationale'],
    data_status: ['数据状态', 'data_status'],
    has_tech_blocker: ['技术阻断', 'has_tech_blocker'],
    tech_blocker_note: ['阻断说明', 'tech_blocker_note'],
    target_phase: ['目标期', '目标阶段', '路线', 'target_phase'],
    kill_reason: ['终止原因', 'kill_reason'],
  },
};

export const TEMPLATE_COLUMNS: Record<ImportKind, string[]> = {
  pains: ['编号', '描述', '环节', '频次', '严重度', '量化影响', '来源类型', '来源说明', '状态'],
  inventory: ['维度', '类别', '名称', '属性(JSON)', '完整度', '已核实', '隐性', '发现方式'],
  opportunities: [
    '编号', '名称', '描述', '价值', '可行性', '紧迫度', '评分理由',
    '数据状态', '目标期', '阶段', '技术阻断', '阻断说明',
  ],
};

export const REQUIRED_COLUMNS: Record<ImportKind, string[]> = {
  pains: ['description', 'source_type', 'source_ref'],
  inventory: ['dimension', 'name'],
  opportunities: ['title', 'value_score', 'feasibility_score', 'score_rationale'],
};

const COLUMN_LABEL: Record<string, string> = {
  description: '描述',
  source_type: '来源类型',
  source_ref: '来源说明',
  dimension: '维度',
  name: '名称',
  title: '名称',
  value_score: '价值',
  feasibility_score: '可行性',
  score_rationale: '评分理由',
};

const FREQUENCY: Record<string, string> = {
  daily: 'daily', 每天: 'daily', 每日: 'daily',
  weekly: 'weekly', 每周: 'weekly',
  monthly: 'monthly', 每月: 'monthly',
  occasional: 'occasional', 偶尔: 'occasional',
};

const SOURCE: Record<string, string> = {
  interview: 'interview', 访谈: 'interview',
  observation: 'observation', 观察: 'observation', 现场观察: 'observation',
  data: 'data', 数据: 'data', 数据抽样: 'data',
};

const PAIN_STATUS: Record<string, string> = {
  open: 'open', 开放: 'open',
  resolved: 'resolved', 已解决: 'resolved',
  merged: 'merged', 已归并: 'merged',
};

const DIMENSION: Record<string, string> = {
  business: 'business', 业务: 'business',
  data: 'data', 数据: 'data',
  system: 'system', 系统: 'system',
  org: 'org', 组织: 'org',
};

const DISCOVERED: Record<string, string> = {
  interview: 'interview', 访谈: 'interview',
  observation: 'observation', 观察: 'observation', 现场观察: 'observation',
  data: 'data', 数据: 'data',
};

const DATA_STATUS: Record<string, string> = {
  ready: 'ready', 就绪: 'ready', 数据就绪: 'ready',
  need_apply: 'need_apply', 需申请: 'need_apply',
  need_build: 'need_build', 需建设: 'need_build',
  unavailable: 'unavailable', 不可得: 'unavailable',
};

const PHASE: Record<string, string> = {
  phase1: 'phase1', 一期: 'phase1',
  phase2: 'phase2', 二期: 'phase2',
  watch: 'watch', 观望: 'watch',
};

const OPP_STAGE: Record<string, string> = {
  candidate: 'candidate', 候选: 'candidate',
  scored: 'scored', 已评估: 'scored',
  selected: 'selected', 已选: 'selected',
  designed: 'designed', 方案设计: 'designed',
};

const URGENCY: Record<string, number> = {
  '0.8': 0.8, 不紧急: 0.8,
  '1': 1, '1.0': 1, 常规: 1,
  '1.2': 1.2, 紧急: 1.2,
};

function rowError(row: number, field: string, message: string): never {
  throw new RowError({ row, field, message });
}

function required(value: string, field: string, row: number): string {
  if (!value.trim()) rowError(row, field, '必填');
  return value.trim();
}

function optional(value: string): string | undefined {
  return value.trim() || undefined;
}

function intValue(
  value: string,
  field: string,
  row: number,
  opts: { required?: boolean; min?: number; max?: number; fallback?: number } = {},
): number | null {
  const raw = value.trim();
  if (!raw) {
    if (opts.fallback !== undefined) return opts.fallback;
    if (opts.required) rowError(row, field, '必填');
    return null;
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) rowError(row, field, `必须是整数：${raw}`);
  if (opts.min !== undefined && n < opts.min) rowError(row, field, `不能小于 ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) rowError(row, field, `不能大于 ${opts.max}`);
  return n;
}

function boolValue(value: string, row: number, field: string, fallback = false): boolean {
  const raw = value.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'y', '是', '有', '已核实', '需要'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', '否', '无', '未核实', '不需要'].includes(raw)) return false;
  rowError(row, field, `无法识别的是/否：${value}`);
}

function enumValue(
  value: string,
  map: Record<string, string>,
  field: string,
  row: number,
  fallback?: string,
): string | null {
  const raw = value.trim();
  if (!raw) {
    if (fallback !== undefined) return fallback;
    return null;
  }
  const hit = map[raw] ?? map[raw.toLowerCase()];
  if (!hit) rowError(row, field, `无法识别：${raw}`);
  return hit;
}

function toRowMap(header: string[], cells: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  header.forEach((h, i) => {
    map[norm(h)] = (cells[i] ?? '').trim();
  });
  return map;
}

function pick(row: Record<string, string>, aliases: string[]): string {
  for (const alias of aliases) {
    const v = row[norm(alias)];
    if (v !== undefined && v !== '') return v;
  }
  return '';
}

function parseAttributes(raw: string, row: number): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      rowError(row, '属性', '必须是 JSON 对象');
    }
    return value as Record<string, unknown>;
  } catch {
    rowError(row, '属性', 'JSON 格式不正确');
  }
}

function parsePain(row: Record<string, string>, rowNo: number) {
  const quantified = optional(pick(row, ALIASES.pains.quantified_impact));
  if (quantified && ['很大', '很多', '严重', '不少'].includes(quantified)) {
    rowError(rowNo, '量化影响', '不接受「很大 / 很多 / 严重 / 不少」这类模糊表述');
  }
  return {
    code: optional(pick(row, ALIASES.pains.code)),
    description: required(pick(row, ALIASES.pains.description), '描述', rowNo),
    channel: optional(pick(row, ALIASES.pains.channel)),
    frequency: enumValue(pick(row, ALIASES.pains.frequency), FREQUENCY, '频次', rowNo),
    severity: intValue(pick(row, ALIASES.pains.severity), '严重度', rowNo, { min: 1, max: 5 }),
    quantified_impact: quantified,
    current_workaround: optional(pick(row, ALIASES.pains.current_workaround)),
    source_type: enumValue(
      required(pick(row, ALIASES.pains.source_type), '来源类型', rowNo),
      SOURCE,
      '来源类型',
      rowNo,
    ),
    source_ref: required(pick(row, ALIASES.pains.source_ref), '来源说明', rowNo),
    status: enumValue(pick(row, ALIASES.pains.status), PAIN_STATUS, '状态', rowNo, 'open'),
  };
}

function parseInventory(row: Record<string, string>, rowNo: number) {
  return {
    dimension: enumValue(
      required(pick(row, ALIASES.inventory.dimension), '维度', rowNo),
      DIMENSION,
      '维度',
      rowNo,
    ),
    category: optional(pick(row, ALIASES.inventory.category)),
    name: required(pick(row, ALIASES.inventory.name), '名称', rowNo),
    attributes: parseAttributes(pick(row, ALIASES.inventory.attributes), rowNo),
    completeness: intValue(pick(row, ALIASES.inventory.completeness), '完整度', rowNo, {
      min: 0,
      max: 100,
      fallback: 0,
    }),
    verified: boolValue(pick(row, ALIASES.inventory.verified), rowNo, '已核实'),
    verified_note: optional(pick(row, ALIASES.inventory.verified_note)),
    is_implicit: boolValue(pick(row, ALIASES.inventory.is_implicit), rowNo, '隐性'),
    discovered_by: enumValue(
      pick(row, ALIASES.inventory.discovered_by),
      DISCOVERED,
      '发现方式',
      rowNo,
    ),
  };
}

function parseOpportunity(row: Record<string, string>, rowNo: number) {
  const stage = enumValue(pick(row, ALIASES.opportunities.stage), OPP_STAGE, '阶段', rowNo, 'scored');
  const hasBlocker = boolValue(
    pick(row, ALIASES.opportunities.has_tech_blocker),
    rowNo,
    '技术阻断',
  );
  const blockerNote = optional(pick(row, ALIASES.opportunities.tech_blocker_note));
  if (hasBlocker && !blockerNote) {
    rowError(rowNo, '阻断说明', '存在技术阻断时必须填写');
  }
  const killReason = optional(pick(row, ALIASES.opportunities.kill_reason));
  if (stage === 'killed' && !killReason) {
    rowError(rowNo, '终止原因', 'stage=killed 时必须填写');
  }

  const urgencyRaw = pick(row, ALIASES.opportunities.urgency).trim();
  const urgency = urgencyRaw ? URGENCY[urgencyRaw] ?? Number(urgencyRaw) : 1;
  if (![0.8, 1, 1.2].includes(urgency)) {
    rowError(rowNo, '紧迫度', '只能是 0.8 / 1.0 / 1.2');
  }

  return {
    code: optional(pick(row, ALIASES.opportunities.code)),
    title: required(pick(row, ALIASES.opportunities.title), '名称', rowNo),
    description: optional(pick(row, ALIASES.opportunities.description)),
    stage,
    value_score: intValue(pick(row, ALIASES.opportunities.value_score), '价值', rowNo, {
      required: true,
      min: 1,
      max: 5,
    }),
    feasibility_score: intValue(
      pick(row, ALIASES.opportunities.feasibility_score),
      '可行性',
      rowNo,
      { required: true, min: 1, max: 5 },
    ),
    urgency,
    data_readiness: intValue(pick(row, ALIASES.opportunities.data_readiness), '数据就绪度', rowNo, {
      min: 1,
      max: 5,
    }),
    score_rationale: required(
      pick(row, ALIASES.opportunities.score_rationale),
      '评分理由',
      rowNo,
    ),
    data_status: enumValue(
      pick(row, ALIASES.opportunities.data_status),
      DATA_STATUS,
      '数据状态',
      rowNo,
      'ready',
    ),
    has_tech_blocker: hasBlocker,
    tech_blocker_note: blockerNote,
    target_phase: enumValue(pick(row, ALIASES.opportunities.target_phase), PHASE, '目标期', rowNo),
    kill_reason: killReason,
  };
}

export function validateImport(kind: ImportKind, header: string[], rows: string[][]) {
  const missing = REQUIRED_COLUMNS[kind].filter(
    (col) => !header.some((h) => ALIASES[kind][col]?.includes(norm(h))),
  );
  if (missing.length) {
    return {
      data: [] as any[],
      errors: [
        {
          row: 1,
          field: '表头',
          message: `缺少列：${missing.map((c) => COLUMN_LABEL[c] ?? c).join('、')}`,
        },
      ],
    };
  }

  const data: any[] = [];
  const errors: ImportRowError[] = [];
  rows.forEach((cells, idx) => {
    if (!cells.some((c) => c.trim())) return;
    const rowNo = idx + 2;
    const map = toRowMap(header, cells);
    try {
      if (kind === 'pains') data.push(parsePain(map, rowNo));
      else if (kind === 'inventory') data.push(parseInventory(map, rowNo));
      else data.push(parseOpportunity(map, rowNo));
    } catch (err) {
      if (err instanceof RowError) errors.push(err.info);
      else throw err;
    }
  });

  return { data, errors };
}

export async function insertImportRows(
  client: pg.PoolClient,
  engagementId: string,
  kind: ImportKind,
  rows: any[],
): Promise<{ inserted: number }> {
  let inserted = 0;

  for (const r of rows) {
    if (kind === 'pains') {
      const code = r.code ?? (await nextCode(client, 'pain_points', engagementId, 'P', 3));
      await client.query(
        `INSERT INTO pain_points
           (engagement_id, code, description, channel, frequency, severity, quantified_impact,
            current_workaround, source_type, source_ref, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          engagementId, code, r.description, r.channel ?? null, r.frequency ?? null,
          r.severity ?? null, r.quantified_impact ?? null, r.current_workaround ?? null,
          r.source_type, r.source_ref, r.status ?? 'open',
        ],
      );
    } else if (kind === 'inventory') {
      await client.query(
        `INSERT INTO inventory_items
           (engagement_id, dimension, category, name, attributes, completeness, verified,
            verified_note, is_implicit, discovered_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          engagementId, r.dimension, r.category ?? null, r.name, JSON.stringify(r.attributes ?? {}),
          r.completeness ?? 0, r.verified ?? false, r.verified_note ?? null,
          r.is_implicit ?? false, r.discovered_by ?? null,
        ],
      );
    } else {
      const code = r.code ?? (await nextCode(client, 'opportunities', engagementId, 'OP', 2));
      await client.query(
        `INSERT INTO opportunities
           (engagement_id, code, title, description, stage, value_score, feasibility_score, urgency,
            data_readiness, score_rationale, data_status, has_tech_blocker, tech_blocker_note,
            target_phase, kill_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          engagementId, code, r.title, r.description ?? null, r.stage ?? 'scored',
          r.value_score, r.feasibility_score, r.urgency ?? 1, r.data_readiness ?? null,
          r.score_rationale, r.data_status ?? 'ready', r.has_tech_blocker ?? false,
          r.tech_blocker_note ?? null, r.target_phase ?? null, r.kill_reason ?? null,
        ],
      );
    }
    inserted++;
  }

  await refreshGateMetrics(client, engagementId);
  return { inserted };
}

/** 极简 CSV 解析：支持引号、转义引号、CRLF。 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const obj = value as any;
  if (Array.isArray(obj.richText)) return obj.richText.map((x: any) => x.text ?? '').join('');
  if (obj.text !== undefined) return String(obj.text);
  if (obj.result !== undefined) return String(obj.result);
  return String(value);
}

export async function parseWorkbook(buffer: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  const ws = wb.worksheets[0];
  if (!ws) return [];

  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values = Array.isArray(row.values) ? row.values : [];
    const cells = values.slice(1).map(cellToString);
    if (cells.some((c) => c.trim())) rows.push(cells);
  });
  return rows;
}

export function templateCsv(kind: ImportKind): string {
  return `${TEMPLATE_COLUMNS[kind].join(',')}\n`;
}
