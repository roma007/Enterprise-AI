-- 订阅周期、自动续费与账单
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS plan_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS plan_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_renew boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS billing_cycle text NOT NULL DEFAULT 'monthly'
    CHECK (billing_cycle IN ('monthly', 'yearly'));

CREATE TABLE IF NOT EXISTS tenant_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_no text NOT NULL UNIQUE,
  plan text NOT NULL,
  cycle text NOT NULL CHECK (cycle IN ('monthly', 'yearly')),
  amount numeric(12,2) NOT NULL,
  currency text NOT NULL DEFAULT 'CNY',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'void', 'overdue')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  paid_at timestamptz,
  provider text NOT NULL DEFAULT 'manual',
  external_id text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_invoices_org_idx
  ON tenant_invoices (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tenant_invoices_status_idx
  ON tenant_invoices (status, due_at);

ALTER TABLE tenant_invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_invoices_org ON tenant_invoices;
CREATE POLICY tenant_invoices_org ON tenant_invoices
  FOR ALL
  USING (app_platform_admin() OR org_id = app_org_id())
  WITH CHECK (app_platform_admin() OR org_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_invoices TO ai_delivery_app;
