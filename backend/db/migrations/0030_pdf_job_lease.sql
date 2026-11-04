-- PDF 任务多实例租约
ALTER TABLE pdf_jobs
  ADD COLUMN IF NOT EXISTS locked_by text,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS pdf_jobs_queue_idx
  ON pdf_jobs (status, created_at);
