-- 工程加固 · 常用列表查询索引
CREATE INDEX IF NOT EXISTS clients_org_created_idx
  ON clients (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS engagements_org_created_idx
  ON engagements (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pain_points_eng_code_idx
  ON pain_points (engagement_id, code);
CREATE INDEX IF NOT EXISTS opportunities_eng_score_idx
  ON opportunities (engagement_id, score DESC);
CREATE INDEX IF NOT EXISTS deliverables_eng_created_idx
  ON deliverables (engagement_id, created_at DESC);
CREATE INDEX IF NOT EXISTS interviews_eng_date_idx
  ON interviews (engagement_id, date DESC);
CREATE INDEX IF NOT EXISTS knowledge_org_status_updated_idx
  ON knowledge_items (org_id, status, updated_at DESC);
