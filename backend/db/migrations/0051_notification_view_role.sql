-- 通知筛选视图支持按角色共享
ALTER TABLE notification_filter_views
  ADD COLUMN IF NOT EXISTS shared_role text;
