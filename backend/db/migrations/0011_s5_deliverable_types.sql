-- R5 · 价值报告与续约建议纳入交付物中心
ALTER TABLE deliverables DROP CONSTRAINT IF EXISTS deliverables_type_check;
ALTER TABLE deliverables ADD CONSTRAINT deliverables_type_check
  CHECK (type IN (
    'charter','one_pager','diagnosis_report','roadmap','roi_sheet','data_report',
    'prd','architecture','proposal','poc_report','uat_report','value_report',
    'quote','acceptance',
    'delivery_plan','go_live_checklist','training_materials',
    'renewal_recommendation'
  ));
