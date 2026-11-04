-- 通知筛选视图：按用户保存的筛选条件（私有）
CREATE TABLE IF NOT EXISTS notification_filter_views (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  kind        text,
  unread      boolean NOT NULL DEFAULT false,
  from_date   date,
  to_date     date,
  scope       text NOT NULL DEFAULT 'inbox',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS notification_filter_views_user_idx
  ON notification_filter_views (user_id, name);

ALTER TABLE notification_filter_views ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_filter_views_org ON notification_filter_views;
CREATE POLICY notification_filter_views_org ON notification_filter_views
  FOR ALL
  USING (app_platform_admin() OR org_id = app_org_id())
  WITH CHECK (app_platform_admin() OR org_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON notification_filter_views TO ai_delivery_app;
