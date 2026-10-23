# F-01 验收操作指南（工程地基与 Provider 适配层）

> 适用对象：项目所有者本人，手动执行。
> 预计总耗时：**35–45 分钟**（含镜像拉取；镜像已预热时约 20 分钟）。
> 验收依据：[spec/features/F-01-bootstrap.md](../spec/features/F-01-bootstrap.md) §4（4 条红线 + 13 条 AC + 100 分评分卡）。

---

## 0. 前置说明

### 0.1 为什么这些命令要你自己跑

自动化代理的沙箱**无法访问 Docker 的 Windows 命名管道**
（`docker ... npipe:////./pipe/dockerDesktopLinuxEngine` → `permission denied`），也无法访问 npm registry。
因此以下命令请在你**自己的 PowerShell 窗口**（或 Windows Terminal）里执行，不要交给我代跑。

### 0.2 已确认的环境状态（2026-10-21 探测）

| 项 | 状态 |
|---|---|
| Docker client | ✅ 29.9.1 |
| Docker Compose | ✅ v5.6.0 |
| Docker daemon | ⚠️ 需你自己确认：`docker info` 能输出内容即正常 |
| Node.js | ✅ v24.17.0 |
| 端口 3000 / 54322 | ✅ 均空闲 |
| `.env` | ✅ 已生成（含 ENCRYPTION_KEY） |
| `node_modules` | ❌ 未安装（阶段 4 需要） |

### 0.3 一个必须先明确的口径调整（重要，避免误判为失败）

F-01 的 **AC-1** 原文是"≤10 分钟内打印可访问地址，且**页面可打开**"。
但 Web 界面属于 I1（F-02 JD 入库闭环），当前代码库**还没有页面**。因此本次验收把它拆成：

| 编号 | 内容 | 本次能否验收 |
|---|---|---|
| **AC-1a** | 数据层一键就绪（`npm run setup` ≤10 分钟完成，DB 可连、迁移已应用） | ✅ 本次验收 |
| **AC-1b** | 页面可打开（Next.js 首页/健康检查端点 200） | ⏳ 留到 F-02 完成后补验 |

`setup` 在结尾会对 `/api/health` 做探测，因为页面不存在会显示 ⚠️ 警告并**仍以退出码 0 结束**——这是预期行为，不是失败。

### 0.4 验收进度（实况，2026-10-21）

| 步骤 | 状态 | 证据 |
|---|---|---|
| 0 环境预检（Docker / Node / 端口） | ✅ 完成 | Docker 29.9.1、Compose v5.6.0、Node v24.17.0、端口空闲 |
| 1 离线验收 `npm run accept` | ⬜ 待你执行 | 未留档（代理侧结果为 75/75） |
| 2.1a AC-1a 一键启动（全新数据卷） | ✅ 完成 | 两次迁移全绿、无 psql 报错；`pg_isready` 探测 12 次 ≈ initdb 真实耗时 |
| 2.2 表/迁移复查 | 🟡 部分（旧卷已验） | 曾见 5 表 + 1 视图 + `schema_migrations` 2 行；干净重跑后需复查一次 |
| 2.3 AC-2 幂等（脚本化） | ✅ 完成 | `verify-idempotency.mjs` → 8/8 断言（两次 setup 退出 0 / 3.3s·2.9s、测试行仍在、`.env` 10 键不变、migrations 未重复） |
| 2.4 doctor（`--no-network`） | ⬜ 待做 | — |
| 3 真实模型（AC-4/5/7/9） | 🟡 3A 可脚本化（`npm run verify:model`，8/8）；3B 待真 Key/Ollama | 3A 无需 Key、不联网；3B 验真实连通性 |
| 4 依赖与静态检查（lint/typecheck） | ✅ 完成（修复配置缺陷后） | `npm install` 成功；`lint` 0 problem、`typecheck` 0 error、`npm test` 137/137（详见 §4.1） |
| 5 收尾（存档 + 评分卡 + 签字） | ⬜ 待做 | — |

> 说明：AC-1a 的计时证据来自本次日志（`pg_isready` 探测 12 次 + 迁移执行，总计约 20–30 秒）。
> 注意区分两种口径：**镜像已缓存**（≈30 秒）与 **干净机器首次拉镜像**（另加几分钟，取决于网络）。
> 证据里请注明是哪种，否则"≤10 分钟"的结论不可比。

**AC-1a 已完成，从阶段 1 补跑 accept 开始，然后顺序推进 2.3 → 2.4 → 3 → 4 → 5。**

---

## 阶段 1｜离线验收（约 5 分钟，零依赖）

```powershell
cd C:\Users\WenFe\Desktop\Projects\profession_search_agent
npm run accept
```

**期望结果**：退出码 `0`，输出末尾为

```
【4 条红线】✅ R1 密钥不泄漏 · ✅ R2 setup 不破坏数据 · ✅ R3 零厂商 SDK · ✅ R4 出站白名单
【验收清单】13 条 AC 中 11 条 ✅，2 条 ⏭️（AC-1、AC-2 需 Docker）
【评分卡】自动可验合计：75 / 75
【结论】✅ 自动可验部分全部通过（75/75）
```

**通过标准**：40 项断言里 R1–R4 全 ✅，评分卡 75/75，退出码 0。

**失败处理**：看报告里 FAIL 那行的 `→ 下一步`；单独重跑 `npm test` / `npm run doctor -- --core-only --no-network` 看细节。

> 留档：`New-Item -ItemType Directory -Force evals\reports | Out-Null; npm run accept *> evals\reports\F-01-accept.txt`

---

## 阶段 2｜数据层验收（约 20–25 分钟，需 Docker）

### 2.1 AC-1a：一键启动并计时

```powershell
# 先确认 daemon 正常（能列出内容即可，空列表也正常）
docker info --format "{{.ServerVersion}}"

# 计时开始
$sw = [Diagnostics.Stopwatch]::StartNew()
npm run setup
$sw.Stop()
"总耗时: {0:N1} 秒" -f $sw.Elapsed.TotalSeconds
```

**期望输出（成功路径，逐行）**：

```
✅ Node.js 版本 —— v24.x
✅ .env —— 已存在（仅补缺失项）
✅ Docker —— docker 与 docker compose 可用
✅ 端口 3000 —— 可用
✅ 启动容器 —— db 已启动（pgvector + Postgres）
✅ 等待数据库 —— 127.0.0.1:54322 可连接
✅ 应用迁移 —— 迁移已应用或已是最新
⚠️  健康检查 —— 应用尚未启动（首次需先安装依赖并构建）   ← 预期（AC-1b 待 F-02）
```

**通过标准**：退出码 `0`；从开始到"等待数据库 ✅" **≤ 10 分钟**（首次含镜像拉取，镜像约 400MB）；
`健康检查 ⚠️` 不计失败。

**常见失败与处理**：

| 现象 | 原因 | 处理 |
|---|---|---|
| 拉取 `pgvector/pgvector:pg16` 超时 / TLS 错误 | Docker Hub 在国内常被限速或不可达 | Docker Desktop → Settings → Docker Engine，在 JSON 里加 `"registry-mirrors": ["<可用的镜像加速器地址>"]` → Apply & Restart；或先单独 `docker pull pgvector/pgvector:pg16` 验证 |
| `Docker / Compose ❌` | daemon 未启动 | 启动 Docker Desktop，等鲸鱼图标变绿后重试 |
| **`failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`** / `The system cannot find the file specified` | **`docker` 命令在、但 Docker Desktop 的 daemon 没启动**（`docker --version` 仍会成功，容易误判） | ① 启动 Docker Desktop，等托盘图标变绿；② 验证 `docker info` 能输出内容；③ 再跑 `npm run setup`。Windows 还要排查 WSL2 后端是否异常、是否刚重启未就绪。脚本已内置 daemon 检测：未运行时**秒级报错**并给出上述命令，不会白等 120 秒 |
| `端口 3000 ❌` | 被其他程序占用 | `npm run setup -- --port 3001`（脚本不会静默换端口） |
| `docker compose up 失败` | 常在首次拉镜像时出现 | `docker compose logs db` 看具体错误 |
| 想跳过拉取（镜像已存在） | — | `npm run setup -- --no-pull` |
| **`\dt` 只有 3 张表**（users/jobs/experiences），且 `schema_migrations` 不存在 | **已修复的已知 bug**：迁移里混入了 Supabase 专有语法（`to authenticated` / `auth.uid()`），纯 Postgres 栈下 0001 末尾报错中止 → 0002 从未执行；容器因 restart 策略重启后变 healthy，表面正常 | 见 §2.1.1「迁移中止的恢复步骤」 |
| `应用迁移 ⚠️ 未确认` | 同上，或某个 SQL 执行失败 | `npm run db:migrate`（现在会透传 psql 原始报错）；必要时 `node scripts/migrate.mjs --verbose` |
| **全新数据卷首次启动时**：`psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: No such file or directory` | **就绪判定竞态**：Docker Desktop 的端口转发会在容器内 Postgres 尚未启动时就先接受 TCP 连接，导致 TCP 探测假阳性、迁移抢跑；此时容器仍在 `initdb` | **已修复**（改用容器内 `pg_isready` + 迁移按 psql 退出码重试）。若你的版本仍有此报错：等 30 秒后 `npm run db:migrate` 即可；**通常数据无害**——postgres 镜像本身会在 init 阶段执行同一批 SQL |

### 2.1.1 迁移中止的恢复步骤（2026-10-21 实况）

**症状**：`npm run setup` 的"应用迁移"显示 ⚠️；`\dt` 只有 3 张表；`schema_migrations` 报"relation does not exist"。

**根因**：见上表。已在 `supabase/migrations/*.sql` 中修复（Supabase 专有语句改为按环境守卫的 `DO` 块），并新增静态回归测试 `tests/migrations.test.ts` 防止复发。

**恢复步骤（推荐：清空重来，顺带把 AC-1a 从干净状态重新验一遍）**

```powershell
docker compose down
Remove-Item -Recurse -Force .data\pgdata   # 注意：bind mount 不会被 `down -v` 清掉，必须手动删
npm run setup
```

**验证**（`\dt` 应列出 6 张表，且 `schema_migrations` 有 2 行）：

```powershell
docker compose exec -T db psql -U postgres -d postgres -c "\dt"
docker compose exec -T db psql -U postgres -d postgres -c "select filename from schema_migrations order by 1;"
```

期望 `\dt` 包含：`users`、`jobs`、`experiences`、`user_llm_credentials`、`llm_usage_logs`、`schema_migrations`（共 6 张表 + 1 个视图 `llm_credentials_summary`，视图可用 `\dv` 查看）。

**备选：保留现有数据做增量修复**

```powershell
npm run db:migrate
```

迁移是幂等的（`create table if not exists` / `drop ... if exists`），会在现有库上补齐 0002 的对象。
但注意：首次失败时已对 3 张表执行过 `enable row level security`（无策略），精简栈下超管连接会绕过 RLS，
不影响使用；若想彻底干净，仍建议走"清空重来"。

> ⚠️ **这一项无法离线验证**：SQL 的语义正确性只有连上真实数据库才能确认。这就是阶段 2 不可跳过的原因——
> 离线验收（阶段 1）只能证明"代码逻辑与脚本符合契约"，不能证明"迁移能在你的 Postgres 上跑通"。

### 2.2 验证数据库与迁移真的生效

```powershell
docker compose ps
docker compose exec -T db psql -U postgres -d postgres -c "\dt"
docker compose exec -T db psql -U postgres -d postgres -c "select filename, applied_at from schema_migrations order by filename;"
docker compose exec -T db psql -U postgres -d postgres -c "select id, deploy_mode from users;"
```

**通过标准**：

- `\dt` 能看到：`users`、`jobs`、`experiences`、`user_llm_credentials`、`llm_usage_logs`、`schema_migrations`
- `schema_migrations` 有 **2 行**（0001、0002）
- `users` 有 **1 行**，`id = 00000000-0000-4000-8000-000000000001`、`deploy_mode = local`

### 2.3 AC-2：幂等（连跑 2 次，数据不丢、.env 不被覆盖）

**用脚本，不要手工逐步执行**：

```powershell
node scripts/verify-idempotency.mjs --report evals\reports\F-01-idempotency.txt
```

**通过标准**：`✅ AC-2 通过：6/6 项断言成立`，退出码 `0`。

脚本自动完成：记录基线（`.env` 逐键、jobs/users/schema_migrations 行数）→ 插入唯一测试行 →
连续跑两次 `setup` → 逐项比对 → **在清理前**给出结论 → 清理测试行。

#### 为什么不能手工做（2026-10-21 实况）

指南早期版本给的是手工六步，其中第 ⑤ 步是"删除测试行"。于是验收结束时执行
`select count(*) from jobs where fingerprint='fp-test'` 得到 **0**——这个 0 **无法判定任何事**：

- 可能"验完清理了"（正确流程）；
- 也可能"测试行根本没插进去"（插入失败）。

证据被自己的清理步骤销毁了，而且无法重跑复现。脚本版把结论打印**在清理之前**，并把逐项断言
写进 UTF-8 报告，才具备留档价值。

<details>
<summary>手工版（仅用于理解或排查，不用于留档）</summary>

```powershell
$before = (Get-FileHash .env -Algorithm SHA256).Hash
docker compose exec -T db psql -U postgres -d postgres -c "insert into jobs (user_id, company, title, raw_text, fingerprint) values ('00000000-0000-4000-8000-000000000001','幂等测试公司','测试岗','raw text','fp-idempotency-test') on conflict do nothing;"
npm run setup
npm run setup
docker compose exec -T db psql -U postgres -d postgres -c "select count(*) as should_be_1 from jobs where fingerprint='fp-idempotency-test';"
if ($before -eq (Get-FileHash .env -Algorithm SHA256).Hash) { '✅ .env 未被覆盖' } else { '❌ .env 被改动' }
docker compose exec -T db psql -U postgres -d postgres -c "delete from jobs where fingerprint='fp-idempotency-test';"
```
</details>

### 2.4 doctor（数据层已就绪时的自检）

```powershell
npm run doctor -- --no-network
```

**期望**：`Docker / Compose ✅`、`数据库可达性 ✅`、`私网访问 ✅ 默认拒绝`、`出站白名单 ✅`、`遥测 ✅ 已关闭`、`权限模式 ✅ 本地单用户`；
`模型接入 ⚠️ 未配置 API Key`（合法状态，阶段 3 处理）。
**通过标准**：退出码 `0`（`--no-network` 下未配 Key 属可接受项）。

---

## 阶段 3｜真实模型验收（约 10 分钟，需网络或本地 Ollama）

> 这一步同时验证 **AC-4 / AC-5 / AC-7 / AC-9** 的真实路径（离线版已验证逻辑，这里验真实连通性）。
> 三选一，推荐 A（最便宜）。

### 方案 A：DeepSeek / 任意 OpenAI 兼容 Key

编辑 `.env`：

```ini
LLM_PROVIDER=deepseek
LLM_API_KEY=sk-你的真实key
LLM_MODEL=deepseek-chat
LLM_BASE_URL=
```

```powershell
npm run doctor
```

**期望**：`模型接入 ✅ DeepSeek / deepseek-chat 连通（xxx ms）`；`能力摘要 ... (source=probe)`。
**通过标准**：退出码 `0`（`--no-network` 不能用于此步，必须联网探活）。

### 方案 B：自定义中转站（验证"换模型只改配置"）

```ini
LLM_PROVIDER=custom
LLM_BASE_URL=https://你的中转站地址/v1
LLM_MODEL=你网关支持的模型名
LLM_API_KEY=sk-你的key
```

再跑 `npm run doctor`，期望同上。**这一项能拿评分卡里"可替换性实证 7 分"**——因为你只改了 `.env`，代码零改动。

### 方案 C：Ollama 本地模型（验证 AC-8 私网放行）

```powershell
ollama pull qwen2.5:7b
```

```ini
LLM_PROVIDER=ollama
LLM_API_KEY=
ALLOW_PRIVATE_BASE_URL=true      # ← 关键：私网地址默认被拒
```

`npm run doctor` → 期望 `模型接入 ✅ Ollama（本地模型）/ qwen2.5:7b 连通`。

### 3.x AC-4 / AC-5 / AC-8 / AC-10 专项：**不需要真实 Key**

原先这里要求在 `.env` 里手工改三次（错误 Key → 不可达地址 → 还原）。**实测容易漏改**
（2026-10-21 就出现过"以为改了、其实 `.env` 里 Key 仍为空"）。现在改为一条命令：

```powershell
node scripts/verify-model-errors.mjs
```

它用**注入的 fetch 桩**精确构造 401 / 403 / 404 / DNS 失败 / 私网地址 / 无 Key 等场景，
不联网、不改 `.env`、可重复执行，最后还会打印"当前 .env 解析结果（Key 脱敏）"，
便于确认配置是否真的生效。

**通过标准**：`合计：8/8 通过`，退出码 `0`。

> 覆盖：AC-4a（401）、AC-4b（403）、AC-5（不可达 → 提示 `LLM_BASE_URL`）、AC-5b（404 → 提示模型名）、
> AC-8（私网默认拒绝）、AC-10（白名单放行/拦截）、AC-6（无 Key → L4 零请求）、脱敏（不泄漏 Key）。

**如果脚本打印的 `.env` 解析结果里 `API Key = 未设置`，说明你的编辑没生效**——常见原因是
编辑器把文件存成了 `.env.txt`。用下面这条命令改（不经过编辑器，避免该问题）：

```powershell
$lines = Get-Content .env
$lines = $lines -replace '^LLM_API_KEY=.*$', 'LLM_API_KEY=你的真实Key'
[System.IO.File]::WriteAllLines((Join-Path $PWD ".env"), $lines)
```

---

## 阶段 4｜依赖与静态检查（约 10 分钟，需网络）

```powershell
npm install
npm run lint
npm run typecheck
```

**通过标准**：`npm install` 无 error；`typecheck` 输出 0 个 error；`lint` 无 error 级问题（warn 可接受，例如 `no-unused-vars`）。
**常见失败**：npm 安装慢/超时 → `npm config set registry https://registry.npmmirror.com` 后重试。

### 4.1 首次执行时踩到的两个配置缺陷（均已在代码中修复）

**① `npm run lint` 报 24 个 `Parsing error: Unexpected token type / interface / {`**

原因：`eslint.config.mjs` 只配了 ESLint core 规则，**没有配置 TypeScript parser**。ESLint 默认用 espree，
解析不了 `.ts` 的类型语法 —— 不是业务代码有问题，是配置缺 parser。
修复：`.ts/.tsx` 使用 `@typescript-eslint/parser`（JS/MJS 仍用默认 parser）；且**不使用任何 recommended 预设**，
只显式开启少数确定有价值的规则，避免规则面不可控。
（`@typescript-eslint/parser` 由 `eslint-config-next` 传递安装，但已显式写入 devDependencies，防止上游更新后消失。）

**② `npm run typecheck` 报 15 个错误**

两类原因，都属测试代码写法问题：

| 报错 | 原因 | 修法 |
|---|---|---|
| `Property 'service' does not exist on type '{ ok: true; ... } \| { ok: false; ... }'`（12 处） | `tryCreateLLM` 返回**判别联合**，`const { ok, service } = …` 在判断 `ok` 之前就解构了 `service`，TS 无法收窄 | 改为 `const created = tryCreateLLM(…); assert.equal(created.ok, true); if (!created.ok) return; const service = created.service;` |
| `Could not find a declaration file for module '../scripts/lib/purity.mjs'` | 测试导入了无类型声明的 `.mjs` 模块 | tsconfig 加 `allowJs: true` + `checkJs: false`，让 TS 从 JS 源码推断类型 |

另清理了 4 个 `no-unused-vars` warning（其中 `setup.mjs` 的 `--yes` 参数**从未实现**，直接移除而不是留个假参数）。

**修复后实测**：`lint` 0 error 0 warning、`typecheck` 0 error、`npm test` 137/137、`npm run accept` 75/75。

> 说明：`npm install` 会拉取 Next.js/React/Zod 等 Web 层依赖，它们供 F-02 使用，不影响 I0 核心。
> `npm audit` 提示 7 个漏洞（1 moderate / 6 high）多为 next / eslint 链的传递依赖，
> **不要执行 `npm audit fix --force`**（会做破坏性升级）；可先用 `npm audit --omit=dev` 判断是否涉及生产依赖，
> 留到 F-02 引入 schema 层时一并处理。

---

## 阶段 5｜收尾（约 5 分钟）

### 5.1 补跑一次完整验收并存档

```powershell
node scripts/accept.mjs --report evals\reports\F-01-accept.txt
node scripts/doctor.mjs --report evals\reports\F-01-doctor.txt
```

`--report` 由脚本自己写 **UTF-8** 文件，**不要用 PowerShell 的 `*>` 重定向**（原因见 §5.1.1）。

数据库结构证据（psql 输出）不属于本项目的 Node 脚本，需要用下面两种方式之一：

```powershell
# 方式 1：先把本会话的原生命令输出解码改成 UTF-8（PS 5.1 必需）
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
docker compose exec -T db psql -U postgres -d postgres -c "\dt" | Out-File -Encoding utf8 evals\reports\F-01-tables.txt

# 方式 2（更稳）：让 psql 在容器内写文件，再用 docker cp 取回（字节原样保留，不经过 PowerShell 解码）
docker compose exec -T db psql -U postgres -d postgres -o /tmp/tables.txt -c "\dt"
docker compose cp db:/tmp/tables.txt evals\reports\F-01-tables.txt
```

#### 5.1.1 乱码的成因与判定（2026-10-21 实况）

**症状**：用 `*>` 存下来的报告，用编辑器/`Get-Content` 打开是 `鈹屸攢鈹€…`、`鈻?姝ラ…` 这类双重乱码。

**成因（Windows PowerShell 5.1 特有）**：

1. Node 往管道写 **UTF-8**；
2. PS 5.1 用系统 ANSI 代码页（中文环境为 GBK/CP936）去解码 → 得到乱码字符串；
3. `*>` 再把这个乱码串写成 **UTF-16LE + BOM** 文件。

**危害**：不只是编码格式不对，而是**内容已被破坏**——GBK 解码时无法映射的字节被替换成 `?`，
信息不可逆丢失（对照：正常 UTF-8 文件里不会出现 `鈹?` 这种"半个字符 + 问号"）。

**判定方法**：

```powershell
# 看文件编码：FF FE 开头 = UTF-16LE（PS 5.1 重定向的产物）；EF BB BF = UTF-8 BOM；无 BOM 的 UTF-8 才正常
$b = [System.IO.File]::ReadAllBytes('evals\reports\F-01-accept.txt')
($b[0..2] | ForEach-Object { $_.ToString('X2') }) -join ' '

# 正常文件应能直接读出中文
Get-Content evals\reports\F-01-accept.txt -Encoding utf8 | Select-Object -First 5
```

**根本修复**：验收脚本已支持 `--report <path>`，由 Node 用 `writeFileSync(..., 'utf8')` 直接落盘，
完全不经过 shell 的编码转换。**今后一律用 `--report`，不要用 `*>`。**

> 注：`accept.mjs` 会把测试套件与 doctor 的子进程输出一并写入报告（管道捕获）；
> 若运行环境禁止管道（如受限沙箱），会退回直接输出到终端，报告里只有结论没有明细——不影响结论。

### 5.2 填写评分卡（100 分）

| 维度 | 权重 | 自动/人工 | 你的得分 | 依据 |
|---|---|---|---|---|
| 适配层可替换性 | 20 | 自动（accept） | ____ | AC-3 + AC-13 |
| 降级链完整性 | 20 | 自动（accept） | ____ | AC-6 + AC-7 |
| 安全与隐私 | 15 | 自动（accept） | ____ | AC-8 / AC-9 / AC-10 |
| 可诊断性 | 10 | 自动（accept） | ____ | AC-12 |
| 工程规范 | 10 | 自动（accept + 阶段 4） | ____ | G-1 + lint/typecheck |
| **一键启动体验** | **25** | **人工** | ____ | 见下方三小项 |
| **合计** | **100** | | **____** | |

**一键启动体验 25 分细分**（建议口径）：

| 子项 | 分值 | 满分条件 | 你的得分 |
|---|---|---|---|
| 干净机器启动 | 10 | AC-1a ≤10 分钟、一次成功、零手工介入 | ___ |
| 同学盲测 | 8 | 只给 README 能独立装完（记下卡在哪一步） | ___ |
| 可替换性实证 | 7 | 只改 `.env` 接入中转站成功（阶段 3 方案 B） | ___ |

### 5.3 签署判定

| 总分 | 结论 | 下一步 |
|---|---|---|
| **≥85** | ✅ 通过 | 进入 I1（F-02 JD 入库闭环） |
| **70–84** | ⚠️ 有条件通过 | 扣分项列为 I1 首日必办，不阻塞开工 |
| **<70** | ❌ 不通过 | 按扣分维度回到 T2/T3/T4 重做 |
| **任一红线 FAIL** | ❌ 直接不通过 | 先修红线，其余不看 |

> 自动部分满分 75，因此"一键启动体验"拿到 **≥10 分**即可过 85 线。

---

## 附：一次性完整命令清单（复制粘贴版）

```powershell
cd C:\Users\WenFe\Desktop\Projects\profession_search_agent
New-Item -ItemType Directory -Force evals\reports | Out-Null

# 阶段 1
npm run accept *> evals\reports\F-01-accept.txt

# 阶段 2
$sw = [Diagnostics.Stopwatch]::StartNew(); npm run setup; $sw.Stop(); "setup 耗时: $($sw.Elapsed.TotalSeconds) 秒"
docker compose ps
docker compose exec -T db psql -U postgres -d postgres -c "\dt"
$before = (Get-FileHash .env -Algorithm SHA256).Hash
docker compose exec -T db psql -U postgres -d postgres -c "insert into jobs (user_id, company, title, raw_text, fingerprint) values ('00000000-0000-4000-8000-000000000001','幂等测试公司','测试岗','raw','fp-test') on conflict do nothing;"
npm run setup; npm run setup; npm run db:migrate
docker compose exec -T db psql -U postgres -d postgres -c "select count(*) from jobs where fingerprint='fp-test';"
if ($before -eq (Get-FileHash .env -Algorithm SHA256).Hash) { '✅ .env 未被覆盖' } else { '❌ .env 被改动' }
docker compose exec -T db psql -U postgres -d postgres -c "delete from jobs where fingerprint='fp-test';"
npm run doctor -- --no-network

# 阶段 3（先编辑 .env 填 Key）
npm run doctor

# 阶段 4
npm install
npm run lint
npm run typecheck

# 阶段 5
npm run doctor *> evals\reports\F-01-doctor.txt
```

---

## 附：清理与回滚

```powershell
docker compose stop            # 停止容器，数据保留
docker compose down            # 删除容器，数据卷保留
docker compose down -v         # ⚠️ 连数据一起删除（本地数据全清）
```

---

## 附：需要回传给谁 / 留什么证据

| 证据 | 位置 |
|---|---|
| 验收报告 | `evals/reports/F-01-accept.txt` |
| doctor 输出 | `evals/reports/F-01-doctor.txt` |
| 启动计时 | 上面的 `setup 耗时: N 秒` 输出 |
| 幂等证据 | `.env` 哈希对比输出 + `count(*) = 1` 结果 |
| 表结构 | `evals/reports/F-01-tables.txt` |
| 可替换性 | 阶段 3 方案 B 的 `.env` 配置片段（**记得脱敏 Key**） |
| 填写后的评分卡 | 复制 §5.2 表格填好后附在报告末尾 |

全部完成后，把总分与结论告诉我即可继续 I1。
