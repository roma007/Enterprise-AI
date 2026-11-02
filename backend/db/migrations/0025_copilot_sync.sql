-- B4 · ai-copilot 评测结果回写
-- 目标：客户侧跑完评测，自动在交付平台的 POC 里生成一条运行记录。
-- 为什么单独建一张同步表：
--   1) 幂等键要能查重（同一份结果重复推送不能生成两条 run）
--   2) 保留原始 payload，指标口径有争议时能回看当时到底推了什么
--   3) 平台自己的 poc_runs 仍由顾问维护，不被外部写入污染语义

CREATE TABLE IF NOT EXISTS copilot_eval_syncs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  org_id          uuid REFERENCES organizations(id) ON DELETE SET NULL,
  experiment_id   uuid REFERENCES poc_experiments(id) ON DELETE SET NULL,
  poc_run_id      uuid REFERENCES poc_runs(id) ON DELETE SET NULL,
  source          text NOT NULL DEFAULT 'ai-copilot',
  dataset_name    text,
  metrics         jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS copilot_sync_exp_idx
  ON copilot_eval_syncs (experiment_id, received_at DESC);
CREATE INDEX IF NOT EXISTS copilot_sync_org_idx
  ON copilot_eval_syncs (org_id, received_at DESC);
