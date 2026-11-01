-- 工程加固 · 审计日志关联请求 ID
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS request_id text;
CREATE INDEX IF NOT EXISTS audit_logs_request_idx ON audit_logs (request_id);
