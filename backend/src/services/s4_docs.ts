import { fmtLocalDateTime } from './time';
import { one, query } from '../db';

export type DeliveryDocType = 'plan' | 'uat' | 'go_live' | 'training';

export interface DeliveryBundle {
  engagement: any;
  plan: any | null;
  tasks: any[];
  uat: any[];
  goLive: any[];
  trainings: any[];
  issues: any[];
  criteria: any[];
}

const PLAN_STATUS: Record<string, string> = {
  draft: '草稿',
  active: '执行中',
  completed: '已完成',
  on_hold: '暂停',
  cancelled: '已取消',
};

const TASK_STATUS: Record<string, string> = {
  todo: '待开始',
  doing: '进行中',
  done: '已完成',
  blocked: '受阻',
};

const UAT_STATUS: Record<string, string> = {
  pending: '待执行',
  passed: '通过',
  failed: '失败',
  blocked: '阻塞',
  skipped: '跳过',
};

const GO_LIVE_STATUS: Record<string, string> = {
  pending: '待检查',
  passed: '通过',
  failed: '未通过',
  waived: '豁免',
};

const TRAINING_STATUS: Record<string, string> = {
  planned: '计划中',
  done: '已完成',
  cancelled: '已取消',
};

const ISSUE_STATUS: Record<string, string> = {
  open: '待处理',
  in_progress: '处理中',
  resolved: '已解决',
  closed: '已关闭',
  rejected: '已拒绝',
};

const table = (headers: string[], rows: string[][]) =>
  [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');

const now = () => fmtLocalDateTime();

export async function loadDeliveryBundle(
  engagementId: string,
  orgId?: string,
): Promise<DeliveryBundle | null> {
  const engagement = await one<any>(
    `SELECT e.*, c.name AS client_name
       FROM engagements e
       JOIN clients c ON c.id = e.client_id
      WHERE e.id = $1 AND e.deleted_at IS NULL AND c.deleted_at IS NULL
        ${orgId ? 'AND e.org_id = $2' : ''}`,
    orgId ? [engagementId, orgId] : [engagementId],
  );
  if (!engagement) return null;

  const plan = await one<any>(
    `SELECT p.*, u.name AS owner_name
       FROM delivery_plans p
       LEFT JOIN users u ON u.id = p.owner
      WHERE p.engagement_id = $1 AND p.status <> 'cancelled'
      ORDER BY p.version DESC LIMIT 1`,
    [engagementId],
  );

  const [tasks, uat, goLive, trainings, issues, criteria] = await Promise.all([
    plan
      ? query(
          `SELECT t.*, u.name AS owner_name
             FROM delivery_tasks t LEFT JOIN users u ON u.id = t.owner
            WHERE t.plan_id = $1 ORDER BY t.sort_order, t.created_at`,
          [plan.id],
        )
      : [],
    query(
      `SELECT c.*, a.metric AS acceptance_metric, a.target AS acceptance_target,
              u.name AS owner_name
         FROM uat_cases c
         LEFT JOIN acceptance_criteria a ON a.id = c.acceptance_id
         LEFT JOIN users u ON u.id = c.owner
        WHERE c.engagement_id = $1 ORDER BY c.code`,
      [engagementId],
    ),
    query(
      `SELECT g.*, u.name AS owner_name
         FROM go_live_items g LEFT JOIN users u ON u.id = g.owner
        WHERE g.engagement_id = $1 ORDER BY g.sort_order, g.created_at`,
      [engagementId],
    ),
    query(
      `SELECT t.*, u.name AS trainer_name
         FROM trainings t LEFT JOIN users u ON u.id = t.trainer
        WHERE t.engagement_id = $1 ORDER BY t.scheduled_at DESC NULLS LAST, t.created_at DESC`,
      [engagementId],
    ),
    query(
      `SELECT i.*, u.name AS owner_name
         FROM delivery_issues i LEFT JOIN users u ON u.id = i.owner
        WHERE i.engagement_id = $1 ORDER BY i.raised_at DESC`,
      [engagementId],
    ),
    query(
      `SELECT a.* FROM acceptance_criteria a
         JOIN solutions s ON s.id = a.solution_id
         JOIN opportunities o ON o.id = s.opportunity_id
        WHERE o.engagement_id = $1 AND a.status <> 'waived'
        ORDER BY a.sort_order, a.metric`,
      [engagementId],
    ),
  ]);

  return { engagement, plan, tasks, uat, goLive, trainings, issues, criteria };
}

function planDoc(b: DeliveryBundle) {
  const e = b.engagement;
  const p = b.plan;
  const title = `${e.name} · 实施计划`;
  const meta = {
    client: e.client_name,
    project: e.name,
    version: p ? `v${p.version}` : 'v0',
  };

  if (!p) {
    return {
      title,
      meta,
      markdown: [
        `# ${e.client_name} · ${e.name} 实施计划`,
        '',
        '尚未创建实施计划。请先在「交付」页创建计划、任务与里程碑。',
      ].join('\n'),
    };
  }

  const byPhase = new Map<string, any[]>();
  for (const t of b.tasks) {
    const list = byPhase.get(t.phase) ?? [];
    list.push(t);
    byPhase.set(t.phase, list);
  }
  const phaseSections = [...byPhase.entries()].map(([phase, list]) => {
    const rows = list.map((t) => [
      t.name,
      t.owner_name ?? '待指定',
      `${t.start_date ?? '—'} → ${t.end_date ?? '—'}`,
      TASK_STATUS[t.status] ?? t.status,
      `${t.progress}%`,
      t.is_milestone ? '是' : '',
    ]);
    return [
      `### ${phase}`,
      '',
      table(['任务', '负责人', '起止', '状态', '进度', '里程碑'], rows),
      '',
    ].join('\n');
  });

  const milestones = b.tasks.filter((t) => t.is_milestone);
  const openHigh = b.issues.filter(
    (i) => ['P0', 'P1'].includes(i.severity) && !['closed', 'rejected', 'resolved'].includes(i.status),
  );
  const changes = b.issues.filter((i) => i.kind === 'change');

  return {
    title,
    meta,
    markdown: [
      `# ${e.client_name} · ${e.name} 实施计划`,
      '',
      `> 计划版本：v${p.version}　｜　周期：${p.start_date} → ${p.end_date}　｜　状态：${PLAN_STATUS[p.status] ?? p.status}`,
      `> 项目经理：${p.owner_name ?? '待指定'}　｜　生成时间：${now()}`,
      '',
      '## 1. 项目概览',
      '',
      `本计划覆盖「${e.name}」的交付实施，目标是按 ${p.start_date} 至 ${p.end_date} 完成上线准备、UAT 验收与培训移交。`,
      '',
      p.notes ? `**说明：** ${p.notes}` : '',
      '',
      '## 2. 阶段与任务',
      '',
      phaseSections.length ? phaseSections.join('\n') : '尚未拆解任务。',
      '',
      '## 3. 关键里程碑',
      '',
      milestones.length
        ? table(
            ['里程碑', '负责人', '计划日期', '状态'],
            milestones.map((t) => [
              t.name,
              t.owner_name ?? '待指定',
              t.end_date ?? '—',
              TASK_STATUS[t.status] ?? t.status,
            ]),
          )
        : '尚未标记里程碑。',
      '',
      '## 4. 验收标准',
      '',
      b.criteria.length
        ? table(
            ['指标', '基线', '目标', '验证方法'],
            b.criteria.map((c) => [c.metric, c.baseline ?? '—', c.target, c.method]),
          )
        : '尚未定义验收标准。',
      '',
      '## 5. 风险、问题与变更',
      '',
      openHigh.length
        ? table(
            ['编号', '问题', '级别', '负责人', '状态'],
            openHigh.map((i) => [
              i.code,
              i.title,
              i.severity,
              i.owner_name ?? '待指定',
              ISSUE_STATUS[i.status] ?? i.status,
            ]),
          )
        : '当前无未关闭的 P0/P1 问题。',
      '',
      changes.length
        ? table(
            ['编号', '变更', '影响', '审批状态'],
            changes.map((i) => [i.code, i.title, i.impact ?? '—', i.approval_status]),
          )
        : '当前无变更请求。',
      '',
      '## 6. 交付确认',
      '',
      '- 计划变更需走变更审批，并同步更新本计划版本。',
      '- 上线前必须完成 UAT、上线检查与培训，具体见对应交付物。',
      '',
      '| 角色 | 姓名 | 签字 | 日期 |',
      '|---|---|---|---|',
      '| 客户项目负责人 |  |  |  |',
      '| 供应商项目经理 |  |  |  |',
      '',
      '> 本计划为执行基线；实际进度以系统任务状态为准。',
    ].join('\n'),
  };
}

function uatDoc(b: DeliveryBundle) {
  const e = b.engagement;
  const title = `${e.name} · UAT 测试报告`;
  const meta = { client: e.client_name, project: e.name, version: `v${b.plan?.version ?? 0}` };
  const passed = b.uat.filter((u) => u.status === 'passed').length;
  const failed = b.uat.filter((u) => ['failed', 'blocked'].includes(u.status)).length;
  const pending = b.uat.filter((u) => u.status === 'pending').length;
  const covered = new Set(b.uat.map((u) => u.acceptance_id).filter(Boolean));
  const uncovered = b.criteria.filter((c) => !covered.has(c.id));
  const rate = b.uat.length ? Math.round((passed / b.uat.length) * 1000) / 10 : 0;
  const conclusion =
    b.uat.length && !failed && !pending && !uncovered.length
      ? 'UAT 全部用例通过，验收标准覆盖完整，建议进入上线。'
      : 'UAT 尚未完全通过，建议补齐未执行/失败用例与未覆盖的验收标准后再上线。';

  return {
    title,
    meta,
    markdown: [
      `# ${e.client_name} · ${e.name} UAT 测试报告`,
      '',
      `> 用例：${b.uat.length} 条　｜　通过率：${rate}%　｜　生成时间：${now()}`,
      '',
      '## 1. 验收范围',
      '',
      b.criteria.length
        ? table(
            ['指标', '基线', '目标', '验证方法', '覆盖状态'],
            b.criteria.map((c) => [
              c.metric,
              c.baseline ?? '—',
              c.target,
              c.method,
              covered.has(c.id) ? '已覆盖' : '**未覆盖**',
            ]),
          )
        : '尚未定义方案验收标准。',
      '',
      '## 2. 用例与结果',
      '',
      b.uat.length
        ? table(
            ['编号', '场景', '验收标准', '预期', '实际', '执行人', '结果'],
            b.uat.map((u) => [
              u.code,
              u.scenario,
              u.acceptance_metric ?? '—',
              u.expected,
              u.actual ?? '—',
              u.owner_name ?? '—',
              UAT_STATUS[u.status] ?? u.status,
            ]),
          )
        : '尚未创建 UAT 用例。',
      '',
      '## 3. 缺陷与遗留问题',
      '',
      b.issues.length
        ? table(
            ['编号', '类型', '标题', '级别', '状态', '负责人'],
            b.issues.map((i) => [
              i.code,
              i.kind === 'change' ? '变更' : '问题',
              i.title,
              i.severity,
              ISSUE_STATUS[i.status] ?? i.status,
              i.owner_name ?? '—',
            ]),
          )
        : '无登记问题。',
      '',
      '## 4. 统计',
      '',
      `- 用例总数：${b.uat.length}`,
      `- 通过：${passed}`,
      `- 失败/阻塞：${failed}`,
      `- 待执行：${pending}`,
      `- 未覆盖验收标准：${uncovered.length}`,
      '',
      '## 5. 结论',
      '',
      conclusion,
      '',
      '| 角色 | 姓名 | 结论 | 签字 | 日期 |',
      '|---|---|---|---|---|',
      '| 客户业务负责人 |  |  |  |  |',
      '| 客户 IT 负责人 |  |  |  |  |',
      '| 供应商项目经理 |  |  |  |  |',
    ].join('\n'),
  };
}

function goLiveDoc(b: DeliveryBundle) {
  const e = b.engagement;
  const title = `${e.name} · 上线检查表`;
  const meta = { client: e.client_name, project: e.name, version: `v${b.plan?.version ?? 0}` };
  const byCategory = new Map<string, any[]>();
  for (const i of b.goLive) {
    const list = byCategory.get(i.category) ?? [];
    list.push(i);
    byCategory.set(i.category, list);
  }
  const sections = [...byCategory.entries()].map(([category, list]) => {
    const rows = list.map((i) => [
      i.item,
      i.blocking ? '是' : '',
      i.owner_name ?? '待指定',
      i.evidence ?? '—',
      GO_LIVE_STATUS[i.status] ?? i.status,
    ]);
    return [`### ${category}`, '', table(['检查项', '阻断', '负责人', '证据', '状态'], rows), ''].join('\n');
  });
  const blockingOpen = b.goLive.filter(
    (i) => i.blocking && !['passed', 'waived'].includes(i.status),
  );

  return {
    title,
    meta,
    markdown: [
      `# ${e.client_name} · ${e.name} 上线检查表`,
      '',
      `> 检查项：${b.goLive.length} 项　｜　阻断未通过：${blockingOpen.length} 项　｜　生成时间：${now()}`,
      '',
      '## 1. 上线信息',
      '',
      `- 项目：${e.name}`,
      `- 客户：${e.client_name}`,
      `- 计划上线周期：${b.plan ? `${b.plan.start_date} → ${b.plan.end_date}` : '待定'}`,
      `- 项目经理：${b.plan?.owner_name ?? '待指定'}`,
      '',
      '## 2. 检查项',
      '',
      sections.length ? sections.join('\n') : '尚未建立上线检查项。',
      '',
      '## 3. 阻断项',
      '',
      blockingOpen.length
        ? blockingOpen
            .map((i) => `- [ ] ${i.category} · ${i.item}（负责人：${i.owner_name ?? '待指定'}）`)
            .join('\n')
        : '所有阻断项已通过或豁免。',
      '',
      '## 4. 回滚与应急',
      '',
      '| 项目 | 内容 | 负责人 |',
      '|---|---|---|',
      '| 回滚触发条件 | 核心流程连续失败 / 数据错误不可接受 | 待指定 |',
      '| 回滚步骤 | 停止新流量 → 恢复上一版本 → 校验数据 → 通知业务 | 待指定 |',
      '| 应急联系人 |  | 待指定 |',
      '| 监控与告警 | 接口成功率、任务积压、异常日志 | 待指定 |',
      '',
      '## 5. 上线结论',
      '',
      blockingOpen.length
        ? '存在未通过的阻断项，**不建议上线**。'
        : '阻断项全部通过，建议按计划上线。',
      '',
      '| 角色 | 姓名 | 结论 | 签字 | 日期 |',
      '|---|---|---|---|---|',
      '| 客户业务负责人 |  |  |  |  |',
      '| 供应商项目经理 |  |  |  |  |',
      '| 运维负责人 |  |  |  |  |',
      '',
      '> 上线检查表需与客户确认记录一并归档。',
    ].join('\n'),
  };
}

function trainingDoc(b: DeliveryBundle) {
  const e = b.engagement;
  const title = `${e.name} · 培训材料`;
  const meta = { client: e.client_name, project: e.name, version: `v${b.plan?.version ?? 0}` };
  const done = b.trainings.filter((t) => t.status === 'done');

  return {
    title,
    meta,
    markdown: [
      `# ${e.client_name} · ${e.name} 培训材料`,
      '',
      `> 培训场次：${b.trainings.length}　｜　已完成：${done.length}　｜　生成时间：${now()}`,
      '',
      '## 1. 培训安排',
      '',
      b.trainings.length
        ? table(
            ['主题', '对象', '形式', '讲师', '日期', '人数', '状态'],
            b.trainings.map((t) => [
              t.title,
              t.audience ?? '—',
              t.mode,
              t.trainer_name ?? '—',
              t.scheduled_at ?? '—',
              t.attendees != null ? String(t.attendees) : '—',
              TRAINING_STATUS[t.status] ?? t.status,
            ]),
          )
        : '尚未安排培训。',
      '',
      '## 2. 培训大纲',
      '',
      '1. 系统整体流程与角色分工',
      '2. 核心功能演示：订单/托书结构化录入、异常处理、人工复核',
      '3. 日常操作：查询、导出、问题上报',
      '4. 管理员操作：用户与权限、基础数据维护',
      '5. 上线初期支持方式与联系人',
      '',
      '## 3. 操作要点',
      '',
      b.trainings
        .filter((t) => t.materials)
        .map((t) => `- **${t.title}**：${t.materials}`)
        .join('\n') || '- 培训材料待补充。',
      '',
      '## 4. 常见问题',
      '',
      '| 问题 | 处理方式 |',
      '|---|---|',
      '| 识别结果不正确 | 在复核界面修正并标记，形成样本回流 |',
      '| 接口调用失败 | 查看任务日志，联系运维并登记问题 |',
      '| 权限不足 | 联系管理员在用户管理中授权 |',
      '',
      '## 5. 反馈与跟进',
      '',
      b.trainings
        .filter((t) => t.feedback)
        .map((t) => `- **${t.title}**：${t.feedback}`)
        .join('\n') || '- 暂无培训反馈。',
      '',
      '## 6. 移交清单',
      '',
      '- [ ] 操作手册与培训材料已交付',
      '- [ ] 管理员账号与权限已移交',
      '- [ ] 上线支持联系人已确认',
      '- [ ] 遗留问题清单与负责人已确认',
      '',
      '| 角色 | 姓名 | 签字 | 日期 |',
      '|---|---|---|---|',
      '| 客户培训负责人 |  |  |  |',
      '| 供应商交付经理 |  |  |  |',
    ].join('\n'),
  };
}

export function renderDeliveryDoc(bundle: DeliveryBundle, type: DeliveryDocType) {
  if (type === 'plan') return planDoc(bundle);
  if (type === 'uat') return uatDoc(bundle);
  if (type === 'go_live') return goLiveDoc(bundle);
  return trainingDoc(bundle);
}
