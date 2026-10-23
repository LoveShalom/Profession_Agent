# Technique Stack

> **术语约定（2026-10-15 起生效）**：**MVP = P0–P1**（必须做）；**Demo 版 = P0–P2**（5 周内交付）；**Post-MVP = P3–P5**（排期待定，见 `logs/open_questions.md` E-05）。全文出现"MVP"处一律按此口径理解。
> 目录约定：规范文档在 `spec/`（mission / tech_stack / roadmap），决策与过程记录在 `logs/`（README / open_questions / decisions_log）。待决策项见 `logs/open_questions.md`，已裁决项与理由见 `logs/decisions_log.md`；本文只写已裁决口径。

## 1. 选型原则

| 原则 | 含义 | 落地约束 |
|---|---|---|
| **合规优先** | 不碰非公开数据，不自动投递 | 只支持手动粘贴、官方/政府开放数据、合规 API；明确排除 BOSS/猎聘/智联爬虫 |
| **低运维** | 个人项目不养服务器 | BaaS + Serverless 优先，不自建数据库、任务队列、K8s；自托管路径用 Docker Compose 一键起 |
| **AI-native** | AI 能力是一等公民，不是补丁 | LLM 抽取、RAG、Agent、Function Calling、评测从 P0 就进架构 |
| **类型安全** | LLM 输出不稳定，靠类型兜底 | TypeScript + Zod，前后端共享 schema，JSON 输出必须过校验 |
| **可替换 / BYOK** | 不锁死单一供应商，使用者可用自己的模型账号 | LLM 与 Embedding 统一走 **Provider 适配层**（OpenAI 兼容端点 + 自定义 `base_url`）；业务代码不直接依赖厂商 SDK；密钥加密存储、只写不回读；无密钥时降级为规则模式 |
| **垂直切片** | 每阶段交付端到端小闭环 | 先跑通"粘贴 JD → 结构化 → 看板 → 提醒 → 匹配"，再扩展插件与数据源 |

## 2. 总体架构

```text
┌──────────────────────────────────────────────────────────────┐
│  客户端层：Web App（Next.js） + 浏览器插件（Plasmo）           │
│           设置页：模型配置（BYOK，密钥只写不回读）              │
└──────────────────────┬───────────────────────────────────────┘
                       ↓
┌──────────────────────────────────────────────────────────────┐
│  应用层：Next.js App Router + Server Actions/Route Handlers   │
│          轻量状态机（XState/自研） + 提醒调度                  │
└──────────────────────┬───────────────────────────────────────┘
                       ↓
┌──────────────────────────────────────────────────────────────┐
│  AI 能力层                                                     │
│  ├─ Provider 适配层：OpenAI 兼容端点 + 自定义 base_url         │
│  │   + 能力探测（tool_calling / json_schema / embedding）      │
│  │   + 降级链（Function Calling → Prompt-JSON → 规则抽取）     │
│  ├─ 能力：LLM 抽取｜RAG 匹配｜Agent 工作流｜材料生成            │
│  └─ 凭证服务：AES-256-GCM 加密存储｜服务端解密｜日志全程脱敏    │
│  统一入口：Vercel AI SDK + Function Calling + Zod              │
└──────────────────────┬───────────────────────────────────────┘
                       ↓
┌──────────────────────────────────────────────────────────────┐
│  数据层：Supabase（Postgres + pgvector + Auth + Storage +     │
│          RLS + Realtime）；凭证表仅服务端 service role 可读     │
│  备选：腾讯云开发 CloudBase ｜ 自托管：Docker + Postgres/pgvector│
└──────────────────────┬───────────────────────────────────────┘
                       ↓
┌──────────────────────────────────────────────────────────────┐
│  外部层：用户自选模型服务（DeepSeek / Qwen / Kimi / GLM /      │
│          SiliconFlow / OpenAI / Ollama / 自建 vLLM）           │
│          合规数据源（国聘 / NCSS / 政府开放数据）              │
│          通知渠道（飞书 / 邮件 / 日历）                        │
└──────────────────────────────────────────────────────────────┘
```

**核心数据流：**

```text
JD 文本 → 清洗归一 → LLM 结构化 → Zod 校验 → 去重 → 岗位库
经历文本 → LLM 结构化（STAR）→ 人工确认 → 经历库
简历 PDF/Word → 文本抽取 → 多条经历草稿 → 逐条确认入库
          ↓
    双库向量化（BGE-M3 或用户配置的 Embedding + pgvector；未配置则 tsvector 关键词检索）
          ↓
    JD 定向检索（向量 + 关键词混合）→ 匹配评分 → 话术生成 → 简历视图
          ↓
    状态机 → 定时调度 → 飞书/邮件提醒

每次 AI 调用：解析用户凭证（BYOK 或平台密钥）→ Provider 适配 → 能力探测/降级 → 用量记账
```

## 3. 技术栈全景

### 3.0 功能列点（Demo 版范围）

Demo 版聚焦两条主线：**JD 解析与管理**、**经历管理**；AI 匹配与话术生成作为第二阶段（P2）。

> 优先级：**P0–P1 = MVP**（必须做）｜**P2 = Demo 版第二阶段**｜**P3+ = Post-MVP**

#### 3.0.1 Agent 核心功能

| 编号 | 功能 | 输入 | 输出 | 优先级 | 依赖 |
|---|---|---|---|---|---|
| A1 | JD 结构化抽取 | 粘贴的 JD 文本 | 字段字典 v1 的 18 个字段（见 §9.2.0） | P0 | LLM + Function Calling |
| A2 | 经历结构化抽取 | 实习/项目/科研/社团原始描述 | STAR 四段 + 技能标签 + 量化结果 | P0 | LLM + STAR 模板 |
| A3 | 字段校验与兜底 | 结构化 JSON | 校验结果 + 低置信度字段标记（阈值 0.7） | P0 | Zod + 规则引擎 |
| A4 | 去重检测 | 新 JD + 已有岗位库 | 重复/新记录判定 | P1 | fingerprint（归一化）+ 向量相似度兜底（阈值 0.92） |
| A5 | 双库向量化 | 经历条目 + JD 分段 | pgvector 向量 | P2 | BGE-M3（或用户配置的 Embedding） |
| A6 | JD 定向检索 | JD 结构化字段 | Top 10 召回 → 重排 Top 5 经历 | P2 | 向量 + `tsvector` 混合召回 + 规则重排 |
| A7 | 匹配评分 | JD + 经历召回结果 | 五维评分（0–100）+ 三级标签 + 差距提示 | P2 | §10.1 规则加权（LLM 不参与打分） |
| A8 | 话术生成 | JD + 相关经历 | 简历 bullet / 打招呼语 / 面试题 | P2 | RAG + Prompt 模板 |
| A9 | 事实校验 | 生成话术 + 经历库 | 可追溯性检查，禁止编造 | P2 | 规则（数字/公司/时间字面命中）+ LLM 校验 |
| A10 | 跟进建议 | 岗位状态 + 时间字段 | 下一步动作 + 跟进话术 | P2 | 状态机 + 定时调度 |
| A11 | **简历解析** | 上传的 PDF/Word 简历 | 多条经历草稿（进入 A2 逐条确认） | **P1**（A-05 裁决） | Node 端文本抽取（`pdfjs-dist`/`unpdf` + `mammoth`）+ 分段 + LLM 结构化；不做 OCR |
| A12 | **Provider 能力探测与降级** | 用户凭证 + 冒烟请求 | `capabilities` + 降级链决策 | P0 | Provider 适配层 |
| A13 | **凭证校验与用量记账** | 用户 API Key | 校验结果（401/429/不可达）+ 用量与成本记录 | P1 | 加密存储 + `llm_usage_logs` |
| **A14** | **验证器优先生成** | 生成候选 + 经历库 | 规则验证 → LLM 复核 → 修复重生成（≤2）→ 弃答 | P2（见 §3.9.1） | 规则验证器 + judge |
| **A15** | **自一致性置信度** | 同一 JD 的 K=3 次抽取 | 字段级一致率 → confidence（替代 LLM 自报） | **P1**（见 §3.9.2） | K 次采样 + 归一化比对 |
| **A16** | **用户风格检索** | 用户已确认/编辑的材料 | 检索自有产物做 few-shot（回退到固定样本） | P2（见 §3.9.3） | 向量检索 + 类型过滤 |
| **A17** | **求职记忆固化** | 投递事件 + 已确认材料 | 周期性固化 → 记忆卡，生成时带引用注入 | 可选增量（见 §3.9.4） | `memory_cards` |
| **A18** | **查询分解与多跳检索** | JD 要求段 | 子查询分解 → 逐项召回 → 充分性检查 | 可选增量（见 §3.9.5） | 多路召回 + 聚合 |
| **A19** | **MCP Server** | 岗位库/经历/匹配/生成能力 | tools + resources 暴露（本地 stdio，默认只读） | P5（见 §3.9.6） | MCP 协议 |

#### 3.0.2 前端功能

| 编号 | 功能 | 说明 | 优先级 |
|---|---|---|---|
| F1 | JD 粘贴与解析 | 粘贴框 → 一键解析 → 预览结构化结果（含 evidence/confidence）→ 确认入库 | P0 |
| F2 | 岗位列表 | 表格/卡片视图，支持筛选、排序、搜索 | P0 |
| F3 | 岗位详情 | JD 原文 + 结构化字段 + 状态 + 提醒 + 备注 | P0 |
| F4 | 状态流转 | 按 §3.5 状态枚举与转移矩阵流转 | P1 |
| F5 | 经历录入 | 手动填写 + 粘贴原文 → LLM 结构化草稿 → 人工确认 | P0 |
| F6 | 经历列表 | 按类型/技能/时间筛选 | P0 |
| F7 | 经历详情 | STAR 四段 + 技能标签 + 证据链接 + 量化结果 | P0 |
| F8 | 看板视图 | 拖拽流转状态 | P1 |
| F9 | 截止倒计时 | 列表和详情展示剩余天数 | P1 |
| F10 | 提醒设置 | 截止/跟进/笔试/面试提醒（含免打扰时段） | **P2（后置）**——A-08 裁决：提醒不在 MVP 内 |
| F11 | 匹配评分展示 | 五维雷达图 + 三级标签 + 差距提示 | P2 |
| F12 | 话术生成面板 | 一键生成 + 编辑 + 复制 + 确认 | P2 |
| F13 | 简历视图 | 按岗位生成简历预览 | P3 |
| F14 | 求职周报 | 本周待投/待跟进/待面试统计 | P3 |
| F15 | **简历上传与解析入口** | 上传 PDF/Word → 草稿预览 → 批量确认 | **P1**（A-05 裁决） |
| F16 | **模型设置页（BYOK）** | 填 Key（只写不回读）+ 冒烟校验 + 任务级默认模型；完整多 provider 版留 P5 | **P1**（最小版 F16-mini；C-10 后果：没有它用户装上也用不了） |

#### 3.0.3 后端功能

| 编号 | 功能 | 说明 | 优先级 |
|---|---|---|---|
| B1 | 用户认证 | Supabase Auth，**邮箱/密码为唯一方式**（D-04 已裁决：配自定义 SMTP 或关闭邮件确认以保证内测注册） | P0 |
| B2 | 岗位 CRUD | 增删改查 + 软删除 | P0 |
| B3 | 经历 CRUD | 增删改查 + 软删除 | P0 |
| B4 | LLM 调用封装 | 统一经 Provider 适配层，支持多模型切换、重试、降级 | P0 |
| B5 | 结构化输出校验 | Zod Schema + 规则校验 + Prompt-JSON 修复重试（≤2 次） | P0 |
| B6 | 去重服务 | fingerprint 生成（归一化）+ 重复检测 | P1 |
| B7 | 状态机服务 | 状态流转 + 事件日志 | P1 |
| B8 | 定时任务 | 每日 + 每小时扫描截止/跟进/笔试/面试提醒 | **P2（后置）**——A-08：提醒不在 MVP 内 |
| B9 | 通知服务 | 飞书 Webhook + 邮件 Resend | **P2（后置）**——A-08；原 G-10"邮件提前到 P1"随之失效 |
| B10 | 向量化服务 | 异步 Embedding + 重试队列 | P2 |
| B11 | RAG 检索服务 | 混合召回 + 重排 | P2 |
| B12 | 话术生成服务 | Prompt 模板 + 上下文组装 | P2 |
| B13 | 版本管理服务 | 简历版本快照 + 关联岗位 | P3 |
| B14 | 处理日志 | 每个阶段记录状态、耗时、token、模型、prompt 版本、缓存命中 | P1 |
| B15 | RLS 策略 | 所有业务表行级安全；凭证表特殊策略（见 §9.3） | P0 |
| B16 | **简历解析服务** | PDF/Word 文本抽取（Node 端 `pdfjs-dist`/`unpdf` + `mammoth`）+ 分段 + 草稿生成 | **P1**（A-05 裁决） |
| B17 | **Provider 适配与凭证服务** | OpenAI 兼容适配、能力探测、密钥加解密、冒烟校验 | P0（适配层）/ P5（BYOK 完整实现） |

#### 3.0.4 Demo 版边界（P0–P2）

**MVP 必须做（P0–P1）**
- **本地一键启动（`npm run setup`）+ 数据只存本机**（C-10 本地优先）
- JD 粘贴 → 结构化 → 入库 → 列表 → 详情
- 经历录入 → 结构化 → 列表 → 详情
- **从 PDF/Word 旧简历导入经历**（A-05 裁决：进入 P1）
- **BYOK 最小版设置页：填自己的 API Key + 冒烟校验**（C-10 的必然结果：没有它用户装上也用不了）
- 状态流转 + 截止倒计时（纯展示，不含通知）
- Provider 适配层（OpenAI 兼容 + 能力探测 + 降级链）；Auth 可选

**Demo 版第二阶段（P2）**
- **提醒与通知（飞书 Webhook + 邮件 Resend + 定时调度）**——A-08 裁决：提醒不在 MVP 内，后置到本阶段
- 向量化 + 混合检索 + 五维匹配评分
- 话术生成 + 事实校验
- 跟进建议

**明确不做（Demo 版之外）**
- 自动投递、自动打招呼
- 爬取 BOSS/猎聘/智联
- 浏览器插件、合规数据源、简历 PDF 导出（Post-MVP）
- 完整多 provider 设置页与用量面板（最小版在 P1，完整版随 P5）
- JD 截图 OCR（Post-MVP）
- **托管多租户**（C-10 已裁决不做）

### 3.1 前端

| 模块 | 选型 | Demo 版 | 说明 |
|---|---|---|---|
| 框架 | Next.js 15 App Router + TypeScript | ✅ | 全栈一体，SSR/Server Actions |
| 样式 | Tailwind CSS + shadcn/ui | ✅ | 管理后台风格，快速搭建 |
| 看板 | dnd-kit | ✅ | 岗位状态拖拽流转 |
| 日历 | FullCalendar | P3 | 截止、笔试、面试时间线 |
| 数据请求 | Supabase SDK + TanStack Query | ✅ | 缓存、乐观更新 |
| 表单校验 | React Hook Form + Zod | ✅ | 手动录入岗位与经历 |
| 模型设置 | 自研表单（密钥字段只写不回读） | P5 | provider / base_url / 任务级模型偏好 / 用量 |
| 图表 | Recharts | P3 | 求职周报、投递转化率（与 F14 对齐） |

### 3.2 后端与数据

| 模块 | 选型 | Demo 版 | 说明 |
|---|---|---|---|
| BaaS | Supabase（**本地栈为主**，Demo 用只读实例） | ✅ | 业务数据默认只存本机 |
| 数据库 | Supabase Postgres（本地容器） | ✅ | 岗位库、经历库、状态、提醒、版本、凭证 |
| 向量库 | pgvector | ✅ | 与业务数据同库，减少组件 |
| 认证 | Supabase Auth（**可选**） | ✅ | 本地单用户可关闭；需要多账号时用邮箱/密码 |
| 文件存储 | Supabase Storage（本地卷） | ✅ | 简历 PDF、JD 截图 |
| 权限 | 本地单用户约束；RLS 仅多账号模式启用 | ✅ | 本地优先下不再需要多租户隔离 |
| 后端逻辑 | Next.js Route Handlers / Server Actions | ✅ | MVP 足够，不单独起后端 |
| 密钥加密 | Node `crypto` AES-256-GCM + 服务端 `ENCRYPTION_KEY` | ✅ | 密钥密文存储，解密只在服务端出站时发生 |
| 可选 Python 服务 | FastAPI | P2+ | 仅当需要 PyMuPDF 等复杂 PDF 解析时引入 |
| 备选 BaaS | 腾讯云开发 CloudBase | 备用 | 仅当需要"国内可访问的在线 Demo"时 |
| 本地一键启动 | Docker Compose + `npm run setup` | ✅ | **主路径**（T1）：起容器 → migration → 校验 `.env` → 打印访问地址 |

**Supabase 额度不足备选：腾讯云开发 CloudBase**

| Supabase 能力 | CloudBase 替代 | 说明 |
|---|---|---|
| Postgres + pgvector | 云数据库（MySQL）+ 腾讯云向量数据库 | 向量访问独立封装，切换不影响上层 |
| Auth | 云开发身份认证 | 邮箱/微信登录 |
| Storage | 云存储 | 简历 PDF、JD 截图 |
| RLS | 数据库安全规则 | 按用户隔离数据 |
| Cron | 定时触发器 | 每日提醒扫描 |
| 逻辑层 | 云函数（Node.js）+ 云托管 | Next.js 应用与 Route Handlers 平滑迁移 |

**切换触发条件**：数据库容量/存储/带宽接近免费额度上限且升级 Pro 不划算时；或需国内访问提速时。
**迁移原则**：数据访问层按 Repository 封装，SQL 兼容导出导入，灰度双写验证后再切换。

### 3.3 AI 能力层

**Provider 适配层（G-12 BYOK 核心）**

| 设计点 | 口径 |
|---|---|
| 接入协议 | 一律 **OpenAI 兼容**端点（`base_url` + `api_key` + `model`），覆盖 DeepSeek / Qwen（百炼）/ Kimi / GLM / SiliconFlow / OpenAI / Ollama / vLLM |
| 预设 provider（= 无状态展示页白名单） | DeepSeek、阿里云百炼 Qwen、月之暗面 Kimi、智谱 GLM、硅基流动 SiliconFlow、OpenAI、Ollama |
| 自定义端点 | **无状态展示页：只允许上表预设 provider，不接受自定义 `base_url`，也不接受用户密钥**（防 SSRF 与"拿平台当代理"）。**本地模式：开放任意 `base_url`，包含第三方中转站（one-api / new-api / OpenRouter 等）**；仅当填私网地址（Ollama / vLLM）时才需要 `ALLOW_PRIVATE_BASE_URL=true` |
| 默认与 fallback | 默认 `deepseek-chat`；调用失败重试 2 次 → 切换 Qwen → 仍失败则降级为规则抽取 + 人工补全（B-09） |
| 能力探测 | 保存凭证时冒烟调用，写入 `capabilities`：`tool_calling` / `json_schema` / `stream` / `embedding` / `context_window` |
| 降级链 | Function Calling → Prompt-based JSON + Zod 校验 + 最多 2 次修复重试 → 规则抽取 + 人工补全 |
| 任务级模型偏好 | `model_prefs`：`extract` / `generate` / `embed` / `rerank` 各自指定 provider+model（抽取用便宜模型、生成用强模型） |
| 凭证失效 | 401/403 → 标记 `status=invalid` 并通知用户；429 → 指数退避 + 该用户备用凭证；网络不可达 → 冒烟测试阶段即拒绝保存 |
| 无密钥模式 | 不配置密钥仍可用：AI 功能显示引导，抽取/匹配降级为规则模式；Embedding 未配置时检索降级为 `tsvector` 关键词检索 |

**能力清单**

| 能力 | 选型 | Demo 版 | 说明 |
|---|---|---|---|
| LLM | 用户自选（默认预设 DeepSeek） | ✅ | 中文 JD 理解好、国内可访问、成本低；BYOK 可替换 |
| 统一调用 | Vercel AI SDK + OpenAI 兼容接口 | ✅ | 流式输出、工具调用、多模型切换 |
| 结构化抽取 | Function Calling + JSON Schema + Zod | ✅ | 输出必须过校验；不支持 FC 的模型走 Prompt-JSON 降级 |
| Embedding | BGE-M3（SiliconFlow / 百炼 / Ollama），可 BYOK | P2 | 未配置时降级为关键词检索 |
| RAG | 混合召回 + LLM 重排 | P2 | 经历按 STAR 四段 + summary 分段；JD 按职责/要求/技能分段；Top10 → Top5 |
| Agent | Tool Use + 状态机 + 定时调度 | P2 | 判断该投递、该跟进、该准备面试 |
| 材料生成 | Prompt 模板 + 结构化上下文 | P2 | 简历 bullet、打招呼语、面试题 |
| Prompt 管理 | `prompts/` + Git + LangFuse Prompt | ✅ | 版本化、可回滚、可评测；**缓存键含 prompt 版本** |
| 幻觉抑制 | 引用原文 + 字段校验 + 人工确认 | ✅ | 薪资、截止时间等关键字段必须可追溯且 100% 带 evidence |
| 用量记账 | `llm_usage_logs` | ✅ | 按任务记录 provider/model/tokens/估算成本，用户可见 |

### 3.4 数据源与导入

| 来源 | 方式 | 合规性 | 阶段 |
|---|---|---|---|
| 手动粘贴 JD | 用户主动输入 | 最高 | ✅ 主路径 |
| 简历上传（PDF/Word） | 用户主动上传 | 高 | P1（A-05） |
| 国聘网 | **仅官方公开接口**（须先验证接口是否存在与授权状态） | 较高 | P4 |
| 国家大学生就业服务平台（NCSS） | **仅官方公开接口**（须先验证） | 较高 | P4 |
| 地方政府开放数据 | CSV / API 下载（须指明具体平台与字段） | 高 | P4 |
| 企业官网招聘页 | 手动导入或低频公开页面 | 中 | P4 |
| BOSS / 猎聘 / 智联 | **不抓取** | 风险高 | ❌ 明确排除 |

> 说明：不使用 Apify / Scrapy / Playwright 等第三方抓取方案；P4 开工前先产出"接口可用性与服务条款核查结论"，无公开接口则该源不做。

### 3.5 通知、调度与状态机

| 模块 | 选型 | Demo 版 | 说明 |
|---|---|---|---|
| 定时任务 | Supabase Cron（pg_cron） | **P2** | **日扫**（每日 09:00）+ **小时扫**（每小时）双层，支持"面试前 2 小时"级提醒；A-08 裁决后置 |
| 工作流 | Inngest / Trigger.dev | P4 | 比裸 Cron 更可观测、可重试 |
| IM 通知 | 飞书机器人 Webhook（按用户配置） | **P2** | 用户各自填写自己的 webhook；A-08 裁决后置 |
| 邮件 | Resend | **P2** | A-08 裁决后置（原 G-10 的"提前到 P1"因提醒移出 MVP 而失效）；内测阶段至少保证一条通路 |
| 日历 | ICS / 飞书日历 | P3 | 面试、笔试自动落日历 |
| 状态机 | XState 或自研轻量状态机 | ✅ | 见下方枚举与转移矩阵 |

**状态枚举（G-03）**

| 中文名 | 枚举值 | 终态 | 说明 |
|---|---|---|---|
| 收藏 | `saved` | 否 | **新入库岗位的默认状态**：先存下来、还没决定投不投 |
| 待投递 | `to_apply` | 否 | 决定要投；入库确认页提供"直接标为待投递"选项（A 类裁决） |
| 已投递 | `applied` | 否 | |
| 待测评 | `assessment` | 否 | 在线测评/性格测试 |
| 待笔试 | `written_test` | 否 | |
| 已笔试 | `test_done` | 否 | 等待结果 |
| 面试中 | `interviewing` | 否 | 具体轮次见 `job_interviews` |
| 待 Offer | `offer_pending` | 否 | 面试通过，等正式 offer |
| 已 Offer | `offered` | 否 | 有 `offer_deadline` |
| 已接受 | `accepted` | 是 | |
| 已拒绝（企业） | `rejected_by_company` | 是 | 被拒 |
| 已放弃（本人） | `withdrawn` | 是 | 主动放弃/拒 offer |
| 已过期 | `expired` | 是 | 截止未投或长期无进展 |

**转移规则（G-03）**
- **顺序定义**：下文"更早 / 更晚"一律指状态枚举表的**行序**（`saved` 最早，`expired` 最晚）。
- 允许向前流转：按行序任意跨步前进（如 `applied → interviewing`）。
- **允许回退**：任意非终态 → 行序更早的任意非终态（如误操作、流程回流），必须写 `job_events` 并填 `note`。
- `priority` 与状态**正交**：状态描述流程位置，`priority` 描述用户主观优先级，两者互不推导。

**命名约定（F-05 已裁决）**：代码中一律使用数据库枚举值 / 英文字段名，中文名只出现在 UI 文案与本文档；映射集中维护在 `src/lib/i18n/zh.ts`。示例：`saved`→收藏、`to_apply`→待投递、`interviewing`→面试中、`deadline`→投递截止、`offer_deadline`→Offer 答复期限、`fingerprint`→去重指纹。
- 终态可"重新激活"：回到用户指定的非终态，同样记事件。
- 终态集合 = `accepted` / `rejected_by_company` / `withdrawn` / `expired`。
- 状态 → 提醒映射：`to_apply`→截止提醒；`applied`/`assessment`/`written_test`→跟进提醒；`interviewing`→面试提醒；`offered`→Offer 答复期限提醒。

**提醒策略（G-08）——实现阶段：P2（A-08 裁决后置；本章为设计口径，表结构可先建）**

| 项 | 口径 |
|---|---|
| 提前量 | 截止：T-3 / T-1 / T-0；面试：T-1 天 20:00 + 开始前 2 小时；跟进：`next_action_at` 当天；Offer：`offer_deadline` T-3 / T-1 |
| 时区 | 统一按 `Asia/Shanghai` 存储与计算；预留 `users.timezone` |
| 渠道 | **一个提醒可同时发多渠道**（用户在设置页勾选，A 类裁决）；发送时按 `users.notification_prefs` 展开，每个渠道各写一条 `notification_logs` |
| 幂等 | 一条 `job_reminders` = 一个具体触发时刻；唯一约束 `(reminder_id, channel)` 保证**同一提醒的同一渠道只成功发送一次** |
| 生成时机 | **应用层在状态变更 / 面试创建时立即创建提醒行**；定时扫描只负责补漏与发送（C-14 已裁决）。避免"仅靠扫描"漏掉刚入库或刚变更的岗位 |
| 免打扰 | `quiet_hours` 内普通提醒延后到结束时刻；**紧急类型（截止当天、面试前 2 小时）不受免打扰限制** |
| 失败重试 | 发送失败进重试队列（最多 3 次，指数退避），最终失败记录并在应用内提示 |

### 3.6 浏览器插件

| 模块 | 选型 | 说明 |
|---|---|---|
| 插件框架 | Plasmo / WXT | Manifest V3，开发体验好 |
| 形态 | Chrome / Edge 侧边栏 | 在招聘页手动触发，只读页面 |
| 功能 | 解析当前 JD、生成匹配评分、打招呼语 | 不自动点击、不自动投递 |
| 数据同步 | Supabase SDK | 登录后同步到岗位库 |
| 合规边界 | 只读 + 手动触发 + 本地优先 | 规避平台风控 |

### 3.7 评测与可观测

| 模块 | 选型 | Demo 版 | 说明 |
|---|---|---|---|
| Prompt 回归 | Promptfoo | ✅ | 每次改 Prompt 跑评测集 |
| RAG 评测 | Ragas | P2 | 召回率、忠实度、答案相关性 |
| LLM 可观测 | LangFuse | **P1** | 调用链、成本、延迟、Prompt 版本；**必须脱敏，禁止记录密钥**（`roadmap.md` 第 3 周即接入） |
| 错误监控 | Sentry | P2 | 前后端异常 |
| 产品分析 | PostHog | P4 | 内测行为分析，可自托管 |
| 测试 | Vitest + Playwright | P1 | 单元测试 + E2E |
| CI | GitHub Actions | P1 | 自动跑测试与 Prompt 评测 |

### 3.8 部署模型与 CI/CD

**本地优先（C-10 已裁决）**：产品的默认形态是**用户从 GitHub clone 仓库 → 在自己机器上一键启动 → 数据全部留在本机**。作者**不托管、不存储任何用户数据**，也不承担模型费用。在线只保留一个**无状态只读 Demo（下称"在线展示页"）** 用于展示。

| 模式 | 用途 | 数据位置 | 模型密钥 | 认证 |
|---|---|---|---|---|
| **本地单用户（主路径）** | 用户 `npm run setup` 一键启动（Docker Compose + Supabase 本地栈） | **全部在本机**（Postgres/pgvector + Storage 均为本地容器） | 用户自己的 Key（`.env` 或设置页；也可用 Ollama 全离线） | 默认可关闭；或本地单账号 |
| **无状态在线 Demo** | 给面试官 / 同学点开看（**只读**） | **不落库**：固定示例数据，只读渲染 | 作者密钥，限额度、仅只读接口 | 无（不注册、不收集） |
| ~~托管多租户~~ | **不做**（避免存储用户信息） | — | — | — |

| 模块 | 选型 | Demo 版 | 说明 |
|---|---|---|---|
| 本地运行 | Docker Compose（Next.js + Supabase 本地栈） | ✅ | **主路径**；`npm run setup` 一键起，代码零改动 |
| 在线 Demo | Vercel + Supabase（只读实例，无写入路径） | P1 | 仅展示；**不接收用户数据**，不开放注册 |
| 数据库/Auth/Storage | Supabase 本地栈为主，Demo 用只读实例 | ✅ | 本地优先，Demo 仅读 |
| 国内备选 | 腾讯云开发 CloudBase / 阿里云 | P5 | 仅当需要"国内可访问的在线 Demo"时 |
| CI/CD | GitHub Actions | ✅ | 测试与评测；**不部署到用户环境** |
| 域名与备案 | 国内云 + ICP 备案 | 可选 | **本地优先后不再是阻塞项**；只有要做国内在线 Demo 时才需要（备案约 20 工作日） |

**部署约束（I4 前核实，结论写入 ADR-0003）**
- 本地模式：Supabase 本地栈镜像体积与首次拉取时间（README 必须写清前置条件与耗时）；
- 本地模式：Windows / macOS / Linux 三平台的启动脚本可用性；
- Demo 模式：只读接口的限流与 Vercel Hobby 函数超时（vs "P95 抽取延迟 ≤5s"）。

### 3.9 前沿能力层（Frontier Layer）

> 这一层不是"为了用新技术"，而是把项目从"2024 代 LLM 应用"提升到**可信、可记忆、可被 Agent 调用**的形态。每项都对应 `mission.md` §四 的一个真实痛点，并且**都能进评测**（不能进评测的一律不做）。

| 编号 | 能力 | 机制 | 放置 | 成本 | 关键指标 |
|---|---|---|---|---|---|
| A14 | 验证器优先生成 | 规则验证 → LLM 复核 → 修复重生成（≤2）→ 弃答 | I6 | +2h | 可追溯率 100%、弃答率 ≤15%、幻觉率 ≤2% |
| A15 | 自一致性置信度 | K=3 采样一致率替代 LLM 自报 | I1 | +4h | 高置信字段占比、置信度分层准确率 |
| A16 | 用户风格检索 | 用 `materials.confirmed` 做 few-shot 池 | I6 | +2h | 话术人工评分 +≥10%、编辑率下降 |
| A17 | 求职记忆固化 | 事件流 → 记忆卡，生成时检索 | 可选增量 | 12h | 记忆引用率、用户修正率 |
| A18 | 查询分解与多跳检索 | JD 要求段 → 子查询 → 逐项召回 → 充分性检查 | 可选增量 | 12h | Top5 命中率、匹配一致率 |
| A19 | MCP Server | tools + resources，本地 stdio | P5 | 8h | 外部 Agent 客户端跑通一条链路 |

#### 3.9.1 验证器优先生成（A14）

- **三段式**：① **规则验证器**（确定性、零成本）→ ② **LLM 复核**（judge，只看可疑项）→ ③ **修复重生成**（≤2 次）→ ④ **弃答**。
- **规则验证器检查项**：数字（含"3 倍"这类换算）、公司名、时间、技能名，必须能在 `evidence_refs` 的 `quote` 中**归一化后字面命中**（与 §12.4 的归一化口径一致）。
- **弃答契约**：返回 `{ status: 'abstained', reasons: [...], suggestions: [...] }`；UI 显示"无法基于现有经历生成可信内容"，并给出"该补哪段经历"的建议。**弃答是正常结果，不是错误**。
- **与 A9 的关系**：A9（事实校验）由"生成后的事后检查"**重构为生成循环的一部分**，功能编号沿用 A9，实现形态按本节执行。
- **可调参数**：`max_repair=2`、`abstain_threshold`（规则验证失败项数）、judge 模型（默认比生成模型便宜一档）。

#### 3.9.2 自一致性置信度（A15）

- **做法**：同一输入做 **K=3** 次抽取（`temperature` 略高，其余参数一致），按字段比对结果，`confidence = 一致次数 / K`。
- **归一化后比较**：全半角、单位、日期格式、城市别名、技能别名统一后比对；组合字段（`salary_min`/`salary_max` 等）**整组一致才算一致**（与 §12.4 口径一致）。
- **规则否决权**：字段无 `evidence` → 强制 `confidence < 0.5`，忽略一致率。
- **成本控制**：K 次采样只用于"抽取"任务（文本短、可用便宜模型）；缓存键含 `K`；`K` 可配置（缺额度时降到 1）。
- **与 B-01 的关系**：B-01 原口径"LLM 自报 + 规则复核"改为**自一致性为主、自报值仅作参考**（不参与 UI 展示与阈值判断）。
- **指标**：`一致率 ≥ 0.9` 的字段占比；**置信度分层准确率**（高置信字段的准确率应显著高于低置信字段——这是置信度是否有意义的判定标准）。

#### 3.9.3 用户风格检索（A16）

- **few-shot 池** = 该用户 `materials.confirmed = true` 的产物 + 用户编辑后的版本（保留 diff）。
- **检索**：类型过滤（`greeting` / `bullet`）+ 向量相似，取 3 条**最相似但来自不同岗位**的样本。
- **冷启动**：池为空时回退到内置 3 条模板样本（即 B-07 原方案）。
- **隐私**：池只在本机；不外发、不训练。
- **与 B-07 的关系**：B-07 的"3 个固定 few-shot + 风格偏好文本框"升级为"**优先检索用户自有产物，回退到固定样本**"。
- **指标**：话术质量样本（30 条）人工评分；用户对生成结果的编辑率。

#### 3.9.4 求职记忆固化（A17，可选增量）

- **输入**：`job_events` + `materials` + 匹配结果；**触发**：每 20 次状态变更或每 7 天（先到者）。
- **产出记忆卡**（`memory_cards` 表）：`stage_summary`（当前战役状态）、`preferences`（城市/薪资/方向）、`rejection_patterns`（被拒共性）、`effective_phrases`（高转化话术）、`open_questions`。
- **使用**：生成话术与跟进建议时作为上下文注入，**必须带引用**（引用到具体 job/event，避免记忆变成"模型想象"）。
- **可控性**：用户可以查看、编辑、删除记忆卡；生成时必须标注"本次使用了哪几张记忆卡"。
- **指标**：记忆引用率、用户修正率（修正率高说明固化质量差）。

#### 3.9.5 查询分解与多跳检索（A18，可选增量）

- 把 JD 的"要求段"分解为 N 个子查询（技能 / 经验 / 项目 / 学历），**逐项检索经历**再聚合打分，替代"整条 JD 一次召回"。
- **充分性检查**：某子查询无命中 → 标记为"经历库缺口"，直接产出"你该补什么经历"的建议（这是比"匹配分"更有用的输出）。
- **迭代上限 2 轮**，避免延迟失控（P95 ≤5s 是硬指标）。
- **指标**：Top5 召回的命中率、匹配一致率（与 §12.4 同口径）。

#### 3.9.6 MCP Server（A19）

| 项 | 口径 |
|---|---|
| 暴露能力 | tools：`search_jobs`、`get_job`、`upsert_experience`、`match_jd`、`generate_material`、`list_actions`；resources：`schema://field-dict`、`memory://cards` |
| 传输 | **本地 stdio**（无网络端口、无鉴权、数据不出机），与本地优先一致 |
| 写入安全 | 默认**只读**；写操作需显式启动参数 `--allow-write`，且每次写入返回 diff 供确认 |
| 与 Web UI 的关系 | 二者共用同一套 `repositories/` 与服务层；**MCP 不是第二套业务逻辑** |
| 文档 | README 给出 Claude Desktop / Cursor 的配置示例 |
| 指标 | 外部客户端能完成"查岗位 → 生成 bullet"完整链路，且不触发任何外发 |

### 3.10 工作区与导出层（Workspace & Export，**F-03**）

> 来源：2026-10-23 两轮裁决（decisions_log §12 / §13 / §14）。用户要"设置一个工作区文件夹，工具往里生成清晰的管理表格"，
> 且表格**允许用户直接编辑**（Agent 为辅助）。**P1 裁决把本层整体移出 I1**，成为 F-03（10h，I1 之后）。

| 项 | 约定 |
|---|---|
| 工作区 | 用户指定的本地文件夹，`WORKSPACE_DIR`（默认 `./data/workspace`）；**DB 是唯一真相源**，工作区可整体删除后重建 |
| 数据载体 | CSV（UTF-8 **带 BOM**；RFC4180 转义；`=`/`+`/`-`/`@` 开头前置 `'` 防公式注入）——**唯一可编辑源** |
| 技能区分方式 | **分列，不靠颜色**：主表 3 列（`技能·明确(必须)` / `技能·明确(加分)` / `技能·推测`），明细表 6 列（见 §10.1.3）。**不生成 XLSX 视图**（CSV 无法保存颜色；也不为颜色引入依赖） |
| 双向同步 | `npm run sync`：按表头名匹配 → 行级增删处理 → `_rev` 冲突检测 → **用户优先** → 冲突写入 `同步冲突记录.csv` |
| 删除保护 | 表格里删行**不删 DB 数据**，重新导出时补回并提示；新增行需 `公司`+`岗位` 以生成指纹 |
| 原文快照 | `原始JD/公司-岗位-录入日期.md`（R1-02 裁决） |
| 不做的 | 多工作区（W-07）、把状态机映射成目录（会产生双真相源） |

## 4. AI-native 开发工具链

| 环节 | 工具 | 落地方式 |
|---|---|---|
| 编码 | Cursor / Claude Code / Copilot / Aider | AI 辅助生成、重构、补测试 |
| 任务拆解 | Spec + Issue + Claude Code | 从 spec 到可执行任务 |
| Prompt 管理 | `prompts/` + Git | 每个 Prompt 可版本化、可回滚 |
| 评测 | `evals/` + Promptfoo | CI 中自动跑回归 |
| 代码审查 | AI Review + 人工 Review | AI 初筛，人工把关 |
| 文档 | README + ADR + AI 生成注释 | 记录选型与决策 |
| AI 辅助开发方式 | Agent 工作流、Prompt 工程、评测驱动迭代 | 记录 Prompt 版本与评测基线对比、架构决策（ADR）；作品化呈现"AI 辅助开发"的技术能力，**不统计"AI 生成代码占比"等不可验证的数字**（A-06 裁决） |

**首批 ADR 清单（F-02 已裁决）**——放 `docs/adr/`，每条一页（背景 / 选项 / 决定 / 后果）：

| 编号 | 主题 |
|---|---|
| ADR-0001 | 为什么选 Supabase（Postgres + pgvector + Auth + Storage + RLS 一体） |
| ADR-0002 | 为什么用 pgvector 而不是专用向量库 |
| ADR-0003 | 部署形态：为什么选"本地优先 + 无状态只读 Demo"，而不是托管多租户（C-10） |
| ADR-0004 | 为什么用 Function Calling + Zod，而不是纯 Prompt 解析或微调 |
| ADR-0005 | 状态机自研（13 状态）而不是引入 XState |
| ADR-0006 | 简历导出选 react-pdf 而不是 Puppeteer / LaTeX |
| ADR-0007 | BYOK 与 Provider 适配层设计（密钥存储、能力探测、降级链） |
| ADR-0008 | 为什么"验证器优先生成"而不是"生成后检查"（含弃答策略与阈值） |
| ADR-0009 | 为什么用自一致性替代 LLM 自报置信度（K 值与成本/精度权衡） |
| ADR-0010 | MCP 暴露的边界：只读默认、写操作确认、为什么用 stdio 而非 HTTP |

**目录结构约定（F-03 已裁决）**

```text
profession_search_agent/
├── spec/                     # 规范文档：mission.md / tech_stack.md / roadmap.md
├── logs/                     # 过程记录：README.md / open_questions.md / decisions_log.md
├── docs/adr/                 # 架构决策记录（ADR-0001 ~ ）
├── prompts/                  # 版本化 Prompt（extract-jd / star-experience / generate-bullet …）
├── evals/                    # Promptfoo 配置与去敏评测集
├── src/
│   ├── app/                  # Next.js App Router：页面 + Route Handlers
│   ├── components/           # UI 组件（shadcn/ui 基础上扩展）
│   ├── lib/
│   │   ├── llm/              # Provider 适配层（OpenAI 兼容 + 能力探测 + 降级链）
│   │   ├── schemas/          # Zod schema（字段字典 v1、状态枚举、API 契约）
│   │   ├── pipeline/         # 清洗 → 抽取 → 校验 → 入库 → 向量化
│   │   ├── scoring/          # 五维匹配评分
│   │   ├── state-machine/    # 13 状态与转移矩阵
│   │   └── crypto/           # 凭证加解密（AES-256-GCM）
│   ├── repositories/         # 数据访问层（为 CloudBase / 自托管迁移预留）
│   └── server/               # Server Actions
├── supabase/migrations/      # 版本化 SQL migration
├── tests/                    # Vitest 单测 + Playwright E2E
├── docker-compose.yml        # 自托管（含 Supabase 本地栈）
└── .env.example              # 模型与数据库配置模板
```

## 5. 安全与合规

**本地优先（C-10 已裁决）**
- **数据不离开你的机器**：岗位、经历、简历文件、生成的版本默认全部存于本机（Docker 内的 Postgres/pgvector 与 Storage 卷）；
- 作者**不托管、不接收、不存储**任何用户数据；在线只保留不落库的只读 Demo；
- 用户主动删除 = 删除本地数据卷（`docker compose down -v`），因此不需要"数据导出/删除"申请流程；
- 仅在用户主动触发 AI 功能时，必要文本才发送给**用户自己配置的**模型服务商；用 Ollama 可完全离线；
- 本地模式**不强制 Auth**：单用户可直接使用；需要多账号时再启用 Supabase 本地 Auth。

**通用**
- 不自动登录、不批量投递、不绕过验证码；
- 不采集他人简历、联系方式等个人信息；
- 只处理用户主动提供或公开/官方数据；
- 最小权限 + 敏感字段加密存储；
- 明确告知用户：AI 只做建议，关键动作由用户确认；
- 用户数据不用于模型训练。

**BYOK 密钥专项（G-12）**
- 密钥以 AES-256-GCM 密文存储，主密钥 `ENCRYPTION_KEY` 只存在于服务端环境变量（本地模式下即用户自己的 `.env`）；
- **密钥永不回传前端**：保存后表单只显示 `key_last4`，客户端读不到密文明文；
- 凭证表 `user_llm_credentials` 读写仅经服务端，不对客户端开放 SELECT；
- 日志 / LangFuse / 错误信息统一脱敏（正则过滤 `sk-`、`Bearer` 等模式 + 字段白名单），密钥泄漏视为 P0 bug；
- **本地模式开放任意 `base_url`**（含 one-api / new-api / OpenRouter 等中转站）；仅私网地址（Ollama / vLLM）需 `ALLOW_PRIVATE_BASE_URL=true`；
- 无状态 Demo **只允许预设 provider、不接受自定义 `base_url`**，且不接受任何用户密钥。

**数据流向告知（D-05 已裁决）**
- 粘贴 / 上传时检测手机号、邮箱、身份证号，提示"这段文本将被发送给你配置的模型服务商"；
- 提供"脱敏后发送"开关（默认关闭）；
- 隐私政策改为"**数据留在你的机器上**"叙事：本工具不收集、不上传任何个人数据，唯一外发行为是你主动触发的模型调用。

## 6. Demo 版技术栈 vs 后续扩展

**Demo 版最小技术栈（P0–P2）**
- Next.js + TypeScript + Tailwind + shadcn/ui
- **Docker Compose + Supabase 本地栈**（Postgres + pgvector + Storage；Auth 可选）+ **一键启动脚本**
- **Provider 适配层**（OpenAI 兼容 + 能力探测 + 降级）+ 用户 BYOK（最小版设置页）+ Vercel AI SDK + Zod
- 飞书 Webhook + Resend 邮件 + Supabase Cron（日扫 + 小时扫）
- **无状态只读 Demo 部署**（Vercel）
- Promptfoo 基础评测 + Vitest

**后续扩展（P3–P5）**
- 浏览器插件：Plasmo / WXT
- 完整多 provider 设置页 + 密钥轮换 + 用量面板（**本地 Docker 自托管已进 Demo 版主路径**）
- 合规数据源：国聘、NCSS、政府开放数据
- Agent 工作流：Inngest / Trigger.dev
- 可观测：LangFuse + Sentry + PostHog
- 国内部署备选：腾讯云开发 CloudBase / 阿里云
- PDF 导出：中文字体嵌入 + ATS 友好文本层

## 7. 明确不采用

| 不采用 | 原因 |
|---|---|
| Scrapy / Playwright 抓取 BOSS、猎聘、智联 | 合规风险高，已有判赔案例 |
| Apify Actor 等第三方托管抓取 | 本质仍是未授权抓取，与合规原则冲突 |
| 自动投递、自动打招呼、批量群发 | 平台风控 + 账号封禁风险 |
| 采集候选人简历与联系方式 | 违反《个人信息保护法》 |
| 展示页开放任意 `base_url` | SSRF 与"把平台当 LLM 代理"的滥用风险 |
| LangChain 全家桶 | Demo 版用 Vercel AI SDK + 原生 SDK 更轻 |
| 一开始就做小程序/SaaS | 合规与审核成本过高 |
| 自建数据库/任务队列/K8s | 个人项目运维成本不划算（开源自托管用 Docker Compose 即可） |

## 8. Visit Processing Pipeline（代理访问完整流程）

### 8.1 设计原则

- **用户主动触发**：所有处理由用户点击、粘贴、上传发起，不做后台静默扫描。
- **分层解耦**：采集 → 清洗 → 结构化 → 校验 → 入库 → 向量化 → 通知，每层可独立替换。
- **幂等可重试**：同一条 JD 重复提交不产生重复记录，失败可单独重试。
- **证据可追溯**：每个结构化字段保留原文片段和来源，便于人工核对。
- **人在回路**：关键字段（薪资、截止时间）必须用户确认后才写入。
- **供应商可替换**：所有 AI 调用经 Provider 适配层，凭证由凭证服务解析。

### 8.2 完整流程

```text
┌──────────────────────────────────────────────────────────────┐
│ 阶段 1：触发与采集                                             │
│ 入口：手动粘贴 / 简历上传 / 插件侧边栏 / 合规数据源导入         │
│ 输出：RawInput { source, rawText, url?, capturedAt, userId }  │
└──────────────────────────┬───────────────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────────────┐
│ 阶段 2：清洗与归一化                                           │
│ - 去除 HTML 标签、多余空行、乱码                               │
│ - 统一全角/半角、日期格式、薪资单位、城市别名                  │
│ - 检测语言、PII（手机号/邮箱/身份证）脱敏标记                  │
│ - 超长文本处理：≤8000 字符直接抽取；>8000 按段落边界分段       │
│   （每段 ≤4000 字符），记录 warnings 供阶段 3 分段抽取后合并    │
│ 输出：CleanText { segments[], language, charCount, warnings[] } │
└──────────────────────────┬───────────────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────────────┐
│ 阶段 3：结构化抽取                                             │
│ - 解析用户凭证（BYOK）或平台密钥 → Provider 适配层              │
│ - 能力探测：无 tool_calling 则降级为 Prompt-JSON               │
│ - 字段：见 §9.2.0 字段字典（18 个字段编号 / 约 22 个字段值）    │
│ - 每字段附带 evidence（原文片段）和 confidence（0-1）           │
│ 输出：StructuredJD { fields, evidence, confidence }           │
└──────────────────────────┬───────────────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────────────┐
│ 阶段 4：校验与兜底                                             │
│ - Zod Schema 校验类型与必填                                    │
│ - 规则校验：薪资范围合理性、日期合法性、城市白名单              │
│ - confidence < 0.7 → 标记"待确认"                              │
│ - 关键字段（薪资/截止时间）无 evidence → 强制待确认             │
│ - 校验失败 → 降级为原文存储 + 提示用户手动补全                  │
│ 输出：ValidatedJD { valid, errors[], needsReview[] }          │
└──────────────────────────┬───────────────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────────────┐
│ 阶段 5：去重与入库                                             │
│ - 指纹 fingerprint = hash(归一化company + 归一化title + 排序后cities) │
│ - 唯一索引 (user_id, fingerprint)，重复 → 提示合并或跳过        │
│ - **一等列是唯一真源**；jd_structured 仅存 LLM 原始输出 +       │
│   evidence + confidence + 长尾字段（不参与筛选与展示）          │
│ - 重解析只更新 jd_structured；一等列须用户逐字段确认后才覆盖    │
│ - needsReview 落库：jd_structured.needsReview + jobs.review_flags │
│ - 写入 jobs 表，默认状态 = saved；确认页可勾选"直接标为待投递"  │
│ 输出：JobRecord { id, status, ... }                           │
└──────────────────────────┬───────────────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────────────┐
│ 阶段 6：向量化与索引                                           │
│ - 分段：JD 按 职责/要求/技能 三段；经历按 STAR 四段 + summary  │
│ - Embedding（BGE-M3 或用户配置）→ pgvector，异步不阻塞主流程    │
│ - 未配置 Embedding → 退化为 tsvector 关键词索引                │
│ - 记录 embedding_model / embedding_dim / prompt_version / content_hash │
│ - 失败进入重试队列                                             │
│ 输出：EmbeddingRecord { jobId, chunkId, vector }              │
└──────────────────────────┬───────────────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────────────┐
│ 阶段 7：后续动作                                               │
│ - 触发匹配评分（P2）：混合召回 Top10 → 规则重排 Top5 → §10.1 五维打分 │
│ - 生成打招呼语（P2）                                           │
│ - 设置截止提醒（P1）：T-3/T-1/T-0                              │
│ - 写 llm_usage_logs（tokens/成本）+ processing_logs           │
│ - 写 LangFuse 追踪（脱敏，禁止记录密钥）                        │
└──────────────────────────────────────────────────────────────┘
```

#### 8.2.1 分支 B：简历解析流水线（A11，P1）

```text
阶段 B1：上传与文本抽取
- PDF：pdfjs-dist / unpdf（仅文本层）；DOCX：mammoth
- 扫描件 / 图片型 PDF → 直接拒绝，提示"暂不支持 OCR，请粘贴文本"
- PII 检测与脱敏标记（与 JD 流程共用）
输出：ResumeText { text, pageCount, piiFlags[], warnings[] }

阶段 B2：段落切分与经历边界识别
- 用标题/时间线正则 + LLM 辅助，切出"教育 / 实习 / 项目 / 科研 / 社团"块
- 每个块 → 一条经历草稿（type / org / role / start_date / end_date / raw_text）
输出：DraftExperience[]（未确认）

阶段 B3：逐条结构化（复用 A2 逻辑）
- 每条草稿跑 STAR 四段抽取 + 技能词表归一 + 量化结果提取
- 单条失败不影响其他条，逐条可重试

阶段 B4：人工确认入库
- UI 逐条展示草稿，用户编辑 / 合并 / 丢弃后写入 experiences
- 未确认草稿保留 7 天后清理
```

**A2 与 A11 的分工（B-08）**：A2 = 单段原文 → STAR；A11 = 整份简历 → 多条草稿 → 逐条走 A2 逻辑确认。

### 8.3 阶段与路线图对应

| 阶段 | P0 | P1 | P2 | P3 | P4 |
|---|---|---|---|---|---|
| 触发与采集 | 脚本验证 → 首周末转 Web | ✅ Web | ✅ | ✅ | ✅ 插件/数据源 |
| 清洗归一化 | 简单 | ✅ | ✅ | ✅ | ✅ |
| 结构化抽取 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 校验兜底 | 基础 | ✅ | ✅ | ✅ | ✅ |
| 去重入库 | 内存 | ✅ DB | ✅ | ✅ | ✅ |
| 向量化 | ❌ | ❌ | ✅ | ✅ | ✅ |
| 后续动作 | ❌ | 提醒 | 匹配/生成 | 版本 | 推荐 |

## 9. 数据库与表结构

### 9.1 ER 关系概览

```text
users ──┬── jobs ──┬── job_events（状态流转日志）
        │          ├── job_interviews（面试轮次）
        │          ├── job_embeddings（JD 向量）
        │          └── job_reminders（提醒）── notification_logs（发送日志）
        │
        ├── experiences ── experience_embeddings（经历向量）
        │
        ├── resumes ── resume_jobs（哪版投了哪个岗位）
        │
        ├── materials（生成的话术）
        │
        ├── attachments（简历 PDF / JD 截图）
        │
        ├── llm_credentials（模型密钥，服务端专用）── llm_usage_logs（用量与成本）
        │
        ├── skills / skill_aliases（技能受控词表）
        │
        └── processing_logs（处理管线日志）
```

> 注：`experience_evidence` 不再单列成表，证据链接保留在 `experiences.evidence_urls`（C-02 已裁决，见 `logs/decisions_log.md`）。

### 9.2 核心表设计

#### 9.2.0 字段字典 v1（G-01）

`jd_structured` 存完整字段；`jobs` 一等列只保留列表/筛选/排序/匹配真正用到的字段。

| # | 字段 | 类型 | 必填 | 归一化口径 | 人工确认 |
|---|---|---|---|---|---|
| 1 | company | text | 是 | 去空白、统一全半角；保留原始后缀用于展示，指纹用去后缀版本 | 否 |
| 2 | title | text | 是 | 保留原值展示；指纹用去括号后缀版本 | 否 |
| 3 | job_type | enum | 否 | 校招 / 社招 / 实习 / 提前批 / 未知 | 否 |
| 4 | graduation_year | int | 否 | "2027届"/"2027年毕业" → 2027 | 否 |
| 5 | cities | text[] | 是 | 城市别名归一（如"帝都"→北京）；"全国"/"多地"→空数组 + warning | 否 |
| 6 | work_mode | enum | 否 | onsite / hybrid / remote / 未知 | 否 |
| 7 | salary_min / salary_max | int | 否 | 元/月；"15k-25k"→15000/25000；"年薪 30 万"→换算月 | **是** |
| 8 | salary_months | int | 否 | "14 薪" → 14 | 否 |
| 9 | salary_negotiable | bool | 否 | "面议"/"薪资面谈" → true，min/max 置空 | **是** |
| 10 | education | enum | 否 | 不限 / 大专 / 本科 / 硕士 / 博士 | 否 |
| 11 | experience_years | jsonb | 否 | `{min, max, unlimited}`；"3-5 年"→{3,5}；"不限"→{unlimited:true} | 否 |
| 12 | skills | text[] | 否 | 经 `skills` 词表 + `skill_aliases` 归一；未命中词表的新词进"待审词"。**技能属性（明确/推测、必需性、熟练度）见 `job_skills` 表（R-4）** | 否 |
| 13 | deadline | timestamptz | 否 | 仅给日期时取当日 23:59:59+08:00。**可选**：JD 未提供截止日期是合法状态（三态 `provided`/`text_only`/`absent`，见 F-02 §2.5.3） | **仅 `provided` 态** |
| 14 | deadline_text | text | 否 | 原文片段（如"11 月 20 日前"）；模糊表述"长期有效/招满为止"也记于此 | 否 |
| 15 | channel | text | 否 | 官网 / BOSS / 猎聘 / 国聘 / NCSS / 内推 / 其他 | 否 |
| 16 | is_referral / referral_code | bool / text | 否 | | 否 |
| 17 | source / source_url | text | 是 / 否 | manual / guopin / ncss / resume_import / plugin | 否 |
| 18 | raw_text | text | 是 | 原文，永不改写 | 否 |

每个字段在 `jd_structured` 中同时携带 `evidence`（原文片段）与 `confidence`（0–1）。

#### users（Supabase Auth 托管，扩展 profile）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键，关联 auth.users |
| email | text | 登录邮箱 |
| timezone | text | 默认 `Asia/Shanghai` |
| target_roles | text[] | 目标岗位方向 |
| nearby_city_groups | jsonb | 邻近城市组（如 `[["上海","苏州","杭州"],["北京","天津"]]`），供 §10.1 城市维度使用 |
| target_job_types | text[] | 目标招聘类型（校招/社招/实习） |
| graduation_year | int | 毕业届别 |
| primary_resume_id | uuid | 主简历（用于简历视图默认结构） |
| notification_prefs | jsonb | 渠道开关、提前量偏好 |
| feishu_webhook_url | text | 加密存储 |
| quiet_hours | jsonb | 免打扰时段 |
| deploy_mode | text | self_host / hosted / byok |
| llm_quota_daily | int | 展示页每日调用上限（**本地模式为 null**） |
| invite_code | text | 内测邀请码（**本地优先下不再需要**，保留列仅为省一次 migration） |
| created_at | timestamptz | |

> **C-10 已裁决（本地优先）**：`users` 表保留以兼容 Supabase Auth，但**本地单用户模式下只有一行、甚至不启用**；RLS 从"多租户隔离"退化为"单用户约束"。`invite_code` / `llm_quota_daily` 在本地优先下不使用（不删列，避免 migration 往返），`deploy_mode` 仍用于区分 local / demo。

#### jobs（岗位库）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| user_id | uuid | 外键 → users |
| company | text | 公司名（一等列 = 真源） |
| title | text | 岗位名 |
| job_type | text | 校招/社招/实习/提前批 |
| graduation_year | int | 届别 |
| city | text | 主城市（展示用） |
| cities | text[] | 全部城市（筛选用） |
| work_mode | text | onsite/hybrid/remote |
| salary_min | int | 薪资下限（元/月） |
| salary_max | int | 薪资上限 |
| salary_months | int | 几薪 |
| salary_negotiable | boolean | 是否面议 |
| education | text | 学历要求 |
| experience_years | jsonb | `{min,max,unlimited}` |
| skills | text[] | 技能关键词（经词表归一） |
| deadline | timestamptz | 投递截止（含时刻） |
| source | text | manual/guopin/ncss/resume_import/plugin |
| source_url | text | 原始链接 |
| channel | text | 投递渠道 |
| is_referral / referral_code | boolean / text | 内推 |
| raw_text | text | JD 原文 |
| jd_structured | jsonb | **仅存** LLM 原始输出 + evidence + confidence + 长尾字段（不参与筛选展示）；含 `needsReview[]` |
| review_flags | text[] | 待确认字段名列表（如 `{salary_min,deadline}`），驱动 UI 高亮与"待确认"筛选 |
| status | text | 见 §3.5 状态枚举 |
| priority | text | 高/中/低（用户手填，默认中） |
| match_score | numeric | 匹配评分 0–100（P2） |
| next_action | text | 下一步动作（建议后经用户确认写入） |
| next_action_at | timestamptz | 下次跟进时间 |
| offer_deadline | date | Offer 答复期限 |
| offer_salary | jsonb | Offer 薪资结构 |
| fingerprint | text | 去重指纹（见 §8.2 阶段 5） |
| deleted_at | timestamptz | 软删除标记 |
| created_at / updated_at | timestamptz | |

索引：`(user_id, status)`、`(user_id, deadline)`、`(user_id, deleted_at)`、**`(user_id, fingerprint)` 唯一**。

#### experiences（经历库）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| user_id | uuid | 外键 |
| type | text | internship/project/research/club |
| org | text | 组织/公司/实验室 |
| role | text | 角色 |
| start_date / end_date | date | |
| summary | text | 一句话概述 |
| star_situation / star_task / star_action / star_result | text | STAR 四段 |
| skills | text[] | 技能标签（经词表归一） |
| metrics | jsonb | 量化结果 |
| evidence_urls | text[] | 证据链接（GitHub/论文/作品） |
| raw_text | text | 原始描述 |
| deleted_at | timestamptz | 软删除标记 |
| created_at / updated_at | timestamptz | |

索引：`(user_id, type)`、`(user_id, deleted_at)`、`skills` GIN 索引。

#### job_interviews（面试轮次，G-04）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| user_id | uuid | 外键（RLS 直接校验） |
| job_id | uuid | 外键 → jobs |
| round | int | 轮次序号 |
| type | text | 一面/二面/三面/HR面/群面/技术面 |
| scheduled_at | timestamptz | 面试时间（驱动提醒与日历） |
| duration_min | int | 时长 |
| format | text | 线上/线下 |
| location | text | 地点或会议链接 |
| interviewer | text | 面试官（可空） |
| result | text | pending/pass/fail |
| note | text | 备注 |
| created_at | timestamptz | |

#### job_events（状态流转日志）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| user_id | uuid | 外键（RLS 直接校验） |
| job_id | uuid | 外键 |
| from_status | text | 原状态 |
| to_status | text | 新状态 |
| note | text | 备注（回退必填） |
| occurred_at | timestamptz | |
| created_at | timestamptz | |

#### job_embeddings / experience_embeddings（向量表）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| user_id | uuid | 外键（冗余，RLS 直接校验） |
| job_id / experience_id | uuid | 外键 |
| chunk_index | int | 分段序号 |
| chunk_type | text | jd_duty/jd_require/jd_skill 或 star_s/star_t/star_a/star_r/summary |
| chunk_text | text | 原文片段 |
| embedding | vector(1024) | 维度由 embedding_dim 约束 |
| embedding_model | text | 如 `bge-m3`、`text-embedding-3-small` |
| embedding_dim | int | 冗余记录维度，便于换模型重建 |
| prompt_version | text | 生成该向量时的版本 |
| content_hash | text | 分块内容哈希，用于增量重建 |
| created_at | timestamptz | |

索引：`hnsw` 向量索引（个人数据量级无需调 `lists`）+ `(user_id, content_hash)` 普通索引。

#### job_reminders（提醒）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| user_id | uuid | 外键 |
| job_id | uuid | 外键 |
| interview_id | uuid | 可空，面试类提醒关联 `job_interviews` |
| type | text | deadline/followup/written_test/interview/offer |
| remind_at | timestamptz | 具体触发时刻 |
| channel | text | **已废弃（A 类裁决）**：一个提醒可发多渠道，渠道由 `users.notification_prefs` 展开，每个渠道一条 `notification_logs` |
| is_urgent | boolean | 是否豁免免打扰 |
| sent | boolean | 是否已发送 |
| sent_at | timestamptz | |
| created_at | timestamptz | |

#### notification_logs（发送日志，G-08）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| user_id | uuid | 外键 |
| reminder_id | uuid | 外键 |
| channel | text | feishu/email |
| status | text | success/failed/retry |
| error | text | 脱敏后的错误信息 |
| attempt | int | 第几次尝试 |
| created_at | timestamptz | |

唯一约束：`(reminder_id, channel)` —— 保证同一提醒同一渠道只成功发送一次。

#### resumes（简历版本快照）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| user_id | uuid | 外键 |
| version | int | 版本号 |
| content | jsonb | 简历结构化内容 |
| pdf_url | text | Supabase Storage 路径 |
| created_at | timestamptz | |

#### resume_jobs（哪版简历投了哪个岗位）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| user_id | uuid | 外键 |
| resume_id | uuid | 外键 → resumes |
| job_id | uuid | 外键 → jobs |
| sent_at | timestamptz | 投出时间 |
| note | text | |

> `resumes.job_id` 字段取消，统一由 `resume_jobs` 表达多对多关系（C-03 已裁决，见 `logs/decisions_log.md`）。

#### materials（生成的话术）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| user_id | uuid | 外键 |
| job_id | uuid | 外键 |
| type | text | greeting/bullet/interview_q |
| content | text | 生成内容 |
| evidence_refs | jsonb | 每条 claim 的出处：`[{experience_id, field, quote, char_start, char_end}]`（C-15 已裁决：引文 + 字符偏移，支持自动字面校验与原文高亮） |
| prompt_version | text | 生成时的 Prompt 版本 |
| model | text | 生成用的 provider/model |
| tokens | int | 消耗 token |
| confirmed | boolean | 用户是否确认 |
| created_at / updated_at | timestamptz | |

#### llm_credentials（模型凭证，服务端专用，G-12）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| user_id | uuid | 外键 |
| provider | text | deepseek/qwen/kimi/glm/siliconflow/openai/ollama/custom |
| base_url | text | OpenAI 兼容端点 |
| encrypted_api_key | bytea | AES-256-GCM 密文 |
| key_last4 | text | 仅用于 UI 展示 |
| model_prefs | jsonb | `{extract, generate, embed, rerank}` → provider/model |
| capabilities | jsonb | 探测结果：tool_calling/json_schema/stream/embedding/context_window |
| status | text | active/invalid/untested |
| last_verified_at | timestamptz | 最近一次冒烟校验 |
| last_used_at | timestamptz | |
| created_at / updated_at | timestamptz | |

#### llm_usage_logs（用量与成本，G-12）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| user_id | uuid | 外键 |
| credential_id | uuid | 可空（平台密钥时为空） |
| provider / model | text | 实际调用方 |
| task | text | extract/generate/embed/rerank |
| prompt_tokens / completion_tokens | int | |
| cost_estimate | numeric | 按 provider 单价估算（元） |
| latency_ms | int | |
| cache_hit | boolean | |
| created_at | timestamptz | |

#### attachments（附件）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| user_id | uuid | 外键 |
| job_id | uuid | 可空 |
| type | text | resume_pdf/jd_screenshot/other |
| storage_path | text | Supabase Storage 路径 |
| mime / size | text / int | |
| ocr_text | text | 截图解析文本（如做 OCR） |
| created_at | timestamptz | |

#### memory_cards（求职记忆卡，A17 可选增量）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| user_id | uuid | 外键 |
| kind | text | stage_summary / preferences / rejection_patterns / effective_phrases / open_questions |
| content | jsonb | 记忆内容 |
| refs | jsonb | **必须带引用**：`[{type: job|event|material, id}]`，避免记忆变成"模型想象" |
| source_window | tstzrange | 覆盖的事件时间窗 |
| edited_by_user | boolean | 用户是否手工修正过 |
| created_at / updated_at | timestamptz | |

> 使用规则：生成话术/建议时按 `kind` 检索注入，并在结果中标注"本次使用了哪几张记忆卡"；用户可查看、编辑、删除（记忆必须可控）。

#### skills / skill_aliases（技能受控词表，C-07）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| name | text | 规范名（如 JavaScript） |
| category | text | 语言/框架/工具/业务/证书 |
| aliases | text[] | 别名（JS、ECMAScript）——或独立 `skill_aliases` 表 |
| status | text | active/pending_review（新词待审） |

> **C-07 已裁决**：预置约 200 个常见技术/业务技能 + 别名作为初始词表；抽取时未命中的新词自动写入 `status = pending_review`，用户在设置页一键确认后转 `active`。

#### processing_logs（处理管线日志）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 主键 |
| user_id | uuid | |
| stage | text | clean/extract/validate/embed |
| input_hash | text | 输入指纹（含 prompt_version + model） |
| status | text | success/failed/retry |
| error | text | 脱敏后的错误信息 |
| model | text | 使用的模型 |
| prompt_version | text | |
| cache_hit | boolean | |
| latency_ms | int | 耗时 |
| tokens | int | 消耗 token |
| created_at | timestamptz | |

### 9.3 RLS 策略

所有业务表启用 RLS，策略统一为：

```sql
create policy "users own their data"
on jobs for all
using (auth.uid() = user_id);
```

向量表通过冗余 `user_id` 直接校验归属。

**凭证表例外（G-12）**：`llm_credentials` 启用 RLS 但**不给 `authenticated` 授予 SELECT/INSERT/UPDATE**；读写只经服务端 service role。客户端仅可通过 `get_credential_summary()` RPC 读取 `provider / base_url / key_last4 / status / last_verified_at` 等脱敏字段。

## 10. 处理方法矩阵

| 环节 | 方案 A | 方案 B | 方案 C | 推荐 | 理由 |
|---|---|---|---|---|---|
| **文本清洗** | 正则规则 | 规则 + LLM 摘要 | 纯 LLM | 规则 + LLM 摘要 | 规则快、便宜；LLM 处理长文本摘要 |
| **JD 结构化** | 纯规则模板 | LLM + Function Calling | 微调小模型 | LLM + FC（不支持则 Prompt-JSON 降级） | 泛化好，零训练，格式可控；BYOK 需兼容异构模型 |
| **经历结构化** | 用户手动填 | LLM 从原文抽取 | 混合：LLM 草稿 + 人工确认 | 混合 | 经历是核心资产，必须人工把关 |
| **去重** | 精确 hash | 模糊匹配（编辑距离） | 向量相似度 | 精确 hash + 向量兜底 | 先精确后模糊，成本低 |
| **匹配评分** | 纯规则加权 | 纯向量相似度 | RAG 召回 + LLM 重排 | 混合召回 + **规则加权打分**（LLM 只出差距提示） | 兼顾语义与硬性条件，且结果可复现、可评测 |
| **话术生成** | 模板填空 | LLM 自由生成 | RAG + 约束生成 | RAG + 约束 | 有证据、不编造 |
| **提醒调度** | 轮询 Cron | 事件驱动 | 工作流引擎 | Cron（日扫 + 小时扫）+ 工作流 | Demo 版用 Cron，复杂后上 Inngest |
| **密钥管理** | 环境变量单密钥 | 每用户加密存储（BYOK） | 第三方密钥托管 | 每用户加密存储 + 环境变量兜底 | 开源必须支持 BYOK；避免引入第三方依赖 |
| **邮件解析** | 全量 IMAP | 关键词过滤 + 单封触发 | 专用邮箱 | 关键词过滤 + 手动触发 | 最小必要 + 用户控制 |
| **PDF 解析** | pdfplumber | PyMuPDF | 云服务 | PyMuPDF | 中文支持好，本地可控 |
| **PDF 生成** | Puppeteer | react-pdf | LaTeX | react-pdf | 前端一体，中文可控 |
| **向量检索** | pgvector | Pinecone | Qdrant | pgvector + tsvector 混合 | 与业务同库，少一个组件；关键词场景更稳 |
| **LLM 调用** | 单模型 | 多模型路由 | 本地模型 | Provider 适配 + 任务级路由 | 成本与可用性平衡，BYOK 可替换 |

### 10.1 五维匹配评分定义（G-07）

| 维度 | 权重 | 计算方式 | 数据来源 | 缺失处理 |
|---|---|---|---|---|
| 技能 | 0.35 | `Σ技能要求强度×命中程度 / Σ技能要求强度`；要求强度 = 熟练度权重 × 必需性权重（见下） | `job_skills` ↔ `experiences.skills`（经词表归一） | JD 无技能字段 → 该维剔除并按剩余权重重归一化 |
| 经验 | 0.25 | JD `experience_years` 区间 vs 用户相关经历总时长；落在区间内 = 1，不足按下限比例衰减，超出上限不扣分 | `experience_years` + `experiences` 日期 | JD 写"不限" → 该维剔除 |
| 学历 | 0.15 | 等级映射：大专 1 / 本科 2 / 硕士 3 / 博士 4；≥ 要求 = 1，低一级 = 0 | `jobs.education` + 用户档案 | JD 未写 → 剔除。**默认不引入 985/海外偏好**，避免歧视性口径 |
| 城市 | 0.15 | 精确命中 = 1；命中用户配置的"邻近城市组"（需显式配置）= 0.7；remote = 1；其余 = 0 | `jobs.cities` + `users.target_cities` + `users.nearby_city_groups` | JD 城市为"全国/多地" → 剔除 |
| 薪资 | 0.10 | 期望薪资落入 JD 区间 = 1；低于下限按差额比例衰减；高于上限不扣分 | JD 薪资 + 用户期望 | `salary_negotiable = true` 或无薪资 → 剔除 |

**总分形态**：`总分 = Σ(子分 × 权重) / Σ(参与维度权重) × 100`，输出 0–100 连续分，同时映射三级标签（≥80 高 / 60–79 中 / <60 低）以对齐评测标注集。

#### 10.1.1 技能维度的属性权重（R-4，2026-10-23）

技能不再是"要/不要"的二元判断，而是带三个**正交**属性的结构（存 `job_skills` 表）：

```
单个技能要求强度 = proficiency_weight × requirement_weight

proficiency_weight：expert 1.0 / proficient 0.8 / familiar 0.6 / basic 0.4 / unknown 0.5
requirement_weight：must ×2（沿用 G-07 的"必须加倍"）/ nice_to_have ×1 / unknown ×1
```

- **显式 vs 推测**：`explicit` 直接计入；`inferred` 需再乘 `SKILL_INFER_WEIGHT`（默认 0.5，R2-01 裁决）。
- **命中程度**：用户该技能水平 ≥ 要求等级 = 1；低一级 = 0.6；低两级 = 0.3；不具备 = 0。
- **可解释输出**（强制）：`技能 0.72 = 显式 5/7 + 推测 2/4×0.5`，用户可核对。
- **"仅用显式"开关**：关闭推测参与后按剩余权重重归一化。

**`job_skills` 表（JD 侧技能属性，供明细导出与差距分析）**

| 列 | 类型 | 说明 |
|---|---|---|
| id / user_id / job_id | uuid | |
| skill | text | 经 C-07 词表归一（`skills` 表外键语义） |
| source | text | `explicit`（JD 明说）/ `inferred`（领域推理） |
| requirement | text | `must` / `nice_to_have` / `unknown` |
| proficiency | text | `expert` / `proficient` / `familiar` / `basic` / `unknown` |
| confidence | numeric | 抽取/推理置信度（0–1） |
| basis_phrase | text | 触发该属性的**原文短语**（强制，无依据则属性记 unknown） |
| rule_id | text | 当 `source=inferred` 时指向技能图谱规则（可追溯） |

唯一约束：`(job_id, skill, source)`。索引：`(user_id, skill)`、`(job_id)`。

#### 10.1.2 技能差距分（回答"先补什么"，由 F-04 实现）

```
差距分(skill) = Σ over jobs( 岗位优先级权重 × 单个技能要求强度 × (1 − 我的水平权重) ) / 要求该技能的岗位数

岗位优先级权重：高 1.0 / 中 0.7 / 低 0.4（jobs.priority）
我的水平权重：expert 1.0 / proficient 0.8 / familiar 0.6 / basic 0.4 / 不具备 0
```

- 输出按差距分降序 → 第一行就是"最该先补的技术栈"；
- **我的水平来源**：I1/I2 用工作区自评表 `我的技能.csv`（`技能, 我的水平`）；I2 之后以 `experiences.skills` 为主、自评补充；
- 无自评数据时该列留空、差距分不计算（不做默认猜测）。

#### 10.1.3 技能分列规范（F-02 导出层，取代着色方案）

**背景**：希望"一眼区分 JD 明确要求 vs 领域推测"。**CSV 无法保存单元格颜色**，
且不为颜色引入 XLSX 依赖或生成重复表 → 改为**分列**：把不同来源/必需性的技能放进不同列。

**主表（`岗位管理表.csv`）3 个技能列**

| 列名 | 内容 | 判定 |
|---|---|---|
| `技能·明确(必须)` | `Java(精通);MySQL(熟练)` | `source=explicit` + `requirement=must` |
| `技能·明确(加分)` | `Kubernetes(熟悉);Go` | `source=explicit` + `requirement=nice_to_have`（`unknown` 也归此列） |
| `技能·推测` | `TensorFlow(0.4←"深度学习")` | `source=inferred`，**必须**带置信度与依据短语 |

- 括号内：明说列写熟练度（精通/熟练/熟悉/了解，未标注省略）；推测列写 `置信度←依据短语`；
- 三列**互斥**（依赖 `job_skills` 的 `(job_id, skill, source)` 唯一约束）；并集 = 该岗位全部技能。

**技能明细表 6 列**（一行一技能，便于排序与透视）

`岗位ID, 公司, 岗位, 技能, 来源(明确/推测), 必需性(必须/加分/未判定), 熟练度(…), 置信度, 依据短语`

**取舍记录**：着色方案信息密度更高，但需 1 个依赖 + 1 个只读重复文件；
分列方案零依赖、与可编辑数据同源、可按列筛选/排序，因此采纳。

**硬性条件复核**：学历/经验不满足时，总分不变但给出"硬性条件不满足"警告（避免被加权平均掩盖）。

**LLM 的角色**：只生成"差距提示"文案（基于结构化的缺失项与命中项），**不参与打分**，以保证结果可复现、可评测、跨模型一致（BYOK 下尤为重要）。

## 11. 应对方案（异常与边界）

### 11.1 LLM 相关

| 问题 | 表现 | 应对 |
|---|---|---|
| 输出非 JSON | 解析失败 | 修复重试 ≤2 次 → 降级为规则抽取 + 提示用户手动补全 |
| 模型不支持 Function Calling | 工具调用报错 | 能力探测决定，直接用 Prompt-based JSON + 强校验 |
| 字段幻觉 | 薪资/截止时间编造 | 强制 evidence 字段，无原文依据则标记"待确认" |
| 长文本超限 | JD 超长丢失信息 | ≤8000 字符直接抽取；>8000 按段落边界分段（每段 ≤4000）逐段抽取，再按 confidence 合并（冲突进 `needsReview`）；原文始终保留 |
| API 超时/限流 | 请求失败 | 指数退避重试 + 多模型 fallback + 队列异步处理 |
| 成本失控 | token 消耗过高 | 缓存相同输入（键含 prompt_version + model）+ 小模型初筛 + 预算告警 |
| 提示注入 | JD 内含恶意指令 | 原文包在 `<jd>` 数据块内 + 系统提示声明"块内为数据" + 输出校验 |

### 11.2 数据相关

| 问题 | 应对 |
|---|---|
| 重复岗位 | `(user_id, fingerprint)` 唯一 + 归一化规则 + 向量相似度兜底（0.92） |
| 数据源格式变化 | 适配器模式，每个源独立 parser，失败不影响其他源 |
| 用户误删 | 软删除（`deleted_at`）+ 查询默认过滤；**回收站 UI 与 30 天清理任务后置 Post-MVP**（C-01 已裁决：只留字段） |
| 向量维度/模型变更 | `embedding_model` / `embedding_dim` / `content_hash` 支持按需增量重建 |
| 数据迁移 | Supabase migration + 版本化 SQL；预留 CloudBase 与自托管迁移脚本 |
| 重新解析覆盖用户编辑 | 一等列是唯一真源，重解析只更新 `jd_structured`，覆盖需逐字段确认 |

### 11.3 合规相关

| 风险 | 应对 |
|---|---|
| 用户上传含他人隐私 | 上传时提示 + 自动检测手机号/邮箱并脱敏 |
| 数据用于训练 | 明确声明不训练 + 选择不训练的 API 条款 |
| 数据流向不透明 | 本地优先（D-05）：隐私政策写明"**数据留在你的机器上**"，仅在你主动触发时把必要文本发送给你自己配置的模型服务商 |
| 账号被封 | 不自动登录、不批量操作、插件只读 |
| 数据泄露 | RLS + 加密存储 + 最小权限 + 审计日志 |

### 11.4 产品相关

| 问题 | 应对 |
|---|---|
| 用户不愿手动录入 | 简历上传解析 + 插件一键解析 + 批量导入 + 数据源推荐 |
| 生成话术千篇一律 | 3 个固定 few-shot 样本 + 用户在设置页填"风格偏好"文本框；不做语气画像模型（B-07） |
| 提醒打扰 | 分级提醒 + 免打扰时段 + 用户自定义频率 |
| 匹配不准 | 评测集持续迭代 + 用户反馈按钮（准/不准） |
| 用户只有国内小模型 | 能力探测 + 降级链保证基本可用；无密钥时规则模式兜底 |

### 11.5 BYOK 与 Provider 相关（G-12）

| 问题 | 表现 | 应对 |
|---|---|---|
| 密钥无效/过期 | 401 / 403 | 标记 `status=invalid`，站内提示用户更新，AI 功能降级为规则模式 |
| 余额不足/限流 | 429 / quota exceeded | 指数退避 + 提示用户；有备用凭证时自动切换 |
| 自定义端点不可达 | 连接超时 | **保存阶段**冒烟测试即拒绝，给出明确原因，不写入凭证 |
| 模型能力不足 | 无 tool_calling / 上下文过小 | 能力探测写入 `capabilities`，走 Prompt-JSON 降级或分段调用 |
| 密钥泄漏 | 日志/错误信息含 Key | 统一脱敏（正则 + 字段白名单），泄漏按 P0 bug 处理并支持一键轮换 |
| SSRF / 代理滥用 | 展示页被拿去转发任意内容 | **展示页只允许预设 provider、不接受自定义 `base_url` 与用户密钥**；**本地模式开放任意 `base_url`（含第三方中转站 one-api / new-api / OpenRouter）**，仅私网地址需 `ALLOW_PRIVATE_BASE_URL=true` |
| 用户 Key 与平台 Key 混用 | 计费归属不清 | 每次调用记录 `credential_id`（平台密钥为空），用量日志可区分 |

## 12. 测试策略

### 12.1 测试分层

| 层级 | 工具 | 覆盖范围 | Demo 版 |
|---|---|---|---|
| 单元测试 | Vitest | 工具函数、Zod schema、状态机、评分算法、凭证加解密 | ✅ |
| 组件测试 | Testing Library | 表单、看板、卡片 | P1 |
| E2E | Playwright | 粘贴 JD → 入库 → 状态流转（本地 `supabase start` 环境） | P1 |
| Prompt 评测 | Promptfoo | 抽取准确率、生成质量 | ✅ |
| RAG 评测 | Ragas | 召回率、忠实度、相关性 | P2 |
| 契约测试 | Zod + 类型 | 前后端 schema 一致 | ✅ |
| RLS / 数据隔离测试 | 双用户用例脚本（**仅多账号模式**） | 用户 A 无法读取用户 B 的 jobs/experiences/凭证 | P2 |
| Provider 兼容性测试 | 多 provider 冒烟用例 | DeepSeek / Qwen / Ollama 至少各一条 | P5（BYOK 落地时） |
| **自一致性稳定性测试** | 脚本（K=3 重复 20 次） | 同一批 JD 的一致率分布稳定；K=1 与 K=3 的准确率差不失控 | P1 |
| **验证器路径测试** | Vitest + 固定样例 | 规则验证命中 / 未命中 / 修复成功 / **弃答**四条路径都有用例 | P2 |
| **MCP 契约测试** | MCP Inspector + 脚本 | tools 与 resources 的 schema 稳定；默认只读、写入需显式开关 | P5 |
| 性能测试 | k6 / Artillery | 并发粘贴、向量检索延迟 | P3 |
| 安全测试 | 手动 + 依赖扫描 | RLS 越权、注入、SSRF、密钥泄漏 | P2 |

**Bug 分级（`roadmap.md`"无 P0 bug"的口径）**

| 级别 | 定义 | 处理 |
|---|---|---|
| P0 | 数据丢失/泄漏、密钥泄漏、无法登录、核心链路（粘贴→入库）中断 | 阻断发布，当天修 |
| P1 | 主要功能不可用但有绕行方案（如提醒发不出、匹配页报错） | 发布前修 |
| P2 | 体验问题、文案、样式 | 迭代修 |

### 12.2 评测集构建

| 评测集 | 规模 | 标注内容 | 用途 |
|---|---|---|---|
| JD 抽取金标准 | 50 条 | 字段字典 v1 的 18 字段人工标注 | 抽取准确率 |
| 经历 STAR 标注 | 30 条 | 结构化字段（四段皆非空且有量化或证据才算完整） | 经历抽取质量 |
| JD-经历匹配对 | 100 条 | 匹配等级（高/中/低） | 匹配一致率 |
| 话术质量样本 | 30 条 | 事实性/关键词覆盖/语气 | 生成质量 |
| 幻觉测试集 | 50 条 | 含诱导性 JD（原 20 条统计意义不足） | 幻觉抑制 |

**评测集治理**：来源须为公开渠道或自撰，去除公司真名与个人信息后入库；标注抽样 20% 双人复核记录一致性。

### 12.3 CI 流程

```text
push / PR
   ↓
lint + typecheck
   ↓
Vitest 单元测试
   ↓
Promptfoo 抽样评测（10 条，PR 触发）
   ↓
Playwright E2E（P1 起，本地 supabase start）
   ↓
部署 Preview（Vercel）
   ↓
main 合并 / 手动触发 → Promptfoo 全量评测（50 条），低于阈值则失败
```

CI 费用与密钥约定（E-08 已裁决）：LLM API key 存 GitHub Actions Secrets；**fork PR 只跑 lint + 单测，不跑评测**；抽样评测只对同仓库 PR 运行；全量评测仅在 `main` 合并与手动触发时运行，避免 token 消耗失控。

### 12.4 验收指标

| 指标 | 目标 | 测量方式 |
|---|---|---|
| JD 抽取准确率 | ≥ 90%（关键字段 100% 带 evidence） | 50 条金标准，口径见下 |
| 经历 STAR 完整率 | ≥ 85% | 30 条标注，四段皆非空且有量化或证据 |
| 匹配一致率 | ≥ 85%（对外口径；第 4 周 80% 为过程门，A-01 已裁决） | 100 条标注对，与高/中/低标签吻合率 |
| 话术事实性 | 100% 可追溯（验证器自动判定） | 每条 claim 关联经历 ID + 原文 span；规则验证器字面命中 |
| **弃答率** | ≤ 15%（高于此说明经历库过薄或阈值过严） | 验证器统计（`abstained / 总生成次数`） |
| **置信度分层准确率** | 高置信字段准确率 ≥ 低置信字段 + 15pt | 评测集按 `confidence` 分层统计（A15 是否有意义的判定标准） |
| **风格检索增益** | 话术人工评分提升 ≥ 10% | 话术质量样本（30 条）A/B 对比（用 / 不用自有产物做 few-shot） |
| 简历导入可用 | 一份旧简历可导入并确认 ≥ 3 段经历（P1，A-05） | 用 3 份真实简历（文本层 PDF / DOCX）人工验证 |
| 提醒送达 | P2 目标，不阻塞 M1 | 飞书或邮件至少一条通路可达（A-08 后置） |
| 幻觉率 | ≤ 2% | 50 条幻觉测试集 |
| P95 抽取延迟 | ≤ 5s | `llm_usage_logs` / LangFuse |
| 单次抽取成本 | ≤ ¥0.05 | `llm_usage_logs`（BYOK 下仅作参考） |
| 模型成本 | **作者侧零成本**（本地模式由用户自付；Demo 仅限额度） | `llm_usage_logs` 仅供用户查看自己的消耗（D-07 已裁决） |

**准确率口径定义（G-02）**
- **统计粒度（A 类裁决）**：按 §9.2.0 字段字典的 **18 个字段编号**统计；组合字段（`salary_min`/`salary_max`、`is_referral`/`referral_code`、`source`/`source_url`）**整组正确才算该项正确**。
- **宏平均**：每个字段编号独立判定"抽对/抽错"，再对参与统计的编号取算术平均；不使用微平均。
- **归一化后比对**：全半角、大小写、空白、单位（薪资）、日期格式、城市别名、技能词表别名统一后再比对。
- **缺失字段排除**：JD 未提及的字段不计入该字段的分母（既不算对也不算错）。
- **关键字段单独统计**：薪资、截止时间单独给出准确率，且必须 100% 带 `evidence`，否则该条判错。
- **过程门**：第 1 周末以 ≥80% 作为过程门（用于验证管线跑通），最终验收按 ≥90%。
