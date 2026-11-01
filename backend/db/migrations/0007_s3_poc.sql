-- R3 · S3 POC 验证
-- 机会点 → 实验版本 → 样本数据 → 运行 → 人工复核 → 结论/Go-No-Go

CREATE TABLE IF NOT EXISTS poc_experiments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  version        int NOT NULL DEFAULT 1,
  hypothesis     text NOT NULL,
  method         text NOT NULL,
  sample_size    int CHECK (sample_size IS NULL OR sample_size > 0),
  success_metric text NOT NULL,
  threshold      text NOT NULL,
  start_date     date,
  end_date       date,
  owner          uuid REFERENCES users(id) ON DELETE SET NULL,
  status         text NOT NULL DEFAULT 'planned'
                 CHECK (status IN ('planned','running','reviewing','passed','failed','cancelled')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (opportunity_id, version)
);

CREATE TABLE IF NOT EXISTS poc_datasets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES poc_experiments(id) ON DELETE CASCADE,
  name          text NOT NULL,
  source        text,
  sample_count  int CHECK (sample_count IS NULL OR sample_count > 0),
  fields        text,
  access_status text NOT NULL DEFAULT 'pending'
                CHECK (access_status IN ('pending','approved','rejected','not_required')),
  version       text,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS poc_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES poc_experiments(id) ON DELETE CASCADE,
  run_no        int NOT NULL,
  dataset_id    uuid REFERENCES poc_datasets(id) ON DELETE SET NULL,
  config        text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  metrics       jsonb NOT NULL DEFAULT '{}'::jsonb,
  issues        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, run_no)
);

CREATE TABLE IF NOT EXISTS poc_reviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES poc_runs(id) ON DELETE CASCADE,
  reviewer      uuid REFERENCES users(id) ON DELETE SET NULL,
  sample_count  int CHECK (sample_count IS NULL OR sample_count > 0),
  accuracy      numeric CHECK (accuracy IS NULL OR (accuracy >= 0 AND accuracy <= 1)),
  false_positive numeric CHECK (false_positive IS NULL OR false_positive >= 0),
  notes         text,
  reviewed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS poc_conclusions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL UNIQUE REFERENCES poc_experiments(id) ON DELETE CASCADE,
  decision      text NOT NULL
                CHECK (decision IN ('go','no_go','conditional','pending')),
  evidence      text NOT NULL,
  conditions    text,
  decided_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at    timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS poc_experiments_opp_idx ON poc_experiments (opportunity_id, version DESC);
CREATE INDEX IF NOT EXISTS poc_datasets_exp_idx ON poc_datasets (experiment_id);
CREATE INDEX IF NOT EXISTS poc_runs_exp_idx ON poc_runs (experiment_id, run_no DESC);
CREATE INDEX IF NOT EXISTS poc_reviews_run_idx ON poc_reviews (run_id, reviewed_at DESC);
