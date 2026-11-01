-- =====================================================================
-- 企业 AI 化项目管理系统 · Schema
-- 对应文档：03_数据模型与页面原型.md (v1 基线) + 05_数据模型v2.md (v2.2 增量)
-- PostgreSQL 15+
--
-- 设计约束：
--   1. 枚举用 text + CHECK，不用 PG ENUM —— 迁移时改枚举不需要 ALTER TYPE。
--   2. 能从别的列算出来的，一律做成 GENERATED 列，不靠应用层写。
--   3. 四条硬规则 (R1–R4) 用触发器强制，不写在文档里。
--   4. v2.2 的生成列存在"生成列不能引用生成列"的限制，
--      所以 realized_value / payback 都用基础列内联表达式。
--
-- 表数：v1 21 张 + v2.2 新增 9 张 = 30 张
-- =====================================================================


CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------
-- 通用触发器函数
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- =====================================================================
-- 2.1 组织与用户
-- =====================================================================

CREATE TABLE organizations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  plan            text NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','enterprise')),
  industry_focus  text[] NOT NULL DEFAULT '{logistics}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  email       text NOT NULL,
  avatar_url  text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);

CREATE TABLE memberships (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('admin','director','pm','consultant','tech_lead')),
  default_rate  numeric,                  -- 内部成本，不进客户文档
  PRIMARY KEY (user_id, org_id)
);

-- 行业模板（交付物模板 + 行业打包配置）
-- 注意：v1 表结构引用了 industry_template_id，但没有单独定义这张表，这里补上。
CREATE TABLE industry_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  industry      text NOT NULL,
  template_key  text NOT NULL,            -- 'logistics_diagnosis'
  name          text NOT NULL,
  version       text NOT NULL,            -- '2.2.0'
  kind          text NOT NULL DEFAULT 'diagnosis'
                CHECK (kind IN ('diagnosis','report','one_pager','roi','roadmap')),
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (industry, template_key, version)
);

-- =====================================================================
-- 2.2 客户与干系人
-- =====================================================================

CREATE TABLE clients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  industry        text NOT NULL DEFAULT 'logistics',
  sub_industry    text,                   -- port_container_trucking / linehaul / warehouse / forwarder
  scale           text CHECK (scale IN ('<30','30-100','100-500','500+')),
  region          text,
  annual_revenue  numeric,                -- 仅内部可见（v2 起改用 client_financials 存快照）
  tags            text[] NOT NULL DEFAULT '{}',
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stakeholders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name        text NOT NULL,
  title       text,
  department  text,
  role_type   text NOT NULL CHECK (role_type IN
              ('decision_maker','project_owner','business_owner','it_data','frontline')),
  influence   int NOT NULL DEFAULT 3 CHECK (influence BETWEEN 1 AND 5),
  attitude    text NOT NULL DEFAULT 'neutral'
              CHECK (attitude IN ('champion','supporter','neutral','skeptic','blocker')),
  concerns    text[] NOT NULL DEFAULT '{}',
  is_key      boolean NOT NULL DEFAULT false,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 2.3 项目与阶段
-- =====================================================================

CREATE TABLE engagements (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id            uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  org_id               uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                 text NOT NULL,
  type                 text NOT NULL DEFAULT 'diagnosis'
                       CHECK (type IN ('diagnosis','full_cycle','poc_only')),
  stage                text NOT NULL DEFAULT 'S1'
                       CHECK (stage IN ('S0','S1','S2','S3','S4','S5')),
  status               text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','on_hold','won','lost','closed')),
  owner_id             uuid REFERENCES users(id) ON DELETE SET NULL,  -- 供应商 PM
  external_owner       uuid REFERENCES stakeholders(id) ON DELETE SET NULL, -- 客户项目负责人
  start_date           date,
  target_end_date      date,
  contract_amount      numeric,                               -- 仅内部
  industry_template_id uuid REFERENCES industry_templates(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id  uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  code           text NOT NULL CHECK (code IN ('G0','G1','G2','G3','G4','G5')),
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','in_review','passed','rejected')),
  checklist      jsonb NOT NULL DEFAULT '[]'::jsonb,
  reviewed_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at    timestamptz,
  reject_reason  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (engagement_id, code)
);

-- =====================================================================
-- 2.4 诊断：访谈、痛点、盘点、确认
-- =====================================================================

CREATE TABLE interviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  stakeholder_id uuid NOT NULL REFERENCES stakeholders(id) ON DELETE CASCADE,
  date          date NOT NULL,
  duration_min  int,
  mode          text NOT NULL DEFAULT 'onsite' CHECK (mode IN ('onsite','video','phone')),
  transcript    text,                     -- 手打纪要原文（不做 ASR）
  ai_summary    text,
  key_quotes    text[] NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','confirmed','archived')),
  confirmed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pain_points (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id      uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  code               text NOT NULL,                     -- P-001
  description        text NOT NULL,                     -- 用客户原话
  channel            text,                              -- 单证录入 / 调度 / 对账
  frequency          text CHECK (frequency IN ('daily','weekly','monthly','occasional')),
  severity           int CHECK (severity BETWEEN 1 AND 5),
  quantified_impact  text,                              -- 允许"待确认"，不允许"很大"
  current_workaround text,
  source_type        text NOT NULL CHECK (source_type IN ('interview','observation','data')),
  -- R1 的地基：来源不能为空，不能是"听说"「感觉」
  source_ref         text NOT NULL CHECK (length(btrim(source_ref)) > 0),
  status             text NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','merged','resolved')),
  merged_into        uuid,                              -- → opportunities(id)，表创建后补外键
  process_node_id    uuid,                              -- → process_nodes(id)，同上
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (engagement_id, code),
  CONSTRAINT pain_point_no_vague_impact CHECK (
    quantified_impact IS NULL OR quantified_impact NOT IN ('很大','很多','严重','不少')
  )
);

CREATE TABLE inventory_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id  uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  dimension      text NOT NULL CHECK (dimension IN ('business','data','system','org')),
  category       text,
  name           text NOT NULL,
  attributes     jsonb NOT NULL DEFAULT '{}'::jsonb,
  completeness   int NOT NULL DEFAULT 0 CHECK (completeness BETWEEN 0 AND 100),
  verified       boolean NOT NULL DEFAULT false,
  verified_note  text,
  -- v2 增量
  is_implicit    boolean NOT NULL DEFAULT false,
  discovered_by  text CHECK (discovered_by IN ('interview','observation','data')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE confirmations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  object_type   text NOT NULL CHECK (object_type IN
                ('flowchart','pain_point','opportunity','deliverable')),
  object_id     uuid NOT NULL,
  confirmed_by  uuid NOT NULL REFERENCES stakeholders(id) ON DELETE CASCADE,
  method        text NOT NULL CHECK (method IN ('meeting','email','wechat','signature')),
  evidence      text,
  confirmed_at  timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 2.5 机会点（核心）
-- =====================================================================

CREATE TABLE opportunities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id    uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  code             text NOT NULL,
  title            text NOT NULL,
  description      text,
  stage            text NOT NULL DEFAULT 'candidate' CHECK (stage IN
                   ('candidate','scored','selected','designed','piloting','validated',
                    'delivering','live','realized','closed','parked','killed')),
  value_score      int NOT NULL CHECK (value_score BETWEEN 1 AND 5),
  feasibility_score int NOT NULL CHECK (feasibility_score BETWEEN 1 AND 5),
  urgency          numeric NOT NULL DEFAULT 1.0 CHECK (urgency IN (0.8,1.0,1.2)),
  data_readiness   int CHECK (data_readiness BETWEEN 1 AND 5),
  score            numeric GENERATED ALWAYS AS
                   (value_score * feasibility_score * urgency) STORED,
  priority_band    text GENERATED ALWAYS AS (
                     CASE
                       WHEN value_score * feasibility_score * urgency >= 20 THEN 'priority'
                       WHEN value_score * feasibility_score * urgency >= 12 THEN 'candidate'
                       ELSE 'parked'
                     END) STORED,
  score_rationale  text NOT NULL,
  data_status      text NOT NULL DEFAULT 'ready'
                   CHECK (data_status IN ('ready','need_apply','need_build','unavailable')),
  has_tech_blocker boolean NOT NULL DEFAULT false,
  tech_blocker_note text,
  blocker_owner    uuid REFERENCES users(id) ON DELETE SET NULL,
  target_phase     text CHECK (target_phase IN ('phase1','phase2','watch')),
  kill_reason      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (engagement_id, code),
  CONSTRAINT tech_blocker_note_required CHECK (
    NOT has_tech_blocker OR (tech_blocker_note IS NOT NULL AND length(btrim(tech_blocker_note)) > 0)
  )
);

ALTER TABLE pain_points
  ADD CONSTRAINT pain_points_merged_into_fk
  FOREIGN KEY (merged_into) REFERENCES opportunities(id) ON DELETE SET NULL;

-- 机会点 ←→ 痛点（v1 领域图里的"关联痛点"，需要连接表）
CREATE TABLE opportunity_pain_points (
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  pain_point_id  uuid NOT NULL REFERENCES pain_points(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (opportunity_id, pain_point_id)
);

CREATE TABLE hypotheses (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id    uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  statement         text NOT NULL,
  type              text NOT NULL CHECK (type IN ('value','feasibility','adoption','data')),
  validation_status text NOT NULL DEFAULT 'unverified'
                    CHECK (validation_status IN ('unverified','validated','refuted')),
  evidence          text,
  verified_stage    text CHECK (verified_stage IN ('S1','S2','S3','S4')),
  verified_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE baselines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  metric         text NOT NULL,
  value          numeric NOT NULL,
  unit           text,
  source         text NOT NULL,
  collected_at   date,
  collected_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  confidence     text NOT NULL DEFAULT 'low' CHECK (confidence IN ('high','medium','low')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roi_models (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id        uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  benefit_type          text NOT NULL
                        CHECK (benefit_type IN ('cost_reduction','efficiency','revenue','risk')),
  formula               text,                       -- 可复核的计算式
  conservative_value    numeric,
  neutral_value         numeric NOT NULL,           -- 理论年化收益（万元）
  optimistic_value      numeric,
  one_time_cost         numeric NOT NULL DEFAULT 0, -- 一次性投入（万元）
  annual_cost           numeric NOT NULL DEFAULT 0, -- 年运维（万元）
  confidence            text NOT NULL DEFAULT 'low'
                        CHECK (confidence IN ('high','medium','low')),
  assumptions_note      text,

  -- v2.1 收益实现形态：全部不给 DEFAULT（P1 决策）
  realization_mode          text CHECK (realization_mode IN
                            ('cut','no_headcount_growth','redeploy','revenue','cost_avoidance')),
  realization_factor        numeric CHECK (realization_factor BETWEEN 0 AND 1),
  realization_note          text,
  realization_confirmed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  realization_confirmed_at  timestamptz,

  -- 生成列（金额单位：万元，保留 1 位 = 1 千元精度，与报告口径一致）
  realized_value        numeric GENERATED ALWAYS AS
                        (round(neutral_value * realization_factor, 1)) STORED,
  -- 系统口径回本：投入 ÷ (可实现年收益/12)
  payback_months        numeric GENERATED ALWAYS AS
                        (round((one_time_cost * 12)
                               / NULLIF(round(neutral_value * realization_factor, 1), 0), 2)) STORED,
  -- 含运维口径：投入 ÷ ((可实现年收益 − 年运维)/12)
  payback_months_with_ops numeric GENERATED ALWAYS AS
                        (round((one_time_cost * 12)
                               / NULLIF(round(neutral_value * realization_factor, 1) - annual_cost, 0), 2)) STORED,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- 全有或全无：选形态、定系数、署名、写理由（≥10 字）必须同时发生
  CONSTRAINT realization_all_or_nothing CHECK (
    (realization_mode IS NULL AND realization_factor IS NULL
       AND realization_confirmed_at IS NULL)
    OR
    (realization_mode IS NOT NULL AND realization_factor IS NOT NULL
       AND realization_confirmed_at IS NOT NULL
       AND realization_note IS NOT NULL
       AND length(btrim(realization_note)) >= 10)
  )
);

-- 一个机会点一张 ROI 卡（v2 的 ddl 用 opportunity_id 作唯一键）
CREATE UNIQUE INDEX roi_models_opportunity_unique ON roi_models (opportunity_id);

-- =====================================================================
-- v2 · 1. benchmarks 行业对标基准
-- =====================================================================

CREATE TABLE benchmarks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  industry      text NOT NULL,
  sub_industry  text NOT NULL DEFAULT '',   -- 必须默认 ''，否则唯一约束对 NULL 失效
  metric_key    text NOT NULL,
  metric_name   text NOT NULL,
  unit          text NOT NULL,
  direction     text NOT NULL CHECK (direction IN ('higher_better','lower_better')),
  p25           numeric,
  p50           numeric,
  p75           numeric,
  source        text NOT NULL,
  source_url    text,
  sample_size   int,
  year          int NOT NULL,
  region        text NOT NULL DEFAULT 'CN',
  calibrated    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (industry, sub_industry, metric_key, year, region)
);

-- =====================================================================
-- v2 · 2. client_financials 企业财务快照
-- =====================================================================

CREATE TABLE client_financials (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  metric_key   text NOT NULL,             -- annual_revenue / net_margin / gross_margin
  value        numeric NOT NULL,
  unit         text NOT NULL,             -- 万元 / %
  period_start date NOT NULL,
  period_end   date NOT NULL,
  source_type  text NOT NULL CHECK (source_type IN ('audited','management','estimate','public')),
  source_note  text,
  confidence   text NOT NULL CHECK (confidence IN ('high','medium','low')),
  verified_by  uuid REFERENCES stakeholders(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, metric_key, period_start)
);

-- =====================================================================
-- v2 · 3. opportunity_dependencies
-- =====================================================================

CREATE TABLE opportunity_dependencies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id    uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  to_id      uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  type       text NOT NULL CHECK (type IN ('requires','blocks','enables')),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_id <> to_id)
);

-- =====================================================================
-- v2.2 · 4. roi_sensitivity 因果传导链（P4）
-- =====================================================================

CREATE TABLE roi_sensitivity (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL REFERENCES roi_models(opportunity_id) ON DELETE CASCADE,

  -- 传导链位置；派生变量固定 90+，不参与连乘
  stage          int NOT NULL CHECK (stage >= 1),
  variable_key   text NOT NULL,
  variable_label text NOT NULL,
  unit           text,

  base_value     numeric,
  low_value      numeric,
  high_value     numeric,

  -- 这一段把上游金额乘掉多少（0–1）
  mult_base      numeric NOT NULL CHECK (mult_base BETWEEN 0 AND 1),
  mult_low       numeric CHECK (mult_low BETWEEN 0 AND 1),
  mult_high      numeric CHECK (mult_high BETWEEN 0 AND 1),

  shape          text NOT NULL DEFAULT 'linear' CHECK (shape IN ('linear','threshold')),
  threshold_note text,                    -- 阈值型变量的断崖说明
  controllable   boolean NOT NULL DEFAULT true,
  owner_role     text,
  is_derived     boolean NOT NULL DEFAULT false,
  depends_on     text[] NOT NULL DEFAULT '{}',
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (opportunity_id, variable_key),
  UNIQUE (opportunity_id, stage),
  -- 派生变量只能放在 90 之后的展示区，避免混进链条乘积
  CONSTRAINT derived_stage_reserved CHECK (NOT is_derived OR stage >= 90),
  CONSTRAINT chain_stage_reserved CHECK (is_derived OR stage < 90)
);

-- =====================================================================
-- v2 · 5. 业务流程图
-- =====================================================================

CREATE TABLE process_models (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  version       int NOT NULL DEFAULT 1,
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','confirmed','archived')),
  confirmed_by  uuid REFERENCES stakeholders(id) ON DELETE SET NULL,
  confirmed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (engagement_id, version)
);

CREATE TABLE process_nodes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id      uuid NOT NULL REFERENCES process_models(id) ON DELETE CASCADE,
  lane          text NOT NULL,
  name          text NOT NULL,
  node_type     text NOT NULL CHECK (node_type IN
                ('start','end','action','decision','wait','system','manual')),
  owner_role    text,
  duration_min  numeric,
  abnormal_rate numeric,
  is_implicit   boolean NOT NULL DEFAULT false,
  discovered_by text CHECK (discovered_by IN ('interview','observation','data')),
  pos_x         numeric,
  pos_y         numeric,
  sort_order    int,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE process_edges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id     uuid NOT NULL REFERENCES process_models(id) ON DELETE CASCADE,
  from_node_id uuid NOT NULL REFERENCES process_nodes(id) ON DELETE CASCADE,
  to_node_id   uuid NOT NULL REFERENCES process_nodes(id) ON DELETE CASCADE,
  label        text,
  condition    text,
  CHECK (from_node_id <> to_node_id)
);

ALTER TABLE pain_points
  ADD CONSTRAINT pain_points_process_node_fk
  FOREIGN KEY (process_node_id) REFERENCES process_nodes(id) ON DELETE SET NULL;

-- =====================================================================
-- 2.6 交付与决策
-- =====================================================================

CREATE TABLE deliverables (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  type          text NOT NULL CHECK (type IN
                ('charter','one_pager','diagnosis_report','roadmap','roi_sheet','data_report',
                 'prd','architecture','proposal','poc_report','uat_report','value_report')),
  title         text NOT NULL,
  version       int NOT NULL DEFAULT 1,
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','in_review','approved','shared','archived')),
  content       jsonb,
  file_url      text,
  generated_from jsonb,
  reviewed_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  -- v2 增量
  template_id       text,                 -- 'logistics_diagnosis'
  template_version  text,                 -- '2.2.0'
  generated_snapshot jsonb,               -- 生成那一刻的数据快照（用于复现）
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (engagement_id, type, version)
);

CREATE TABLE deliverable_shares (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deliverable_id uuid NOT NULL REFERENCES deliverables(id) ON DELETE CASCADE,
  shared_to      uuid NOT NULL REFERENCES stakeholders(id) ON DELETE CASCADE,
  channel        text NOT NULL CHECK (channel IN ('email','wechat','meeting','print')),
  shared_at      timestamptz NOT NULL DEFAULT now(),
  note           text
);

CREATE TABLE decisions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  title         text NOT NULL,
  context       text,
  decided_by    uuid,                     -- stakeholder.id 或 user.id
  decided_at    timestamptz NOT NULL DEFAULT now(),
  outcome       text NOT NULL CHECK (outcome IN ('approved','rejected','deferred')),
  related_type  text,
  related_id    uuid
);

CREATE TABLE risks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  title         text NOT NULL,
  category      text NOT NULL CHECK (category IN ('data','tech','org','commercial','compliance')),
  probability   int NOT NULL CHECK (probability BETWEEN 1 AND 5),
  impact        int NOT NULL CHECK (impact BETWEEN 1 AND 5),
  mitigation    text,
  owner         uuid,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','mitigated','closed')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- v2.2 · 6.5 limitations（P5）
-- =====================================================================

CREATE TABLE limitations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id  uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  source_type    text NOT NULL CHECK (source_type IN
                 ('baseline_low_confidence','client_financial','gate_gap',
                  'benchmark_uncalibrated','manual')),
  source_id      uuid,
  title          text NOT NULL,
  detail         text NOT NULL,
  affected_refs  text[] NOT NULL DEFAULT '{}',   -- 机会点 code，如 OP-02
  impact_class   text NOT NULL CHECK (impact_class IN ('amount','scope','method','internal')),
  severity       int NOT NULL DEFAULT 1 CHECK (severity BETWEEN 1 AND 3),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- v2 · 7. consistency_checks（R5 结果）
-- =====================================================================

CREATE TABLE consistency_checks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deliverable_id uuid NOT NULL REFERENCES deliverables(id) ON DELETE CASCADE,
  check_code     text NOT NULL,
  level          text NOT NULL CHECK (level IN ('block','warn')),
  passed         boolean NOT NULL,
  detail         jsonb,
  checked_at     timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 索引
-- =====================================================================

CREATE INDEX ON benchmarks (industry, metric_key);
CREATE INDEX ON stakeholders (client_id, role_type);
CREATE INDEX ON engagements (org_id, status);
CREATE INDEX ON pain_points (engagement_id, status);
CREATE INDEX ON inventory_items (engagement_id, dimension);
CREATE INDEX ON opportunities (engagement_id, priority_band);
CREATE INDEX ON baselines (opportunity_id);
CREATE INDEX ON hypotheses (opportunity_id, validation_status);
CREATE INDEX ON roi_sensitivity (opportunity_id, stage);
CREATE INDEX ON limitations (engagement_id, impact_class);
CREATE INDEX ON consistency_checks (deliverable_id, check_code);
CREATE INDEX ON deliverables (engagement_id, type, version DESC);
CREATE UNIQUE INDEX ON opportunity_dependencies (from_id, to_id, type);
CREATE INDEX ON opportunity_dependencies (to_id);
CREATE INDEX ON process_nodes (model_id, lane, sort_order);
CREATE INDEX ON process_edges (model_id);

-- 触发器：updated_at
CREATE TRIGGER trg_engagements_touch BEFORE UPDATE ON engagements
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_opportunities_touch BEFORE UPDATE ON opportunities
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_roi_models_touch BEFORE UPDATE ON roi_models
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
