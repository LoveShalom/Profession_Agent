-- =============================================================================
-- 0010_jobs_campaign_tier.sql —— 投递定位可手动覆盖
--
-- 背景：定位默认由分类派生（医学影像=主投、CV/AI应用=副投、其余=碰运气），
-- 但用户可能想"这个后端岗也要主投试试"或"这个 CV 岗先放着"。
-- 因此加 `campaign_tier` 覆盖列：NULL = 跟随分类；非 NULL = 用户手动指定。
-- =============================================================================

alter table jobs add column if not exists campaign_tier text;

alter table jobs drop constraint if exists jobs_campaign_tier_check;
alter table jobs
  add constraint jobs_campaign_tier_check
  check (campaign_tier is null or campaign_tier in ('primary', 'secondary', 'casual'));

comment on column jobs.campaign_tier is '投递定位覆盖：NULL=跟随分类派生；primary=主投 / secondary=副投 / casual=碰运气';
