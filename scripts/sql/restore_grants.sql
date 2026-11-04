SET client_min_messages = warning;

-- 恢复后修复 RLS 应用角色权限。
-- pg_dump --no-acl 不会包含 GRANT，恢复到新集群/新库后需重新授权，
-- 否则 SET ROLE ai_delivery_app 后会出现 permission denied。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_delivery_app') THEN
    CREATE ROLE ai_delivery_app NOLOGIN;
  END IF;
END $$;

DO $$
BEGIN
  EXECUTE format('GRANT ai_delivery_app TO %I', current_user);
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

GRANT USAGE ON SCHEMA public TO ai_delivery_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ai_delivery_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ai_delivery_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ai_delivery_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ai_delivery_app;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE schema_migrations FROM ai_delivery_app';
  END IF;
END $$;
