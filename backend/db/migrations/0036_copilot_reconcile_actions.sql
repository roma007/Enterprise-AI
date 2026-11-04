-- 对账复核：按单条差异生成风险/待办
CREATE TABLE IF NOT EXISTS copilot_reconcile_actions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id     uuid NOT NULL REFERENCES copilot_reconcile_reviews(id) ON DELETE CASCADE,
  difference_id text NOT NULL,
  action_type   text NOT NULL CHECK (action_type IN ('risk', 'issue')),
  target_id     uuid NOT NULL,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (review_id, difference_id, action_type)
);

CREATE INDEX IF NOT EXISTS copilot_reconcile_actions_review_idx
  ON copilot_reconcile_actions (review_id, created_at);

ALTER TABLE copilot_reconcile_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS copilot_reconcile_actions_org ON copilot_reconcile_actions;
CREATE POLICY copilot_reconcile_actions_org ON copilot_reconcile_actions
  FOR ALL
  USING (
    app_platform_admin()
    OR EXISTS (
      SELECT 1 FROM copilot_reconcile_reviews r
       WHERE r.id = review_id AND r.org_id = app_org_id()
    )
  )
  WITH CHECK (
    app_platform_admin()
    OR EXISTS (
      SELECT 1 FROM copilot_reconcile_reviews r
       WHERE r.id = review_id AND r.org_id = app_org_id()
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON copilot_reconcile_actions TO ai_delivery_app;
