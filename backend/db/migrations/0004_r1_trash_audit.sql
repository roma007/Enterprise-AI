-- R1 · 软删除 + 回收站 + 审计日志
-- 只对三类“容器型”资源做软删除：client / engagement / deliverable。
-- 子资源（痛点、盘点、机会点等）仍走物理删除，但所有写操作都会进 audit_logs。

ALTER TABLE clients      ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE clients      ADD COLUMN IF NOT EXISTS delete_batch uuid;
ALTER TABLE engagements  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE engagements  ADD COLUMN IF NOT EXISTS delete_batch uuid;
ALTER TABLE deliverables ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE deliverables ADD COLUMN IF NOT EXISTS delete_batch uuid;

CREATE INDEX IF NOT EXISTS clients_deleted_idx
  ON clients (org_id, deleted_at);
CREATE INDEX IF NOT EXISTS engagements_deleted_idx
  ON engagements (org_id, deleted_at);
CREATE INDEX IF NOT EXISTS deliverables_deleted_idx
  ON deliverables (engagement_id, deleted_at);
CREATE INDEX IF NOT EXISTS clients_batch_idx
  ON clients (delete_batch) WHERE delete_batch IS NOT NULL;
CREATE INDEX IF NOT EXISTS engagements_batch_idx
  ON engagements (delete_batch) WHERE delete_batch IS NOT NULL;
CREATE INDEX IF NOT EXISTS deliverables_batch_idx
  ON deliverables (delete_batch) WHERE delete_batch IS NOT NULL;

CREATE TABLE IF NOT EXISTS audit_logs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid,
  user_id      uuid,
  action       text NOT NULL,
  object_type  text,
  object_id    uuid,
  status_code  int,
  ip           text,
  user_agent   text,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_org_time_idx
  ON audit_logs (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_object_idx
  ON audit_logs (object_type, object_id, created_at DESC);
