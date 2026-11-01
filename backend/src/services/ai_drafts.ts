import { one, query } from '../db';

export type AiDraftKind =
  | 'interview_summary'
  | 'report_draft'
  | 'solution_skeleton'
  | 'prd_skeleton'
  | 'answer';

export interface AiContext {
  engagement: any;
  pains: any[];
  interviews: any[];
  opportunities: any[];
  solutions: any[];
  criteria: any[];
  knowledge: any[];
}

const HEADER = '> 系统生成草稿，需人工确认；不替代顾问判断。';

const fmtDate = (v: unknown) =>
  v ? new Date(String(v)).toLocaleDateString('sv-SE') : '—';

const truncate = (s: unknown, n = 120) => {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim();
  return text.length > n ? `${text.slice(0, n)}…` : text;
};

const list = (items: string[]) =>
  items.length ? items.map((i) => `- ${i}`).join('\n') : '- 暂无数据';

export async function loadAiContext(engagementId: string): Promise<AiContext | null> {
  const engagement = await one<any>(
    `SELECT e.*, c.name AS client_name, c.industry, c.sub_industry
       FROM engagements e JOIN clients c ON c.id = e.client_id
      WHERE e.id = $1 AND e.deleted_at IS NULL AND c.deleted_at IS NULL`,
    [engagementId],
  );
  if (!engagement) return null;

  const [pains, interviews, opportunities, solutions, criteria, knowledge] = await Promise.all([
    query<any>(
      `SELECT * FROM pain_points WHERE engagement_id = $1 AND status = 'open'
        ORDER BY severity DESC NULLS LAST, code LIMIT 10`,
      [engagementId],
    ),
    query<any>(
      `SELECT i.*, s.name AS stakeholder_name, s.title AS stakeholder_role
         FROM interviews i JOIN stakeholders s ON s.id = i.stakeholder_id
        WHERE i.engagement_id = $1
        ORDER BY i.date DESC, i.created_at DESC LIMIT 10`,
      [engagementId],
    ),
    query<any>(
      `SELECT * FROM opportunities WHERE engagement_id = $1
        ORDER BY score DESC NULLS LAST, code`,
      [engagementId],
    ),
    query<any>(
      `SELECT s.*, o.code AS opportunity_code, o.title AS opportunity_title
         FROM solutions s JOIN opportunities o ON o.id = s.opportunity_id
        WHERE o.engagement_id = $1
        ORDER BY s.version DESC`,
      [engagementId],
    ),
    query<any>(
      `SELECT a.* FROM acceptance_criteria a
         JOIN solutions s ON s.id = a.solution_id
         JOIN opportunities o ON o.id = s.opportunity_id
        WHERE o.engagement_id = $1 ORDER BY a.sort_order, a.metric`,
      [engagementId],
    ),
    query<any>(
      `SELECT * FROM knowledge_items
        WHERE org_id = $1 AND status = 'published'
        ORDER BY created_at DESC LIMIT 20`,
      [engagement.org_id],
    ),
  ]);

  return { engagement, pains, interviews, opportunities, solutions, criteria, knowledge };
}

function pickInterview(ctx: AiContext, sourceId?: string) {
  if (sourceId) return ctx.interviews.find((i) => i.id === sourceId) ?? null;
  return ctx.interviews.find((i) => String(i.transcript ?? '').trim()) ?? ctx.interviews[0] ?? null;
}

function interviewSummary(ctx: AiContext, sourceId?: string) {
  const e = ctx.engagement;
  const iv = pickInterview(ctx, sourceId);
  if (!iv) {
    return {
      title: `${e.name} · 访谈摘要草稿`,
      content: `${HEADER}\n\n# ${e.name} 访谈摘要草稿\n\n当前项目还没有访谈记录，无法生成摘要。先在「干系人与访谈」录入纪要。`,
    };
  }

  const lines = String(iv.transcript ?? '')
    .split(/\n+/)
    .map((l: string) => l.trim())
    .filter(Boolean)
    .slice(0, 6);
  const quotes = Array.isArray(iv.key_quotes) ? iv.key_quotes : [];
  const related = ctx.pains.slice(0, 5);

  return {
    title: `${e.name} · ${iv.stakeholder_name} 访谈摘要草稿`,
    content: [
      HEADER,
      '',
      `# ${iv.stakeholder_name} 访谈摘要（草稿）`,
      '',
      `- 项目：${e.name}`,
      `- 受访人：${iv.stakeholder_name}${iv.stakeholder_role ? ` · ${iv.stakeholder_role}` : ''}`,
      `- 访谈日期：${fmtDate(iv.date)}`,
      `- 形式：${iv.mode}`,
      '',
      '## 1. 纪要要点',
      '',
      list(lines.length ? lines.map((l) => truncate(l)) : ['原纪要为空，请补充转录文本。']),
      '',
      '## 2. 客户原话',
      '',
      list(quotes.length ? quotes.map((q: string) => `“${q}”`) : ['访谈未标记关键原话。']),
      '',
      '## 3. 可关联痛点',
      '',
      list(
        related.map(
          (p) => `${p.code} ${p.description}（${p.channel ?? '未分类'}，影响：${p.quantified_impact ?? '待确认'}）`,
        ),
      ),
      '',
      '## 4. 待确认问题',
      '',
      list([
        '这条痛点的发生频率与影响金额是否需要客户书面确认？',
        '谁对访谈纪要负责确认？确认方式是什么？',
        '是否有需要补充的数据或系统截图作为证据？',
      ]),
      '',
      '## 5. 人工复核建议',
      '',
      '- 对照原始纪要检查是否有过度归纳。',
      '- 客户原话必须保留原意，不改成内部术语。',
      '- 确认后将摘要状态改为 approved，再用于报告引用。',
    ].join('\n'),
  };
}

function reportDraft(ctx: AiContext) {
  const e = ctx.engagement;
  const phase1 = ctx.opportunities.filter((o) => o.target_phase === 'phase1');
  const topPains = ctx.pains.slice(0, 6);

  return {
    title: `${e.name} · 诊断报告草稿`,
    content: [
      HEADER,
      '',
      `# ${e.client_name} · ${e.name} 诊断报告（草稿）`,
      '',
      '## 1. 项目背景',
      '',
      `${e.client_name}（${e.industry}${e.sub_industry ? ` · ${e.sub_industry}` : ''}）本次诊断聚焦 AI 可落地的业务场景，目标是把痛点和机会点变成可验证的价值假设。`,
      '',
      '## 2. 关键发现',
      '',
      `本轮共记录 ${ctx.pains.length} 条开放痛点，按严重度排序的前 ${topPains.length} 条：`,
      '',
      list(
        topPains.map(
          (p) =>
            `**${p.code} ${truncate(p.description, 80)}** — 渠道：${p.channel ?? '未分类'}；影响：${p.quantified_impact ?? '待确认'}；现状绕行：${p.current_workaround ?? '未记录'}`,
        ),
      ),
      '',
      '## 3. 机会点组合',
      '',
      ctx.opportunities.length
        ? list(
            ctx.opportunities
              .slice(0, 8)
              .map(
                (o) =>
                  `**${o.code} ${o.title}** — 评分 ${o.score ?? '—'}（价值 ${o.value_score} × 可行 ${o.feasibility_score} × 紧迫 ${o.urgency}），阶段：${o.target_phase ?? '待定'}`,
              ),
          )
        : '- 尚未识别机会点。',
      '',
      '## 4. 建议路线',
      '',
      phase1.length
        ? list(phase1.map((o) => `${o.code} ${o.title}：优先进入方案与 POC。`))
        : '- 尚未标记一期机会点，建议先完成评分与排序。',
      '',
      '## 5. 主要风险',
      '',
      list([
        '痛点量化影响仍可能缺客户确认。',
        '数据可得性与系统接口是 POC 前置条件。',
        '组织变革与一线使用意愿需要在方案阶段单独评估。',
      ]),
      '',
      '## 6. 下一步',
      '',
      list([
        '补齐痛点来源与影响数字。',
        '对一期机会点完成方案设计与报价。',
        '用 POC 验证关键假设，再进入交付。',
      ]),
      '',
      '## 7. 人工确认',
      '',
      '本稿由系统按当前项目数据生成，顾问需核对数字、补充客户原话，并走报告审核流程。',
    ].join('\n'),
  };
}

function solutionSkeleton(ctx: AiContext, sourceId?: string) {
  const e = ctx.engagement;
  const opp =
    ctx.opportunities.find((o) => o.id === sourceId) ??
    ctx.opportunities.find((o) => o.target_phase === 'phase1') ??
    ctx.opportunities[0];
  if (!opp) {
    return {
      title: `${e.name} · 方案骨架草稿`,
      content: `${HEADER}\n\n# ${e.name} 方案骨架（草稿）\n\n当前项目还没有机会点，无法生成方案骨架。先完成机会点识别与评分。`,
    };
  }
  const sol = ctx.solutions.find((s) => s.opportunity_id === opp.id);

  return {
    title: `${opp.code} ${opp.title} · 方案骨架草稿`,
    content: [
      HEADER,
      '',
      `# ${opp.code} ${opp.title} 方案骨架（草稿）`,
      '',
      '## 1. 目标与范围',
      '',
      `- 目标：${truncate(opp.description ?? opp.title, 240)}`,
      `- 一期范围：${sol?.scope ?? '待补充：明确做什么、不做什么。'}`,
      `- 不在范围：${sol?.exclusions ?? '待补充。'}`,
      '',
      '## 2. 方案思路',
      '',
      sol?.approach
        ? `现有方案版本 v${sol.version} 的思路：${sol.approach}`
        : '待补充：用一段话说明技术路线与业务改造方式。',
      '',
      '## 3. 技术架构',
      '',
      sol?.architecture
        ? sol.architecture
        : list([
            '接入层：业务系统 / 手工上传',
            '处理层：AI 服务 + 规则校验',
            '应用层：业务工作台 / 复核队列',
            '数据层：样本库、结果库、审计日志',
          ]),
      '',
      '## 4. 关键组件',
      '',
      '待补充：组件清单、自研/采购判断、工作量估算。',
      '',
      '## 5. 系统集成',
      '',
      '待补充：TMS / WMS / 财务等系统的接口方式、频率与责任人。',
      '',
      '## 6. 验收标准',
      '',
      ctx.criteria.filter((c) => c.opportunity_id === opp.id).length
        ? list(
            ctx.criteria
              .filter((c) => c.opportunity_id === opp.id)
              .map((c) => `${c.metric}：${c.baseline ?? '—'} → ${c.target}（${c.method}）`),
          )
        : list(['待补充：指标、基线、目标值、验证方法。']),
      '',
      '## 7. 风险与假设',
      '',
      list([
        `数据可得性：${opp.data_status ?? '待确认'}`,
        '业务配合：需要客户指定业务负责人参与验收。',
        '技术阻断：' + (opp.has_tech_blocker ? opp.tech_blocker_note ?? '已标记' : '暂无'),
      ]),
      '',
      '## 8. 下一步',
      '',
      '顾问补齐组件、集成、工作量与报价后，生成正式方案书并走评审。',
    ].join('\n'),
  };
}

function prdSkeleton(ctx: AiContext, sourceId?: string) {
  const e = ctx.engagement;
  const opp =
    ctx.opportunities.find((o) => o.id === sourceId) ??
    ctx.opportunities.find((o) => o.target_phase === 'phase1') ??
    ctx.opportunities[0];
  if (!opp) {
    return {
      title: `${e.name} · PRD 骨架草稿`,
      content: `${HEADER}\n\n# ${e.name} PRD 骨架（草稿）\n\n当前项目还没有机会点，无法生成 PRD 骨架。`,
    };
  }

  return {
    title: `${opp.code} ${opp.title} · PRD 骨架草稿`,
    content: [
      HEADER,
      '',
      `# ${opp.code} ${opp.title} PRD 骨架（草稿）`,
      '',
      '## 1. 背景与问题',
      '',
      truncate(opp.description ?? opp.title, 300),
      '',
      '## 2. 目标用户',
      '',
      list(['一线操作人员（高频执行）', '业务主管（复核与异常处理）', 'IT / 运维（接口与权限）']),
      '',
      '## 3. 核心流程',
      '',
      list([
        '数据进入：系统接口 / 文件上传 / 人工录入',
        'AI 处理：识别、抽取、校验',
        '异常处理：低置信度进入复核队列',
        '结果回写：业务系统 + 操作日志',
      ]),
      '',
      '## 4. 功能需求',
      '',
      list([
        '任务列表与状态',
        '识别结果查看与人工修正',
        '复核队列与批量处理',
        '数据导出与审计查询',
        '用户、权限与基础数据维护',
      ]),
      '',
      '## 5. 数据与接口',
      '',
      '待补充：字段清单、接口协议、调用频率、失败重试策略。',
      '',
      '## 6. 非功能需求',
      '',
      list(['单条处理时延目标', '可用性与降级策略', '数据脱敏与权限', '操作审计']),
      '',
      '## 7. 验收标准',
      '',
      ctx.criteria.filter((c) => c.opportunity_id === opp.id).length
        ? list(
            ctx.criteria
              .filter((c) => c.opportunity_id === opp.id)
              .map((c) => `${c.metric}：${c.baseline ?? '—'} → ${c.target}`),
          )
        : list(['待补充验收指标与目标值。']),
      '',
      '## 8. 待确认问题',
      '',
      list(['异常处理的责任人是谁？', '历史数据是否需要迁移？', '上线后如何收集错误样本？']),
    ].join('\n'),
  };
}

function answerDraft(ctx: AiContext, prompt?: string) {
  const e = ctx.engagement;
  const q = String(prompt ?? '').trim();
  if (!q) {
    return {
      title: `${e.name} · 问答草稿`,
      content: `${HEADER}\n\n# 问答草稿\n\n请先输入问题，例如「托书识别怎么做 POC？」。`,
    };
  }

  const bigrams = (s: string) => {
    const text = s.replace(/[^\p{L}\p{N}]+/gu, '');
    const set = new Set<string>();
    for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
    return set;
  };
  const qg = bigrams(q);
  const scored = ctx.knowledge
    .map((k) => {
      const kg = bigrams(`${k.title} ${k.summary} ${(k.tags ?? []).join(' ')} ${k.content}`);
      let overlap = 0;
      for (const g of qg) if (kg.has(g)) overlap += 1;
      return { item: k, score: overlap };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  return {
    title: `${e.name} · 问答草稿：${truncate(q, 30)}`,
    content: [
      HEADER,
      '',
      `# 问答草稿`,
      '',
      `**问题：** ${q}`,
      '',
      '## 1. 回答要点',
      '',
      scored.length
        ? list(
            scored.map(
              (x) =>
                `**${x.item.title}**：${truncate(x.item.summary, 160)}（相关度 ${x.score}）`,
            ),
          )
        : list([
            '知识库中没有直接匹配的条目。',
            '可基于当前项目数据给出初步建议，但需顾问补充行业经验。',
          ]),
      '',
      '## 2. 项目内依据',
      '',
      list([
        `开放痛点 ${ctx.pains.length} 条，机会点 ${ctx.opportunities.length} 个。`,
        `方案版本 ${ctx.solutions.length} 个，验收标准 ${ctx.criteria.length} 条。`,
        ctx.opportunities[0]
          ? `当前最高分机会点：${ctx.opportunities[0].code} ${ctx.opportunities[0].title}。`
          : '尚未识别机会点。',
      ]),
      '',
      '## 3. 参考来源',
      '',
      scored.length
        ? list(
            scored.map(
              (x) =>
                `${x.item.title}（${x.item.category}，来源：${x.item.source ?? '内部知识库'}）`,
            ),
          )
        : list(['暂无知识库引用。']),
      '',
      '## 4. 使用边界',
      '',
      '- 本回答是检索式草稿，不是模型推理结论。',
      '- 引用知识条目时需核对是否适用于当前客户与行业。',
      '- 涉及金额、承诺与合规的判断必须由顾问和客户确认。',
    ].join('\n'),
  };
}

export function buildAiDraft(
  ctx: AiContext,
  kind: AiDraftKind,
  sourceId?: string,
  prompt?: string,
): { title: string; content: string } {
  if (kind === 'interview_summary') return interviewSummary(ctx, sourceId);
  if (kind === 'report_draft') return reportDraft(ctx);
  if (kind === 'solution_skeleton') return solutionSkeleton(ctx, sourceId);
  if (kind === 'prd_skeleton') return prdSkeleton(ctx, sourceId);
  return answerDraft(ctx, prompt);
}

/** 给可选大模型使用的上下文摘要；只放已落库事实，不含推断。 */
export function summarizeAiContext(ctx: AiContext): string {
  const e = ctx.engagement;
  const lines: string[] = [
    `项目：${e.client_name} · ${e.name}`,
    `行业：${e.industry}${e.sub_industry ? ` / ${e.sub_industry}` : ''}`,
    `阶段：${e.stage}　状态：${e.status}`,
    '',
    `开放痛点（${ctx.pains.length}）：`,
    ...ctx.pains.slice(0, 8).map(
      (p) => `- ${p.code} ${p.description}（渠道：${p.channel ?? '未分类'}；影响：${p.quantified_impact ?? '待确认'}）`,
    ),
    '',
    `机会点（${ctx.opportunities.length}）：`,
    ...ctx.opportunities.slice(0, 8).map(
      (o) => `- ${o.code} ${o.title}（评分 ${o.score ?? '—'}；阶段 ${o.target_phase ?? '待定'}；数据 ${o.data_status ?? '待确认'}）`,
    ),
    '',
    `方案（${ctx.solutions.length}）：`,
    ...ctx.solutions.slice(0, 5).map(
      (s2) => `- ${s2.opportunity_code} v${s2.version}：${s2.scope}`,
    ),
    '',
    `知识库条目（${ctx.knowledge.length}）：`,
    ...ctx.knowledge.slice(0, 10).map(
      (k) => `- ${k.title}：${k.summary}（标签：${(k.tags ?? []).join('、') || '无'}）`,
    ),
  ];
  return lines.join('\n').slice(0, 7000);
}
