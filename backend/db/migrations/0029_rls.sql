-- 多租户 RLS：应用角色 + 请求级 org 上下文
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_delivery_app') THEN
    CREATE ROLE ai_delivery_app NOLOGIN;
  END IF;
END $$;

DO $$
BEGIN
  EXECUTE format('GRANT ai_delivery_app TO %I', current_user);
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

GRANT USAGE ON SCHEMA public TO ai_delivery_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ai_delivery_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ai_delivery_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ai_delivery_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ai_delivery_app;
REVOKE ALL ON TABLE schema_migrations FROM ai_delivery_app;

CREATE OR REPLACE FUNCTION app_org_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.org_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_platform_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.platform_admin', true), 'off') = 'on'
$$;

DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      ('organizations', 'app_platform_admin() OR id = app_org_id()'),
      ('users', 'app_platform_admin() OR org_id = app_org_id()'),
      ('memberships', 'app_platform_admin() OR org_id = app_org_id()'),
      ('clients', 'app_platform_admin() OR org_id = app_org_id()'),
      ('engagements', 'app_platform_admin() OR org_id = app_org_id()'),
      ('knowledge_items', 'app_platform_admin() OR org_id = app_org_id()'),
      ('audit_logs', 'app_platform_admin() OR org_id = app_org_id()'),
      ('audit_logs_archive', 'app_platform_admin() OR org_id = app_org_id()'),
      ('share_views_archive', 'app_platform_admin() OR org_id = app_org_id()'),
      ('copilot_eval_syncs', 'app_platform_admin() OR org_id = app_org_id()'),
      ('user_sessions', 'app_platform_admin() OR org_id = app_org_id()'),
      ('client_financials', 'app_platform_admin() OR EXISTS (SELECT 1 FROM clients c WHERE c.id = client_financials.client_id AND c.org_id = app_org_id())'),
      ('stakeholders', 'app_platform_admin() OR EXISTS (SELECT 1 FROM clients c WHERE c.id = stakeholders.client_id AND c.org_id = app_org_id())'),
      ('gates', 'app_platform_admin() OR EXISTS (SELECT 1 FROM engagements e WHERE e.id = gates.engagement_id AND e.org_id = app_org_id())'),
      ('interviews', 'app_platform_admin() OR EXISTS (SELECT 1 FROM engagements e WHERE e.id = interviews.engagement_id AND e.org_id = app_org_id())'),
      ('pain_points', 'app_platform_admin() OR EXISTS (SELECT 1 FROM engagements e WHERE e.id = pain_points.engagement_id AND e.org_id = app_org_id())'),
      ('inventory_items', 'app_platform_admin() OR EXISTS (SELECT 1 FROM engagements e WHERE e.id = inventory_items.engagement_id AND e.org_id = app_org_id())'),
      ('process_models', 'app_platform_admin() OR EXISTS (SELECT 1 FROM engagements e WHERE e.id = process_models.engagement_id AND e.org_id = app_org_id())'),
      ('process_nodes', 'app_platform_admin() OR EXISTS (SELECT 1 FROM process_models m JOIN engagements e ON e.id = m.engagement_id WHERE m.id = process_nodes.model_id AND e.org_id = app_org_id())'),
      ('process_edges', 'app_platform_admin() OR EXISTS (SELECT 1 FROM process_models m JOIN engagements e ON e.id = m.engagement_id WHERE m.id = process_edges.model_id AND e.org_id = app_org_id())'),
      ('opportunities', 'app_platform_admin() OR EXISTS (SELECT 1 FROM engagements e WHERE e.id = opportunities.engagement_id AND e.org_id = app_org_id())'),
      ('opportunity_pain_points', 'app_platform_admin() OR EXISTS (SELECT 1 FROM opportunities o JOIN engagements e ON e.id = o.engagement_id WHERE o.id = opportunity_pain_points.opportunity_id AND e.org_id = app_org_id())'),
      ('hypotheses', 'app_platform_admin() OR EXISTS (SELECT 1 FROM opportunities o JOIN engagements e ON e.id = o.engagement_id WHERE o.id = hypotheses.opportunity_id AND e.org_id = app_org_id())'),
      ('baselines', 'app_platform_admin() OR EXISTS (SELECT 1 FROM opportunities o JOIN engagements e ON e.id = o.engagement_id WHERE o.id = baselines.opportunity_id AND e.org_id = app_org_id())'),
      ('roi_models', 'app_platform_admin() OR EXISTS (SELECT 1 FROM opportunities o JOIN engagements e ON e.id = o.engagement_id WHERE o.id = roi_models.opportunity_id AND e.org_id = app_org_id())'),
      ('roi_sensitivity', 'app_platform_admin() OR EXISTS (SELECT 1 FROM opportunities o JOIN engagements e ON e.id = o.engagement_id WHERE o.id = roi_sensitivity.opportunity_id AND e.org_id = app_org_id())'),
      ('opportunity_dependencies', 'app_platform_admin() OR EXISTS (SELECT 1 FROM opportunities o JOIN engagements e ON e.id = o.engagement_id WHERE o.id = opportunity_dependencies.from_id AND e.org_id = app_org_id())'),
      ('risks', 'app_platform_admin() OR EXISTS (SELECT 1 FROM engagements e WHERE e.id = risks.engagement_id AND e.org_id = app_org_id())'),
      ('limitations', 'app_platform_admin() OR EXISTS (SELECT 1 FROM engagements e WHERE e.id = limitations.engagement_id AND e.org_id = app_org_id())'),
      ('decisions', 'app_platform_admin() OR EXISTS (SELECT 1 FROM engagements e WHERE e.id = decisions.engagement_id AND e.org_id = app_org_id())'),
      ('confirmations', 'app_platform_admin() OR EXISTS (SELECT 1 FROM engagements e WHERE e.id = confirmations.engagement_id AND e.org_id = app_org_id())'),
      ('deliverables', 'app_platform_admin() OR EXISTS (SELECT 1 FROM engagements e WHERE e.id = deliverables.engagement_id AND e.org_id = app_org_id())'),
      ('consistency_checks', 'app_platform_admin() OR EXISTS (SELECT 1 FROM deliverables d JOIN engagements e ON e.id = d.engagement_id WHERE d.id = consistency_checks.deliverable_id AND e.org_id = app_org_id())'),
      ('deliverable_shares', 'app_platform_admin() OR EXISTS (SELECT 1 FROM deliverables d JOIN engagements e ON e.id = d.engagement_id WHERE d.id = deliverable_shares.deliverable_id AND e.org_id = app_org_id())'),
      ('share_views', 'app_platform_admin() OR EXISTS (SELECT 1 FROM deliverable_shares sh JOIN deliverables d ON d.id = sh.deliverable_id JOIN engagements e ON e.id = d.engagement_id WHERE sh.id = share_views.share_id AND e.org_id = app_org_id())'),
      ('pdf_jobs', 'app_platform_admin() OR EXISTS (SELECT 1 FROM deliverables d JOIN engagements e ON e.id = d.engagement_id WHERE d.id = pdf_jobs.deliverable_id AND e.org_id = app_org_id())'),
      ('solutions', 'app_platform_admin() OR EXISTS (SELECT 1 FROM opportunities o JOIN engagements e ON e.id = o.engagement_id WHERE o.id = solutions.opportunity_id AND e.org_id = app_org_id())'),
      ('solution_components', 'app_platform_admin() OR EXISTS (SELECT 1 FROM solutions s JOIN opportunities o ON o.id = s.opportunity_id JOIN engagements e ON e.id = o.engagement_id WHERE s.id = solution_components.solution_id AND e.org_id = app_org_id())'),
      ('integrations', 'app_platform_admin() OR EXISTS (SELECT 1 FROM solutions s JOIN opportunities o ON o.id = s.opportunity_id JOIN engagements e ON e.id = o.engagement_id WHERE s.id = integrations.solution_id AND e.org_id = app_org_id())'),
      ('workload_estimates', 'app_platform_admin() OR EXISTS (SELECT 1 FROM solutions s JOIN opportunities o ON o.id = s.opportunity_id JOIN engagements e ON e.id = o.engagement_id WHERE s.id = workload_estimates.solution_id AND e.org_id = app_org_id())'),
      ('acceptance_criteria', 'app_platform_admin() OR EXISTS (SELECT 1 FROM solutions s JOIN opportunities o ON o.id = s.opportunity_id JOIN engagements e ON e.id = o.engagement_id WHERE s.id = acceptance_criteria.solution_id AND e.org_id = app_org_id())'),
      ('solution_reviews', 'app_platform_admin() OR EXISTS (SELECT 1 FROM solutions s JOIN opportunities o ON o.id = s.opportunity_id JOIN engagements e ON e.id = o.engagement_id WHERE s.id = solution_reviews.solution_id AND e.org_id = app_org_id())'),
      ('quotes', 'app_platform_admin() OR EXISTS (SELECT 1 FROM engagements e WHERE e.id = quotes.engagement_id AND e.org_id = app_org_id())'),
      ('quote_items', 'app_platform_admin() OR EXISTS (SELECT 1 FROM quotes q JOIN engagements e ON e.id = q.engagement_id WHERE q.id = quote_items.quote_id AND e.org_id = app_org_id())'),
      ('poc_experiments', 'app_platform_admin() OR EXISTS (SELECT 1 FROM opportunities o JOIN engagements e ON e.id = o.engagement_id WHERE o.id = poc_experiments.opportunity_id AND e.org_id = app_org_id())'),
      ('poc_datasets', 'app_platform_admin() OR EXISTS (SELECT 1 FROM poc_experiments p JOIN opportunities o ON o.id = p.opportunity_id JOIN engagements e ON e.id = o.engagement_id WHERE p.id = poc_datasets.experiment_id AND e.org_id = app_org_id())'),
      ('poc_runs', 'app_platform_admin() OR EXISTS (SELECT 1 FROM poc_experiments p JOIN opportunities o ON o.id = p.opportunity_id JOIN engagements e ON e.id = o.engagement_id WHERE p.id = poc_runs.experiment_id AND e.org_id = app_org_id())'),
      ('poc_reviews', 'app_platform_admin() OR EXISTS (SELECT 1 FROM poc_runs r JOIN poc_experiments p ON p.id = r.experiment_id JOIN opportunities o ON o.id = p.opportunity_id JOIN engagements e ON e.id = o.engagement_id WHERE r.id = poc_reviews.run_id AND e.org_id = app_org_id())'),
      ('poc_conclusions', 'app_platform_admin() OR EXISTS (SELECT 1 FROM poc_experiments p JOIN opportunities o ON o.id = p.opportunity_id JOIN engagements e ON e.id = o.engagement_id WHERE p.id = poc_conclusions.experiment_id AND e.org_id = app_org_id())'),
      ('delivery_plans', 'app_platform_admin() OR EXISTS (SELECT 1 FROM engagements e WHERE e.id = delivery_plans.engagement_id AND e.org_id = app_org_id())'),
      ('delivery_tasks', 'app_platform_admin() OR EXISTS (SELECT 1 FROM delivery_plans p JOIN engagements e ON e.id = p.engagement_id WHERE p.id = delivery_tasks.plan_id AND e.org_id = app_org_id())'),
      ('uat_cases', 'app_platform_admin() OR EXISTS (SELECT 1 FROM engagements e WHERE e.id = uat_cases.engagement_id AND e.org_id = app_org_id())'),
      ('go_live_items', 'app_platform_admin() OR EXISTS (SELECT 1 FROM engagements e WHERE e.id = go_live_items.engagement_id AND e.org_id = app_org_id())'),
      ('trainings', 'app_platform_admin() OR EXISTS (SELECT 1 FROM engagements e WHERE e.id = trainings.engagement_id AND e.org_id = app_org_id())'),
      ('delivery_issues', 'app_platform_admin() OR EXISTS (SELECT 1 FROM engagements e WHERE e.id = delivery_issues.engagement_id AND e.org_id = app_org_id())'),
      ('metric_targets', 'app_platform_admin() OR EXISTS (SELECT 1 FROM engagements e WHERE e.id = metric_targets.engagement_id AND e.org_id = app_org_id())'),
      ('metric_snapshots', 'app_platform_admin() OR EXISTS (SELECT 1 FROM metric_targets t JOIN engagements e ON e.id = t.engagement_id WHERE t.id = metric_snapshots.target_id AND e.org_id = app_org_id())'),
      ('value_records', 'app_platform_admin() OR EXISTS (SELECT 1 FROM engagements e WHERE e.id = value_records.engagement_id AND e.org_id = app_org_id())'),
      ('usage_records', 'app_platform_admin() OR EXISTS (SELECT 1 FROM engagements e WHERE e.id = usage_records.engagement_id AND e.org_id = app_org_id())'),
      ('renewal_risks', 'app_platform_admin() OR EXISTS (SELECT 1 FROM engagements e WHERE e.id = renewal_risks.engagement_id AND e.org_id = app_org_id())'),
      ('ai_drafts', 'app_platform_admin() OR EXISTS (SELECT 1 FROM engagements e WHERE e.id = ai_drafts.engagement_id AND e.org_id = app_org_id())'),
      ('engagement_members', 'app_platform_admin() OR EXISTS (SELECT 1 FROM engagements e WHERE e.id = engagement_members.engagement_id AND e.org_id = app_org_id())'),
      ('password_history', 'app_platform_admin() OR EXISTS (SELECT 1 FROM users u WHERE u.id = password_history.user_id AND u.org_id = app_org_id())')
    ) AS t(tbl, pred)
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', rec.tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', rec.tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (%s) WITH CHECK (%s)',
      rec.tbl, rec.pred, rec.pred
    );
  END LOOP;
END $$;
