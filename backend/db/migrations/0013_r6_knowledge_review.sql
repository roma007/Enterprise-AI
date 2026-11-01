-- R6 · 知识审批与过期管理
ALTER TABLE knowledge_items
  ADD COLUMN IF NOT EXISTS expires_at  date,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_note text;

CREATE INDEX IF NOT EXISTS knowledge_items_expiry_idx
  ON knowledge_items (org_id, status, expires_at);
