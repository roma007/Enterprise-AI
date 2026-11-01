-- 分享访问归档补充组织字段，便于分享链接删除后仍按组织检索
ALTER TABLE share_views_archive ADD COLUMN IF NOT EXISTS org_id uuid;

UPDATE share_views_archive a
   SET org_id = e.org_id
  FROM deliverable_shares sh
  JOIN deliverables d ON d.id = sh.deliverable_id
  JOIN engagements e ON e.id = d.engagement_id
 WHERE a.share_id = sh.id AND a.org_id IS NULL;

CREATE INDEX IF NOT EXISTS share_views_archive_org_time_idx
  ON share_views_archive (org_id, viewed_at DESC);
