-- PDF 异步任务
CREATE TABLE IF NOT EXISTS pdf_jobs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deliverable_id uuid NOT NULL REFERENCES deliverables(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','running','done','failed')),
  cache_key      text,
  error          text,
  requested_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  finished_at    timestamptz
);

CREATE INDEX IF NOT EXISTS pdf_jobs_status_idx ON pdf_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS pdf_jobs_deliverable_idx ON pdf_jobs (deliverable_id, created_at DESC);
