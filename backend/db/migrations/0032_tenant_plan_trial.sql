-- 套餐枚举新增 trial（试用）
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_plan_check;
ALTER TABLE organizations
  ADD CONSTRAINT organizations_plan_check
  CHECK (plan IN ('trial', 'free', 'pro', 'enterprise'));
