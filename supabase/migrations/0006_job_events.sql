-- =============================================================================
-- 0006_job_events.sql —— 投递状态机（F-08 / I3 T1）
--
-- 1) 建 `job_events`：每次状态流转（含回退/重新激活）追加一行，**只追加不修改**，
--    与 `jobs.status` 的更新在同一事务里完成（应用层负责）。
-- 2) 给 `jobs.status` 补上 13 状态 CHECK：0001 只给了默认值 `saved`，没有约束。
-- 3) 先把历史脏值归一为 `saved`，否则加约束会失败（幂等：重复执行无副作用）。
--
-- 演进说明：如果再来一个新状态，需要同时改三处——本迁移的 CHECK、`src/lib/status.ts`
-- 的枚举、看板列。三者不一致时以 `src/lib/status.ts` 为唯一真源。
-- =============================================================================

create table if not exists job_events (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references users (id) on delete cascade,
  job_id uuid not null references jobs (id) on delete cascade,
  from_status text not null,
  to_status text not null,
  -- 回退与"进入终态/重新激活"必须填备注（应用层校验，这里只保证可空以兼容历史）
  note text,
  -- 语义标记：便于时间线渲染与复盘统计，避免从 from/to 反推
  is_rollback boolean not null default false,
  is_reactivation boolean not null default false,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint job_events_from_status_check check (
    from_status in (
      'saved', 'to_apply', 'applied', 'assessment', 'written_test', 'test_done',
      'interviewing', 'offer_pending', 'offered', 'accepted',
      'rejected_by_company', 'withdrawn', 'expired'
    )
  ),
  constraint job_events_to_status_check check (
    to_status in (
      'saved', 'to_apply', 'applied', 'assessment', 'written_test', 'test_done',
      'interviewing', 'offer_pending', 'offered', 'accepted',
      'rejected_by_company', 'withdrawn', 'expired'
    )
  )
);

create index if not exists job_events_job_idx
  on job_events (user_id, job_id, occurred_at desc);

-- ---------------------------------------------------------------- 归一并加约束
-- 历史数据里可能存在非 13 枚举的值（早期测试写入过 `offer` 之类的缩写）
update jobs
   set status = 'saved'
 where status not in (
   'saved', 'to_apply', 'applied', 'assessment', 'written_test', 'test_done',
   'interviewing', 'offer_pending', 'offered', 'accepted',
   'rejected_by_company', 'withdrawn', 'expired'
 );

alter table jobs drop constraint if exists jobs_status_check;
alter table jobs
  add constraint jobs_status_check check (
    status in (
      'saved', 'to_apply', 'applied', 'assessment', 'written_test', 'test_done',
      'interviewing', 'offer_pending', 'offered', 'accepted',
      'rejected_by_company', 'withdrawn', 'expired'
    )
  );

-- ---------------------------------------------------------------- RLS
-- 精简 Postgres 栈为单用户、应用层用超级用户连接；这里只启用 RLS（无策略 = 全部拒绝），
-- 与 0001 的做法一致：将来切 Supabase 时再按用户补策略。
alter table job_events enable row level security;

comment on table job_events is '岗位状态流转日志（只追加，回退/重新激活带标记）';
comment on column job_events.note is '回退、进入终态、重新激活时必填（应用层校验）';
