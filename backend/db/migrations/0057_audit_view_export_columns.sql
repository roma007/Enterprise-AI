-- 审计筛选视图：保存导出列模板
ALTER TABLE audit_filter_views
  ADD COLUMN IF NOT EXISTS export_columns jsonb NOT NULL DEFAULT '[]'::jsonb;
