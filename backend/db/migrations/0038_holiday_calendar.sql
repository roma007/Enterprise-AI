-- 组织级节假日日历：SLA 跳过周末 + 已配置节假日
CREATE TABLE IF NOT EXISTS holiday_calendar (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid REFERENCES organizations(id) ON DELETE CASCADE,
  region     text NOT NULL DEFAULT 'CN',
  date       date NOT NULL,
  name       text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- org_id IS NULL 表示平台级/全国节假日；每个组织可覆盖自己的日历
CREATE UNIQUE INDEX IF NOT EXISTS holiday_org_unique
  ON holiday_calendar (org_id, region, date)
  WHERE org_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS holiday_global_unique
  ON holiday_calendar (region, date)
  WHERE org_id IS NULL;
CREATE INDEX IF NOT EXISTS holiday_date_idx
  ON holiday_calendar (date) WHERE active;

ALTER TABLE holiday_calendar ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS holiday_calendar_read_write ON holiday_calendar;
CREATE POLICY holiday_calendar_read_write ON holiday_calendar
  FOR ALL
  USING (app_platform_admin() OR org_id IS NULL OR org_id = app_org_id())
  WITH CHECK (app_platform_admin() OR org_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON holiday_calendar TO ai_delivery_app;
