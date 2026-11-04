-- 批量任务支持取消状态
ALTER TABLE copilot_reconcile_batches
  DROP CONSTRAINT IF EXISTS copilot_reconcile_batches_status_check;

ALTER TABLE copilot_reconcile_batches
  ADD CONSTRAINT copilot_reconcile_batches_status_check
  CHECK (status IN ('running', 'completed', 'failed', 'cancelled'));
