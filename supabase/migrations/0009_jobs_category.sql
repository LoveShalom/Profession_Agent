-- =============================================================================
-- 0009_jobs_category.sql —— 岗位分类标签（用户需求：医学影像算法 / 大模型算法 / CV 算法…）
--
-- 设计：`category` 存**分类 code**（如 algo-medical-imaging），UI 显示中文标签；
-- 不设 CHECK 约束：分类是开放集合，用户可写自定义分类，不让数据库挡住演进。
-- 已有岗位在迁移时按标题做一次回填（应用层 deriveJobCategory 无法在 SQL 里跑，
-- 所以这里只补 NULL，回填由 `npm run db:backfill-category` 完成）。
-- =============================================================================

alter table jobs add column if not exists category text;

comment on column jobs.category is '岗位分类 code（如 algo-medical-imaging / algo-llm / algo-cv / backend），可用户自定义';

create index if not exists jobs_user_category_idx on jobs (user_id, category) where deleted_at is null;
