-- R2 · S2 方案设计
-- 机会点 → 方案版本 → 组件 / 集成 / 工作量 / 验收标准 / 评审
-- 报价挂在项目下，报价行可关联方案；金额单位统一万元。

CREATE TABLE IF NOT EXISTS solutions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  version       int NOT NULL DEFAULT 1,
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','in_review','approved','rejected','archived')),
  scope         text NOT NULL,
  approach      text,
  architecture  text,
  deployment    text,
  security      text,
  assumptions   text,
  exclusions    text,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (opportunity_id, version)
);

CREATE TABLE IF NOT EXISTS solution_components (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  solution_id   uuid NOT NULL REFERENCES solutions(id) ON DELETE CASCADE,
  name          text NOT NULL,
  type          text NOT NULL
                CHECK (type IN ('build','buy','integrate','service')),
  description   text,
  effort_days   numeric NOT NULL DEFAULT 0 CHECK (effort_days >= 0),
  sort_order    int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS integrations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  solution_id   uuid NOT NULL REFERENCES solutions(id) ON DELETE CASCADE,
  system        text NOT NULL,
  direction     text NOT NULL
                CHECK (direction IN ('inbound','outbound','bidirectional')),
  protocol      text,
  fields        text,
  frequency     text,
  owner         text,
  risk          text,
  sort_order    int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workload_estimates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  solution_id   uuid NOT NULL REFERENCES solutions(id) ON DELETE CASCADE,
  role          text NOT NULL,
  days          numeric NOT NULL CHECK (days >= 0),
  rate          numeric NOT NULL CHECK (rate >= 0),   -- 万元/人天（内部成本）
  cost          numeric GENERATED ALWAYS AS (round(days * rate, 2)) STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (solution_id, role)
);

CREATE TABLE IF NOT EXISTS acceptance_criteria (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  solution_id   uuid NOT NULL REFERENCES solutions(id) ON DELETE CASCADE,
  metric        text NOT NULL,
  baseline      text,
  target        text NOT NULL,
  method        text NOT NULL,
  owner         text,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','met','not_met','waived')),
  sort_order    int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS solution_reviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  solution_id   uuid NOT NULL REFERENCES solutions(id) ON DELETE CASCADE,
  reviewer      uuid REFERENCES users(id) ON DELETE SET NULL,
  decision      text NOT NULL
                CHECK (decision IN ('approved','rejected','changes_requested')),
  comments      text,
  reviewed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quotes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  version       int NOT NULL DEFAULT 1,
  currency      text NOT NULL DEFAULT 'CNY',
  payment_terms text,
  valid_until   date,
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','sent','accepted','rejected','expired')),
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (engagement_id, version)
);

CREATE TABLE IF NOT EXISTS quote_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id      uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  solution_id   uuid REFERENCES solutions(id) ON DELETE SET NULL,
  kind          text NOT NULL DEFAULT 'one_time'
                CHECK (kind IN ('one_time','annual_ops')),
  description   text NOT NULL,
  qty           numeric NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit_price    numeric NOT NULL CHECK (unit_price >= 0),  -- 万元
  amount        numeric GENERATED ALWAYS AS (round(qty * unit_price, 2)) STORED,
  sort_order    int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS solutions_opportunity_idx ON solutions (opportunity_id, version DESC);
CREATE INDEX IF NOT EXISTS components_solution_idx ON solution_components (solution_id, sort_order);
CREATE INDEX IF NOT EXISTS integrations_solution_idx ON integrations (solution_id, sort_order);
CREATE INDEX IF NOT EXISTS workload_solution_idx ON workload_estimates (solution_id);
CREATE INDEX IF NOT EXISTS acceptance_solution_idx ON acceptance_criteria (solution_id, sort_order);
CREATE INDEX IF NOT EXISTS reviews_solution_idx ON solution_reviews (solution_id, reviewed_at DESC);
CREATE INDEX IF NOT EXISTS quotes_engagement_idx ON quotes (engagement_id, version DESC);
CREATE INDEX IF NOT EXISTS quote_items_quote_idx ON quote_items (quote_id, sort_order);
