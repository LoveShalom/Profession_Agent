# F-01 工程地基与 Provider 适配层

> 本节即"功能规范"正文，结构遵循 [_TEMPLATE.md](_TEMPLATE.md)。四节齐全，可直接开工。
> 这是**项目的第一个功能规范**：它是基础设施类功能，但对使用者的价值同样可被验收——"一条命令跑起来、换模型只改配置、没有密钥也能用"。

## 0. 元信息

| 项 | 内容 |
|---|---|
| 编号 / 名称 | **F-01 工程地基与 Provider 适配层**（一键启动 + 多模型可插拔 + 数据只落本机） |
| 所属增量 | **I0**（工程地基，见 [roadmap.md](../roadmap.md) §3） |
| 优先级 | P0（一切增量的前置） |
| 关联功能编号 | **T1**（一键启动脚本）、**B4**（LLM 调用封装 / 适配层）、**B17**（适配层部分；密钥加解密与用量面板留 I2/P5）、**B15**（数据层约束）、**A12**（Provider 能力探测与降级链）、B1（可选认证，本增量仅做开关） |
| 关联 ADR | [ADR-0001](../tech_stack.md#4-ai-native-开发工具链)（Supabase 本地栈）、ADR-0003（本地优先 vs 托管多租户）、ADR-0007（BYOK 与 Provider 适配层） |
| 依赖 | 无（第一个增量） |
| 负责人 / 状态 | 【待填】 / ⬜ 未开始 |
| 估时 | **12h**（与 [roadmap.md](../roadmap.md) §5 的 I0 预算一致，对账见 §3.3） |

**一句话定义**：让任何一台装了 Docker 的机器，用**一条命令**跑起整套系统；之后**只改配置**就能换成自己的大模型（含 Ollama 全离线），没有密钥也不会白屏。

---

## 1. 功能规格与分支

### 1.1 用户故事

**终端使用者视角**
- **US-1**：作为使用者，我 clone 仓库后只跑一条命令，就能在浏览器打开系统，不需要懂数据库、不需要注册账号。
- **US-2**：作为使用者，我只改 `.env` 里的 provider / base_url / model，就能换成我自己的模型服务（含本地 Ollama）。
- **US-3**：作为使用者，我把 API Key 填错时，希望**在保存阶段**就被明确告知（401 / 不可达），而不是等到第一次抽取才失败。
- **US-4**：作为没有配置模型的用户，我希望系统仍能启动并给出引导，而不是白屏或崩溃。
- **US-5**：作为重视隐私的使用者，我希望确认除了我配置的模型服务商之外，没有任何数据外发。

**开发者视角**（本项目由 AI 辅助开发，适配层的可替换性是核心约束）
- **US-6**：作为开发者，我希望业务代码里**不出现任何厂商 SDK 名称**，新增一个 provider 只改配置和一处注册表。
- **US-7**：作为开发者，我希望环境变量在启动时就被校验，而不是在运行时抛 `undefined`。

### 1.2 输入 / 输出契约

**A. 环境契约（`.env.example`）**

| 变量 | 必填 | 默认 | 校验规则 |
|---|---|---|---|
| `DATABASE_URL` | 是（模板预填） | 本地栈默认值 | 连接成功才算通过 |
| `ENCRYPTION_KEY` | 是（setup 自动生成） | — | base64，解码后 32 字节 |
| `NEXT_PUBLIC_APP_URL` | 否 | `http://localhost:3000` | 合法 URL；影响 MCP/回调 |
| `LLM_PROVIDER` | 否 | `deepseek` | 枚举：deepseek / qwen / kimi / glm / siliconflow / openai / ollama / custom |
| `LLM_BASE_URL` | 否 | 按 provider 内置 | URL；**私网地址需** `ALLOW_PRIVATE_BASE_URL=true` |
| `LLM_API_KEY` | 否 | 空 | 空 = 规则模式（不视为错误） |
| `LLM_MODEL` | 否 | 按 provider 内置 | 非空字符串 |
| `LLM_MODEL_EXTRACT` / `_GENERATE` / `_EMBED` | 否 | 继承 `LLM_MODEL` | 任务级模型偏好 |
| `LLM_SAMPLE_K` | 否 | `3` | 整数 1–5（自一致性采样次数，见 F-02） |
| `EMBEDDING_PROVIDER` / `EMBEDDING_MODEL` | 否 | 空 | 空 = 检索降级为 `tsvector` |
| `ENABLE_AUTH` | 否 | `false` | 布尔；`false` = 本地单用户（不阻断） |
| `ALLOW_PRIVATE_BASE_URL` | 否 | `false` | 布尔；`true` 才允许 127.0.0.1 等私网端点 |
| `LANGFUSE_*` | 否 | 空 | 空 = 关闭遥测（本地默认关闭） |

**B. 命令契约**

| 命令 | 语义 | 幂等 | 退出码 |
|---|---|---|---|
| `npm run setup` | 探测环境 → 生成 `.env`（若无）→ 生成 `ENCRYPTION_KEY` → 拉起容器 → 跑 migration → 健康检查 → 打印访问地址 | **是**（不重置数据、不覆盖已有 `.env` 值） | 0 成功；2 前置条件不满足（如无 Docker）；1 运行失败 |
| `npm run doctor` | 体检：Docker / 端口 / DB / `.env` 完整性 / 凭证连通性 / 出站白名单 | 是（只读） | 0 全部通过；1 有失败项 |
| `npm run dev` / `build` | 常规开发与构建 | — | — |
| `--no-pull` 参数 | 跳过镜像拉取（离线/已预热场景） | — | — |
| `--port <n>` 参数 | 覆盖默认端口 | — | — |

**C. 代码契约（适配层，不暴露厂商名）**

```ts
interface ProviderAdapter {
  chat(messages, opts): Promise<string>
  chatJSON<T>(messages, schema: ZodSchema<T>, opts): Promise<T>   // 内部完成校验 + 修复重试
  embed(texts: string[]): Promise<number[][]>                     // 未配置时抛 CapabilityError
  capabilities(): Capabilities                                    // 来自探测缓存
  probe(): Promise<ProbeResult>                                   // 冒烟校验（保存凭证时调用）
}

interface Capabilities {
  tool_calling: boolean; json_schema: boolean; stream: boolean
  embedding: boolean; context_window: number; max_output: number
}

type ProviderError =
  | { kind: 'auth'; status: 401 | 403 }        // AuthError
  | { kind: 'rate_limit'; retryAfter?: number } // RateLimitError
  | { kind: 'unreachable'; cause: string }      // UnreachableError
  | { kind: 'capability'; missing: keyof Capabilities }
  | { kind: 'schema'; raw: string; attempts: number }
```

**D. 数据契约**

| 对象 | 契约 |
|---|---|
| `llm_usage_logs` | 每次调用写一条：`provider / model / task / prompt_tokens / completion_tokens / cost_estimate / latency_ms / cache_hit / degraded(boolean)` |
| `user_llm_credentials` | 本地模式可空；写入时 `encrypted_api_key` + `key_last4` + `capabilities` + `status`；**永不回读明文** |
| `users` | 本地单用户模式：只写一行固定标识（不强制登录）；`ENABLE_AUTH=true` 时才走 Supabase Auth |
| 出站白名单 | 允许的域名集合 = 用户配置的 provider 域名（+ 可选的 LangFuse）；其余出站一律不允许 |

### 1.3 分支与变体矩阵

**A. 环境与启动分支**

| 分支 | 检测方式 | 行为 | 用户可见结果 |
|---|---|---|---|
| 干净机器但无 Docker | setup 前置检查 | 中止，退出码 **2** | 明确报错 + 各平台安装链接 |
| 有 Docker、无 `.env` | 文件检查 | 从模板生成 + 生成 `ENCRYPTION_KEY` | "已生成 .env，模型可稍后配置" |
| `.env` 存在但缺必填 | Zod 校验 | 列出缺失/非法项，**不覆盖已有值** | 逐项指出并给出示例 |
| 端口被占用（3000 / 5432） | 端口探测 | 报错并打印占用进程；支持 `--port` | "端口 3000 被占用，可用 `--port 3001`"；**不静默换端口** |
| 数据卷已存在 | 卷检查 | **幂等**：不重置数据，只跑增量 migration | "检测到已有数据，跳过初始化" |
| migration 失败 | 退出码非 0 | 打印最后 20 行日志 + 建议跑 `doctor`；**不继续启动** | 明确失败原因 |
| 系统代理 / 企业网络 | 环境变量检测 | 提示代理配置位置；镜像拉取走系统代理 | 提示文案 |
| 无法拉取镜像（离线） | 拉取失败 | 提示 `--no-pull` + 离线镜像安装说明 | 文档指引 |
| 平台差异 | `process.platform` | Windows → `start.bat`；macOS/Linux → `setup.sh`；行为一致 | 两条等价入口 |
| 中途 Ctrl+C | 信号处理 | 不留半初始化状态（migration 单事务） | 可安全重跑 |

**B. 模型接入分支**

| 分支 | 判定 | 行为 |
|---|---|---|
| 预设 provider（7 个） | `LLM_PROVIDER` 枚举 | 使用内置 base_url 与默认模型名 |
| 自定义 base_url（含 one-api / new-api / OpenRouter 中转站） | `provider=custom` 或显式覆盖 | **本地模式允许**；写入前做 probe |
| 私网 base_url（Ollama / vLLM） | URL 落在私网段 | 默认**拒绝**；仅 `ALLOW_PRIVATE_BASE_URL=true` 时放行（AC-8） |
| 未配置 Key | `LLM_API_KEY` 为空 | **视为合法状态**：系统正常启动，AI 功能显示配置引导，抽取走规则模式 |
| Key 无效 | probe 返回 401/403 | `AuthError`：保存阶段拒绝写入，提示"Key 无效或权限不足" |
| 端点不可达 | probe 超时 / DNS 失败 | `UnreachableError`：保存阶段拒绝，提示检查 base_url / 网络 / 代理 |
| 限流 | 调用返回 429 | 指数退避 2 次 → 仍失败则降级（L3）并在用量日志标 `degraded=true` |
| 模型不支持 `tool_calling` | probe 结果 | `capabilities.tool_calling=false` → 强制走 Prompt-JSON（L1） |
| 模型不支持 `json_schema` | probe 结果 | 走 Prompt-JSON + Zod 修复重试 ≤2 |
| 上下文窗口过小（<8k） | probe 结果 | 警告 + 超长输入直接分段；标记"能力受限" |
| Embedding 未配置 | 配置为空 | 向量检索降级为 `tsvector` 关键词检索（不报错） |

**C. 降级链（业务侧统一可见，贯穿所有 AI 功能）**

| 层级 | 条件 | 行为 | UI 表现 |
|---|---|---|---|
| **L0** 主路径 | 有 Key + 支持 FC | Function Calling + JSON Schema | 无提示 |
| **L1** | 无 `json_schema` / 不支持 FC | Prompt-JSON + Zod + 修复重试 ≤2 | 无提示（内部事件可查） |
| **L2** | L1 修复仍失败 | 抛出 `SchemaError`，由调用方决定重试或降级 | 该条功能显示"解析失败，请手动补全" |
| **L3** | Key 失效 / 429 耗尽 / 不可达 | 规则抽取（正则 + 词表）+ 全字段待确认 | 顶部横幅"模型不可用，已切换规则模式" |
| **L4** | 未配置 Key | 规则抽取 | 引导"配置模型可自动抽取" |

**D. 数据层与权限分支**

| 分支 | 条件 | 行为 |
|---|---|---|
| 本地单用户（默认） | `ENABLE_AUTH=false` | 不阻断访问；写入固定单用户标识；**不启用 RLS** |
| 多账号 | `ENABLE_AUTH=true` | 启用 Supabase Auth（邮箱/密码）+ RLS（策略见 tech_stack §9.3） |
| 凭证写入 | 有 Key | AES-256-GCM 密文 + `key_last4`；**只写不回读**（AC-9） |
| 凭证轮换 | 用户更换 Key | 覆盖密文，保留 `llm_usage_logs.credential_id` 历史 |
| 能力缓存 | 已探测 | `capabilities` 落库，24h 过期或手动重探 |
| 遥测 | `LANGFUSE_*` 为空 | 完全关闭外发；`doctor` 可验证 |

**E. 失败与恢复分支**

| 分支 | 行为 |
|---|---|
| DB 连接失败 | 重试 3 次（1s/2s/4s）→ 仍失败：分类报错 + `doctor` 建议 |
| 容器启动失败 | 分类（端口 / 镜像 / 资源）报错；`--verbose` 输出完整日志 |
| 环境变量非法 | 启动即失败并打印**全部**非法项（不是第一个） |
| 重复执行 setup | 幂等：跳过已完成步骤，只补增量（AC-2） |

### 1.4 状态与流转

```text
环境：not_initialized ──setup──> initializing ──成功──> ready
                                    └──失败──> failed（可重入；幂等，不破坏已有数据）

凭证：untested ──probe 通过──> active
            └──probe 401/403──> invalid（保存被拒，不落库）
能力：unknown ──probe──> cached（24h）──过期/手动──> unknown

降级等级：L0 → L1 → L2 → L3 → L4（单向；恢复需重新 probe 或用户操作）
```

不允许的流转：`failed → ready` 未经 setup；`invalid → active` 未经重新 probe。

### 1.5 边界与非目标

- **非目标**：K8s / 远程服务器部署、多机集群、托管多租户、模型微调、向量库替换、模型"市场"页面、自动选择最便宜模型。
- **边界**：一键启动只承诺 Docker 可用；Windows 家庭版 / Hyper-V 端口冲突只给文档说明，不做自动修复。
- **明确不做**：把 provider SDK 直接引入业务代码（lint 规则强制拦截，见 §4.1）。

---

## 2. 收集需求

### 2.1 需求来源与方法

| 来源 | 方法 | 产出 | 时间盒 |
|---|---|---|---|
| 自身环境 | 在 **2 台机器**（Windows 主力 + 一台干净环境/WSL）实跑 `setup`，记录每一步耗时与卡点 | 阻塞点清单 + 首次启动耗时基线 | 45 min |
| 目标用户 | 找 **1 位非本项目同学**，只给 README 让他独立安装，全程观察但不指导 | 门槛清单（卡在哪一步、什么话看不懂） | 30 min |
| 平台约束 | 查 Docker Desktop 版本要求、镜像体积、端口冲突概率、企业网络/代理限制 | 约束表（写进 README 前置条件） | 30 min |
| Provider 文档 | 逐个核对 7 个预设 provider 的 base_url、模型名、是否支持 FC / json_schema、计费口径 | **provider 矩阵**（落进 `tech_stack.md` §3.3） | 45 min |
| 对标项目 | 参考 supabase CLI / Ollama 的安装引导体验，定"一条命令"的体验基线 | 体验基线（≤10 分钟、≤3 步） | 30 min |

**合计约 3h**，在 I0 首日完成；产出直接决定 §1.3-A 的分支清单与 README 内容。

### 2.2 验收场景（Given / When / Then）

- **AC-1 干净机器一键启动**：Given 一台只装了 Docker 的机器，When 运行 `npm run setup`，Then **≤10 分钟**内打印可访问地址，且页面可打开（**未配置 Key 也成功**）。
- **AC-2 幂等**：Given 已初始化环境，When 再次 `setup`（连续 3 次），Then 数据不丢、`.env` 已有值不被覆盖、只跑增量 migration，结果一致。
- **AC-3 换模型不改代码**：Given 系统运行中，When 只改 `.env` 的 provider/model 并重启，Then 新调用使用新模型（用量日志 `model` 字段变化），**业务代码零改动**。
- **AC-4 Key 校验前置**：Given 填入错误 Key，When 保存凭证或运行 `doctor`，Then 在**保存阶段**返回 401/403 原因，且**不写入凭证**。
- **AC-5 不可达端点**：Given base_url 指向不可达地址，When 保存，Then `UnreachableError` 并给出检查建议（网络/代理/地址拼写）。
- **AC-6 无密钥可用**：Given 未配置 Key，When 启动并触发一次抽取，Then 不报错，走规则抽取，全部字段标记待确认，并显示配置引导。
- **AC-7 能力探测与降级**：Given 一个不支持 `tool_calling` 的模型，When 触发抽取，Then 自动走 Prompt-JSON 且成功（不抛错），`capabilities` 可查。
- **AC-8 私网保护**：Given 未开启 `ALLOW_PRIVATE_BASE_URL`，When base_url 为 `127.0.0.1:11434`，Then 明确拒绝并说明如何开启；开启后 Ollama 可正常使用。
- **AC-9 密钥不回读**：Given 已保存 Key，When 检查任何 API 响应、页面源码与数据库导出，Then 只能看到 `key_last4`，密文不出服务端。
- **AC-10 出站白名单**：Given 完整走一遍主流程，When 抓取出站请求，Then 只出现用户配置的 provider 域名（关遥测时无其他出站）。
- **AC-11 认证可选**：Given `ENABLE_AUTH=false`，Then 无需登录即可用；When 改为 `true` 并重启，Then 出现登录页且数据按用户隔离。
- **AC-12 doctor 可诊断**：Given 任一故障（无 Docker / 端口占用 / DB 不通 / Key 失效 / 环境变量非法），When 运行 `doctor`，Then 分类报错 + 修复建议，退出码非 0。
- **AC-13 适配层纯净**：Given 代码库，When 运行 lint 规则与依赖检查，Then 业务代码（`src/lib/pipeline`、`src/app`）中**零处**引用厂商 SDK；新增一个 provider 只需改配置 + 注册表一处。

### 2.3 非功能需求

| 类别 | 指标 |
|---|---|
| 首次启动 | ≤ **10 分钟**（含镜像拉取）；镜像预热后 ≤2 分钟 |
| 幂等性 | `setup` 连跑 3 次结果一致，**数据零丢失** |
| 适配层纯净度 | 业务代码引用厂商 SDK **0 处**（lint 规则可证） |
| 探测开销 | `probe` ≤5s；结果缓存 24h；不阻塞页面首屏 |
| 安全 | 密钥密文存储 + 只写不回读；日志/遥测脱敏（`sk-`、`Bearer` 等正则 + 字段白名单）；私网默认拒绝 |
| 可观测 | 每次 AI 调用写 `llm_usage_logs`；`degraded` 标记降级发生 |
| 可诊断 | `doctor` 覆盖 5 类故障；错误信息含"下一步怎么做" |
| 文档 | README 写明前置条件（Docker 版本、磁盘、耗时），5 分钟可读懂 |

### 2.4 优先级（MoSCoW）

- **Must**：`setup` 一键启动与幂等、`.env` 模板与启动校验、Provider 适配层接口与 OpenAI 兼容实现、能力探测（A12）、错误分类（401/403/429/不可达/Schema）、无 Key 降级（L4）、数据只落本机、密钥密文与不回读、`llm_usage_logs`、`doctor`。
- **Should**：`ENABLE_AUTH` 开关与可选登录（B1 最小版）、私网开关、能力缓存与手动重探、离线镜像安装说明、出站白名单校验。
- **Could**：设置页里的"一键测试连通性"、多 provider fallback 链的可视化配置。
- **Won't（本期）**：K8s/远程部署、托管多租户、模型市场、自动选最便宜模型、完整注册/找回密码流程。

### 2.5 待澄清问题

| 问题 | 影响 | 默认处理（未澄清时按此执行） |
|---|---|---|
| `setup` 是否自动拉镜像（体积大）？ | 首次耗时与磁盘占用 | **自动拉**，同时提供 `--no-pull` |
| 是否默认开启认证？ | 本地单用户体验 | **默认关闭**（`ENABLE_AUTH=false`） |
| `doctor` 是否执行修复动作？ | 复杂度与风险 | **只诊断不自动改**，给出命令让用户执行 |
| 是否内置多 provider 自动 fallback？ | 配置复杂度 | 本期**不做**，仅做单 provider + 降级链 |

---

## 3. 任务计划

### 3.1 任务分解

| ID | 任务 | 依赖 | 估时 | 产出 | DoD |
|---|---|---|---|---|---|
| **T1** | 仓库骨架：目录树（[tech_stack.md](../tech_stack.md) §4）、tsconfig / ESLint（含"禁止业务代码引用厂商 SDK"规则）、CI 骨架 | — | 2h | 可 `lint` + `typecheck` 的空仓库 | D5 |
| **T2** | Docker Compose（Next.js + Supabase 本地栈）+ `.env.example` + 环境变量 Zod 校验（启动即失败并列出全部非法项） | T1 | 2h | `docker-compose.yml`、`src/lib/env.ts` | D4 |
| **T3** | `npm run setup`（幂等：前置探测 → 生成 `.env`/`ENCRYPTION_KEY` → 拉起容器 → migration → 健康检查 → 打印地址） + `start.bat` / `setup.sh` | T2 | 2h | `scripts/setup.mjs` | D5 |
| **T4** | Provider 适配层：接口 + OpenAI 兼容实现（`chat` / `chatJSON` / `embed`）+ provider 注册表（7 预设 + custom） | T2 | 2h | `src/lib/llm/` | D4 |
| **T5** | **A12 能力探测与降级链**：`probe()`、`capabilities` 缓存、L0–L4 路径与错误分类 | T4 | 2h | `src/lib/llm/capabilities.ts` | D4 |
| **T6** | 私有网保护 + 出站白名单 + `doctor`（Docker/端口/DB/.env/凭证 五类诊断） | T4 | 1h | `src/lib/llm/guard.ts`、`scripts/doctor.mjs` | D4 |
| **T7** | **B15 数据层约束**：migration 框架、本地单用户标识、`ENABLE_AUTH` 开关（B1 最小版：关闭时不阻断；开启时出现登录页） | T2 | 1h | `supabase/migrations/`、`repositories/` | D1 |
| | **I0 内合计** | | **12h** | | |

### 3.2 顺序与里程碑

- **关键路径**：T1 → T2 → T4 → T5 →（T3 可并行）→ 收尾。
- **可并行**：T3（启动脚本）与 T4/T5（适配层）互不阻塞，但 T3 的健康检查依赖 T2 的容器。
- **I0 出口**：AC-1 ~ AC-13 通过 + 评分卡 ≥85 + **I1 可以立刻开工**（能跑起服务、能调用模型）。

### 3.3 工时对账

| 项 | 值 |
|---|---|
| 本规范 I0 内估时 | **12h** |
| [roadmap.md](../roadmap.md) §5 的 I0 预算 | **12h** ✅ |
| **B1 的处置** | 完整认证流程（注册 / 邮箱确认 / SMTP）**移出 I0**，本增量只交付"开关 + 不阻断 + 可选登录页"；完整流程归属 **I2 前段**（此时已有经历库页面，正好一起做权限） |

### 3.4 风险与回退

| 风险 | 触发信号 | 回退动作 |
|---|---|---|
| Supabase 本地栈镜像体积过大 / 拉取慢 | AC-1 超过 10 分钟 | 提供 `--no-pull` + 离线镜像 tar 说明；必要时改用"仅 Postgres + pgvector 容器"精简栈 |
| Windows / WSL 端口与卷权限问题 | 同学盲测卡住 | 文档化两种路径；`doctor` 增加 Windows 专项检查 |
| provider 兼容性差异（不同厂商 base_url 与模型名不一致） | probe 失败率上升 | 维护 provider 矩阵 + 允许 `custom` 兜底；每个预设 provider 至少在 CI 里跑一次冒烟 |
| 降级链路径爆炸（L0–L4 × 各功能） | 测试成本上升 | 降级链实现在适配层统一，业务侧只感知"成功 / 降级 / 失败"三态 |
| 一键启动被安全软件拦截 | 用户反馈 | README 说明；脚本只做本地文件与 Docker 操作，无网络下载（除镜像） |

---

## 4. 如何验收评分

### 4.1 验收清单（逐项可测）

- [ ] **AC-1** 干净机器（仅 Docker）≤10 分钟 `setup` 成功，页面可打开（无 Key 也成功）
- [ ] **AC-2** `setup` 连续 3 次幂等，数据不丢、`.env` 不被覆盖
- [ ] **AC-3** 只改 `.env` 即切换 provider/model；用量日志 `model` 字段随之变化
- [ ] **AC-4** 错误 Key 在**保存阶段**被拒（401/403），不写入凭证
- [ ] **AC-5** 不可达端点被拒，并给出检查建议
- [ ] **AC-6** 无 Key 可启动并完成一次规则抽取，不报错且给出引导
- [ ] **AC-7** 不支持 FC 的模型自动降级到 Prompt-JSON 且成功；`capabilities` 可查
- [ ] **AC-8** 私网 base_url 默认被拒；开启 `ALLOW_PRIVATE_BASE_URL` 后 Ollama 可用
- [ ] **AC-9** 密钥不回读：API 响应 / 页面源码 / 导出数据中只有 `key_last4`
- [ ] **AC-10** 出站白名单：抓包只出现用户配置的 provider 域名（关遥测时无其他出站）
- [ ] **AC-11** `ENABLE_AUTH` 两种模式均可跑通；开启后数据按用户隔离
- [ ] **AC-12** `doctor` 对 5 类故障给出分类诊断与修复建议，退出码非 0
- [ ] **AC-13** lint 规则证明业务代码零处引用厂商 SDK；新增 provider 只改配置 + 注册表
- [ ] **降级链** L0–L4 五条路径都有测试且行为符合 §1.3-C 契约
- [ ] **用量与可观测** 每次调用一条 `llm_usage_logs`，含 `degraded` 标记
- [ ] **脱敏** 抽查 1 条日志/trace，无原文敏感字段与密钥
- [ ] **平台** Windows + （macOS 或 WSL）至少 2 个平台跑通
- [ ] **文档** README 含前置条件、耗时、三平台步骤，5 分钟可读懂

### 4.2 评分卡（100 分）

| 维度 | 权重 | 满分条件 → 0 分条件 | 测量方法 |
|---|---|---|---|
| **一键启动体验** | 25 | 干净机器 ≤10 分钟一次成功、无需手工改配置 → 需要人工介入多步 | 2 台机器实跑 + 1 位同学盲测计时 |
| **适配层可替换性** | 20 | 新增一个 provider 只改配置（≤10 行）→ 需改业务代码 | 代码审查 + 实测新增一个中转站 provider |
| **降级链完整性** | 20 | L0–L4 五条路径均有测试且符合契约 → 任一崩溃 | 固定用例集（含无 Key / 不支持 FC / 429 / 不可达） |
| **安全与隐私** | 15 | 密钥不回读 + 出站白名单 + 脱敏 + 私网默认拒绝 → 任一失败 | AC-8/9/10 + 代码审查 |
| **可诊断性** | 10 | `doctor` 覆盖 5 类故障并给修复建议 → 无 `doctor` | AC-12 |
| **工程规范** | 10 | 目录树 / lint（含 SDK 禁用规则）/ CI / 环境变量校验齐备 → 无 | CI 报告 |
| **合计** | **100** | | |

### 4.3 通过阈值

| 分数 | 结论 | 后续动作 |
|---|---|---|
| **≥85** | 通过 | 立即进入 I1（F-02 JD 入库闭环） |
| **70–84** | 有条件通过 | 扣分项写入 I1 首日必办清单；**不阻塞 I1 开工**（I1 只需"能跑起服务 + 能调模型"） |
| **<70** | 不通过 | 按扣分维度回到 T2/T3/T4 定位重做（通常是环境或适配层问题） |
| **红线（任一即不通过）** | — | ① 密钥或原文泄漏进日志/响应；② `setup` 破坏已有数据；③ 业务代码引用厂商 SDK；④ 出站出现未授权域名 |

### 4.4 证据与留档

| 项 | 位置 / 内容 |
|---|---|
| 启动证据 | 2 台机器的 `setup` 日志与耗时记录 + 1 位同学盲测的观察记录（卡点逐条） |
| 诊断证据 | `doctor` 在 5 类故障下的输出截图（含修复建议） |
| 适配层证据 | "新增一个 provider"的 diff（应 ≤10 行配置 + 注册表 1 行） |
| 安全证据 | 抓包结果（出站域名列表）、密钥不回读的接口响应样例 |
| provider 矩阵 | 7 个预设 provider 的 base_url / 模型名 / FC 支持 / 计费口径表，落进 `tech_stack.md` §3.3 |
| ADR 回填 | ADR-0001、ADR-0003、ADR-0007 补"实际结果"小节（镜像体积、首次耗时、探测结果） |
| 工时偏差 | 实际耗时 vs 12h；偏差 >20% 时写入 `roadmap.md` §4 并触发容量校准 |

---

## 5. 实现状态（2026-10-16，T1–T7 已编码）

> **验收入口（一条命令）**：`npm run accept` → 自动跑 4 条红线 + 13 条 AC + 评分卡，输出可留档报告。
> 自动可验部分满分 **75/75**；AC-1（干净机器 ≤10 分钟）与 AC-2（幂等）需 Docker 环境，报告中标记 ⏭️ SKIP。
> 详见 [README.md](../../README.md) §5「验收方式」。

> 约束说明：当前开发环境**无网络（装不了依赖）、无 Docker**，因此实现遵循"核心零依赖、离线可跑可测"。
> 依赖 Node 22.6+ 的原生 TypeScript 类型剥离，`.ts` 可直接执行，无需构建。

### 5.1 交付物

| 任务 | 产物 | 状态 |
|---|---|---|
| T1 工程骨架 | `package.json`、`tsconfig.json`、`eslint.config.mjs`（含厂商 SDK 禁用规则）、`.gitignore`、`.github/workflows/ci.yml` | ✅ 已交付 |
| T2 环境契约 | `.env.example`（14 项）、`src/lib/env.ts`（声明式 spec + 一次性列出全部非法项 + 错误/警告分级） | ✅ 已交付 |
| T3 一键启动 | `scripts/setup.mjs`（幂等 / `--dry-run` / `--no-pull` / `--port`）、`start.bat`、`setup.sh`、`docker-compose.yml`（pgvector 精简栈）、`Dockerfile` | ✅ 已交付 |
| T4 适配层 | `src/lib/errors.ts`、`src/lib/llm/{types,registry,openai-compatible}.ts` | ✅ 已交付 |
| T5 能力与降级 | `src/lib/llm/{capabilities,rules,degrade,index}.ts` | ✅ 已交付 |
| T6 安全与诊断 | `src/lib/llm/guard.ts`、`scripts/doctor.mjs`、`scripts/{check-adapter-purity,migrate,run-tests}.mjs`、`scripts/lib/purity.mjs` | ✅ 已交付 |
| T7 数据层 | `src/lib/tenant.ts`、`supabase/migrations/0001_init.sql`、`0002_credentials_usage.sql` | ✅ 已交付 |
| 文档 | `README.md`、`docs/adr/0001`、`0003`、`0007` | ✅ 已交付 |

### 5.2 验收清单勾选（离线可验证部分）

- [x] **AC-3** 换模型只改 `.env`：门面从 env 解析 provider/model/地址，含自定义网关与 `EGRESS_EXTRA_HOSTS`
- [x] **AC-4** Key 校验前置：`probe()` 返回 `ok=false` 与修复建议；401 不重试
- [x] **AC-5** 不可达提示：`unreachable.userHint` 含 `LLM_BASE_URL` 与私网开关指引
- [x] **AC-6** 无密钥可用：L4 规则模式，**零网络请求**，字段全部待确认 + 引导横幅
- [x] **AC-7** 能力探测与降级：不支持 tools 时自动切 Prompt-JSON 并记住能力（`source='probe'`）
- [x] **AC-8** 私网保护：默认拒绝，`ALLOW_PRIVATE_BASE_URL=true` 后 Ollama 可用
- [x] **AC-9** 密钥不回读：`status()` / `describeEnv()` / 错误 `raw` 全部经 `redactSecrets`
- [x] **AC-10** 出站白名单：请求发出前拦截，未授权域名零请求
- [x] **AC-11** 认证可选：`resolveTenant` 两种模式，单用户固定归属 ID
- [x] **AC-12** doctor 可诊断：11 项检查 + 修复建议 + 退出码（实测：无 Docker/DB → 2 项 ❌、1 项 ⚠️）
- [x] **AC-13** 适配层纯净度：脚本 + 违规夹具反向验证（防止"目录不存在导致真空通过"）
- [x] 降级链 L0–L4 全部路径有用例；`config` 类错误**不降级**（避免掩盖配置错误）
- [x] 脱敏：7 类密钥形态（`sk-` / Bearer / JSON / URL / AWS / Google / base64）
- [x] 环境契约：一次性列出全部非法项（AC-12 的前置）

### 5.3 待环境验证（不谎报为通过）

| 项 | 阻塞原因 | 验证方式 |
|---|---|---|
| **AC-1** 干净机器 ≤10 分钟启动 | 无 Docker、无网络 | 在有 Docker 的机器执行 `npm run setup` 并计时 |
| **AC-2** setup 幂等 | 同上 | 连续执行 3 次，比对数据与 `.env` |
| 迁移在真实 Postgres 上执行 | 无 Docker | `npm run setup` 后 `npm run db:migrate`；首次由 `docker-entrypoint-initdb.d` 自动执行 |
| RLS 多账号隔离 | 需完整 Supabase 环境 | `supabase start` + `ENABLE_AUTH=true` 后跑双用户用例 |
| 7 个预设 provider 真实连通性 | 无网络 | 逐个填 Key 跑 `npm run doctor`（Provider 兼容性测试） |
| `lint` / `typecheck` | ✅ **已通过**（2026-10-21） | `npm install` 后 `npm run lint`（0 problem）+ `npm run typecheck`（0 error）。修复了两处配置缺陷：① ESLint 漏配 `@typescript-eslint/parser`（24 个 Parsing error）；② 测试里对判别联合的解构破坏类型收窄（11 处）+ `.mjs` 导入缺类型（`allowJs: true`） |

### 5.4 证据

| 项 | 结果 |
|---|---|
| 核心测试 | `node scripts/run-tests.mjs` → **126/126 通过**（9 个测试文件，覆盖 env / errors / registry / guard / adapter / capabilities / rules / degrade / 门面 / 纯净度） |
| 纯净度红线 | `node scripts/check-adapter-purity.mjs` → 通过；6 个业务目录尚未创建时**显式报告**而非静默跳过；违规夹具可被稳定抓出 |
| 自检 | `node scripts/doctor.mjs --no-network` → 11 项，2 ❌（Docker / DB，环境所限）、1 ⚠️（未配 Key，属合法状态） |
| 一键启动 | `node scripts/setup.mjs` → 生成 `.env` 与 `ENCRYPTION_KEY`，在 Docker 前置检查处按契约退出 **2** |
| 测试运行器 | 自研 `scripts/run-tests.mjs`（同进程导入，零 spawn）——规避受限沙箱下 `node --test` 的 EPERM，CI 同样可用 |

### 5.5 过程中修正的真实缺陷（值得记录）

1. **脱敏静默失效**：`String.replace` 回调参数个数取决于正则是否有捕获组；无捕获组时把 `offset` 当 `$1`、整个输入当 `$2`，导致密钥未脱敏且原文被复制一份 → 改为每个模式显式声明替换模板（`errors.ts`）。
2. **base64 密钥漏脱敏**：`\b` 无法在 `=` 后成立边界 → 改用无边界字符类。
3. **`token=` 形态未覆盖**：覆盖面不足 → 规则与用例双向补齐。
4. **能力来源被覆盖**：`mergeCapabilities` 硬编码 `source:'declared'`，把探测结果标记错 → 改为显式传入优先。
5. **测试夹具复用 `Response`**：body 只能消费一次，重试路径读到已消费 body 并误报 `unreachable` → 夹具改为每次 `.clone()`。
6. **迁移混入 Supabase 专有语法**（真实验收首日暴露）：精简 Postgres 栈没有 `authenticated` 角色与 `auth.uid()`，`0001_init.sql` 末尾的 RLS 策略导致整个迁移中止 → 0002 从未执行；容器因 restart 策略重启后变 healthy，表面正常。→ 改为按环境守卫的 `DO` 块（检测 `auth` schema 才建策略）。
7. **就绪判定用 TCP 导致假阳性**：Docker Desktop 会在容器内 Postgres 启动前先接受 TCP 连接，`waitForTcp` 因此误判就绪，迁移抢跑报 `socket ... No such file or directory` → 改用容器内 `pg_isready` + 按 psql 退出码（2=连接失败）重试。
8. **ESLint 漏配 TypeScript parser**：只有 core 规则时，`.ts` 文件被 espree 解析，报 24 个 `Parsing error` → 改用 `@typescript-eslint/parser`；同时不使用任何 recommended 预设（规则面不可控）。
9. **测试代码解构破坏判别联合收窄**：`const { ok, service } = tryCreateLLM(...)` 在判断 `ok` 之前取 `service`，TS 无法收窄 → 改为先断言再取（11 处）。
10. **验收脚本先清理后断言**：`verify-idempotency.mjs` 首版把清理放在 `finally`、断言放在其后，导致"测试行仍在"这项证据被自己删除，判出 2 项假失败。**脚本的存在理由正是"证据不被清理步骤销毁"，却自己犯了同样的错** → 断言移入 `try` 块内、清理留在 `finally`。
11. **验收报告落盘乱码**：PowerShell 5.1 用 GBK 解码 Node 的 UTF-8 输出再写成 UTF-16LE，双重乱码且不可逆 → 脚本支持 `--report` 直接写 UTF-8，不再依赖 shell 重定向。

> 前 5 条由单元测试发现；第 6–11 条**只有连上真实环境（Docker / Postgres / 真实网络 / 真实 ESLint）才会暴露**。
> 这正是 F-01 把"离线可验"与"需环境验证"分开统计的原因：离线测试证明逻辑符合契约，
> 但配置、SQL 语义、容器时序、工具链行为只有真跑才能验证。

### 5.6 真实环境验收结果（2026-10-21，作者本人执行）

> **验收结论：✅ 通过（90 / 100），红线 4/4 成立，放行进入 I1。**
> 完整报告见 [docs/acceptance-report-F01.md](../../docs/acceptance-report-F01.md)。

| 项 | 结果 | 证据 |
|---|---|---|
| AC-1a 一键启动（数据层） | ✅ 通过 | 全新数据卷一次成功；幂等重跑 **5.3s**；`pg_isready` 探测 12 次 ≈ initdb 实际耗时 |
| 数据库与迁移 | ✅ 通过 | 6 张表 + 1 视图；`schema_migrations` 2 行；两次迁移全绿 |
| AC-2 幂等 | ✅ 通过 | 脚本 `scripts/verify-idempotency.mjs` → **8/8 断言**：两次 setup 退出 0、测试行仍在、jobs/users 行数符合预期、`.env` 10 个键逐键不变、migrations 未重复记录 |
| AC-3 换模型只改配置 | ✅ 通过（离线） | `accept` 断言 + 真实 Key 连通 |
| 真实模型连通（3B） | ✅ 通过 | `doctor`：DeepSeek/deepseek-chat 连通 **252ms**，能力 `source=probe`，11/11 项全绿 |
| lint / typecheck | ✅ 通过 | `lint` 0 problem、`typecheck` 0 error、`npm test` 137/137 |
| 验收报告留档 | ✅ 解决 | 报告由 `--report` 直接写 UTF-8（PowerShell 5.1 的 `*>` 会把 UTF-8 按 GBK 解码后存成 UTF-16LE，双重乱码且不可逆） |

**过程中新增的验收工具**（把易错的手工步骤固化成可重复命令）：

| 脚本 | 替代的手工步骤 | 价值 |
|---|---|---|
| `scripts/verify-model-errors.mjs` | 阶段 3A：在 `.env` 里手工改三次 Key | 用注入 fetch 桩构造 401/403/404/不可达/私网/无 Key，不联网、不改配置、可重复 |
| `scripts/verify-idempotency.mjs` | 阶段 2.3：手工六步（含清理） | 结论打印在清理**之前**，逐项断言写入 UTF-8 报告 |
| `scripts/accept.mjs --report` | PowerShell `*>` 重定向 | 绕开 PS 5.1 编码转换，报告中文不再损坏 |
