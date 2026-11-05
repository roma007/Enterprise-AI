-- 方案负责人：用于方案门禁与责任追踪
ALTER TABLE solutions
  ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_solutions_owner_id ON solutions(owner_id);
