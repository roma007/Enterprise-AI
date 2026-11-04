-- 审计日志筛选视图：按用户保存（私有）
CREATE TABLE IF NOT EXISTS audit_filter_views (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  mode        text NOT NULL DEFAULT 'live',
  q           text,
  action      text,
  object_type text,
  status      text,
  from_date   date,
  to_date     date,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS audit_filter_views_user_idx
  ON audit_filter_views (user_id, name);

ALTER TABLE audit_filter_views ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_filter_views_org ON audit_filter_views;
CREATE POLICY audit_filter_views_org ON audit_filter_views
  FOR ALL
  USING (app_platform_admin() OR org_id = app_org_id())
  WITH CHECK (app_platform_admin() OR org_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON audit_filter_views TO ai_delivery_app;
