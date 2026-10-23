# F-01 验收报告：工程地基与 Provider 适配层

| 项 | 内容 |
|---|---|
| **验收对象** | 增量 **I0**，功能规范 [F-01](../spec/features/F-01-bootstrap.md) |
| **验收日期** | 2026-10-21 |
| **执行人** | 项目所有者（真实环境执行） + 自动化代理（离线自动验收） |
| **验收依据** | [F-01 §4 验收评分](../spec/features/F-01-bootstrap.md)（4 条红线 + 13 条 AC + 100 分评分卡） |
| **执行手册** | [acceptance-guide-F01.md](acceptance-guide-F01.md)（5 阶段） |
| **结论** | ✅ **通过（90 / 100）**，红线 4/4 成立，放行进入 I1 |

---

## 1. 结论摘要

- **4 条红线全部成立**（密钥不泄漏、setup 不破坏数据、业务代码零厂商 SDK、出站仅限配置域名）。
- **自动可验部分 75 / 75 满分**；环境验证与人工评分 **15 / 25**。
- **137 个自动化测试全绿**，`lint` 0 problem，`typecheck` 0 error。
- 真实环境验证：数据层一键启动 **5.3s**（门槛 10 分钟）；迁移在真实 Postgres 上两次全绿；真实模型连通 **252ms**、能力探测 `source=probe`；幂等验收 **8/8**。
- 过程中发现并修复 **11 个真实缺陷**，其中 6 个只有连上真实环境才会暴露（详见 §7）。
- **遗留项不影响放行**（RLS 多账号、7 provider 逐一连通、同学盲测），已列入 §10。

---

## 2. 验收方法：三层结构

| 层 | 覆盖内容 | 手段 | 结果 |
|---|---|---|---|
| **L1 离线可验（自动）** | 逻辑正确性、契约、安全策略、错误分类、降级链 | `npm run accept`、`npm test`、`npm run verify:model` | ✅ 75/75 + 137/137 + 8/8 |
| **L2 环境验证（真实栈）** | SQL 语义、容器时序、迁移幂等、真实网络连通、工具链 | `npm run setup`、`npm run doctor`、`npm run verify:idempotency` | ✅ 全部通过 |
| **L3 人工评分** | 一键启动体验、可替换性实证、第三方盲测 | 本人执行 + 计时 + 主观判定 | 🟡 15/25 |

> **分层的必要性**（本次验收实证）：6 个缺陷只能被 L2 发现——SQL 在纯 Postgres 上的语义、
> Docker Desktop 的端口转发行为、PS 5.1 的编码转换、ESLint 的 parser 配置。
> L1 全绿并不代表"能跑"，只代表"逻辑符合契约"。

---

## 3. 环境矩阵

| 项 | 版本 / 状态 |
|---|---|
| OS | Windows（PowerShell 5.1 + Docker Desktop） |
| Node.js | v24.17.0（原生 TypeScript 类型剥离） |
| Docker | client 29.9.1 / Compose v5.6.0 / daemon 正常 |
| 数据层 | `pgvector/pgvector:pg16`，端口 54322，healthy |
| 依赖 | `npm install` 成功（312 packages） |
| 模型 | DeepSeek `deepseek-chat`（BYOK，真实 Key） |

---

## 4. 评分卡（100 分）

| # | 维度 | 权重 | 得分 | 证据 |
|---|---|---|---|---|
| 1 | 适配层可替换性 | 20 | **20** | AC-3 三配置解析断言 + AC-13 纯净度（含违规夹具反向验证） |
| 2 | 降级链完整性 | 20 | **20** | L0–L4 全路径用例 + AC-6 零网络请求 + AC-7 能力自学习 |
| 3 | 安全与隐私 | 15 | **15** | AC-8 私网拒绝 / AC-9 密钥不回读 / AC-10 白名单 / 脱敏用例 |
| 4 | 可诊断性 | 10 | **10** | `doctor` 11 项检查，真实环境 0 失败 0 提示 |
| 5 | 工程规范 | 10 | **10** | `lint` 0 problem + `typecheck` 0 error + 137 测试 + CI 配置 |
| 6 | 一键启动 · 干净机器启动 | 10 | **10** | 全新数据卷一次成功；幂等重跑 **5.3s** |
| 7 | 一键启动 · 可替换性实证 | 7 | **5** | 真实 provider 连通 ✅（3）；换 provider 无需改代码 ✅（2）；非预设端点真实连通 ⬜（2） |
| 8 | 一键启动 · 第三方盲测 | 8 | **0** | 未执行（不构成放行阻塞项） |
| | **合计** | **100** | **90** | **≥85 → 通过** |

> 第 7 项的 2 分可通过一个 2 分钟测试补齐（`LLM_PROVIDER=custom` 指向 DeepSeek 端点跑通 `doctor`）；
> 第 8 项需找一位同学仅凭 README 独立安装。两项补齐后为满分 100。

---

## 5. 红线检查（任一失败即不通过）

| 红线 | 结果 | 判定依据 |
|---|---|---|
| ① 密钥/原文不泄漏进日志/响应 | ✅ | 4 类形态脱敏 + 错误对象 + `describeEnv` 均无明文；真实 `doctor` 输出不含 Key |
| ② `setup` 破坏已有数据 | ✅ | 幂等验收 AC-2.2/2.3/2.4/2.5 全过；迁移无 `DROP TABLE`/`TRUNCATE`（静态测试固化） |
| ③ 业务代码引用厂商 SDK | ✅ | 纯净度扫描 0 违规；ESLint `no-restricted-imports` 双保险；违规夹具可被稳定抓出 |
| ④ 出站出现未授权域名 | ✅ | 白名单在请求发出前拦截；私网地址默认拒绝（AC-8/AC-10） |

---

## 6. 验收项逐条结果

### 6.1 AC-1 一键启动（拆分为 1a / 1b）

| 项 | 结果 | 证据 |
|---|---|---|
| **AC-1a** 数据层一键就绪 ≤10 分钟 | ✅ | 全新数据卷一次成功；`pg_isready` 探测 12 次 ≈ initdb 实际耗时；幂等重跑 **5.3s** |
| **AC-1b** 页面可打开 | ⏳ 移交 I1 | Web 层属 F-02；`setup` 对 `/api/health` 报 ⚠️ 且退出码 0（设计预期） |

> 口径说明：计时区分"镜像已缓存"（≈5s）与"干净机器首次拉镜像"（另加数分钟，取决于网络）。
> 本次记录的 5.3s 属镜像已缓存场景，两种口径均远低于 10 分钟门槛。

### 6.2 AC-2 幂等（脚本化验收）

`node scripts/verify-idempotency.mjs` → **✅ 8/8 项断言成立**

| 断言 | 结果 |
|---|---|
| AC-2.1 两次 `setup` 均退出码 0 | ✅（3.3s / 2.9s） |
| AC-2.2 已有数据未丢失（测试行仍在） | ✅ |
| AC-2.3 `jobs` 总行数 = 基线 +1 | ✅ |
| AC-2.4 `users` 行数不变（播种未重复） | ✅ |
| AC-2.5 `.env` 逐键比对，已有值未覆盖 | ✅（10 个键全部保持） |
| AC-2.6 `schema_migrations` 未重复记录 | ✅ |
| 清理 | ✅ 现场已恢复 |

### 6.3 其余验收项

| 项 | 结果 | 证据 |
|---|---|---|
| AC-3 换模型只改 `.env` | ✅ | deepseek / qwen / custom 三种配置解析出不同 `baseUrl` 与 `model` |
| AC-4 Key 校验前置 | ✅ | 401/403 → `probe` 返回 `ok=false`；**真实** Key 连通 252ms |
| AC-5 不可达提示可操作 | ✅ | 提示含 `LLM_BASE_URL` 与 `ALLOW_PRIVATE_BASE_URL`；404 提示模型名 |
| AC-6 无密钥可用 | ✅ | L4 规则模式返回结果，**零网络请求**，带引导横幅 |
| AC-7 能力探测与降级 | ✅ | 不支持 tool calling 时自动走 Prompt-JSON 并记忆；真实探测 `source=probe` |
| AC-8 私网保护 | ✅ | 默认拒绝并给出开启方式；显式开启后 Ollama 地址通过 |
| AC-9 密钥不回读 | ✅ | `status()` 输出不含明文 Key |
| AC-10 出站白名单 | ✅ | 放行配置域名、拦截未知域名（真实 `.env` 白名单 = `api.deepseek.com`） |
| AC-11 认证可选 | ✅ | 单用户固定归属 ID；`ENABLE_AUTH` 两态均有断言 |
| AC-12 doctor 可诊断 | ✅ | 真实环境 11/11（0 失败 0 提示），每项带修复建议 |
| AC-13 适配层纯净度 | ✅ | 扫描 + 违规夹具反向验证（防止"目录不存在导致真空通过"） |

### 6.4 数据库与迁移（真实 Postgres）

| 项 | 结果 |
|---|---|
| 表 | 6 张：`users` / `jobs` / `experiences` / `user_llm_credentials` / `llm_usage_logs` / `schema_migrations` |
| 视图 | 1 个：`llm_credentials_summary`（脱敏，供设置页读取） |
| 迁移记录 | `schema_migrations` 2 行 |
| 单用户播种 | `users` 1 行，`id=00000000-…-0001`、`deploy_mode=local` |
| 重复执行 | 两次全量重放无错误、无重复记录 |

---

## 7. 缺陷台账（11 项，全部已修复）

### 7.1 逻辑层（5 项，单元测试发现）

| # | 缺陷 | 影响 | 修复 |
|---|---|---|---|
| 1 | 脱敏静默失效：`String.replace` 回调参数随捕获组数量变化，把 `offset` 当 `$1` | 密钥未脱敏且原文被复制一份 | 表驱动 + 显式替换模板 |
| 2 | base64 密钥漏脱敏（`\b` 在 `=` 后不成立） | 长密钥可泄漏 | 改用无边界字符类 |
| 3 | `token=` 形态未覆盖 | 覆盖面缺口 | 规则与用例双向补齐 |
| 4 | `mergeCapabilities` 硬编码 `source:'declared'` | 探测结果被标错 | 显式传入优先 |
| 5 | 测试夹具复用 `Response`（body 只能消费一次） | 重试路径误报 `unreachable` | 每次 `.clone()` |

### 7.2 环境层（6 项，只有真跑才暴露）

| # | 缺陷 | 影响 | 修复 |
|---|---|---|---|
| 6 | 迁移混入 Supabase 专有语法（`to authenticated` / `auth.uid()`） | 精简 Postgres 栈下 0001 中止 → 0002 从未执行，容器却显示 healthy | 改为按环境守卫的 `DO` 块 + 静态回归测试 |
| 7 | 就绪判定用 TCP 探测 | Docker Desktop 提前接受 TCP → 迁移抢跑报 socket 不存在 | 容器内 `pg_isready` + 按 psql 退出码重试 |
| 8 | ESLint 漏配 TypeScript parser | 24 个 `Parsing error`（误判为业务代码问题） | 改用 `@typescript-eslint/parser`，不使用 recommended 预设 |
| 9 | 测试代码解构破坏判别联合收窄 | 15 个 typecheck 错误 | 先断言 `ok` 再取 `service`（11 处） |
| 10 | 验收脚本先清理后断言（`finally` 顺序） | 判出 2 项假失败，证据被自己删除 | 断言移入 `try`、清理留在 `finally` |
| 11 | 报告落盘双重乱码（PS 5.1 UTF-8→GBK→UTF-16LE） | 证据文件不可逆损坏 | 脚本 `--report` 直接写 UTF-8，不依赖 shell 重定向 |

> **教训**：#10 尤其值得记录——验收脚本存在的理由就是"证据不被清理步骤销毁"，却自己犯了同样的错。
> 这类"验收工具自身出错"最危险：既能把合格判成不合格，也能反过来把不合格判成合格。
> 因此所有验收脚本现在都支持 `--report`（结论落盘、可复查），并把"断言必须在清理之前"写入注释。

---

## 8. 交付物清单

### 8.1 代码（34 文件 / 约 5,600 行）

| 模块 | 文件数 | 行数 | 内容 |
|---|---|---|---|
| `src/lib/llm/` | 8 | 1,603 | 适配层：types / registry / guard / openai-compatible / capabilities / rules / degrade / index |
| `src/lib/`（根） | 3 | 486 | `env.ts`（环境契约）/ `errors.ts`（错误分类+脱敏）/ `tenant.ts`（权限模式） |
| `scripts/` | 9 | 1,535 | setup / doctor / migrate / run-tests / check-adapter-purity / accept / verify-model-errors / verify-idempotency / lib/purity |
| `tests/` | 11 | 1,634 | 137 个用例 + 违规夹具 |
| `supabase/migrations/` | 2 | 222 | 0001 表结构 / 0002 凭证与用量（均幂等） |

### 8.2 工程与配置

`package.json`（含 9 个验收/维护命令）、`tsconfig.json`、`eslint.config.mjs`（含厂商 SDK 禁令）、
`.env.example`（14 项）、`.github/workflows/ci.yml`（零依赖检查 + 全量检查双 job）、
`docker-compose.yml`、`Dockerfile`、`start.bat`、`setup.sh`、`.gitignore`。

### 8.3 文档（17 个 markdown / 2,697 行）

| 文档 | 作用 |
|---|---|
| `README.md` | 快速开始、命令一览、验收方式、安全隐私 |
| `docs/acceptance-guide-F01.md` | 5 阶段手动验手册（含失败对照表、乱码成因） |
| `docs/acceptance-report-F01.md` | 本报告 |
| `docs/adr/0001,0003,0007` | 本地栈选型 / 本地优先部署 / BYOK 适配层 |
| `spec/features/F-01-bootstrap.md` | 功能规范 + §5 实现状态 + §5.5 缺陷台账 + §5.6 实测结果 |

### 8.4 验收证据

| 文件 | 内容 |
|---|---|
| `evals/reports/F-01-accept.txt` | 红线 + 13 AC + 评分卡（75/75） |
| `evals/reports/F-01-doctor.txt` | 11 项体检（真实模型连通 252ms、`source=probe`） |
| `evals/reports/F-01-idempotency.txt` | 幂等断言 8/8 + 两次 setup 完整输出 |

---

## 9. 代码验收的成果：这套地基现在能做什么

### 9.1 可直接复用的能力（F-02 起不再重造）

| 能力 | 接口 | 下游价值 |
|---|---|---|
| 换模型零改码 | `createLLM(env)` | 用户只改 `.env` 即可切换 7 个预设 / 任意 OpenAI 兼容网关 |
| 结构化抽取带降级 | `service.run({ messages, schema, rulesFallback })` | 一次调用拿到 `{ level, status, data, banner }`，UI 直接渲染横幅 |
| 错误分类与重试 | `ProviderError`（7 类 kind） | 401/429/5xx/超时/404 各有既定处置，不再散落 try/catch |
| 能力探测与缓存 | `service.probe()` + 24h 缓存 | 弱模型自动走 Prompt-JSON，不必假设所有模型都支持 tool calling |
| 无密钥可用 | L4 规则抽取（`rules.ts`） | 用户不配 Key 也能用，字段全部标"待确认" |
| 安全边界 | `EgressGuard` + `checkBaseUrl` | 白名单/私网拒绝在请求发出前生效 |
| 密钥不落地明文 | `redactSecrets` + 密文列 + 脱敏视图 | 日志、响应、doctor 输出均无明文 |
| 一键就绪 | `setup` / `doctor` / `migrate` | 用户 ≤10 分钟从 clone 到数据层可用 |

### 9.2 对 I1（F-02 JD 入库闭环）的支撑

F-02 需要的三个前置能力**已全部就位**：

1. **抽取调用点**：`service.run<JdStructured>({ schema, rulesFallback })` —— schema 用零依赖 `SchemaLike` 契约，联网后可平移 Zod；
2. **降级路径**：L3/L4 已能返回"可用的最小结果 + 全部待确认"，JD 入库不会因子模型故障而白屏；
3. **入库表与约束**：`jobs` 表含 18 字段一等列、`jd_structured`、`review_flags`、指纹唯一索引、组合字段约束。

I1 只需补：清洗分段 → 抽取 prompt → K=3 自一致性 → 校验 → 入库 → 预览页，**无需改动适配层**。

### 9.3 已守住的非目标

- 业务代码**零厂商 SDK**（红线③，双保险：ESLint + 脚本）
- 不做托管多租户、不存用户数据（ADR-0003）
- 不自动投递、不爬取非公开数据
- 核心零运行时依赖（Node 24 直接执行 `.ts`，无网络也能测）

---

## 10. 遗留项与风险（不影响放行）

| # | 项 | 状态 | 处置 |
|---|---|---|---|
| 1 | AC-1b 页面可打开 | ⏳ | 随 F-02 落地后补验 |
| 2 | RLS 多账号隔离 | ⏳ | 需 `supabase start` + `ENABLE_AUTH=true`；策略已就绪（环境守卫） |
| 3 | 7 个预设 provider 逐一真实连通 | 🟡 1/7（DeepSeek） | 逐家填 Key 跑 `npm run doctor`；预设表可能随厂商调整而过时 |
| 4 | 同学盲测（8 分） | ⬜ | 不阻塞放行；建议 F-02 有页面后补做（盲测范围到"setup + doctor 全绿"） |
| 5 | 可替换性实证剩余 2 分 | ⬜ | 2 分钟：`LLM_PROVIDER=custom` 指向 DeepSeek 端点跑通 `doctor` |
| 6 | `npm audit` 7 个告警（1 moderate / 6 high） | 🟡 | 多为 next/eslint 传递依赖；**勿用 `npm audit fix --force`**；F-02 引入 schema 层时统一升级 |
| 7 | 中文环境编码 | ✅ 已规避 | 验收脚本统一 `--report`（UTF-8）；psql 证据用 `docker cp` 或设 `[Console]::OutputEncoding` |

---

## 11. 放行决定

**F-01 验收通过（90 / 100），红线 4/4 成立，批准进入 I1（F-02 JD 入库闭环）。**

**进入 I1 前必办（3 项，合计 ≤10 分钟）**

1. `npm run verify:idempotency` 的结论行已留档（✅ 已完成）；
2. 补做 `custom` 端点连通（+2 分，同时验证"非预设 provider 可用"这一对外承诺）；
3. 更新 README「已实现与验证」表格中 AC-1/AC-2 的状态为已验。

**I1 首日建议**

- 先把 `SchemaLike` 契约接上 Zod（联网后），确保 prompt 校验与运行时校验同源；
- 建立 `evals/` 的 Prompt 评测基线（Promptfoo），F-02 的抽取准确率门是宏平均 ≥80%；
- 保持"适配层不变"：F-02 不许在业务代码里出现 `fetch` 或厂商 SDK。

---

## 12. 附录

### 12.1 复现命令（按序执行）

```powershell
# L1 离线
npm run accept                                   # 75/75
npm test                                         # 137/137
npm run verify:model                             # 8/8
npm run lint ; npm run typecheck                 # 0 problem / 0 error

# L2 真实环境
npm run setup                                    # ≤10 分钟（实测 5.3s，镜像已缓存）
npm run db:migrate                               # 幂等重放
npm run doctor                                   # 11/11
npm run verify:idempotency -- --report evals\reports\F-01-idempotency.txt

# 证据留档（一律用 --report，不要用 PowerShell 的 *>）
node scripts/accept.mjs --report evals\reports\F-01-accept.txt
node scripts/doctor.mjs --report evals\reports\F-01-doctor.txt
```

### 12.2 术语

| 术语 | 含义 |
|---|---|
| L0–L4 | 降级链：tool calling / Prompt-JSON / SchemaError / 规则模式（有 Key 异常）/ 规则模式（无 Key） |
| AC | 验收标准（Acceptance Criteria） |
| BYOK | Bring Your Own Key，用户自带模型 API Key |
| DoD | Definition of Done |
| I0 / I1 | 增量 0（工程地基）/ 增量 1（JD 入库闭环） |

---

**签署**

| | |
|---|---|
| 验收执行 | 项目所有者 · 2026-10-21 |
| 自动化验收 | 代理（离线 75/75、137 测试、8/8 错误路径） |
| 结论 | ✅ 通过，进入 I1 |
