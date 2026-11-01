-- 密码历史：新密码不能与最近 5 次相同
CREATE TABLE IF NOT EXISTS password_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_history_user_idx
  ON password_history (user_id, created_at DESC);
