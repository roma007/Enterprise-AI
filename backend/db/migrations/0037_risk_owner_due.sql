-- 风险负责人与截止日期
ALTER TABLE risks
  ADD COLUMN IF NOT EXISTS owner uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS due_date date;

CREATE INDEX IF NOT EXISTS risks_owner_idx ON risks (owner, due_date);
