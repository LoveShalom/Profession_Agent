# ADR-0001：数据层选 Supabase 本地栈（pgvector 精简版）

- 状态：已采纳（I0 实施）
- 日期：2026-10-16
- 关联：F-01 T2/T7、[tech_stack.md](../../spec/tech_stack.md) §3.2、[ADR-0003](0003-local-first-deployment.md)

## 背景

项目需要：关系型数据 + 向量检索 + 文件存储 + 行级安全，且**低运维**（个人项目不养服务器）。
C-10 裁决后产品形态是"用户 clone 到本机运行"，因此数据层必须能在单机上一条命令拉起来。

## 选项

| 方案 | 优点 | 缺点 |
|---|---|---|
| A. 云端 Supabase（托管） | 零运维、Auth/Storage/Studio 齐全 | 与"数据不出机"冲突；国内直连不稳 |
| B. Supabase CLI 本地全家桶（`supabase start`） | Auth/Storage/Studio 全都有，代码零改动 | 镜像体积大、首次启动慢（>10 分钟） |
| C. **仅 Postgres + pgvector 容器（本 ADR 采纳）** | 镜像小、启动快（秒级）、迁移即建表 | 没有 Auth/Storage/Studio；多账号模式需另起 supabase CLI |

## 决定

采用 **方案 C 作为默认**：`docker-compose.yml` 只起 `pgvector/pgvector:pg16`，并把
`supabase/migrations/` 挂载到容器的 `/docker-entrypoint-initdb.d`，首次启动自动建表。
需要完整 Supabase 本地栈（Auth / Storage / RLS 演练）时，用户可改用 `supabase start`，
应用代码无需修改（连接串在 `.env` 里）。

## 后果

- ✅ AC-1（干净机器 ≤10 分钟启动）可达：镜像小、无额外依赖；离线时可用 `--no-pull` + 预拉镜像。
- ✅ 迁移策略简化：SQL 全部写成幂等，`npm run db:migrate` 可重复执行（`scripts/migrate.mjs`）。
- ⚠️ 单用户默认模式下不启用 RLS（service role 连接）；多账号模式需 `supabase start` 或云端实例，
  策略已在 `0001_init.sql` 中就绪但需真实 Supabase 环境验证——**列为 I1 之后的待验证项**。
- ⚠️ 未在真实 Docker 环境验证（当前开发环境无 Docker）；`setup`/`migrate` 的容器路径属"已实现未验证"，
  已在 [F-01 实现状态](../../spec/features/F-01-bootstrap.md) 中显式标注。

## 实施中发现的问题与修正（2026-10-21 首次真实验收）

**问题**：本 ADR 选定"纯 pgvector/Postgres 精简栈"，但迁移文件里直接写了 Supabase 专有语句
（`create policy ... to authenticated using (auth.uid() = ...)`）。纯 Postgres **没有** `auth` schema、
`auth.uid()` 函数与 `authenticated` 角色 → `0001_init.sql` 在末尾 RLS 段报错中止：
表已建好（所以表面"部分成功"），`0002` 从未执行，`schema_migrations` 也不存在；
而容器因 `restart: unless-stopped` 重启后变 healthy，`docker compose ps` 看起来一切正常。

**影响面**：迁移未完整应用；`npm run setup` 的"应用迁移"步骤只显示 ⚠️（当时错误输出被脚本吞掉）。

**修正**：
1. 迁移中的 Supabase 专有段全部改为**按环境守卫的 `DO` 块**——检测到 `auth` schema + `authenticated`
   角色才启用 RLS 并建策略，否则 `raise notice` 跳过（精简栈由超级用户连接，本就绕过 RLS）。
2. `migrate.mjs` / `setup.mjs` 在**交互终端**下改为透传子进程输出（`stdio: 'inherit'`），
   迁移失败时能直接看到 psql 的原始报错；非 TTY（CI/沙箱）仍用 `ignore`。
3. 新增静态回归测试 `tests/migrations.test.ts`：检查 Supabase 专有标识符只出现在守卫之后、
   `create policy` 必须用 `execute` 动态执行、幂等标记齐备、不含破坏性语句——**离线即可跑**。
4. 验收指南补充该故障的症状、根因与恢复步骤（[acceptance-guide-F01.md](../acceptance-guide-F01.md) §2.1.1）。

**结论**：本 ADR 的选型不变（精简栈仍是默认），但"Supabase 专有语法必须环境守卫"成为硬约束，
由测试固化。这也验证了验收流程中"阶段 2（真实 DB）不可跳过"——离线测试只能证明逻辑符合契约，
SQL 语义只有连上真实数据库才能确认。
