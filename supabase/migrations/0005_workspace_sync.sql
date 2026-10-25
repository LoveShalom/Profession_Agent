-- =============================================================================
-- 0005_workspace_sync.sql —— 工作区双向同步所需列（F-03 T1/T2）
--
-- `revision`：修订号。CSV 里的 `_rev` 就是它；同步时比对可发现"文件落后于库"。
-- `notes`   ：台账的「备注」列（用户自由文本，不参与字段校验）。
--
-- 为什么不用 `updated_at` 做冲突检测：时间戳精度与时钟漂移会让冲突判断不稳定，
-- 单调递增的整数修订号更可靠（且便于人读懂"我这张表落后 2 版"）。
-- =============================================================================

alter table jobs add column if not exists revision int not null default 1;
alter table jobs add column if not exists notes text not null default '';

comment on column jobs.revision is '台账同步用的单调修订号（每次同步 +1）';
comment on column jobs.notes is '用户备注（工作区台账「备注」列）';
