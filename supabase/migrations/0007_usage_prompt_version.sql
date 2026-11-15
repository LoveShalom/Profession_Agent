-- =============================================================================
-- 0007_usage_prompt_version.sql —— 用量日志补 prompt 版本（F-09 T9）
--
-- 为什么需要：`llm_usage_logs` 已记录 provider/model/task/tokens/latency/degraded，
-- 但没法回答"这次调用用的是哪一版 prompt"。改了 prompt 之后想对比质量与成本时会失忆。
-- 版本取值 = `prompts/*.md` 内容的 sha256 前 8 位（由应用层计算），换 prompt 自动换版本。
-- =============================================================================

alter table llm_usage_logs add column if not exists prompt_version text;

comment on column llm_usage_logs.prompt_version is 'prompt 内容哈希前 8 位（改了 prompt 自动变），用于对比质量/成本';
