-- R5 · S5 运营与价值
-- 指标字典 → 目标 → 周期快照 → 价值记录 → 使用数据 → 续约/二期风险

CREATE TABLE IF NOT EXISTS metric_definitions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,
  name        text NOT NULL,
  unit        text NOT NULL DEFAULT '',
  direction   text NOT NULL DEFAULT 'higher_better'
              CHECK (direction IN ('higher_better','lower_better')),
  category    text NOT NULL DEFAULT 'value',
  formula     text,
  source      text,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS metric_targets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id  uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  metric_id      uuid NOT NULL REFERENCES metric_definitions(id) ON DELETE CASCADE,
  baseline       numeric,
  target         numeric,
  target_date    date,
  owner          uuid REFERENCES users(id) ON DELETE SET NULL,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (opportunity_id, metric_id)
);

CREATE TABLE IF NOT EXISTS metric_snapshots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id   uuid NOT NULL REFERENCES metric_targets(id) ON DELETE CASCADE,
  period      text NOT NULL,                    -- 2026-11
  value       numeric NOT NULL,
  source      text NOT NULL,
  confidence  text NOT NULL DEFAULT 'low'
              CHECK (confidence IN ('high','medium','low')),
  note        text,
  recorded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_id, period)
);

CREATE TABLE IF NOT EXISTS value_records (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id  uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  target_id      uuid REFERENCES metric_targets(id) ON DELETE SET NULL,
  metric_id      uuid NOT NULL REFERENCES metric_definitions(id) ON DELETE CASCADE,
  period         text NOT NULL,                 -- 2026-11
  realized_value numeric NOT NULL,              -- 按指标单位；财务类统一万元
  method         text NOT NULL,                 -- 归因方法
  evidence       text NOT NULL,                 -- 数据来源/凭证
  confidence     text NOT NULL DEFAULT 'low'
                 CHECK (confidence IN ('high','medium','low')),
  variance_note  text,
  verified_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (opportunity_id, metric_id, period)
);

CREATE TABLE IF NOT EXISTS usage_records (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  solution_id   uuid REFERENCES solutions(id) ON DELETE SET NULL,
  period        text NOT NULL,                  -- 2026-11
  active_users  int NOT NULL DEFAULT 0 CHECK (active_users >= 0),
  volume        numeric NOT NULL DEFAULT 0 CHECK (volume >= 0),
  errors        int NOT NULL DEFAULT 0 CHECK (errors >= 0),
  source        text NOT NULL,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS renewal_risks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id  uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  kind           text NOT NULL DEFAULT 'renewal'
                 CHECK (kind IN ('renewal','expansion')),
  title          text NOT NULL,
  probability    text NOT NULL DEFAULT 'medium'
                 CHECK (probability IN ('high','medium','low')),
  impact         text,
  action         text,
  owner          uuid REFERENCES users(id) ON DELETE SET NULL,
  due_date       date,
  value_potential numeric,
  status         text NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','mitigating','closed')),
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS metric_targets_eng_idx ON metric_targets (engagement_id, opportunity_id);
CREATE INDEX IF NOT EXISTS metric_snapshots_target_idx ON metric_snapshots (target_id, period DESC);
CREATE INDEX IF NOT EXISTS value_records_eng_idx ON value_records (engagement_id, period DESC);
CREATE INDEX IF NOT EXISTS usage_records_eng_idx ON usage_records (engagement_id, period DESC);
CREATE INDEX IF NOT EXISTS renewal_risks_eng_idx ON renewal_risks (engagement_id, status, due_date);
