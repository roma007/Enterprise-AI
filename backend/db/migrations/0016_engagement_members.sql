-- 工程加固 · 项目级成员与权限
CREATE TABLE IF NOT EXISTS engagement_members (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          text NOT NULL DEFAULT 'member'
                CHECK (role IN ('manager','member','viewer')),
  added_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (engagement_id, user_id)
);

CREATE INDEX IF NOT EXISTS engagement_members_user_idx
  ON engagement_members (user_id, engagement_id);
CREATE INDEX IF NOT EXISTS engagement_members_eng_idx
  ON engagement_members (engagement_id, role);
