-- 试点一：ai-copilot 对账单/结算单复核结果回写
CREATE TABLE IF NOT EXISTS copilot_reconcile_reviews (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key  text NOT NULL UNIQUE,
  org_id           uuid REFERENCES organizations(id) ON DELETE SET NULL,
  engagement_id    uuid REFERENCES engagements(id) ON DELETE SET NULL,
  experiment_id    uuid REFERENCES poc_experiments(id) ON DELETE SET NULL,
  kind             text NOT NULL CHECK (kind IN ('statement', 'settlement')),
  document_id      text,
  status           text NOT NULL DEFAULT 'confirmed'
                     CHECK (status IN ('confirmed', 'revised')),
  summary          jsonb NOT NULL DEFAULT '{}'::jsonb,
  document         jsonb NOT NULL DEFAULT '{}'::jsonb,
  differences      jsonb NOT NULL DEFAULT '[]'::jsonb,
  decisions        jsonb NOT NULL DEFAULT '[]'::jsonb,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  source           text NOT NULL DEFAULT 'ai-copilot-pilot',
  received_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS copilot_reconcile_eng_idx
  ON copilot_reconcile_reviews (engagement_id, received_at DESC);
CREATE INDEX IF NOT EXISTS copilot_reconcile_org_idx
  ON copilot_reconcile_reviews (org_id, received_at DESC);

ALTER TABLE copilot_reconcile_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS copilot_reconcile_org ON copilot_reconcile_reviews;
CREATE POLICY copilot_reconcile_org ON copilot_reconcile_reviews
  FOR ALL
  USING (app_platform_admin() OR org_id = app_org_id())
  WITH CHECK (app_platform_admin() OR org_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON copilot_reconcile_reviews TO ai_delivery_app;
