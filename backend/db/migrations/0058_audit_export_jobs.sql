-- 审计日志异步导出任务
CREATE TABLE IF NOT EXISTS audit_export_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'pending',
  scope       text NOT NULL DEFAULT 'live',
  filters     jsonb NOT NULL DEFAULT '{}'::jsonb,
  columns     jsonb NOT NULL DEFAULT '[]'::jsonb,
  row_count   integer,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS audit_export_jobs_user_idx
  ON audit_export_jobs (user_id, created_at DESC);

ALTER TABLE audit_export_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_export_jobs_org ON audit_export_jobs;
CREATE POLICY audit_export_jobs_org ON audit_export_jobs
  FOR ALL
  USING (app_platform_admin() OR org_id = app_org_id())
  WITH CHECK (app_platform_admin() OR org_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON audit_export_jobs TO ai_delivery_app;
