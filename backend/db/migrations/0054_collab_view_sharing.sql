-- 协作审计筛选视图：共享给同组织同事
ALTER TABLE collab_audit_filter_views
  ADD COLUMN IF NOT EXISTS shared boolean NOT NULL DEFAULT false;
ALTER TABLE collab_audit_filter_views
  ADD COLUMN IF NOT EXISTS shared_role text;

CREATE TABLE IF NOT EXISTS collab_audit_filter_view_shares (
  view_id    uuid NOT NULL REFERENCES collab_audit_filter_views(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (view_id, user_id)
);

CREATE INDEX IF NOT EXISTS collab_audit_filter_view_shares_user_idx
  ON collab_audit_filter_view_shares (user_id);

ALTER TABLE collab_audit_filter_view_shares ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS collab_audit_filter_view_shares_org ON collab_audit_filter_view_shares;
CREATE POLICY collab_audit_filter_view_shares_org ON collab_audit_filter_view_shares
  FOR ALL
  USING (
    app_platform_admin()
    OR EXISTS (
      SELECT 1 FROM collab_audit_filter_views v
       WHERE v.id = view_id AND v.org_id = app_org_id()
    )
  )
  WITH CHECK (
    app_platform_admin()
    OR EXISTS (
      SELECT 1 FROM collab_audit_filter_views v
       WHERE v.id = view_id AND v.org_id = app_org_id()
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON collab_audit_filter_view_shares TO ai_delivery_app;
