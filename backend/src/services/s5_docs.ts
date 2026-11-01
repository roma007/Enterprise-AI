import { fmtLocalDateTime } from './time';
import { one, query } from '../db';

export type ValueDocType = 'value' | 'renewal';

export interface ValueBundle {
  engagement: any;
  targets: any[];
  snapshots: any[];
  values: any[];
  usage: any[];
  risks: any[];
}

const CONFIDENCE_LABEL: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

const PROBABILITY_LABEL: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

const RISK_STATUS: Record<string, string> = {
  open: '待处理',
  mitigating: '缓解中',
  closed: '已关闭',
};

const table = (headers: string[], rows: string[][]) =>
  [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');

const now = () => fmtLocalDateTime();
const num = (v: unknown) =>
  v == null ? '—' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 });

const achieved = (t: any) => {
  if (t.latest_value == null || t.target == null || Number(t.target) === 0) return null;
  const latest = Number(t.latest_value);
  const target = Number(t.target);
  return t.direction === 'lower_better' ? (target / latest) * 100 : (latest / target) * 100;
};

export async function loadValueBundle(
  engagementId: string,
  orgId?: string,
): Promise<ValueBundle | null> {
  const engagement = await one<any>(
    `SELECT e.*, c.name AS client_name
       FROM engagements e
       JOIN clients c ON c.id = e.client_id
      WHERE e.id = $1 AND e.deleted_at IS NULL AND c.deleted_at IS NULL
        ${orgId ? 'AND e.org_id = $2' : ''}`,
    orgId ? [engagementId, orgId] : [engagementId],
  );
  if (!engagement) return null;

  const targets = await query<any>(
    `SELECT t.*, m.name AS metric_name, m.unit, m.direction,
            o.code AS opportunity_code, o.title AS opportunity_title,
            u.name AS owner_name,
            ls.value AS latest_value, ls.period AS latest_period, ls.source AS latest_source
       FROM metric_targets t
       JOIN metric_definitions m ON m.id = t.metric_id
       JOIN opportunities o ON o.id = t.opportunity_id
       LEFT JOIN users u ON u.id = t.owner
       LEFT JOIN LATERAL (
         SELECT s.value, s.period, s.source
           FROM metric_snapshots s
          WHERE s.target_id = t.id
          ORDER BY s.period DESC LIMIT 1
       ) ls ON true
      WHERE t.engagement_id = $1
      ORDER BY o.code, m.name`,
    [engagementId],
  );

  const [snapshots, values, usage, risks] = await Promise.all([
    query<any>(
      `SELECT s.*, m.name AS metric_name, m.unit, o.code AS opportunity_code
         FROM metric_snapshots s
         JOIN metric_targets t ON t.id = s.target_id
         JOIN metric_definitions m ON m.id = t.metric_id
         JOIN opportunities o ON o.id = t.opportunity_id
        WHERE t.engagement_id = $1
        ORDER BY s.period DESC, m.name`,
      [engagementId],
    ),
    query<any>(
      `SELECT v.*, m.name AS metric_name, m.unit, o.code AS opportunity_code,
              o.title AS opportunity_title, t.target, u.name AS verified_by_name
         FROM value_records v
         JOIN metric_definitions m ON m.id = v.metric_id
         JOIN opportunities o ON o.id = v.opportunity_id
         LEFT JOIN metric_targets t ON t.id = v.target_id
         LEFT JOIN users u ON u.id = v.verified_by
        WHERE v.engagement_id = $1
        ORDER BY v.period DESC, o.code, m.name`,
      [engagementId],
    ),
    query<any>(
      `SELECT * FROM usage_records WHERE engagement_id = $1 ORDER BY period DESC`,
      [engagementId],
    ),
    query<any>(
      `SELECT r.*, u.name AS owner_name FROM renewal_risks r
         LEFT JOIN users u ON u.id = r.owner
        WHERE r.engagement_id = $1
        ORDER BY r.kind, r.status, r.due_date NULLS LAST`,
      [engagementId],
    ),
  ]);

  return { engagement, targets, snapshots, values, usage, risks };
}

function valueDoc(b: ValueBundle) {
  const e = b.engagement;
  const title = `${e.name} · 价值实现报告`;
  const meta = { client: e.client_name, project: e.name, version: `v${new Date().toISOString().slice(0, 10)}` };

  const financial = b.values.filter((v) => v.unit === '万元');
  const realized = financial.reduce((s, v) => s + Number(v.realized_value ?? 0), 0);
  const withSnapshot = b.targets.filter((t) => t.latest_value != null);
  const achievedTargets = b.targets.filter((t) => {
    const a = achieved(t);
    return a != null && a >= 100;
  });
  const totalVolume = b.usage.reduce((s, u) => s + Number(u.volume ?? 0), 0);
  const totalErrors = b.usage.reduce((s, u) => s + Number(u.errors ?? 0), 0);
  const activeUsers = b.usage.reduce((s, u) => s + Number(u.active_users ?? 0), 0);
  const errorRate = totalVolume > 0 ? (totalErrors / totalVolume) * 100 : null;

  const targetRows = b.targets.map((t) => {
    const a = achieved(t);
    return [
      t.opportunity_code,
      t.metric_name,
      `${num(t.baseline)}${t.unit}`,
      `${num(t.target)}${t.unit}`,
      t.latest_value != null ? `${num(t.latest_value)}${t.unit}` : '—',
      a != null ? `${a.toFixed(1)}%` : '—',
      a == null ? '无快照' : a >= 100 ? '达成' : '未达成',
    ];
  });

  const valueRows = b.values.map((v) => [
    v.period,
    v.opportunity_code,
    `${v.metric_name}（${v.unit}）`,
    num(v.realized_value),
    v.target != null ? num(v.target) : '—',
    v.method,
    v.evidence,
    CONFIDENCE_LABEL[v.confidence] ?? v.confidence,
    v.verified_by_name ?? '—',
  ]);

  const usageRows = b.usage.map((u) => [
    u.period,
    String(u.active_users),
    num(u.volume),
    String(u.errors),
    u.volume > 0 ? `${((u.errors / u.volume) * 100).toFixed(2)}%` : '—',
    u.source,
  ]);

  const explained = b.values.filter((v) => {
    if (v.target == null || Number(v.target) === 0) return false;
    return Math.abs(Number(v.realized_value) - Number(v.target)) / Math.abs(Number(v.target)) > 0.1;
  });

  const openRisks = b.risks.filter((r) => r.status !== 'closed');
  const expansion = b.risks.filter((r) => r.kind === 'expansion');

  return {
    title,
    meta,
    markdown: [
      `# ${e.client_name} · ${e.name} 价值实现报告`,
      '',
      `> 生成时间：${now()}　｜　指标目标：${b.targets.length}　｜　价值记录：${b.values.length}`,
      '',
      '## 1. 执行摘要',
      '',
      `- 已兑现财务价值（万元口径）：**${num(realized)} 万元**`,
      `- 有快照的指标：${withSnapshot.length} / ${b.targets.length}`,
      `- 达到目标的指标：${achievedTargets.length} / ${b.targets.length}`,
      `- 活跃用户：${activeUsers}　｜　处理量：${num(totalVolume)}　｜　错误率：${errorRate != null ? `${errorRate.toFixed(2)}%` : '—'}`,
      `- 未关闭续约/二期事项：${openRisks.length}`,
      '',
      '## 2. 指标目标与达成',
      '',
      b.targets.length
        ? table(
            ['机会点', '指标', '基线', '目标', '最新实际', '达成率', '状态'],
            targetRows,
          )
        : '尚未设定指标目标。',
      '',
      '## 3. 价值记录明细',
      '',
      b.values.length
        ? table(
            ['周期', '机会点', '指标', '实现值', '目标', '归因方法', '证据', '置信度', '确认人'],
            valueRows,
          )
        : '尚未登记价值记录。',
      '',
      '## 4. 使用情况',
      '',
      b.usage.length
        ? table(['周期', '活跃用户', '处理量', '错误数', '错误率', '来源'], usageRows)
        : '尚未登记使用数据。',
      '',
      '## 5. 差异说明',
      '',
      explained.length
        ? explained
            .map(
              (v) =>
                `- **${v.opportunity_code} ${v.metric_name}（${v.period}）**：目标 ${num(v.target)}，实际 ${num(v.realized_value)}。${v.variance_note ? `说明：${v.variance_note}` : '**未填写差异说明。**'}`,
            )
            .join('\n')
        : '所有价值记录与目标的偏差均在 10% 以内，或无关联目标。',
      '',
      '## 6. 续约与二期建议',
      '',
      openRisks.length
        ? table(
            ['类型', '事项', '概率', '潜在价值（万元）', '应对动作', '负责人', '截止', '状态'],
            openRisks.map((r) => [
              r.kind === 'expansion' ? '二期' : '续约',
              r.title,
              PROBABILITY_LABEL[r.probability] ?? r.probability,
              r.value_potential != null ? num(r.value_potential) : '—',
              r.action ?? '—',
              r.owner_name ?? '—',
              r.due_date ?? '—',
              RISK_STATUS[r.status] ?? r.status,
            ]),
          )
        : '当前无未关闭的续约/二期事项。',
      '',
      expansion.length
        ? `二期机会潜在价值合计：**${num(expansion.reduce((s, r) => s + Number(r.value_potential ?? 0), 0))} 万元**。`
        : '尚未登记二期机会。',
      '',
      '## 7. 数据来源与口径',
      '',
      '- 指标定义、基线、目标与周期快照来自「运营」页签，快照必须写明来源与置信度。',
      '- 财务类价值统一按万元计；非财务指标按各自单位记录，不折算为金额。',
      '- 价值记录必须写明归因方法与证据，并由确认人署名。',
      '- 本报告不替代财务审计或合同结算。',
      '',
      '| 角色 | 姓名 | 结论 | 签字 | 日期 |',
      '|---|---|---|---|---|',
      '| 客户业务负责人 |  |  |  |  |',
      '| 客户财务负责人 |  |  |  |  |',
      '| 供应商项目经理 |  |  |  |  |',
      '',
      '> 报告中每个数字均可追溯到指标快照或价值记录。',
    ].join('\n'),
  };
}

function renewalDoc(b: ValueBundle) {
  const e = b.engagement;
  const title = `${e.name} · 续约与二期建议`;
  const meta = { client: e.client_name, project: e.name, version: `v${new Date().toISOString().slice(0, 10)}` };
  const achievedCount = b.targets.filter((t) => {
    const a = achieved(t);
    return a != null && a >= 100;
  }).length;
  const open = b.risks.filter((r) => r.status !== 'closed');
  const expansion = b.risks.filter((r) => r.kind === 'expansion');
  const renewal = b.risks.filter((r) => r.kind === 'renewal');

  return {
    title,
    meta,
    markdown: [
      `# ${e.client_name} · ${e.name} 续约与二期建议`,
      '',
      `> 生成时间：${now()}　｜　续约风险：${renewal.length}　｜　二期机会：${expansion.length}`,
      '',
      '## 1. 判断依据',
      '',
      `- 指标目标：${b.targets.length} 个，其中达到目标 ${achievedCount} 个。`,
      `- 价值记录：${b.values.length} 条，财务类实现价值 ${num(
        b.values.filter((v) => v.unit === '万元').reduce((s, v) => s + Number(v.realized_value ?? 0), 0),
      )} 万元。`,
      `- 使用数据：${b.usage.length} 个周期，活跃用户 ${b.usage.reduce((s, u) => s + Number(u.active_users ?? 0), 0)}。`,
      '',
      '## 2. 续约风险',
      '',
      renewal.length
        ? table(
            ['事项', '概率', '影响', '应对动作', '负责人', '截止', '状态'],
            renewal.map((r) => [
              r.title,
              PROBABILITY_LABEL[r.probability] ?? r.probability,
              r.impact ?? '—',
              r.action ?? '—',
              r.owner_name ?? '—',
              r.due_date ?? '—',
              RISK_STATUS[r.status] ?? r.status,
            ]),
          )
        : '无登记续约风险。',
      '',
      '## 3. 二期机会',
      '',
      expansion.length
        ? table(
            ['机会', '概率', '潜在价值（万元）', '下一步动作', '负责人', '截止'],
            expansion.map((r) => [
              r.title,
              PROBABILITY_LABEL[r.probability] ?? r.probability,
              r.value_potential != null ? num(r.value_potential) : '—',
              r.action ?? '—',
              r.owner_name ?? '—',
              r.due_date ?? '—',
            ]),
          )
        : '尚未登记二期机会。',
      '',
      '## 4. 建议动作与时间表',
      '',
      open.length
        ? open
            .filter((r) => r.due_date || r.action)
            .map(
              (r) =>
                `- ${r.due_date ?? '待定'}：${r.title} — ${r.action ?? '待补充动作'}（${r.owner_name ?? '待指定'}）`,
            )
            .join('\n') || '- 暂无明确时间表。'
        : '- 无未关闭事项，按合同节点推进续约。',
      '',
      '## 5. 客户沟通要点',
      '',
      '- 先讲已兑现指标与证据，再讲未达标项和原因。',
      '- 续约/二期建议必须与指标数据、使用情况对应，不做无依据承诺。',
      '- 对未达成目标给出补救计划、负责人和时间点。',
      '- 客户签收与确认走现有确认单流程。',
      '',
      '| 角色 | 姓名 | 建议 | 签字 | 日期 |',
      '|---|---|---|---|---|',
      '| 客户业务负责人 |  |  |  |  |',
      '| 供应商客户成功 |  |  |  |  |',
      '| 供应商项目经理 |  |  |  |  |',
      '',
      '> 本建议基于系统内指标快照、价值记录与使用数据；最终续约以合同为准。',
    ].join('\n'),
  };
}

export function renderValueDoc(bundle: ValueBundle, type: ValueDocType) {
  return type === 'value' ? valueDoc(bundle) : renewalDoc(bundle);
}
