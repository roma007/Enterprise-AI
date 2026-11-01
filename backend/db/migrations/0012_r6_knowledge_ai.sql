-- R6 · 知识库与 AI 草稿
-- 知识条目按组织隔离；AI 产出一律是草稿，必须人工确认。

CREATE TABLE IF NOT EXISTS knowledge_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  industry      text NOT NULL DEFAULT 'general',
  category      text NOT NULL DEFAULT 'pattern'
                CHECK (category IN ('opportunity','pattern','template','lesson','case')),
  title         text NOT NULL,
  summary       text NOT NULL,
  content       text NOT NULL,
  tags          text[] NOT NULL DEFAULT '{}',
  source        text,
  engagement_id uuid REFERENCES engagements(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'published'
                CHECK (status IN ('draft','published','archived')),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_drafts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  kind          text NOT NULL
                CHECK (kind IN ('interview_summary','report_draft','solution_skeleton','prd_skeleton','answer')),
  source_type   text,
  source_id     uuid,
  title         text NOT NULL,
  prompt        text,
  content       text NOT NULL,
  model         text NOT NULL DEFAULT 'rule-based-v1',
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','confirmed','rejected')),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_items_org_idx
  ON knowledge_items (org_id, industry, category, status);
CREATE INDEX IF NOT EXISTS knowledge_items_tags_idx
  ON knowledge_items USING gin (tags);
CREATE INDEX IF NOT EXISTS ai_drafts_eng_idx
  ON ai_drafts (engagement_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_drafts_status_idx
  ON ai_drafts (engagement_id, status);
