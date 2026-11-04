-- 通知筛选视图支持共享给同组织同事
ALTER TABLE notification_filter_views
  ADD COLUMN IF NOT EXISTS shared boolean NOT NULL DEFAULT false;
