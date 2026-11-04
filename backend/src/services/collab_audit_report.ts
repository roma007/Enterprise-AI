export interface CollabReportComparison {
  current: {
    start: string;
    end: string;
    delta_total: number;
    delta_notification: number;
    delta_filter_view: number;
    delta_export: number;
    delta_decision: number;
  } | null;
  previous: {
    start: string;
    end: string;
    delta_total: number;
    delta_notification: number;
    delta_filter_view: number;
    delta_export: number;
    delta_decision: number;
  } | null;
  change: {
    delta_total: number;
    delta_notification: number;
    delta_filter_view: number;
    delta_export: number;
    delta_decision: number;
  } | null;
}

export interface CollabReportInput {
  orgName: string;
  days: number;
  bucket: 'day' | 'week' | 'month';
  from: string;
  to: string;
  byType: {
    notification: number;
    filter_view: number;
    export: number;
    decision: number;
    total: number;
  };
  comparison: CollabReportComparison | null;
  topActions: Array<{ action: string; count: number }>;
  topActors: Array<{ actor_name: string | null; count: number }>;
  trend: Array<{
    period_start: string;
    period_end: string;
    total: number;
    notification_count: number;
    filter_view_count: number;
    export_count: number;
    decision_count: number;
    delta_total: number;
  }>;
}

const TYPE_LABEL: Record<string, string> = {
  notification: '通知',
  filter_view: '筛选视图',
  export: '导出',
  decision: '决策',
};

const ACTION_LABEL: Record<string, string> = {
  'DELETE copilot-notification': '删除通知',
  'RESTORE copilot-notification': '恢复通知',
  'PURGE copilot-notification': '彻底删除通知',
  'SAVE copilot-batch-filter-view': '保存筛选视图',
  'DELETE copilot-batch-filter-view': '删除筛选视图',
  'EXPORT copilot-notification-audits': '导出通知审计',
  'EXPORT copilot-collab-audits': '导出协作审计',
  'EXPORT copilot-batch-filter-view-audits': '导出视图审计',
  'EXPORT copilot-collab-merged': '导出合并审计',
  'EXPORT copilot-collab-archive': '导出归档审计',
  'DECIDE copilot-reconcile-difference': '差异决策',
};

function cell(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return String(value).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function bucketLabel(bucket: 'day' | 'week' | 'month'): string {
  return bucket === 'week' ? '按周' : bucket === 'month' ? '按月' : '按日';
}

/** 生成协作审计周报/月报 Markdown。 */
export function renderCollabAuditReport(input: CollabReportInput): {
  title: string;
  markdown: string;
  meta: { client: string; project: string; version: string };
} {
  const title = `协作审计报告 · ${input.from} ~ ${input.to}`;
  const current = input.comparison?.current ?? null;
  const previous = input.comparison?.previous ?? null;
  const change = input.comparison?.change ?? null;
  const lines: string[] = [];

  lines.push(`# ${title}`);
  lines.push('');
  lines.push(
    `> ${input.orgName} · 最近 ${input.days} 天 · ${bucketLabel(input.bucket)}口径`,
  );
  lines.push('');

  lines.push('## 一、新增对比');
  lines.push('');
  lines.push('| 指标 | 本周期 | 上周期 | 环比 |');
  lines.push('| --- | --- | --- | --- |');
  type DeltaKey =
    | 'delta_total'
    | 'delta_notification'
    | 'delta_filter_view'
    | 'delta_export'
    | 'delta_decision';
  const rows: Array<[string, DeltaKey]> = [
    ['总数', 'delta_total'],
    ['通知', 'delta_notification'],
    ['筛选视图', 'delta_filter_view'],
    ['导出', 'delta_export'],
    ['决策', 'delta_decision'],
  ];
  for (const [label, key] of rows) {
    lines.push(
      `| ${label} | ${current ? current[key] : 0} | ${
        previous ? previous[key] : 0
      } | ${change ? signed(change[key]) : 0} |`,
    );
  }
  lines.push('');
  if (current && previous) {
    lines.push(
      `- 本周期：${current.start} ~ ${current.end}`,
    );
    lines.push(
      `- 上周期：${previous.start} ~ ${previous.end}`,
    );
    lines.push('');
  }

  lines.push('## 二、周期内操作分布');
  lines.push('');
  lines.push('| 类型 | 数量 |');
  lines.push('| --- | --- |');
  for (const key of ['notification', 'filter_view', 'export', 'decision']) {
    lines.push(
      `| ${TYPE_LABEL[key]} | ${
        (input.byType as any)[key] ?? 0
      } |`,
    );
  }
  lines.push(`| 合计 | ${input.byType.total} |`);
  lines.push('');

  lines.push('## 三、高频操作');
  lines.push('');
  if (!input.topActions.length) {
    lines.push('本周期无操作记录。');
  } else {
    lines.push('| 操作 | 次数 |');
    lines.push('| --- | --- |');
    for (const row of input.topActions) {
      lines.push(
        `| ${cell(ACTION_LABEL[row.action] ?? row.action)} | ${row.count} |`,
      );
    }
  }
  lines.push('');

  lines.push('## 四、活跃操作人');
  lines.push('');
  if (!input.topActors.length) {
    lines.push('本周期无操作记录。');
  } else {
    lines.push('| 操作人 | 次数 |');
    lines.push('| --- | --- |');
    for (const row of input.topActors) {
      lines.push(`| ${cell(row.actor_name ?? '系统')} | ${row.count} |`);
    }
  }
  lines.push('');

  lines.push('## 五、趋势');
  lines.push('');
  lines.push('| 周期 | 总数 | 新增 | 通知 | 筛选视图 | 导出 | 决策 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const row of input.trend.slice(0, 31)) {
    lines.push(
      `| ${
        row.period_start === row.period_end
          ? row.period_start
          : `${row.period_start} ~ ${row.period_end}`
      } | ${row.total} | +${row.delta_total} | ${row.notification_count} | ${
        row.filter_view_count
      } | ${row.export_count} | ${row.decision_count} |`,
    );
  }
  lines.push('');

  lines.push('## 六、说明');
  lines.push('');
  lines.push('- 数据来自审计日志与每日快照，归档数据计入累计。');
  lines.push(
    '- 统计口径：通知、筛选视图、导出、差异决策；不含登录与项目类审计。',
  );
  lines.push('- 快照按组织时区生成，环比为与上一等长周期的差值。');
  lines.push('');

  return {
    title,
    markdown: lines.join('\n'),
    meta: {
      client: input.orgName,
      project: '协作审计',
      version: `最近 ${input.days} 天`,
    },
  };
}
