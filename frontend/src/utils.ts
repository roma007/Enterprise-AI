export const cn = (...parts: Array<string | false | null | undefined>) =>
  parts.filter(Boolean).join(' ');

export const fmtMoney = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined ? '—' : `${Number(v.toFixed(digits))} 万`;

export const fmtNum = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined ? '—' : String(Number(v.toFixed(digits)));

export const fmtPct = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${Number(v.toFixed(2))}%`;

export const fmtDate = (v: string | null | undefined) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
};

export const fmtDateTime = (v: string | null | undefined) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return `${fmtDate(v)} ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
};

const dict = (map: Record<string, string>, key: string | null | undefined) =>
  key ? map[key] ?? key : '—';

export const stageLabel = (v: string | null | undefined) =>
  dict({ S0: 'S0 商机', S1: 'S1 诊断', S2: 'S2 方案', S3: 'S3 POC', S4: 'S4 交付', S5: 'S5 运营' }, v);

export const engagementStatusLabel = (v: string | null | undefined) =>
  dict({ active: '进行中', on_hold: '暂停', won: '已赢单', lost: '已失单', closed: '已关闭' }, v);

export const oppStageLabel = (v: string | null | undefined) =>
  dict(
    {
      candidate: '候选', scored: '已评估', selected: '已选', designed: '方案设计',
      piloting: 'POC 中', validated: '已验证', delivering: '交付中', live: '已上线',
      realized: '价值达成', closed: '已关闭', parked: '搁置', killed: '终止',
    },
    v,
  );

export const priorityLabel = (v: string | null | undefined) =>
  dict({ priority: '优先', candidate: '候选', parked: '搁置' }, v);

export const phaseLabel = (v: string | null | undefined) =>
  dict({ phase1: '一期', phase2: '二期', watch: '观望' }, v);

export const dataStatusLabel = (v: string | null | undefined) =>
  dict({ ready: '数据就绪', need_apply: '需申请', need_build: '需建设', unavailable: '不可得' }, v);

export const roleLabel = (v: string | null | undefined) =>
  dict(
    { decision_maker: '决策人', project_owner: '项目负责人', business_owner: '业务负责人', it_data: 'IT/数据', frontline: '一线' },
    v,
  );

export const attitudeLabel = (v: string | null | undefined) =>
  dict({ champion: '拥护', supporter: '支持', neutral: '中立', skeptic: '疑虑', blocker: '抵触' }, v);

export const nodeTypeLabel = (v: string | null | undefined) =>
  dict(
    {
      start: '起点',
      end: '终点',
      action: '动作',
      decision: '判断',
      wait: '等待',
      system: '系统',
      manual: '手工',
    },
    v,
  );

export const modeLabel = (v: string | null | undefined) =>
  dict({ onsite: '现场', video: '视频', phone: '电话' }, v);

export const subIndustryLabel = (v: string | null | undefined) =>
  dict(
    {
      port_container_trucking: '港口集卡',
      linehaul: '干线运输',
      warehouse: '仓储',
      forwarder: '货代',
      supply_chain: '供应链',
    },
    v,
  );

export const dimensionLabel = (v: string | null | undefined) =>
  dict({ business: '业务', data: '数据', system: '系统', org: '组织' }, v);

export const confidenceLabel = (v: string | null | undefined) =>
  dict({ high: '高', medium: '中', low: '低' }, v);

export const impactLabel = (v: string | null | undefined) =>
  dict({ amount: '金额', scope: '范围', method: '方法', internal: '内部' }, v);

export const deliverableTypeLabel = (v: string | null | undefined) =>
  dict(
    {
      diagnosis_report: '诊断报告',
      one_pager: '一页纸简报',
      proposal: '方案说明书',
      architecture: '技术架构与集成方案',
      prd: '产品需求文档',
      acceptance: '验收标准',
      quote: '报价单',
      roadmap: '路线图',
      roi_sheet: 'ROI 测算表',
      data_report: '数据报告',
      charter: '项目章程',
      poc_report: 'POC 报告',
      uat_report: 'UAT 报告',
      value_report: '价值报告',
    },
    v,
  );

export const deliverableStatusLabel = (v: string | null | undefined) =>
  dict({ draft: '草稿', in_review: '审核中', approved: '已批准', shared: '已外发', archived: '已归档' }, v);

export const namesPreview = (
  items: Array<{ name: string }>,
  max = 3,
): string => {
  if (!items.length) return '';
  const names = items.slice(0, max).map((item) => item.name).join('、');
  return items.length > max ? `${names} 等 ${items.length} 人` : names;
};

export const shareChannelLabel = (v: string | null | undefined) =>
  dict({ email: '邮件', wechat: '企业微信', meeting: '会议', print: '打印' }, v);

export const gateStatusLabel = (v: string | null | undefined) =>
  dict({ pending: '待办', in_review: '审核中', passed: '已通过', rejected: '已驳回' }, v);

export const frequencyLabel = (v: string | null | undefined) =>
  dict({ daily: '每天', weekly: '每周', monthly: '每月', occasional: '偶尔' }, v);

export const riskCategoryLabel = (v: string | null | undefined) =>
  dict({ data: '数据', tech: '技术', org: '组织', commercial: '商务', compliance: '合规' }, v);

export const dependencyTypeLabel = (v: string | null | undefined) =>
  dict({ requires: '依赖', blocks: '阻断', enables: '使能' }, v);

export const benefitTypeLabel = (v: string | null | undefined) =>
  dict({ cost_reduction: '降本', efficiency: '提效', revenue: '增收', risk: '风险' }, v);

export const realizationModeLabel = (v: string | null | undefined) =>
  dict(
    { cut: '裁员兑现', no_headcount_growth: '不增人', redeploy: '转岗', revenue: '直接增收', cost_avoidance: '避免成本' },
    v,
  );

export const stageTone = (v: string | null | undefined) =>
  v === 'S1' ? 'brand' : v === 'S0' ? 'gray' : v === 'S5' ? 'green' : 'blue';

export const gateTone = (v: string | null | undefined) =>
  v === 'passed' ? 'green' : v === 'rejected' ? 'red' : v === 'in_review' ? 'amber' : 'gray';

export const priorityTone = (v: string | null | undefined) =>
  v === 'priority' ? 'green' : v === 'candidate' ? 'amber' : 'gray';

export const confidenceTone = (v: string | null | undefined) =>
  v === 'high' ? 'green' : v === 'medium' ? 'amber' : 'red';

export const jsonPretty = (v: unknown) => JSON.stringify(v ?? {}, null, 2);

export const parseJson = <T,>(text: string, fallback: T): T => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};
