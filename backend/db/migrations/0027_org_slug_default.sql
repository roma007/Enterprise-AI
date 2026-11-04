-- 兼容测试/脚本直接插入组织：未提供 slug 时自动生成
ALTER TABLE organizations
  ALTER COLUMN slug SET DEFAULT ('org-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
