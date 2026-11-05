/**
 * 合成演示数据：把 S2–S5 页面填满，便于演示/验收 UI。
 *
 *   npm run demo:seed
 *
 * 注意：所有数据都带“【合成演示】”标记，只用于演示和联调；
 * 不能当作真实客户试点、真实 POC 或真实价值结论。
 */
import { closePool, one, query, withTransaction } from '../src/db';

const MARK = '【合成演示】';

function log(message: string) {
  console.log(`  ${message}`);
}

async function main() {
  const eng = await one<{ id: string; client_id: string; org_id: string; name: string }>(
    `SELECT id, client_id, org_id, name
       FROM engagements
      WHERE deleted_at IS NULL
      ORDER BY created_at
      LIMIT 1`,
  );
  if (!eng) throw new Error('没有可用项目，请先 npm run db:reset');

  const users = await query<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE org_id = $1 ORDER BY email`,
    [eng.org_id],
  );
  const owner =
    users.find((u) => u.email === 'zhang@hengzhi.ai')?.id ?? users[0]?.id;
  if (!owner) throw new Error('没有可用用户');

  const opps = await query<{ id: string; code: string }>(
    `SELECT id, code FROM opportunities WHERE engagement_id = $1 ORDER BY code`,
    [eng.id],
  );
  const oppByCode = new Map(opps.map((o) => [o.code, o.id]));
  const picked = ['OP-01', 'OP-02', 'OP-03', 'OP-04'].map((code) => {
    const id = oppByCode.get(code);
    if (!id) throw new Error(`缺少机会点 ${code}`);
    return { id, code };
  });
  const oppIds = picked.map((o) => o.id);

  const stakeholder = await one<{ id: string }>(
    `SELECT id FROM stakeholders WHERE client_id = $1 ORDER BY created_at LIMIT 1`,
    [eng.client_id],
  );
  if (!stakeholder) throw new Error('缺少客户干系人');

  const summary = await withTransaction(async (client) => {
    const q = async (sql: string, params: unknown[] = []) =>
      (await client.query(sql, params)).rows as any[];

    // ------------------------------------------------------------ 清理旧演示数据
    await q(`DELETE FROM confirmations WHERE engagement_id = $1 AND object_id IN
               (SELECT id FROM deliverables WHERE engagement_id = $1 AND title LIKE $2)`,
      [eng.id, `${MARK}%`]);
    await q(`DELETE FROM deliverables WHERE engagement_id = $1 AND title LIKE $2`,
      [eng.id, `${MARK}%`]);
    await q(`DELETE FROM quotes WHERE engagement_id = $1 AND notes LIKE $2`,
      [eng.id, `${MARK}%`]);
    await q(`DELETE FROM solutions WHERE opportunity_id = ANY($1::uuid[]) AND scope LIKE $2`,
      [oppIds, `${MARK}%`]);
    await q(`DELETE FROM poc_experiments WHERE opportunity_id = ANY($1::uuid[]) AND hypothesis LIKE $2`,
      [oppIds, `${MARK}%`]);
    await q(`DELETE FROM delivery_plans WHERE engagement_id = $1 AND name LIKE $2`,
      [eng.id, `${MARK}%`]);
    await q(`DELETE FROM uat_cases WHERE engagement_id = $1 AND code LIKE 'DEMO-%'`, [eng.id]);
    await q(`DELETE FROM go_live_items WHERE engagement_id = $1 AND item LIKE $2`,
      [eng.id, `${MARK}%`]);
    await q(`DELETE FROM trainings WHERE engagement_id = $1 AND title LIKE $2`,
      [eng.id, `${MARK}%`]);
    await q(`DELETE FROM delivery_issues WHERE engagement_id = $1 AND code LIKE 'DEMO-%'`, [eng.id]);
    await q(`DELETE FROM value_records WHERE engagement_id = $1 AND evidence LIKE $2`,
      [eng.id, `${MARK}%`]);
    await q(`DELETE FROM metric_targets WHERE engagement_id = $1 AND note LIKE $2`,
      [eng.id, `${MARK}%`]);
    await q(`DELETE FROM usage_records WHERE engagement_id = $1 AND note LIKE $2`,
      [eng.id, `${MARK}%`]);
    await q(`DELETE FROM renewal_risks WHERE engagement_id = $1 AND note LIKE $2`,
      [eng.id, `${MARK}%`]);

    // ------------------------------------------------------------ S2 方案
    const acceptanceIds: Array<{ id: string; metric: string }> = [];
    const solutionIds = new Map<string, string>();
    const componentDays = [10, 8, 12, 6];
    const rates = [0.25, 0.3, 0.2, 0.22];

    for (let i = 0; i < picked.length; i++) {
      const opp = picked[i];
      const versions = opp.code === 'OP-01' ? [1, 2] : [1];
      for (const version of versions) {
        const archived = version === 1 && opp.code === 'OP-01';
        const scope = `${MARK}${opp.code} 方案 v${version}：${archived ? '一期试点范围' : '一期试点 + 异常处理'}`;
        const [solution] = await q(
          `INSERT INTO solutions
             (opportunity_id, version, status, scope, approach, architecture, deployment,
              security, assumptions, exclusions, created_by, owner_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING id`,
          [
            opp.id,
            version,
            archived ? 'archived' : 'approved',
            scope,
            'OCR/规则先抽取，人工只处理低置信与异常',
            'TMS 前置解析服务 + 规则引擎 + 人工复核台',
            '客户内网私有化，单实例交付',
            '数据不出内网，日志脱敏，关键操作留痕',
            '历史单据格式基本稳定',
            '不覆盖手写体与极端模糊图片',
            owner,
            owner,
          ],
        );
        solutionIds.set(`${opp.code}-v${version}`, solution.id);
        if (archived) continue;

        await q(
          `INSERT INTO solution_components
             (solution_id, name, type, description, effort_days, sort_order)
           VALUES ($1,$2,$3,$4,$5,1), ($1,$6,$7,$8,$9,2)`,
          [
            solution.id,
            '单据解析服务', 'build', 'OCR + 字段抽取 + 规则校验', componentDays[i] * 0.6,
            '异常复核台', 'build', '低置信/差异单据人工确认', componentDays[i] * 0.4,
          ],
        );
        await q(
          `INSERT INTO integrations
             (solution_id, system, direction, protocol, fields, frequency, owner, risk, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1)`,
          [
            solution.id,
            'TMS', 'bidirectional', 'REST',
            '托书号、箱号、客户、截港、费用', '实时',
            '客户 IT', '接口文档需客户确认',
          ],
        );
        await q(
          `INSERT INTO workload_estimates (solution_id, role, days, rate)
           VALUES ($1,$2,$3,$4), ($1,$5,$6,$7)`,
          [
            solution.id,
            '算法/规则', componentDays[i] * 0.6, rates[i],
            '前端/交付', componentDays[i] * 0.4, 0.2,
          ],
        );
        const [criterion] = await q(
          `INSERT INTO acceptance_criteria
             (solution_id, metric, baseline, target, method, owner, status, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,'met',1)
           RETURNING id, metric`,
          [
            solution.id,
            i === 0 ? '托书字段准确率' : i === 1 ? '异常费用识别率' : i === 2 ? '单证核对准确率' : '客户查询响应时间',
            i === 0 ? '人工录入 90%' : '人工抽检 80%',
            i === 0 ? '≥95%' : i === 1 ? '≥90%' : i === 2 ? '≥95%' : '≤2 秒',
            '客户样本抽检 100 单',
            '客户业务负责人',
          ],
        );
        acceptanceIds.push({ id: criterion.id, metric: criterion.metric });
        await q(
          `INSERT INTO solution_reviews (solution_id, reviewer, decision, comments)
           VALUES ($1,$2,'approved',$3)`,
          [solution.id, owner, `${MARK}评审通过`],
        );
      }
    }

    // ------------------------------------------------------------ 报价（两版，便于版本对比）
    for (const version of [1, 2]) {
      const [quote] = await q(
        `INSERT INTO quotes
           (engagement_id, version, currency, payment_terms, valid_until, status, notes)
         VALUES ($1,$2,'CNY','3:4:3','2026-12-31',$3,$4)
         RETURNING id`,
        [
          eng.id,
          version,
          version === 1 ? 'sent' : 'accepted',
          `${MARK}报价 v${version}（合成数据，不构成商务承诺）`,
        ],
      );
      let sort = 0;
      for (const opp of picked) {
        const solId = solutionIds.get(`${opp.code}-v2`) ?? solutionIds.get(`${opp.code}-v1`);
        if (!solId) continue;
        const bump = version === 2 ? 1.06 : 1;
        await q(
          `INSERT INTO quote_items
             (quote_id, solution_id, kind, description, qty, unit_price, sort_order)
           VALUES ($1,$2,'one_time',$3,1,$4,$5), ($1,$2,'annual_ops',$6,1,$7,$8)`,
          [
            quote.id, solId, `${opp.code} 实施费`, Number((30 * bump).toFixed(2)), ++sort,
            `${opp.code} 年运维`, Number((6 * bump).toFixed(2)), ++sort,
          ],
        );
      }
    }

    // ------------------------------------------------------------ S3 POC
    const [experiment] = await q(
      `INSERT INTO poc_experiments
         (opportunity_id, version, hypothesis, method, sample_size, success_metric,
          threshold, start_date, end_date, owner, status)
       VALUES ($1,1,$2,$3,200,$4,'≥95%','2026-10-01','2026-10-20',$5,'passed')
       RETURNING id`,
      [
        picked[0].id,
        `${MARK}托书字段可由 OCR + 规则稳定抽取`,
        '抽 200 份历史托书，与人工录入结果比对，低置信转人工',
        '托书字段准确率',
        owner,
      ],
    );
    const [dataset] = await q(
      `INSERT INTO poc_datasets
         (experiment_id, name, source, sample_count, fields, access_status, version, note)
       VALUES ($1,$2,'客户 TMS 历史托书',200,$3,'approved','v1',$4)
       RETURNING id`,
      [experiment.id, `${MARK}托书样本 200 份`, '托书号、箱号、客户、截港、费用', `${MARK}已脱敏`],
    );
    const [run] = await q(
      `INSERT INTO poc_runs
         (experiment_id, run_no, dataset_id, config, finished_at, metrics, issues)
       VALUES ($1,1,$2,$3,now(),$4::jsonb,null)
       RETURNING id`,
      [
        experiment.id,
        dataset.id,
        'rule-first + LLM fallback',
        JSON.stringify({ accuracy: 0.96, false_positive: 0.02, sample_count: 200 }),
      ],
    );
    await q(
      `INSERT INTO poc_reviews (run_id, reviewer, sample_count, accuracy, false_positive, notes)
       VALUES ($1,$2,200,0.96,0.02,$3)`,
      [run.id, owner, `${MARK}人工抽检通过`],
    );
    await q(
      `INSERT INTO poc_conclusions (experiment_id, decision, evidence, conditions, decided_by)
       VALUES ($1,'go',$2,'先在一期试点范围上线，低置信转人工',$3)`,
      [experiment.id, `${MARK}200 份样本，字段准确率 96%`, owner],
    );

    // ------------------------------------------------------------ S4 交付
    const [plan] = await q(
      `INSERT INTO delivery_plans
         (engagement_id, version, name, start_date, end_date, status, owner, notes)
       VALUES ($1,1,$2,'2026-11-01','2026-12-31','active',$3,$4)
       RETURNING id`,
      [eng.id, `${MARK}一期实施计划`, owner, `${MARK}合成演示计划`],
    );
    const tasks = [
      ['准备', '环境与账号开通', 'done', 100, true],
      ['集成', 'TMS 接口联调', 'done', 100, false],
      ['试点', '托书解析试运行', 'doing', 70, false],
      ['验收', 'UAT 与签收', 'todo', 0, true],
    ];
    for (let i = 0; i < tasks.length; i++) {
      const [phase, name, status, progress, milestone] = tasks[i];
      await q(
        `INSERT INTO delivery_tasks
           (plan_id, phase, name, owner, start_date, end_date, status, progress, is_milestone, sort_order)
         VALUES ($1,$2,$3,$4,'2026-11-01','2026-12-31',$5,$6,$7,$8)`,
        [plan.id, phase, `${MARK}${name}`, owner, status, progress, milestone, i],
      );
    }
    for (let i = 0; i < acceptanceIds.length; i++) {
      const criterion = acceptanceIds[i];
      await q(
        `INSERT INTO uat_cases
           (engagement_id, acceptance_id, code, scenario, steps, expected, actual, status, owner, executed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'passed',$8,now())`,
        [
          eng.id,
          criterion.id,
          `DEMO-UAT-${i + 1}`,
          `${MARK}${criterion.metric}验收`,
          '按客户样本抽检 100 单',
          criterion.metric,
          '通过',
          owner,
        ],
      );
    }
    const goLive = [
      '网络与账号开通',
      'TMS 接口连通',
      '数据脱敏确认',
      '回滚方案确认',
      '值班人确认',
    ];
    for (let i = 0; i < goLive.length; i++) {
      await q(
        `INSERT INTO go_live_items
           (engagement_id, category, item, status, blocking, owner, evidence, checked_at, sort_order)
         VALUES ($1,'上线检查',$2,'passed',true,$3,$4,now(),$5)`,
        [eng.id, `${MARK}${goLive[i]}`, owner, `${MARK}检查通过`, i],
      );
    }
    await q(
      `INSERT INTO trainings
         (engagement_id, title, audience, mode, trainer, scheduled_at, attendees, materials, status, feedback)
       VALUES ($1,$2,'单证员/财务','onsite',$3,'2026-11-20',12,$4,'done',$5)`,
      [eng.id, `${MARK}一期用户培训`, owner, '操作手册 + 录屏', `${MARK}培训反馈良好`],
    );
    await q(
      `INSERT INTO delivery_issues
         (engagement_id, code, kind, title, description, severity, status, owner, due_date,
          resolution, approval_status, approved_by, approved_at, closed_at)
       VALUES ($1,'DEMO-ISS-1','issue',$2,'合成演示问题','P2','resolved',$3,'2026-11-30',$4,'not_required',null,null,now())`,
      [eng.id, `${MARK}低置信样本需补充规则`, owner, `${MARK}已补充规则并复测`],
    );
    await q(
      `INSERT INTO delivery_issues
         (engagement_id, code, kind, title, description, severity, status, owner, due_date,
          resolution, approval_status, approved_by, approved_at)
       VALUES ($1,'DEMO-CHG-1','change',$2,'合成演示变更','P3','closed',$3,'2026-11-30',$4,'approved',$3,now())`,
      [eng.id, `${MARK}增加费用字段校验`, owner, `${MARK}已评审通过`],
    );

    const [uatReport] = await q(
      `INSERT INTO deliverables
         (engagement_id, type, title, version, status, content, template_id, template_version)
       VALUES ($1,'uat_report',$2,1,'approved',$3::jsonb,'demo_uat','1.0')
       RETURNING id`,
      [eng.id, `${MARK}UAT 报告`, JSON.stringify({ summary: '合成演示 UAT 全部通过' })],
    );
    await q(
      `INSERT INTO confirmations
         (engagement_id, object_type, object_id, confirmed_by, method, evidence, confirmed_at)
       VALUES ($1,'deliverable',$2,$3,'signature',$4,now())`,
      [eng.id, uatReport.id, stakeholder.id, `${MARK}客户签收（合成演示）`],
    );

    // ------------------------------------------------------------ S5 运营与价值
    const defs: Array<[string, string, string, string, string, string]> = [
      ['doc_entry_minutes', '单均录入耗时', '分钟', 'lower_better', 'efficiency', '人工录入耗时 / 单量'],
      ['reconcile_hours', '月度对账工时', '小时/月', 'lower_better', 'efficiency', '财务对账投入工时'],
      ['entry_accuracy', '托书字段准确率', '%', 'higher_better', 'quality', '抽检正确字段 / 总字段'],
      ['receivable_days', '平均回款天数', '天', 'lower_better', 'cash', '回款周期加权平均'],
    ];
    const metricIds = new Map<string, string>();
    for (const [key, name, unit, direction, category, formula] of defs) {
      const [row] = await q(
        `INSERT INTO metric_definitions (key, name, unit, direction, category, formula, source)
         VALUES ($1,$2,$3,$4,$5,$6,'合成演示指标')
         ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, unit = EXCLUDED.unit,
           direction = EXCLUDED.direction, category = EXCLUDED.category,
           formula = EXCLUDED.formula, source = EXCLUDED.source, updated_at = now()
         RETURNING id`,
        [key, name, unit, direction, category, formula],
      );
      metricIds.set(key, row.id);
    }
    const targets = [
      { key: 'doc_entry_minutes', baseline: 10, target: 3, value: 5.2, note: '首月仍在爬坡，未达目标' },
      { key: 'reconcile_hours', baseline: 80, target: 30, value: 34, note: '差异解释仍需人工复核' },
      { key: 'entry_accuracy', baseline: 90, target: 95, value: 96, note: '' },
      { key: 'receivable_days', baseline: 45, target: 35, value: 38, note: '部分客户回款延迟' },
    ];
    for (const t of targets) {
      const [target] = await q(
        `INSERT INTO metric_targets
           (engagement_id, opportunity_id, metric_id, baseline, target, target_date, owner, note)
         VALUES ($1,$2,$3,$4,$5,'2026-12-31',$6,$7)
         RETURNING id`,
        [eng.id, picked[0].id, metricIds.get(t.key), t.baseline, t.target, owner, `${MARK}${t.note || '目标'}`],
      );
      for (const [idx, period] of ['2026-09', '2026-10'].entries()) {
        const value = idx === 0 ? t.baseline : t.value;
        await q(
          `INSERT INTO metric_snapshots
             (target_id, period, value, source, confidence, note, recorded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [target.id, period, value, `${MARK}TMS/财务台账`, idx === 0 ? 'medium' : 'high', `${MARK}周期快照`, owner],
        );
        const diff = Math.abs(value - t.target) / t.target;
        await q(
          `INSERT INTO value_records
             (engagement_id, opportunity_id, target_id, metric_id, period, realized_value,
              method, evidence, confidence, variance_note, verified_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'high',$9,$10)`,
          [
            eng.id, picked[0].id, target.id, metricIds.get(t.key), period, value,
            '与客户基线对比，按同口径折算',
            `${MARK}客户台账 + 抽检记录`,
            diff > 0.1 ? `${MARK}${t.note || '差异说明'}` : null,
            owner,
          ],
        );
      }
    }
    await q(
      `INSERT INTO usage_records
         (engagement_id, solution_id, period, active_users, volume, errors, source, note)
       VALUES ($1,$2,'2026-10',8,1200,12,$3,$4)`,
      [eng.id, solutionIds.get('OP-01-v2'), `${MARK}ai-copilot 运行日志`, `${MARK}使用数据`],
    );
    await q(
      `INSERT INTO renewal_risks
         (engagement_id, kind, title, probability, impact, action, owner, due_date, value_potential, status, note)
       VALUES ($1,'renewal',$2,'medium','一期效果达标后转二期',$3,$4,'2027-01-31',120,'mitigating',$5)`,
      [eng.id, `${MARK}续约取决于一期指标兑现`, '每月复盘指标，提前锁定二期范围', owner, `${MARK}续约风险`],
    );

    // ------------------------------------------------------------ 阶段与机会点
    await q(`UPDATE engagements SET stage = 'S5', updated_at = now() WHERE id = $1`, [eng.id]);
    await q(`UPDATE opportunities SET stage = CASE code
               WHEN 'OP-01' THEN 'validated'
               WHEN 'OP-02' THEN 'delivering'
               WHEN 'OP-03' THEN 'designed'
               WHEN 'OP-04' THEN 'designed'
               ELSE stage END,
               updated_at = now()
             WHERE engagement_id = $1`, [eng.id]);

    const counts = await q(
      `SELECT
         (SELECT count(*)::int FROM solutions WHERE opportunity_id = ANY($1::uuid[]) AND status <> 'archived') AS solutions,
         (SELECT count(*)::int FROM quotes WHERE engagement_id = $2 AND notes LIKE $3) AS quotes,
         (SELECT count(*)::int FROM poc_experiments WHERE opportunity_id = ANY($1::uuid[])) AS experiments,
         (SELECT count(*)::int FROM delivery_plans WHERE engagement_id = $2 AND name LIKE $3) AS plans,
         (SELECT count(*)::int FROM uat_cases WHERE engagement_id = $2 AND code LIKE 'DEMO-%') AS uat,
         (SELECT count(*)::int FROM metric_targets WHERE engagement_id = $2 AND note LIKE $3) AS targets,
         (SELECT count(*)::int FROM value_records WHERE engagement_id = $2 AND evidence LIKE $3) AS values,
         (SELECT count(*)::int FROM renewal_risks WHERE engagement_id = $2 AND note LIKE $3) AS risks`,
      [oppIds, eng.id, `${MARK}%`],
    );
    return counts[0];
  });

  log(`项目：${eng.name}`);
  log(`S2 方案 ${summary.solutions}；报价 ${summary.quotes}；S3 实验 ${summary.experiments}`);
  log(`S4 计划 ${summary.plans}；UAT ${summary.uat}；S5 目标 ${summary.targets}；价值记录 ${summary.values}；风险 ${summary.risks}`);
  log('所有数据均带“【合成演示】”标记，不代表真实客户结果。');
  await closePool();
}

main().catch(async (err) => {
  console.error(err);
  await closePool().catch(() => undefined);
  process.exitCode = 1;
});
