-- =============================================================================
-- 0001_init.sql —— 岗位库 / 经历库 / 用户档案 的初始结构
-- 对应 tech_stack.md §9.2（字段字典 v1 的核心一等列）与 §9.3（RLS 策略）
--
-- 设计要点：
-- 1) 本地优先（C-10）：默认单用户，播种一行固定 users 记录（见 tenant.ts 的 SINGLE_USER_ID）
-- 2) 一等列是唯一真源；LLM 原始输出 + evidence/confidence/长尾字段放 jd_structured（G-05）
-- 3) 组合字段整组校验（G-02）：salary 三件套、source/source_url 成对出现
-- 4) 指纹唯一约束带 user_id（G-06）：避免多用户间互相冲突
-- =============================================================================

create extension if not exists "uuid-ossp";
create extension if not exists vector;

-- ---------------------------------------------------------------- 用户档案
create table if not exists users (
  id uuid primary key default uuid_generate_v4(),
  email text,
  timezone text not null default 'Asia/Shanghai',
  target_roles text[] not null default '{}',
  target_cities text[] not null default '{}',
  nearby_city_groups jsonb not null default '[]'::jsonb,
  target_job_types text[] not null default '{}',
  graduation_year int,
  primary_resume_id uuid,
  notification_prefs jsonb not null default '{}'::jsonb,
  feishu_webhook_url text,
  quiet_hours jsonb not null default '{}'::jsonb,
  deploy_mode text not null default 'local' check (deploy_mode in ('local', 'demo')),
  llm_quota_daily int,
  invite_code text,
  created_at timestamptz not null default now()
);

-- 本地单用户播种（幂等）
insert into users (id, email, deploy_mode)
values ('00000000-0000-4000-8000-000000000001', null, 'local')
on conflict (id) do nothing;

-- ---------------------------------------------------------------- 岗位库
create table if not exists jobs (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references users (id) on delete cascade,

  -- 一等列（字段字典 v1）
  company text not null,
  title text not null,
  job_type text,
  graduation_year int,
  city text,
  cities text[] not null default '{}',
  work_mode text,
  salary_min int check (salary_min is null or salary_min >= 0),
  salary_max int check (salary_max is null or salary_max >= 0),
  salary_months int check (salary_months is null or (salary_months between 1 and 36)),
  salary_negotiable boolean not null default false,
  education text,
  experience_years jsonb,
  skills text[] not null default '{}',
  deadline timestamptz,
  source text not null default 'manual',
  source_url text,
  channel text,
  is_referral boolean not null default false,
  referral_code text,
  raw_text text not null,

  -- LLM 原始输出 + evidence/confidence + 长尾字段（不参与筛选与展示）
  jd_structured jsonb not null default '{}'::jsonb,
  -- 待确认字段名列表（驱动 UI 高亮与"待确认"筛选，B3）
  review_flags text[] not null default '{}',

  -- 流程与元数据
  status text not null default 'saved',
  priority text not null default '中' check (priority in ('高', '中', '低')),
  match_score numeric,
  next_action text,
  next_action_at timestamptz,
  offer_deadline date,
  offer_salary jsonb,
  fingerprint text not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- 组合字段整组约束（G-02）
  constraint jobs_salary_range check (
    salary_min is null or salary_max is null or salary_max >= salary_min
  )
);

create unique index if not exists jobs_user_fingerprint_key on jobs (user_id, fingerprint);
create index if not exists jobs_user_status_idx on jobs (user_id, status) where deleted_at is null;
create index if not exists jobs_user_deadline_idx on jobs (user_id, deadline) where deleted_at is null;
create index if not exists jobs_skills_gin on jobs using gin (skills);
create index if not exists jobs_review_flags_gin on jobs using gin (review_flags);

-- ---------------------------------------------------------------- 经历库
create table if not exists experiences (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references users (id) on delete cascade,
  type text not null check (type in ('internship', 'project', 'research', 'club')),
  org text not null,
  role text,
  start_date date,
  end_date date,
  summary text,
  star_situation text,
  star_task text,
  star_action text,
  star_result text,
  skills text[] not null default '{}',
  metrics jsonb not null default '{}'::jsonb,
  evidence_urls text[] not null default '{}',
  raw_text text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint experiences_date_order check (
    start_date is null or end_date is null or end_date >= start_date
  )
);

create index if not exists experiences_user_type_idx on experiences (user_id, type) where deleted_at is null;
create index if not exists experiences_skills_gin on experiences using gin (skills);

-- ---------------------------------------------------------------- updated_at 触发器
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists jobs_set_updated_at on jobs;
create trigger jobs_set_updated_at before update on jobs
  for each row execute function set_updated_at();

drop trigger if exists experiences_set_updated_at on experiences;
create trigger experiences_set_updated_at before update on experiences
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------- RLS（可选：仅 Supabase 环境）
-- ⚠️ 重要：ADR-0001 的默认栈是"纯 pgvector/Postgres 精简栈"，它**没有** Supabase 的
-- `auth` schema、`auth.uid()` 函数，也没有 `authenticated` 角色。若直接写 `create policy ... to authenticated`，
-- 整个迁移会在这里中止（2026-10-21 首次验收就因此导致 0002 未执行）。
-- 因此用 DO 块按环境守卫：
--   · Supabase 环境（存在 auth schema + authenticated 角色）→ 启用 RLS 并建策略
--   · 精简栈 → 跳过（本地单用户由超级用户连接，本就绕过 RLS）
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'auth')
     and exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'alter table jobs enable row level security';
    execute 'alter table experiences enable row level security';
    execute 'alter table users enable row level security';

    execute $p$drop policy if exists "users own their jobs" on jobs$p$;
    execute $p$create policy "users own their jobs" on jobs
      for all to authenticated
      using (auth.uid() = user_id) with check (auth.uid() = user_id)$p$;

    execute $p$drop policy if exists "users own their experiences" on experiences$p$;
    execute $p$create policy "users own their experiences" on experiences
      for all to authenticated
      using (auth.uid() = user_id) with check (auth.uid() = user_id)$p$;

    execute $p$drop policy if exists "users read own profile" on users$p$;
    execute $p$create policy "users read own profile" on users
      for all to authenticated
      using (auth.uid() = id) with check (auth.uid() = id)$p$;

    raise notice '已启用 Supabase RLS 策略（多账号模式）';
  else
    raise notice '跳过 Supabase RLS：当前为精简 Postgres 栈（单用户模式由超级用户连接，不受 RLS 约束）';
  end if;
end
$$;
