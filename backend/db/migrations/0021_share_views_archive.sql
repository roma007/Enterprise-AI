-- 分享访问明细归档
CREATE TABLE IF NOT EXISTS share_views_archive (
  id         uuid PRIMARY KEY,
  share_id   uuid NOT NULL,
  token      text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('view','docx','pdf')),
  ip         text,
  user_agent text,
  referer    text,
  viewed_at  timestamptz NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS share_views_archive_share_idx
  ON share_views_archive (share_id, viewed_at DESC);
CREATE INDEX IF NOT EXISTS share_views_archive_time_idx
  ON share_views_archive (viewed_at DESC);
CREATE INDEX IF NOT EXISTS share_views_archive_archived_idx
  ON share_views_archive (archived_at DESC);
