-- 命名筛选视图：按角色 / 指定用户定向共享
ALTER TABLE copilot_batch_filter_views
  ADD COLUMN IF NOT EXISTS shared_role text
  CHECK (shared_role IN ('admin', 'director', 'pm', 'consultant', 'tech_lead'));

CREATE TABLE IF NOT EXISTS copilot_batch_filter_view_shares (
  view_id    uuid NOT NULL REFERENCES copilot_batch_filter_views(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (view_id, user_id)
);

CREATE INDEX IF NOT EXISTS copilot_batch_filter_view_shares_user_idx
  ON copilot_batch_filter_view_shares (user_id);

ALTER TABLE copilot_batch_filter_view_shares ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS copilot_batch_filter_view_shares_org ON copilot_batch_filter_view_shares;
CREATE POLICY copilot_batch_filter_view_shares_org ON copilot_batch_filter_view_shares
  FOR ALL
  USING (
    app_platform_admin()
    OR EXISTS (
      SELECT 1 FROM copilot_batch_filter_views v
       WHERE v.id = view_id AND v.org_id = app_org_id()
    )
  )
  WITH CHECK (
    app_platform_admin()
    OR EXISTS (
      SELECT 1 FROM copilot_batch_filter_views v
       WHERE v.id = view_id AND v.org_id = app_org_id()
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON copilot_batch_filter_view_shares TO ai_delivery_app;
