-- 通知筛选视图：指定用户共享
CREATE TABLE IF NOT EXISTS notification_filter_view_shares (
  view_id    uuid NOT NULL REFERENCES notification_filter_views(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (view_id, user_id)
);

CREATE INDEX IF NOT EXISTS notification_filter_view_shares_user_idx
  ON notification_filter_view_shares (user_id);

ALTER TABLE notification_filter_view_shares ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_filter_view_shares_org ON notification_filter_view_shares;
CREATE POLICY notification_filter_view_shares_org ON notification_filter_view_shares
  FOR ALL
  USING (
    app_platform_admin()
    OR EXISTS (
      SELECT 1 FROM notification_filter_views v
       WHERE v.id = view_id AND v.org_id = app_org_id()
    )
  )
  WITH CHECK (
    app_platform_admin()
    OR EXISTS (
      SELECT 1 FROM notification_filter_views v
       WHERE v.id = view_id AND v.org_id = app_org_id()
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON notification_filter_view_shares TO ai_delivery_app;
