-- 站内通知（当前用于筛选视图共享）
CREATE TABLE IF NOT EXISTS user_notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  kind       text NOT NULL,
  title      text NOT NULL,
  body       text,
  link       text,
  ref_type   text,
  ref_id     uuid,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_notifications_user_idx
  ON user_notifications (user_id, read_at, created_at DESC);

ALTER TABLE user_notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_notifications_org ON user_notifications;
CREATE POLICY user_notifications_org ON user_notifications
  FOR ALL
  USING (app_platform_admin() OR org_id = app_org_id())
  WITH CHECK (app_platform_admin() OR org_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON user_notifications TO ai_delivery_app;
