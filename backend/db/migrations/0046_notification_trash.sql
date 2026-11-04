-- 站内通知回收站：软删除
ALTER TABLE user_notifications
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS user_notifications_trash_idx
  ON user_notifications (user_id, deleted_at, created_at DESC);
