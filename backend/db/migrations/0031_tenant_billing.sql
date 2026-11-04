-- 租户试用、套餐配额与账单联系人
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS billing_email text;

-- 已有租户保持可用：不自动设置试用到期
UPDATE organizations SET trial_ends_at = NULL WHERE trial_ends_at IS NULL;

-- 平台级套餐目录（可由平台管理员调整，租户只读）
CREATE TABLE IF NOT EXISTS tenant_plans (
  code text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  price_monthly numeric(12,2) NOT NULL DEFAULT 0,
  price_yearly numeric(12,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'CNY',
  max_users integer NOT NULL,
  max_clients integer NOT NULL,
  max_engagements integer NOT NULL,
  max_pdf_jobs_month integer NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO tenant_plans
  (code, name, description, price_monthly, price_yearly, max_users, max_clients, max_engagements, max_pdf_jobs_month, sort_order)
VALUES
  ('trial', '试用版', '14 天试用，适合评估', 0, 0, 3, 2, 2, 20, 10),
  ('free', '免费版', '长期免费的小团队版本', 0, 0, 3, 3, 3, 30, 20),
  ('pro', '专业版', '成长型 AI 解决方案供应商', 2999, 29990, 20, 50, 50, 500, 30),
  ('enterprise', '企业版', '多团队、大客户与专属支持', 0, 0, 100, 500, 500, 5000, 40)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE tenant_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_plans_read ON tenant_plans;
CREATE POLICY tenant_plans_read ON tenant_plans
  FOR SELECT USING (true);

DROP POLICY IF EXISTS tenant_plans_admin_write ON tenant_plans;
CREATE POLICY tenant_plans_admin_write ON tenant_plans
  FOR ALL
  USING (app_platform_admin())
  WITH CHECK (app_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_plans TO ai_delivery_app;
