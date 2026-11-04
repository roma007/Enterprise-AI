-- 对账复核批量生成记录：持久化批次、逐条结果与失败重试
CREATE TABLE IF NOT EXISTS copilot_reconcile_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id       uuid NOT NULL REFERENCES copilot_reconcile_reviews(id) ON DELETE CASCADE,
  parent_batch_id uuid REFERENCES copilot_reconcile_batches(id) ON DELETE SET NULL,
  action_type     text NOT NULL CHECK (action_type IN ('risk', 'issue')),
  status          text NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'completed', 'failed')),
  requested_count int NOT NULL DEFAULT 0,
  created_count   int NOT NULL DEFAULT 0,
  skipped_count   int NOT NULL DEFAULT 0,
  failed_count    int NOT NULL DEFAULT 0,
  owner           uuid REFERENCES users(id) ON DELETE SET NULL,
  severity        text NOT NULL DEFAULT 'P2'
                  CHECK (severity IN ('P0', 'P1', 'P2', 'P3')),
  due_date        date,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);

CREATE INDEX IF NOT EXISTS copilot_reconcile_batches_review_idx
  ON copilot_reconcile_batches (review_id, created_at DESC);

CREATE TABLE IF NOT EXISTS copilot_reconcile_batch_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id      uuid NOT NULL REFERENCES copilot_reconcile_batches(id) ON DELETE CASCADE,
  difference_id text NOT NULL,
  status        text NOT NULL CHECK (status IN ('created', 'duplicate', 'failed')),
  target_id     uuid,
  action_id     uuid,
  item_code     text,
  error_code    text,
  error_message text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, difference_id)
);

CREATE INDEX IF NOT EXISTS copilot_reconcile_batch_items_batch_idx
  ON copilot_reconcile_batch_items (batch_id, created_at);

ALTER TABLE copilot_reconcile_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS copilot_reconcile_batches_org ON copilot_reconcile_batches;
CREATE POLICY copilot_reconcile_batches_org ON copilot_reconcile_batches
  FOR ALL
  USING (
    app_platform_admin()
    OR EXISTS (
      SELECT 1 FROM copilot_reconcile_reviews r
       WHERE r.id = review_id AND r.org_id = app_org_id()
    )
  )
  WITH CHECK (
    app_platform_admin()
    OR EXISTS (
      SELECT 1 FROM copilot_reconcile_reviews r
       WHERE r.id = review_id AND r.org_id = app_org_id()
    )
  );

ALTER TABLE copilot_reconcile_batch_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS copilot_reconcile_batch_items_org ON copilot_reconcile_batch_items;
CREATE POLICY copilot_reconcile_batch_items_org ON copilot_reconcile_batch_items
  FOR ALL
  USING (
    app_platform_admin()
    OR EXISTS (
      SELECT 1
        FROM copilot_reconcile_batches b
        JOIN copilot_reconcile_reviews r ON r.id = b.review_id
       WHERE b.id = batch_id AND r.org_id = app_org_id()
    )
  )
  WITH CHECK (
    app_platform_admin()
    OR EXISTS (
      SELECT 1
        FROM copilot_reconcile_batches b
        JOIN copilot_reconcile_reviews r ON r.id = b.review_id
       WHERE b.id = batch_id AND r.org_id = app_org_id()
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON copilot_reconcile_batches TO ai_delivery_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON copilot_reconcile_batch_items TO ai_delivery_app;
