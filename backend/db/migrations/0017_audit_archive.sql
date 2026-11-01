-- 工程加固 · 审计日志归档
-- 与 audit_logs 同构；归档不删除历史，只是从热表移出，避免主表无限增长。

CREATE TABLE IF NOT EXISTS audit_logs_archive (
  id           uuid PRIMARY KEY,
  org_id       uuid,
  user_id      uuid,
  action       text NOT NULL,
  object_type  text,
  object_id    uuid,
  status_code  int,
  ip           text,
  user_agent   text,
  request_id   text,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL,
  archived_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_archive_org_time_idx
  ON audit_logs_archive (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_archive_action_idx
  ON audit_logs_archive (action, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_archive_archived_idx
  ON audit_logs_archive (archived_at DESC);
