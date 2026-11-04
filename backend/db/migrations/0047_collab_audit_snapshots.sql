-- 协作审计每日快照（按组织）
CREATE TABLE IF NOT EXISTS collab_audit_snapshots (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  snapshot_date        date NOT NULL,
  total                int NOT NULL DEFAULT 0,
  notification_count   int NOT NULL DEFAULT 0,
  filter_view_count    int NOT NULL DEFAULT 0,
  export_count         int NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS collab_audit_snapshots_org_date_idx
  ON collab_audit_snapshots (org_id, snapshot_date DESC);

ALTER TABLE collab_audit_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS collab_audit_snapshots_org ON collab_audit_snapshots;
CREATE POLICY collab_audit_snapshots_org ON collab_audit_snapshots
  FOR ALL
  USING (app_platform_admin() OR org_id = app_org_id())
  WITH CHECK (app_platform_admin() OR org_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON collab_audit_snapshots TO ai_delivery_app;
