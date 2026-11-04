-- 批量任务：保存请求差异、取消原因/操作人，支持取消后继续剩余差异
ALTER TABLE copilot_reconcile_batches
  ADD COLUMN IF NOT EXISTS difference_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancel_reason text,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
