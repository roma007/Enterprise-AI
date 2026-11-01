-- =====================================================================
-- 002_functions.sql
-- 把"规则"钉在数据库里：函数 + 触发器
-- 对应 05_数据模型v2.md §1.3 / §4.3 / §7.3，03_数据模型与页面原型.md §3.2
-- =====================================================================


-- ---------------------------------------------------------------------
-- R4：进入 killed 必须写原因（用 CHECK 比触发器更难绕过）
-- ---------------------------------------------------------------------
ALTER TABLE opportunities
  DROP CONSTRAINT IF EXISTS kill_requires_reason;
ALTER TABLE opportunities
  ADD CONSTRAINT kill_requires_reason CHECK (
    stage <> 'killed'
    OR (kill_reason IS NOT NULL AND length(btrim(kill_reason)) > 0)
  );

-- ---------------------------------------------------------------------
-- 分位定位（§1.3）
--   边界规则：触发「落后」的那条边界归落后，其余边界归优
--   lower_better：<= p25 优秀 | < p50 良好 | < p75 中位 | >= p75 落后
--   higher_better：>= p75 优秀 | > p50 良好 | > p25 中位 | <= p25 落后
--
-- 与文档的差异：文档用 year = 当前年；这里取"该指标最新一年"，
-- 这样跨年时不会因为忘了更新种子数据而全部返回 unknown。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION benchmark_position(
  p_industry   text,
  p_metric_key text,
  p_value      numeric
) RETURNS text AS $$
DECLARE
  b benchmarks;
BEGIN
  SELECT * INTO b
    FROM benchmarks
   WHERE industry = p_industry
     AND metric_key = p_metric_key
   ORDER BY year DESC, (sub_industry = '') DESC
   LIMIT 1;

  IF NOT FOUND OR p_value IS NULL THEN
    RETURN 'unknown';
  END IF;

  IF b.direction = 'lower_better' THEN
    RETURN CASE
      WHEN p_value <= b.p25 THEN 'excellent'
      WHEN p_value <= b.p50 THEN 'good'        -- p50 边界归优（P2 决策）
      WHEN p_value <  b.p75 THEN 'median'
      ELSE 'lagging' END;          -- 含 p_value = p75（边界归落后）
  ELSE
    RETURN CASE
      WHEN p_value >= b.p75 THEN 'excellent'
      WHEN p_value >= b.p50 THEN 'good'        -- p50 边界归优（P2 决策）
      WHEN p_value >  b.p25 THEN 'median'
      ELSE 'lagging' END;          -- 含 p_value = p25（边界归落后）
  END IF;
END $$ LANGUAGE plpgsql STABLE;

-- 方便报告直接取到阈值
CREATE OR REPLACE FUNCTION benchmark_row(
  p_industry   text,
  p_metric_key text
) RETURNS benchmarks AS $$
  SELECT * FROM benchmarks
   WHERE industry = p_industry AND metric_key = p_metric_key
   ORDER BY year DESC, (sub_industry = '') DESC
   LIMIT 1;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------
-- C11 缺口比例分级（P3 决策）
--   ratio >= 1.0        → pass
--   0.5 <= ratio < 1.0  → warn
--   ratio < 0.5         → block
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ratio_level(actual numeric, required numeric)
RETURNS text AS $$
DECLARE
  r numeric;
BEGIN
  IF required IS NULL OR required = 0 THEN
    RETURN 'pass';
  END IF;
  r := actual / required;
  RETURN CASE
    WHEN r >= 1.0 THEN 'pass'
    WHEN r >= 0.5 THEN 'warn'
    ELSE 'block'
  END;
END $$ LANGUAGE plpgsql IMMUTABLE;

-- ---------------------------------------------------------------------
-- C12：传导链连乘（§4.3）
--   realized_factor = ∏ mult_base（派生变量不参与）
--   - 没有链条        → NULL（C10 会拦）
--   - 任一段系数为 0  → 0（ln(0) 会报错，先判掉）
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION chain_product(p_opportunity_id uuid)
RETURNS numeric AS $$
  SELECT CASE
    WHEN count(*) = 0 THEN NULL
    WHEN count(*) FILTER (WHERE mult_base = 0) > 0 THEN 0::numeric
    ELSE round(exp(sum(ln(mult_base))), 4)
  END
  FROM roi_sensitivity
  WHERE opportunity_id = p_opportunity_id
    AND NOT is_derived;
$$ LANGUAGE sql STABLE;

-- 链条段号必须从 1 连续（中间断号 = 漏了一段）
CREATE OR REPLACE FUNCTION chain_stage_gaps(p_opportunity_id uuid)
RETURNS TABLE(expected int, actual int) AS $$
  WITH s AS (
    SELECT stage, row_number() OVER (ORDER BY stage) AS rn
      FROM roi_sensitivity
     WHERE opportunity_id = p_opportunity_id
       AND NOT is_derived
  )
  SELECT rn::int AS expected, stage AS actual
    FROM s
   WHERE stage <> rn;
$$ LANGUAGE sql STABLE;

-- 把链条乘积写回 roi_models（应用层保存链条后调用）
CREATE OR REPLACE FUNCTION sync_realization_factor(p_opportunity_id uuid)
RETURNS numeric AS $$
DECLARE
  f numeric;
BEGIN
  f := chain_product(p_opportunity_id);
  IF f IS NOT NULL THEN
    UPDATE roi_models SET realization_factor = f
     WHERE opportunity_id = p_opportunity_id;
  END IF;
  RETURN f;
END $$ LANGUAGE plpgsql;

-- C12 的 SQL 版：列出所有对不上的机会点
CREATE OR REPLACE FUNCTION fn_chain_factor_mismatches(p_engagement_id uuid)
RETURNS TABLE (
  opportunity_code text,
  chain_product    numeric,
  realization_factor numeric,
  diff             numeric
) AS $$
  SELECT o.code,
         chain_product(o.id) AS chain_product,
         r.realization_factor,
         round(abs(chain_product(o.id) - r.realization_factor), 4) AS diff
    FROM opportunities o
    JOIN roi_models r ON r.opportunity_id = o.id
   WHERE o.engagement_id = p_engagement_id
     AND r.realization_factor IS NOT NULL
     AND chain_product(o.id) IS NOT NULL
     AND abs(chain_product(o.id) - r.realization_factor) > 0.005;
$$ LANGUAGE sql STABLE;

-- C8：requires 依赖环
CREATE OR REPLACE FUNCTION fn_requires_cycles(p_engagement_id uuid)
RETURNS TABLE (path text) AS $$
  WITH RECURSIVE edges AS (
    SELECT d.from_id, d.to_id, o.code AS from_code, o2.code AS to_code
      FROM opportunity_dependencies d
      JOIN opportunities o  ON o.id  = d.from_id
      JOIN opportunities o2 ON o2.id = d.to_id
     WHERE d.type = 'requires'
       AND o.engagement_id = p_engagement_id
  ),
  walk AS (
    SELECT from_id AS start_id, to_id AS cur_id,
           ARRAY[from_id, to_id] AS ids,
           from_code || ' → ' || to_code AS path,
           1 AS depth
      FROM edges
    UNION ALL
    SELECT w.start_id, e.to_id,
           w.ids || e.to_id,
           w.path || ' → ' || e.to_code,
           w.depth + 1
      FROM walk w
      JOIN edges e ON e.from_id = w.cur_id
     WHERE NOT (e.to_id = ANY(w.ids))
       AND w.depth < 20
  )
  SELECT DISTINCT path FROM walk WHERE cur_id = start_id;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------
-- R2：无基线 → ROI 置信度锁死 low（自动降级，不报错）
--      v2 扩展：引用低置信度企业财务数据的 ROI，不得高于 low
--      （后一条依赖引用关系，MVP 在应用层 C6 里体现）
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_roi_baseline() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM baselines WHERE opportunity_id = NEW.opportunity_id) THEN
    NEW.confidence := 'low';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_roi_baseline_lock ON roi_models;
CREATE TRIGGER trg_roi_baseline_lock
  BEFORE INSERT OR UPDATE ON roi_models
  FOR EACH ROW EXECUTE FUNCTION enforce_roi_baseline();

-- ---------------------------------------------------------------------
-- R1：无来源的痛点不能关联机会点
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_pain_point_source() RETURNS trigger AS $$
DECLARE
  p pain_points;
  o opportunities;
BEGIN
  SELECT * INTO p FROM pain_points WHERE id = NEW.pain_point_id;
  SELECT * INTO o FROM opportunities WHERE id = NEW.opportunity_id;

  IF p.source_ref IS NULL OR length(btrim(p.source_ref)) = 0 THEN
    RAISE EXCEPTION 'R1: 痛点 % 没有来源，不能关联机会点', p.code;
  END IF;
  IF p.status = 'merged' THEN
    RAISE EXCEPTION 'R1: 痛点 % 已被归并，不能再单独关联', p.code;
  END IF;
  IF p.engagement_id <> o.engagement_id THEN
    RAISE EXCEPTION 'R1: 痛点 % 与机会点 % 不属于同一个项目', p.code, o.code;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_opp_pain_source ON opportunity_pain_points;
CREATE TRIGGER trg_opp_pain_source
  BEFORE INSERT OR UPDATE ON opportunity_pain_points
  FOR EACH ROW EXECUTE FUNCTION enforce_pain_point_source();

-- ---------------------------------------------------------------------
-- R3：有技术阻断项禁止进入 designed（除非指定承担人）
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_opportunity_rules() RETURNS trigger AS $$
BEGIN
  IF NEW.stage = 'designed'
     AND (OLD.stage IS DISTINCT FROM 'designed')
     AND NEW.has_tech_blocker
     AND NEW.blocker_owner IS NULL THEN
    RAISE EXCEPTION 'R3: 机会点 % 存在技术阻断项，未指定承担人，不能进入 designed', NEW.code;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_opportunity_rules ON opportunities;
CREATE TRIGGER trg_opportunity_rules
  BEFORE UPDATE ON opportunities
  FOR EACH ROW EXECUTE FUNCTION enforce_opportunity_rules();

-- ---------------------------------------------------------------------
-- 报告口径的回本（含运维），供视图/查询复用
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_roi_summary AS
SELECT o.engagement_id,
       o.code,
       o.title,
       o.target_phase,
       o.stage,
       r.benefit_type,
       r.realization_mode,
       r.realization_factor,
       r.neutral_value,
       r.realized_value,
       r.one_time_cost,
       r.annual_cost,
       r.payback_months,
       r.payback_months_with_ops,
       r.confidence,
       r.assumptions_note
  FROM opportunities o
  JOIN roi_models r ON r.opportunity_id = o.id;
