-- 平台运营方管理员：可查看/暂停/恢复租户
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin boolean NOT NULL DEFAULT false;
UPDATE users SET is_platform_admin = true WHERE lower(email) = 'admin@hengzhi.ai';
