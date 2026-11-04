-- 多租户底座：供应商组织（tenant）
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS slug text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suspended')),
  ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE organizations
   SET slug = CASE
     WHEN id = 'a0000000-0000-4000-8000-000000000001' THEN 'hengzhi'
     ELSE 'org-' || substr(replace(id::text, '-', ''), 1, 8)
   END
 WHERE slug IS NULL;

ALTER TABLE organizations ALTER COLUMN slug SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_unique
  ON organizations (lower(slug));
