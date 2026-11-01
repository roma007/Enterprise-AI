-- 客户分享访问明细
CREATE TABLE IF NOT EXISTS share_views (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id   uuid NOT NULL REFERENCES deliverable_shares(id) ON DELETE CASCADE,
  token      text NOT NULL,
  kind       text NOT NULL DEFAULT 'view'
             CHECK (kind IN ('view','docx','pdf')),
  ip         text,
  user_agent text,
  referer    text,
  viewed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS share_views_share_time_idx
  ON share_views (share_id, viewed_at DESC);
CREATE INDEX IF NOT EXISTS share_views_time_idx
  ON share_views (viewed_at DESC);
