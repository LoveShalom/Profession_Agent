-- =============================================================================
-- 0004_jobs_deadline_text.sql —— 补齐 jobs.deadline_text（F-02 T1 遗漏修复）
--
-- 背景：字段字典 v1 的 #14 是 `deadline_text`（原文片段，如"11月20日前"；
-- 模糊表述"招满为止"也记于此），但 0001_init.sql 建表时漏写了这一列。
-- F-02 的入库映射写入该字段时被真实数据库拒绝（42703），因此补一条迁移。
--
-- 为什么单独开一条而不是改 0001：0001 已在用户的库上执行过，
-- `create table if not exists` 对已存在的表不会补列；用新迁移才是可追踪的做法。
-- =============================================================================

alter table jobs add column if not exists deadline_text text;

-- 历史数据回填：三态为 text_only 但缺原文的行（当前应为 0 行）
update jobs
   set deadline_text = '（历史数据未记录原文）'
 where deadline_kind = 'text_only'
   and (deadline_text is null or length(trim(deadline_text)) = 0);
