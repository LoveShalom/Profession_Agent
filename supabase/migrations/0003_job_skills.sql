-- =============================================================================
-- 0003_job_skills.sql —— 技能属性表 + 截止时间三态（F-02 T1，R-3 / R-4 裁决）
--
-- 背景：
--   1) `jobs.skills` 只是归一化技能名的数组，无法表达"明确/推测""必须/加分""熟练度"；
--   2) 截止时间三态（provided / text_only / absent）需要落库才能区分
--      "JD 没写截止日期"（合法）与"抽到了但没证据"（异常）。
--
-- 设计要点：
--   · 技能属性放 job_skills 关联表（一行一个技能），便于按技能透视与差距分析（F-04）；
--   · (job_id, skill, source) 唯一：同一技能可以同时是"明确"与"推测"，但各自只有一行；
--   · 粒度校验：explicit 技能允许有熟练度；inferred 的 proficiency 必须 unknown（推测说不出程度）；
--   · 与 0001 一致：Supabase 专有 RLS 段用 DO 块按环境守卫，精简栈跳过。
-- =============================================================================

-- ---------------------------------------------------------------- 截止时间三态
alter table jobs
  add column if not exists deadline_kind text not null default 'absent';

-- 早前版本没有该列时，用已有 deadline 推断（有值 = provided）
update jobs set deadline_kind = 'provided' where deadline is not null and deadline_kind = 'absent';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'jobs_deadline_kind_check'
  ) then
    alter table jobs
      add constraint jobs_deadline_kind_check
      check (deadline_kind in ('provided', 'text_only', 'absent'));
  end if;
end
$$;

-- 三态与值的一致性：provided 必须有值；text_only/absent 必须为空
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'jobs_deadline_consistency_check'
  ) then
    alter table jobs
      add constraint jobs_deadline_consistency_check
      check (
        (deadline_kind = 'provided' and deadline is not null)
        or (deadline_kind in ('text_only', 'absent') and deadline is null)
      );
  end if;
end
$$;

-- ---------------------------------------------------------------- 技能属性表
create table if not exists job_skills (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references users (id) on delete cascade,
  job_id uuid not null references jobs (id) on delete cascade,

  -- 技能名（经 C-07 词表归一；未命中词表的新词先进待审词）
  skill text not null,

  -- 来源：JD 明说 / 领域推理
  source text not null check (source in ('explicit', 'inferred')),

  -- 必需性（与熟练度正交）
  requirement text not null default 'unknown' check (requirement in ('must', 'nice_to_have', 'unknown')),

  -- 熟练度（中文 JD 四档 + 未标注）
  proficiency text not null default 'unknown'
    check (proficiency in ('expert', 'proficient', 'familiar', 'basic', 'unknown')),

  confidence numeric(4, 3) not null default 0.5 check (confidence >= 0 and confidence <= 1),

  -- 触发该技能的原文短语（强制：反幻觉，便于用户核对）
  basis_phrase text not null check (length(trim(basis_phrase)) > 0),

  -- 推测技能指向技能图谱规则（F-04 填充）
  rule_id text,

  created_at timestamptz not null default now(),

  -- 推测技能不允许声称熟练度（推测只能说"可能要"，说不出"要多熟练"）
  constraint job_skills_inferred_proficiency_check
    check (source = 'explicit' or proficiency = 'unknown')
);

create unique index if not exists job_skills_job_skill_source_key
  on job_skills (job_id, skill, source);
create index if not exists job_skills_user_skill_idx on job_skills (user_id, skill);
create index if not exists job_skills_job_idx on job_skills (job_id);

-- ---------------------------------------------------------------- RLS（与 0001 同理：仅 Supabase 环境启用）
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'auth')
     and exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'alter table job_skills enable row level security';

    execute $p$drop policy if exists "users own their job skills" on job_skills$p$;
    execute $p$create policy "users own their job skills" on job_skills
      for all to authenticated
      using (auth.uid() = user_id) with check (auth.uid() = user_id)$p$;

    raise notice '已启用 Supabase RLS 策略（job_skills）';
  else
    raise notice '跳过 Supabase RLS：精简 Postgres 栈（job_skills 由服务端超级用户访问）';
  end if;
end
$$;
