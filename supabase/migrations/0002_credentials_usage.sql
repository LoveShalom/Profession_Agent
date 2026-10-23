-- =============================================================================
-- 0002_credentials_usage.sql —— BYOK 凭证与用量日志
-- 对应 tech_stack.md §9.2（user_llm_credentials / llm_usage_logs）与 §5（密钥专项）
--
-- 安全要点（AC-9）：
-- 1) 密钥只存密文（AES-256-GCM），主密钥来自服务端 ENCRYPTION_KEY
-- 2) 表启用 RLS 且**不向 authenticated 授予任何策略** → 客户端拿不到，只能经服务端 service role
-- 3) 另提供脱敏视图 llm_credentials_summary 供设置页读取（仅 provider / base_url / key_last4 / status）
-- =============================================================================

create table if not exists user_llm_credentials (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references users (id) on delete cascade,
  provider text not null,
  base_url text not null,
  -- AES-256-GCM 密文（bytea）；主密钥不落库
  encrypted_api_key bytea,
  -- 仅用于 UI 展示，绝不存明文
  key_last4 text,
  model_prefs jsonb not null default '{}'::jsonb,
  capabilities jsonb not null default '{}'::jsonb,
  status text not null default 'untested' check (status in ('untested', 'active', 'invalid')),
  last_verified_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists user_llm_credentials_user_provider_key
  on user_llm_credentials (user_id, provider, base_url);

drop trigger if exists credentials_set_updated_at on user_llm_credentials;
create trigger credentials_set_updated_at before update on user_llm_credentials
  for each row execute function set_updated_at();

-- 启用 RLS 但不建任何 policy：等于对 anon/authenticated 全部拒绝
alter table user_llm_credentials enable row level security;

-- 脱敏视图：设置页只能读这几个字段（不含密文）
create or replace view llm_credentials_summary
with (security_invoker = true) as
select
  id,
  user_id,
  provider,
  base_url,
  key_last4,
  status,
  capabilities,
  last_verified_at,
  last_used_at,
  created_at
from user_llm_credentials;

-- ---------------------------------------------------------------- 用量日志
create table if not exists llm_usage_logs (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references users (id) on delete cascade,
  credential_id uuid references user_llm_credentials (id) on delete set null,
  provider text not null,
  model text not null,
  task text not null,
  prompt_tokens int not null default 0,
  completion_tokens int not null default 0,
  cost_estimate numeric(12, 6),
  latency_ms int not null default 0,
  cache_hit boolean not null default false,
  -- 是否发生了降级（L3/L4）；评测报告与"降级率"指标依赖它
  degraded boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists llm_usage_logs_user_created_idx on llm_usage_logs (user_id, created_at desc);
create index if not exists llm_usage_logs_task_idx on llm_usage_logs (task);

-- user_llm_credentials：启用 RLS 但**不建任何策略**（对普通角色默认全拒绝，最安全）。
-- 精简栈下由服务端以超级用户连接，不受 RLS 约束；Supabase 下由 service role 访问。
alter table user_llm_credentials enable row level security;

-- llm_usage_logs：策略同样依赖 Supabase 专有的 auth.uid() 与 authenticated 角色，
-- 用 DO 块按环境守卫（与 0001 同理，避免精简栈上迁移中止）。
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'auth')
     and exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'alter table llm_usage_logs enable row level security';

    execute $p$drop policy if exists "users read own usage" on llm_usage_logs$p$;
    execute $p$create policy "users read own usage" on llm_usage_logs
      for select to authenticated using (auth.uid() = user_id)$p$;

    execute $p$drop policy if exists "users insert own usage" on llm_usage_logs$p$;
    execute $p$create policy "users insert own usage" on llm_usage_logs
      for insert to authenticated with check (auth.uid() = user_id)$p$;

    raise notice '已启用 Supabase RLS 策略（llm_usage_logs）';
  else
    raise notice '跳过 Supabase RLS：精简 Postgres 栈（llm_usage_logs 不做 RLS 限制）';
  end if;
end
$$;
