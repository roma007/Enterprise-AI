-- 批量历史：用户保存的命名筛选视图
CREATE TABLE IF NOT EXISTS copilot_batch_filter_views (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  review_id   uuid NOT NULL REFERENCES copilot_reconcile_reviews(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  status      text CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  action_type text CHECK (action_type IN ('risk', 'issue')),
  from_date   date,
  to_date     date,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (review_id, user_id, name)
);

CREATE INDEX IF NOT EXISTS copilot_batch_filter_views_user_idx
  ON copilot_batch_filter_views (review_id, user_id, name);

ALTER TABLE copilot_batch_filter_views ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS copilot_batch_filter_views_org ON copilot_batch_filter_views;
CREATE POLICY copilot_batch_filter_views_org ON copilot_batch_filter_views
  FOR ALL
  USING (app_platform_admin() OR org_id = app_org_id())
  WITH CHECK (app_platform_admin() OR org_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON copilot_batch_filter_views TO ai_delivery_app;
