-- R4 · S4 交付实施
-- 实施计划 → 任务/里程碑 → UAT → 上线检查 → 培训 → 问题/变更

CREATE TABLE IF NOT EXISTS delivery_plans (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id  uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  version        int NOT NULL DEFAULT 1,
  name           text NOT NULL,
  start_date     date NOT NULL,
  end_date       date NOT NULL,
  status         text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','active','completed','on_hold','cancelled')),
  owner          uuid REFERENCES users(id) ON DELETE SET NULL,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (engagement_id, version),
  CONSTRAINT delivery_plan_dates CHECK (end_date >= start_date)
);

CREATE TABLE IF NOT EXISTS delivery_tasks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id        uuid NOT NULL REFERENCES delivery_plans(id) ON DELETE CASCADE,
  phase          text NOT NULL,
  name           text NOT NULL,
  owner          uuid REFERENCES users(id) ON DELETE SET NULL,
  start_date     date,
  end_date       date,
  status         text NOT NULL DEFAULT 'todo'
                 CHECK (status IN ('todo','doing','done','blocked')),
  progress       int NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  is_milestone   boolean NOT NULL DEFAULT false,
  dependency     text,
  note           text,
  sort_order     int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS uat_cases (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id  uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  acceptance_id  uuid REFERENCES acceptance_criteria(id) ON DELETE SET NULL,
  code           text NOT NULL,
  scenario       text NOT NULL,
  steps          text NOT NULL,
  expected       text NOT NULL,
  actual         text,
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','passed','failed','blocked','skipped')),
  owner          uuid REFERENCES users(id) ON DELETE SET NULL,
  executed_at    timestamptz,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (engagement_id, code)
);

CREATE TABLE IF NOT EXISTS go_live_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id  uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  category       text NOT NULL,
  item           text NOT NULL,
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','passed','failed','waived')),
  blocking       boolean NOT NULL DEFAULT true,
  owner          uuid REFERENCES users(id) ON DELETE SET NULL,
  evidence       text,
  checked_at     timestamptz,
  sort_order     int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trainings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id  uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  title          text NOT NULL,
  audience       text,
  mode           text NOT NULL DEFAULT 'onsite'
                 CHECK (mode IN ('onsite','video','online')),
  trainer        uuid REFERENCES users(id) ON DELETE SET NULL,
  scheduled_at   date,
  attendees      int CHECK (attendees IS NULL OR attendees >= 0),
  materials      text,
  status         text NOT NULL DEFAULT 'planned'
                 CHECK (status IN ('planned','done','cancelled')),
  feedback       text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS delivery_issues (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id   uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  code            text NOT NULL,
  kind            text NOT NULL DEFAULT 'issue'
                  CHECK (kind IN ('issue','change')),
  title           text NOT NULL,
  description     text,
  severity        text NOT NULL DEFAULT 'P2'
                  CHECK (severity IN ('P0','P1','P2','P3')),
  status          text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','in_progress','resolved','closed','rejected')),
  owner           uuid REFERENCES users(id) ON DELETE SET NULL,
  due_date        date,
  resolution      text,
  impact          text,
  approval_status text NOT NULL DEFAULT 'not_required'
                  CHECK (approval_status IN ('not_required','pending','approved','rejected')),
  approved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at     timestamptz,
  raised_at       timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (engagement_id, code)
);

CREATE INDEX IF NOT EXISTS delivery_plans_eng_idx ON delivery_plans (engagement_id, version DESC);
CREATE INDEX IF NOT EXISTS delivery_tasks_plan_idx ON delivery_tasks (plan_id, sort_order, created_at);
CREATE INDEX IF NOT EXISTS uat_cases_eng_idx ON uat_cases (engagement_id, code);
CREATE INDEX IF NOT EXISTS go_live_items_eng_idx ON go_live_items (engagement_id, sort_order);
CREATE INDEX IF NOT EXISTS trainings_eng_idx ON trainings (engagement_id, scheduled_at);
CREATE INDEX IF NOT EXISTS delivery_issues_eng_idx ON delivery_issues (engagement_id, status, severity);
