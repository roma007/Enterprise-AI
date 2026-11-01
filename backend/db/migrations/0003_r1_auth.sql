-- R1 · 最小登录骨架
-- 只加字段与索引；真正的 org_id 强制过滤在 W2 做。
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

CREATE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));
