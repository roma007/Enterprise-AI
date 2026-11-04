-- 对账复核 → 风险/待办 的关联与防重复
ALTER TABLE copilot_reconcile_reviews
  ADD COLUMN IF NOT EXISTS risk_id uuid REFERENCES risks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS issue_id uuid REFERENCES delivery_issues(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS copilot_reconcile_risk_idx
  ON copilot_reconcile_reviews (risk_id);
CREATE INDEX IF NOT EXISTS copilot_reconcile_issue_idx
  ON copilot_reconcile_reviews (issue_id);
