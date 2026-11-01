-- 客户只读分享：token、有效期、撤销、访问计数
ALTER TABLE deliverable_shares
  ADD COLUMN IF NOT EXISTS token          text UNIQUE,
  ADD COLUMN IF NOT EXISTS expires_at     timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_at     timestamptz,
  ADD COLUMN IF NOT EXISTS view_count     int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_viewed_at timestamptz;

CREATE INDEX IF NOT EXISTS deliverable_shares_token_idx
  ON deliverable_shares (token) WHERE token IS NOT NULL;
CREATE INDEX IF NOT EXISTS deliverable_shares_expiry_idx
  ON deliverable_shares (expires_at) WHERE expires_at IS NOT NULL;
