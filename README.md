# Profession Search Agent

> 国内求职者的**本地优先 AI 求职副驾驶**：把散落的岗位信息与个人经历，变成"可检索、可匹配、可复用、可复盘"的两个库；
> 简历从静态文档变成按 JD 动态生成的视图。
>
> **数据只存在你自己的机器上**；不自动投递、不爬取非公开数据；模型自带（BYOK，支持本地 Ollama 完全离线）。

| 项目 | 状态 |
|---|---|
| **已完成** | I0 工程地基（**验收通过 90/100**）<br>I1 JD 入库闭环（**验收通过**）<br>I2 经历库 / 简历导入 / BYOK 设置页（**验收通过**） |
| 自动化测试 | **244 / 244 通过** · typecheck 0 error · lint 0 problem |
| 代码规模 | `src/` 35 文件 / 5,342 行 · `tests/` 17 文件 / 2,857 行 · `scripts/` 10 文件 |
| 数据库 | 4 个幂等迁移（`jobs` / `job_skills` / 凭证 / 用量） |

---

## 1. 现在能做什么

打开界面粘贴一段招聘 JD，系统会：

1. **清洗**（全半角、HTML 残留、PII 检测、提示注入隔离、超长分段）；
2. **抽取 18 个字段**（公司 / 岗位 / 城市 / 薪资 / 学历 / 届别 / 截止时间 / 技能…），
   每个字段都带**原文依据**与**置信度**；
3. **截止时间三态**：有明确日期 / 模糊表述（招满为止）/ **JD 未提供**——三者都是合法结果，不会编造日期、不会阻塞入库；
4. **技能三属性**：明确·必须 / 明确·加分 / **推测**（JD 只写"深度学习"→ 推测 PyTorch/TensorFlow，并标注依据）；
5. **校验与待确认**：低置信度、关键字段、缺证据的字段全部标黄，用户核对后才能入库；
6. **去重入库**：公司 + 岗位 + 城市归一化后生成指纹，重复提交会提示"已存在"并给出选择；
7. **落库**：`jobs`（一等列）+ `job_skills`（技能属性行，含熟练度与依据短语）。

**没有 API Key 也能用**：自动走规则模式（L4），字段大多标"待确认"，链路照样走通。

除了岗位库，你现在还可以：

8. **经历库**（`/experiences`）：手动填或粘贴一段自述 → **AI 归纳成 STAR 四段**（不虚构、可逐段编辑），
   技能自动拆分归一、量化指标自动抽取；支持查看详情、编辑、软删恢复、按类型筛选；
9. **简历导入**（`/experiences/import`）：上传 PDF/DOCX → **AI 切分多段经历** → 候选可编辑 → 勾选批量导入；
   扫描件会明确提示改用截图识别，绝不输出乱码；
10. **工作区台账**（`/settings/workspace`）：一键导出 CSV 台账（岗位 + 技能 + **经历库** + 原始 JD），
    在 Excel 改完可同步回库（列级权限 / 修订号冲突 / 用户优先 / 删行保护 / 同步前备份）；
11. **截图 OCR**：招聘网站禁止复制时，`Ctrl+V` 粘贴截图 → 视觉模型识别成文本 → 走同一条抽取管线；
12. **模型设置**（`/settings/llm`）：在网页里配文本/视觉两套凭证（AES-256-GCM 加密、保存前真实探活、优先于 `.env`）。

---

## 2. 功能计划

按**功能增量**排期（不按周划分），每个增量都能独立演示与验收。合计 ≈ **212 小时**。
I1.5 与 I2 的详细规范已写好：见 [F-03](spec/features/F-03-workspace-export.md) / [F-04](spec/features/F-04-screenshot-ocr.md) /
[F-05](spec/features/F-05-experience-entry.md) / [F-06](spec/features/F-06-resume-import.md) / [F-07](spec/features/F-07-byok-settings.md)。

| 增量 | 内容 | 工时 | 状态 |
|---|---|---|---|
| **I0** | 工程地基与 Provider 适配层：环境契约、BYOK 适配层（7 预设 + 自定义）、降级链 L0–L4、安全护栏、一键启动、doctor | 12h | ✅ **验收通过（90/100）** |
| **I1** | JD 入库闭环：字段字典 v1、清洗分段、抽取编排、K=3 自一致性、校验、截止三态、技能三属性、指纹去重、入库 API 与界面 | 34h | ✅ **验收通过（2026-10-25）** |
| **I1.5** | **① 工作区与表格导出（F-03）**：指定文件夹 + CSV 台账 + **双向同步**（列级权限 / 修订号冲突 / 用户优先）+ 原始 JD 快照<br>**② 截图 OCR 输入（F-04）**：粘贴/拖拽/长图切片 → 视觉模型或本地 OCR → 文本 → **复用 JD 抽取管线**（应对禁止复制的网站） | 18h | 🟡 **代码完成**（F-03 台账双向同步 + 设置页 · F-04 截图 OCR + 附件落盘；待正式验收） |
| **I2** | 经历库：**F-05** 经历录入与 STAR（18h）+ **F-06** 简历导入解析（PDF/DOCX，8h）+ **F-07** BYOK 设置页最小版（4h） | 30h | ✅ **验收通过（2026-10-25）** |
| **I3** | 投递流程管理：13 状态机 + 看板 + 面试记录 | 20h | ⬜ 未开始 |
| **I4** | 质量基线与"可交付"：评测集 50 条、E2E、一键启动文档、**无状态只读展示页** | 26h | ⬜ 未开始 |
| **I5** | 智能匹配：向量检索 + 五维评分调参 + **F-10 技能图谱与差距分析**（"先补什么"） | 30h + 15h | ⬜ 未开始 |
| **I6** | 材料生成与校验：简历视图 + bullet 生成 + 验证器优先生成（含弃答） | 22h | ⬜ 未开始 |
| **I7** | 提醒与通知：截止 T-1 单渠道最小版（**第一个可牺牲增量**） | 6h | ⬜ 未开始 |
| **I8** | 发布与打磨：文档、内测、演示视频、开源化 | 24h | ⬜ 未开始 |

**里程碑（软锚点，由增量完成度定义）**

| 里程碑 | 定义 | 当前 |
|---|---|---|
| **M1** | I4 关闭：Demo 版可用（P0–P2） | I0 完成 / 4 |
| **M2** | I6 关闭：核心能力完整（P3–P4） | 未开始 |
| **M3** | I8 关闭：可发布作品（P5） | 未开始 |

> 详细任务卡、风险与降级链见 [spec/roadmap.md](spec/roadmap.md)。

---

## 3. 已完成功能（含验收证据）

### 3.1 I0 工程地基与 Provider 适配层 —— 验收通过 90/100

| 能力 | 说明 | 证据 |
|---|---|---|
| **换模型零改码** | 只改 `.env`：7 个预设（DeepSeek / 通义 / Kimi / GLM / SiliconFlow / OpenAI / Ollama）+ 任意 OpenAI 兼容网关 | 3 种配置解析断言 |
| **降级链 L0–L4** | tool calling → Prompt-JSON → SchemaError → 规则（有 Key 异常）→ 规则（无 Key） | 全路径用例 |
| **能力探测与缓存** | 探测模型是否支持 tool calling / embedding，24h 缓存，调用中自学习 | `source=probe` 实测 |
| **错误分类与重试** | 401/403、429（读 `Retry-After`）、5xx、超时、404 模型名 | 25 个适配层用例 |
| **安全护栏** | 私网地址默认拒绝（防 SSRF）、出站域名白名单、密钥 7 类形态脱敏 | 实测 + 用例 |
| **一键启动** | `npm run setup` 幂等：生成 `.env` → 起容器 → 等 `pg_isready` → 迁移 → 健康检查 | 实测 **5.3s** |
| **诊断工具** | `npm run doctor`：11 项检查 + 修复建议（含 daemon 检测） | 真实环境 11/11 |

### 3.2 I1 JD 入库闭环 —— 代码完成

| 模块 | 实现 |
|---|---|
| **字段字典 v1** | 18 编号 / 21 字段值的唯一真源；Zod 校验 + 手写 JSON Schema（喂 tool calling），两者用 ajv 做一致性校验 |
| **清洗与分段** | NFKC 全半角、HTML 剥离、语言检测、PII 检测与打码、提示注入检测、城市别名、超长分段、20k 硬截断 |
| **抽取编排** | `extractJd()`：clean → prompt → `LLMService.run`(L0–L4) → merge → validate；**AI 与规则走同一条代码路径** |
| **抽取 Prompt** | `prompts/extract-jd.md` 唯一真源；`<jd>` 隔离防注入、evidence 强制、三态说明、技能属性约束 |
| **K=3 自一致性** | 字段级多数票 + **一致率覆盖模型自报置信度**（2/3 一致 → 0.667 → 自动进待确认） |
| **校验** | 0.7 阈值、人工确认字段、**三态豁免**、`confirmedFields`（用户核对后豁免证据阻塞） |
| **截止时间三态** | `provided` / `text_only` / `absent`；无年份补全 + 跨年顺延；DB 侧有 CHECK 约束保证"三态与值一致" |
| **技能三属性** | 明确/推测 × 必须/加分 × 精通/熟练/熟悉/了解；每条必须带**原文依据短语**；推测上限 6 条、熟练度必须 `unknown`（DB 约束） |
| **指纹去重** | 公司去法人后缀 + 岗位去括号噪声 + 城市集合排序 + 版本号参与哈希 |
| **存储** | `jobs`（29 列一等列）+ `job_skills`（技能属性行），**同一事务写入** |
| **API** | `POST /api/parse-jd`（不落库）、`POST|GET /api/jobs`（服务端重校验 + `confirmedFields`） |
| **界面** | `/jobs/new`：粘贴 → 预览（依据 / 置信度 / 待确认高亮 / 技能三列）→ 校准 → 确认入库；`/jobs`：最小列表 |

### 3.3 质量门

```
npm test              244 / 244 通过（17 个测试文件）
npm run typecheck     0 error
npm run lint          0 problem
npm run verify:f02    12 项：D1–D3c（真实数据库）+ L1–L4（逻辑）
npm run accept        75 / 75（F-01 自动可验部分）
```

### 3.4 明确还没做（避免误解）

| 未完成 | 说明 |
|---|---|
| I1 的评测基线（T12a） | 10 条 JD + Promptfoo，宏平均 ≥80% 过程门；需安装评测依赖 |
| 工作区与表格导出（F-03） | 用户指定文件夹 + CSV 台账 + 双向同步（P1 裁决从 I1 移出） |
| 截图 OCR 输入（F-04） | 禁止复制的网站用截图输入；OCR 文本复用 JD 抽取管线（并入 I1.5） |
| 技能差距分析（F-10） | "先补什么"排序表（依赖经历库与推测技能，挂 I5） |
| 经历库 / 投递流程 / 匹配 / 生成 / 提醒 | I2–I8 |
| 岗位详情页、完整筛选排序 | 属 I2 的 F2 任务 |

---

## 4. 安装与使用

### 4.1 前置要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | **22.6+**（推荐 24） | 依赖原生 TypeScript 类型剥离 |
| Docker | 可选 | 只有"完整体验"需要；本地栈为 `pgvector/pgvector:pg16` |
| 网络 | 可选 | 不配模型也能用；`npm install` 与镜像拉取需要网络 |
| 模型 API | 可选 | BYOK：DeepSeek / 通义 / Kimi / GLM / SiliconFlow / OpenAI / **Ollama（可全离线）** / 任意兼容网关 |

### 4.2 路径 A：只跑核心逻辑与测试（不需要 Docker / 不需要联网）

```powershell
node scripts/run-tests.mjs              # 244 个用例
node scripts/check-adapter-purity.mjs   # 适配层纯净度红线
node scripts/doctor.mjs --no-network    # 环境与安全自检
```

> 核心实现是**零依赖 TypeScript**，靠 Node 原生类型剥离直接运行，**不需要 npm install**。

### 4.3 路径 B：完整体验（需要 Docker）

```powershell
# 1) 启动 Docker Desktop（等托盘鲸鱼图标变绿）
docker info                                    # 能输出内容 = daemon 正常

# 2) 起数据层 + 应用迁移（幂等，可重复执行）
npm run setup

# 3) 安装 Web 层依赖
npm install

# 4) 启动应用
npm run dev                                    # http://localhost:3000

# 5) 自检（含模型连通性）
npm run doctor
```

`npm run setup` 参数：

| 参数 | 作用 |
|---|---|
| `--dry-run` | 只检查，不写文件、不起容器 |
| `--no-pull` | 跳过镜像拉取（离线或镜像已预热） |
| `--port 3001` | 覆盖端口（端口被占用时**不会静默换端口**） |
| `--verbose` | 详细输出 |

### 4.4 配置模型（可选，不配也能用）

只改 `.env`，代码零改动：

```ini
# ---------- 文本模型（抽取 / 生成 / 校验）----------
LLM_PROVIDER=deepseek        # deepseek | qwen | kimi | glm | siliconflow | openai | ollama | custom
LLM_API_KEY=sk-...           # 留空 = 规则模式
LLM_MODEL=deepseek-chat      # 留空 = 该 provider 默认模型
LLM_BASE_URL=                # 留空 = 内置地址；自定义网关填这里
LLM_SAMPLE_K=3               # 自一致性采样次数（1–5）

# ---------- 视觉模型（可选，截图识别专用）----------
# 与文本模型完全独立：可用不同厂商 / 不同 Key / 不同模型
LLM_VISION_PROVIDER=qwen
LLM_VISION_MODEL=qwen-vl-plus
LLM_VISION_API_KEY=sk-...    # 留空 = 继承 LLM_API_KEY（同一家服务商时可省略）
LLM_VISION_BASE_URL=         # 留空 = 该 provider 内置地址
```

**典型配置**

| 场景 | 配置 |
|---|---|
| **单 Key 全包（推荐）** | 文本 `LLM_MODEL=deepseek-chat`（L0 tool calling，待确认少）+ 视觉 `LLM_VISION_PROVIDER=deepseek` / `LLM_VISION_MODEL=deepseek-flash`（支持读图）；**同一个 DeepSeek Key**，`LLM_VISION_API_KEY` 留空即继承 |
| 文本便宜 + 视觉免费 | 文本 `deepseek`（`deepseek-flash`）+ 视觉 `LLM_VISION_PROVIDER=glm` / `LLM_VISION_MODEL=glm-4v-flash`（智谱免费图像理解模型，需单独 Key） |
| 中转站 / 自建网关 | `LLM_PROVIDER=custom` + `LLM_BASE_URL=...` + Key；视觉同理用 `LLM_VISION_*` |
| 完全离线（Ollama） | `LLM_PROVIDER=ollama` + `ALLOW_PRIVATE_BASE_URL=true`；视觉 `LLM_VISION_MODEL=qwen2.5vl:7b` |

> 不配 `LLM_VISION_PROVIDER` 时**截图识别显示"未配置视觉模型"并给出配置指引**，文本功能完全不受影响。
> `npm run doctor` 会分别报告「文本 / 视觉」两条配置，并判定视觉模型是否真能读图。

改完用 `npm run doctor` 验证（会真实探活一次并显示延迟与能力来源）。

### 4.5 使用流程

1. 打开 http://localhost:3000 → 点「粘贴 JD 并解析」
2. 粘贴一段招聘 JD（网页复制的原文即可）→ 点「解析 JD」
3. 检查预览：
   - 顶部显示抽取层级（L0 AI / 规则模式）、采样次数、待确认数量；
   - 每个字段有**原文依据**；建议复核的**黄色高亮**；
   - 技能分三列：明确·必须 / 明确·加分 / 推测（推测带 `置信度←依据`）。
4. 校准字段（公司/岗位/城市/薪资/截止时间可改），勾选「我已核对以上字段」
5. 点「确认入库」→ 提示成功 → 到 `/jobs` 查看列表
6. **再贴同一段**：会提示「该岗位已存在」，可选「查看已有 / 仍然新建一条」

### 4.6 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `failed to connect to the docker API at npipe://…` | Docker Desktop 的 daemon 没启动 | 启动 Docker Desktop，`docker info` 有输出后重试（脚本会秒级报错，不会白等） |
| 拉取 `pgvector/pgvector:pg16` 超时 | Docker Hub 国内限速 | 配置镜像加速器，或先单独 `docker pull` 验证网络 |
| `Cannot find module 'pg'` | 没装依赖 | `npm install` |
| 页面报「无法读取数据库」 | 数据层未启动 / `DATABASE_URL` 不对 | `npm run setup` + 检查 `.env` + `npm run doctor` |
| 解析显示「规则模式」 | 没配 `LLM_API_KEY` | 属正常降级；配 Key 后重启 `npm run dev` |
| 中文乱码 | Windows PowerShell 5.1 重定向编码 | 用 `--report` 参数而不是 `*>`（详见验收指南） |

---

## 5. 命令一览

| 命令 | 作用 | 依赖 |
|---|---|---|
| `npm test` | 核心单测（node:test，244 例） | 仅 Node |
| `npm run verify:f02` | **F-02 验收**：数据层 5 项 + 逻辑层 5 项（`--real` 加真实模型） | 仅 Node（有库更佳） |
| `npm run verify:ocr` | **截图 OCR 验收**：真实截图 → 识别 → 抽取，6 项关键检查（`--image` 指定截图） | 需要视觉模型 |
| `npm run workspace:export` | 导出 CSV 台账（岗位 / 技能 / **经历库** / 原始 JD） | Docker |
| `npm run workspace:sync` | 台账同步回库（`--dry-run` 可预演） | Docker |
| `npm run workspace:export` | **导出 CSV 台账**（F-03）：主表 + 技能长表 + 原始 JD 快照 | Docker |
| `npm run workspace:sync` | **同步台账回库**（F-03）：只采纳可改列，`--dry-run` 可预演 | Docker |
| `npm run accept` | **F-01 验收**：4 红线 + 13 AC + 评分卡 | 仅 Node |
| `npm run check:adapter` | 业务代码零厂商 SDK（红线③） | 仅 Node |
| `npm run doctor` | 环境/配置/安全自检，11 项 + 修复建议 | 仅 Node |
| `npm run setup` | 一键启动（幂等：`.env` → 容器 → 迁移 → 健康检查） | Docker |
| `npm run db:migrate` | 应用迁移（幂等 SQL，可重复执行） | Docker |
| `npm run build` / `dev` | Next.js 构建 / 开发 | npm install |
| `npm run lint` / `typecheck` | 静态检查 | npm install |
| `npm run verify:model` | 模型错误路径验收（401/404/不可达/私网/无 Key，不联网） | 仅 Node |
| `npm run verify:idempotency` | setup 幂等验收（连跑两次，校验数据与配置不被覆盖） | Docker |

---

## 6. 目录结构

```
spec/          规范：项目书 / mission / tech_stack / roadmap / features（功能规范）
logs/          过程：README（索引与术语）/ open_questions / decisions_log
docs/          验收指南（F-01 / F-02）、验收报告、ADR-0001/0003/0007
prompts/       抽取 Prompt（extract-jd.md，运行时读取）
src/lib/       env / errors / tenant / llm（适配层·多模型路由）/ schemas（字段契约）/ pipeline（清洗·校验·指纹·一致性·经历抽取）/ jobs / experience / credentials / resume / ocr / workspace / db / server
src/app/       Next.js App Router：页面（/、/jobs、/jobs/new、/experiences、/experiences/import、/settings/workspace、/settings/llm）
               与 API（/api/parse-jd、/api/jobs、/api/ocr、/api/workspace、/api/experiences、/api/resume/import、/api/settings/credentials）
scripts/       setup / doctor / migrate / run-tests / check-adapter-purity / accept / verify-*
tests/         244 个用例（node:test）+ 违规夹具
supabase/migrations/  4 个幂等 SQL 迁移
```

---

## 7. 技术栈与关键设计

| 层 | 选择 | 理由 |
|---|---|---|
| 运行时 | Node 22.6+ / TypeScript（原生类型剥离） | 核心可零依赖直接跑，无构建步骤 |
| Web | Next.js 15 App Router + React 19 | 本地优先、单机部署 |
| 数据 | PostgreSQL + pgvector（Docker 精简栈） | 关系 + 向量同库；迁移幂等 |
| 校验 | Zod 3 + 手写 JSON Schema | 运行期校验与 tool calling 双份定义，用 ajv 做一致性测试 |
| 模型 | 统一 OpenAI 兼容协议 | 换模型只改 `.env`，业务代码零厂商 SDK（CI 强制） |
| 降级 | L0→L1→L2→L3→L4 | 上游故障 / 限流 / 无 Key 都不白屏 |

**四条红线（CI 强制）**

1. 密钥/原文不泄漏进日志、响应、诊断输出；
2. `setup` 不破坏已有数据（幂等，只补缺失值）；
3. 业务代码不得引用任何厂商 SDK（所有模型调用经 `src/lib/llm`）；
4. 出站只允许用户配置的域名，私网地址默认拒绝。

---

## 8. 安全与隐私

- **数据不离开你的机器**：岗位、经历、简历、生成物全部存于本地容器；作者不托管、不接收、不存储任何用户数据；
- 唯一外发是**你主动触发**的模型调用，发往**你自己配置**的服务商；用 Ollama 可完全离线；
- API Key 以 AES-256-GCM 密文存储，主密钥在你的 `.env`；凭证表对客户端不可读；
- 删除即删除：`docker compose down -v` 清空本地数据；
- 不自动投递、不爬取非公开数据、不采集他人信息、不用于模型训练。

---

## 9. 文档索引

| 文档 | 用途 |
|---|---|
| [spec/project_book.md](spec/project_book.md) | 项目总纲（目标、范围、前沿性、治理、作品化产出） |
| [spec/mission.md](spec/mission.md) | 为什么做、给谁做、靠什么机制成立 |
| [spec/tech_stack.md](spec/tech_stack.md) | 技术选型、数据表、字段字典、算法口径、评测指标、前沿能力层 |
| [spec/roadmap.md](spec/roadmap.md) | 功能增量、DoD、容量预算、风险与降级链 |
| [spec/features/F-01-bootstrap.md](spec/features/F-01-bootstrap.md) | 工程地基与 Provider 适配层（已验收） |
| [spec/features/F-02-jd-ingest.md](spec/features/F-02-jd-ingest.md) | JD 入库闭环（代码完成） |
| [spec/features/F-03-workspace-export.md](spec/features/F-03-workspace-export.md) | 工作区与 CSV 台账双向同步（I1.5，10h） |
| [spec/features/F-04-screenshot-ocr.md](spec/features/F-04-screenshot-ocr.md) | 截图 OCR 输入（I1.5，8h） |
| [spec/features/F-05-experience-entry.md](spec/features/F-05-experience-entry.md) | 经历录入与 STAR 结构化（I2，18h） |
| [spec/features/F-06-resume-import.md](spec/features/F-06-resume-import.md) | 简历导入解析（I2，8h） |
| [spec/features/F-07-byok-settings.md](spec/features/F-07-byok-settings.md) | BYOK 设置页最小版（I2，4h） |
| [docs/acceptance-report-F01.md](docs/acceptance-report-F01.md) | F-01 验收报告（90/100 与缺陷台账） |
| [docs/acceptance-guide-F01.md](docs/acceptance-guide-F01.md) | F-01 手动验收步骤 |
| [docs/acceptance-guide-F02.md](docs/acceptance-guide-F02.md) | F-02 手动验收步骤（5 层） |
| [docs/adr/](docs/adr/) | 架构决策记录（本地栈 / 本地优先 / BYOK 适配层） |
| [logs/decisions_log.md](logs/decisions_log.md) | 历史裁决与理由（含 14 轮裁决） |

---

## 10. 更新记录

### 2026-10-25：I1.5 + I2 落地

| 增量 | 内容 | 状态 |
|---|---|---|
| I1.5 | F-03 工作区台账（CSV 双向同步、设置页、经历库导出）+ F-04 截图 OCR（视觉模型、长图切片、附件落盘、`verify:ocr`） | 🟡 代码完成，待正式验收 |
| I2 | F-05 经历录入与 STAR（规则 + **AI 归纳**、查看/编辑/软删恢复/筛选）+ F-06 简历导入（PDF/DOCX、**AI 切分**、候选可编辑、批量导入）+ F-07 BYOK 设置页（AES-GCM、probe、DB 优先） | ✅ **验收通过** |

**多模型路由**：文本与视觉模型独立配置（`LLM_*` 与 `LLM_VISION_*`），设置页凭证优先于 `.env`；
`npm run doctor` 会分别报告文本/视觉两条配置并判定视觉模型能否读图。

**本轮修掉的真实缺陷**（均为真跑才暴露，单元测试无法发现）：指标被清空、技能被合并、日期带"日"导致切分失效、
导入去重键撞车导致只进一条、**Postgres `date` 不接受 `YYYY-MM`** 导致带日期的经历全部导入失败。

**已知限制**：技能"待审"标记未做；`org` 对科研/课程项目仍必填（用原文首行兜底）；双栏 PDF 的规则切分只能尽力而为（AI 为主路径）。

---

## 11. 隐私与误提交防护

**本项目会在工作区里产生大量个人信息**（JD 原文、台账、简历、截图、附件）——这些**永远不该进 Git**。

### 11.1 三层防护

| 层 | 机制 | 文件 |
|---|---|---|
| 忽略 | `.gitignore` 忽略 `data/`、`.env`、密钥文件、验收报告 | [.gitignore](.gitignore) |
| 拦截 | pre-commit 扫描**暂存区**（路径 + 内容特征：API Key / 私钥 / 身份证号） | [scripts/check-sensitive.mjs](scripts/check-sensitive.mjs) · [.githooks/pre-commit](.githooks/pre-commit) |
| 复核 | `npm run check:sensitive -- --all` 扫描整个仓库 | package.json |

### 11.2 每台机器启用一次

```powershell
npm run hooks:install     # 等价于 git config core.hooksPath .githooks
```

之后每次 `git commit` 都会自动检查；命中敏感路径/内容会**直接阻止提交**并给出处理建议。

### 11.3 已经误提交了怎么办

1. **止损**：`git rm --cached data/...`（保留本地文件）+ 确认 `.gitignore` 已包含该路径；
2. **轮换密钥**：`.env` 里的 `LLM_API_KEY` / `ENCRYPTION_KEY` 一旦上过 GitHub 就必须视为已泄露；
3. **清历史**（必要时）：`git filter-repo --path data/ --invert-paths`，强推后通知协作者重新 clone；
4. 记住：**GitHub 上的历史无法真正删除**（fork / 缓存 / 爬虫），关键是"根本别提交"。

### 11.4 检验清单

```powershell
git check-ignore -v data/workspace/岗位管理表.csv   # 应输出规则，说明已忽略
npm run check:sensitive -- --all                   # 全仓扫描，应无命中
git status --short                                 # data/ 不应出现在列表里
```
