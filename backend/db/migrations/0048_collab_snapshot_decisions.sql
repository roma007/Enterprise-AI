-- 协作审计快照增加差异决策计数
ALTER TABLE collab_audit_snapshots
  ADD COLUMN IF NOT EXISTS decision_count int NOT NULL DEFAULT 0;
