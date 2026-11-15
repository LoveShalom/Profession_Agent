# F-09 质量基线与无状态展示页（I4 / M1 关闭点）

## 0. 元信息

| 项 | 内容 |
|---|---|
| 编号 / 名称 | F-09 质量基线与无状态展示页 |
| 所属增量 | **I4**（M1 关闭点） |
| 优先级 | P0（"可交付"门槛） |
| 关联功能编号 | **A13**（凭证冒烟 + 用量记账）、**B14**（处理管线日志）、Promptfoo 评测集 50 条 + CI 门、Playwright E2E、一键启动文档、**无状态只读 Demo** |
| 依赖 | I1–I3 全部验收通过（已完成） |
| 负责人 / 状态 | 【待填】 / 🟢 **已裁决，开工中**（Q-11~Q-14 全部按建议） |
| 估时 | **40h**（见 §3.3 对账） |

**一句话定义**：不加新功能，只把"能跑"变成"**可交付**"——有评测基线、有 CI 门、有干净机器一键启动、有能公开演示的只读 Demo。

> **不做什么**：不做匹配算法（I5）、不做材料生成（I6）、不做提醒（I7）。I4 期间冻结业务功能，只做质量与交付基础设施。

---

## 1. 功能规格与分支

### 1.1 用户故事

- **US-1**：作为项目作者，我希望能证明"这套抽取确实有质量"，而不是凭手感——需要**可复现的评测基线**。
- **US-2**：作为项目作者，我希望每次改 prompt/管线后，CI 能自动告诉我质量有没有退化。
- **US-3**：作为新用户/评审者，我希望在**干净机器**上按 README 一步步跑起来，不踩隐藏的坑。
- **US-4**：作为评审者/招聘方，我希望打开一个链接就能看到产品长什么样，**不需要注册、不会写入任何数据**。
- **US-5**：作为作者，我希望知道每次 LLM 调用的成本与降级情况（stage/model/prompt 版本/命中缓存），否则没法优化。

### 1.2 输入 / 输出契约

| 产物 | 契约 |
|---|---|
| 评测集 | `evals/jd/dataset.jsonl`：50 条，每条 `{id, raw_text, gold:{company,title,cities,deadline_kind,deadline,salary_min,salary_max,skills[]}, tags[]}`；**不含任何真实个人信息** |
| 评测脚本 | `npm run eval -- [--real] [--subset=20] [--report]`；默认 **replay 模式**（读 `evals/jd/fixtures/*.json` 录制输出，不联网）；`--real` 才调真实模型 |
| 指标 | 字段级 F1（company/title/cities/deadline_kind/salary/skills）+ **宏平均**；基线阈值写入 `evals/jd/baseline.json` |
| 评测报告 | `evals/reports/eval-<mode>-<date>.txt`（默认不进 Git） |
| CI 门 | `.github/workflows/ci.yml`：`typecheck → lint → test → build(可选) → eval --replay`；**任何一步失败即红** |
| 一键启动 | `README` 的「安装与运行」必须能在干净机器复现；`npm run preflight` 检查 Docker/Node/端口/依赖并给出可执行命令 |
| 只读 Demo | `/demo` 路由：读 `evals/demo/sample.json`（静态样例），**无任何写接口调用**；部署到 Vercel/静态托管均可（`DEMO_MODE=1`）|
| 日志 | `llm_usage_logs` 已存在（0002）；补 `stage`、`prompt_version`、`cache_hit` 字段并在 `/settings/diagnostics` 展示最近 20 条 |

### 1.3 分支与变体矩阵

**A. 评测执行**

| 分支 | 条件 | 行为 |
|---|---|---|
| 默认（replay） | 无 `--real` | 读 fixtures 回放；**不需要网络/密钥**，CI 用它 |
| 真实模型 | `--real` + 有效 Key | 调真实模型 K=1（省钱；质量对比用 K=1 的一致性口径） |
| 无 Key 且 `--real` | 未配置凭证 | 立即失败并提示"要么配 Key，要么去掉 --real" |
| 子集 | `--subset=20` | 只跑前 20 条（快速回归） |
| 基线缺失 | 首次运行 | 生成 `baseline.json` 并提示"基线已建立，请 review 后提交" |
| 指标退化 | 宏平均 < 基线 − 3pt | 退出码 1，报告里标退化字段 |
| 指纹变化 | 评测集条目被修改 | `dataset.lock.json` 校验失败，提示"评测集不可随手改；改了要 bump 版本" |

**B. CI**

| 分支 | 行为 |
|---|---|
| PR / push | 全量：typecheck + lint + 386 测试 + `eval --replay`（约 2 分钟） |
| 无网络环境 | 全部离线可跑（**评测走 fixtures**） |
| 有 secrets 误入 | `scripts/check-sensitive.mjs` 在 CI 里再跑一次（双保险） |
| 失败 | 保留报告 artifact；不自动重试（避免掩盖 flaky） |

**C. 一键启动（preflight）**

| 分支 | 检出问题 | 输出 |
|---|---|---|
| 未装 Docker | `docker info` 失败 | 给出安装链接 + 说明"无 Docker 时可用外部 Postgres" |
| Docker 未启动 | daemon 探测失败 | `docker compose up -d` 命令 + 说明 |
| 端口占用 | 54322 被占 | 提示改 `POSTGRES_PORT` 或停掉占用进程 |
| 缺 `.env` | 不存在 | 从 `.env.example` 复制并列出"必须填的 3 个键" |
| 迁移未跑 | `schema_migrations` < 6 | `node scripts/migrate.mjs` |
| 无 LLM Key | 空 | 提示"也可以先跑规则模式（L4），功能完整但字段待确认" |
| 全部就绪 | — | 打印"✅ 可以 `npm run dev`"，附 4 个入口 URL |

**D. 只读 Demo**

| 分支 | 行为 |
|---|---|
| `DEMO_MODE=1` | 所有写接口返回 403 `E_DEMO_READONLY`；页面顶部显示"演示模式"横幅 |
| 未登录/无 DB | Demo 页只读静态 JSON，**不连数据库** |
| 部署到公网 | 样例数据不含真实信息；限流由托管平台负责（不引入额外依赖） |
| 本地普通模式 | `/demo` 仍然可访问（就当作"看示例"） |

**E. 日志与用量**

| 分支 | 行为 |
|---|---|
| 每次 LLM 调用 | 写 `llm_usage_logs`：provider/model/stage/prompt_version/tokens/成本估算/cache_hit/degraded |
| 降级 | `level` 记 L0–L4，便于统计"规则兜底比例" |
| 无 Key | 不写日志（没有真实调用） |
| 展示 | `/settings/diagnostics`：最近 20 条 + 当月累计成本 + 降级比例 |

### 1.4 边界与非目标

- **不做**：Promptfoo 以外的评测框架（不自研 dashboard）；不做 A/B 自动迭代 prompt。
- **不做**：LangFuse 以外的遥测；**LangFuse 默认关闭**，见 §2.5 Q-11。
- **不做**：真实数据进仓库——评测集只放合成/脱敏 JD。
- **不做**：Demo 的写操作（只读是硬约束）。
- **不做**：多平台部署脚本（Vercel/静态托管二选一即可）。

### 1.5 与红线的关系

| 红线 | I4 如何守住 |
|---|---|
| 密钥不泄漏 | 评测 fixtures 只存**模型输出**，不存 Key；CI 不含 secrets；`check-sensitive` 双保险 |
| setup 不破坏数据 | `preflight` 只检查不修改；迁移幂等 |
| 业务零厂商 SDK | 评测与日志不引入新的"业务依赖"（Promptfoo/Playwright 仅 devDependencies） |
| 出站白名单 | Demo 不发起出站请求；`--real` 才访问已配置 provider |

---

## 2. 收集需求

### 2.1 需求来源

| 来源 | 结论 |
|---|---|
| `roadmap I4` 出口标准 | CI 全绿 / 50 条基线 / 一键启动可复现 / 只读 Demo 可打开 |
| `roadmap I4` 功能项 | A13 凭证冒烟+用量记账、B14 处理管线日志、LangFuse、Promptfoo 扩到 50 + CI 门、Playwright E2E、一键启动文档、只读 Demo |
| `decisions_log §14.1`（T12a） | 评测基线：10 条起、宏平均 ≥80% 过程门 |
| 隐私红线 & pre-commit 扫描 | 评测集/报告默认不进 Git；CI 离线运行 |

### 2.2 验收场景（Given / When / Then）

- **AC-1 评测可复现**：Given 同一份 fixtures，When 连跑两次 `npm run eval`，Then 指标**完全一致**（确定性）。
- **AC-2 基线门**：Given 基线 0.82，When 人为把某字段抽取打坏，Then eval 退出码 1 且报告标出退化字段。
- **AC-3 真实模型口径**：Given 配置了 Key，When `npm run eval -- --real --subset=10`，Then 输出字段级 F1 与宏平均，并写报告。
- **AC-4 CI 门**：Given 一个把测试改红的提交，When 推送到 GitHub，Then CI 失败并给出失败步骤。
- **AC-5 离线 CI**：Given 无网络环境（或 secrets 为空），When 跑 CI 等价命令，Then 全部通过（不依赖真实模型）。
- **AC-6 干净机器启动**：Given 新机器 + 已装 Docker/Node，When 按 README 执行，Then `npm run preflight` 通过且 `npm run dev` 可访问 4 个入口。
- **AC-7 只读 Demo**：Given `DEMO_MODE=1`，When 打开 `/demo` 并尝试任何写操作，Then 页面显示演示横幅、写接口返回 403。
- **AC-8 日志可见**：Given 做过一次真实抽取，When 打开 `/settings/diagnostics`，Then 能看到 provider/model/stage/prompt_version/tokens/降级等级。
- **AC-9 评测集不可偷改**：Given 修改了 dataset 条目，When 跑 eval，Then 因 lock 校验失败而拒绝（提示 bump 版本）。
- **AC-10 敏感文件不泄露**：Given 试图 `git add evals/reports/x.txt`，When 提交，Then pre-commit 拦截。

### 2.3 非功能需求

| 项 | 要求 |
|---|---|
| 速度 | `eval --replay` ≤ 30s；CI 全流程 ≤ 5 分钟 |
| 成本 | 全量真实评测（50 条）≤ ¥5（K=1） |
| 可移植 | 三平台（Windows/macOS/Linux）；Windows 用 PowerShell 命令 |
| 离线 | 除 `--real` 外全部离线可跑 |
| 隐私 | 评测集、报告、Demo 样例都不含真实姓名/手机号/邮箱 |

### 2.4 优先级（MoSCoW）

- **Must**：评测集 50 条 + fixtures + replay 评测器 + 基线 JSON；CI 门；`preflight` 一键启动检查；`/demo` 只读页；写接口 `DEMO_MODE` 拦截。
- **Should**：真实模式评测（`--real`）；`/settings/diagnostics` 日志展示；A13 用量记账接上（表已存在）。
- **Could**：Playwright E2E（本地跑 3 条主链路）；LangFuse（默认关闭）；B14 全链路 stage 日志。
- **Won't**：自研评测 dashboard；多平台部署脚本；真实数据入库。

### 2.5 待澄清问题

| 问题 | 影响 | 默认（未裁决时按此执行） |
|---|---|---|
| **Q-11：LangFuse 是否必须？** | 引入外部遥测与隐私红线的冲突 | **默认不接**：用本地 `llm_usage_logs` + 诊断页；如要接，必须默认关闭且脱敏（P1 → Could） |
| **Q-12：50 条评测集从哪来？** | 真实 JD 采集需用户参与 | 默认：我合成 40 条（覆盖 8 类岗位/5 种边界）+ 你提供 10 条脱敏真实 JD；若你暂无，先 40 条，基线口径不变 |
| **Q-13：E2E 是否必须？** | 新依赖（Playwright ≈ 浏览器内核 100MB+） | 默认 **Could**：先用手工走查 + `verify:*` 脚本；E2E 等 CI 稳定后再加 |
| **Demo 是否要连真实抽取？** | 成本与复杂度 | 默认 **不连**：只读预生成结果，零成本、零密钥、可公开 |

---

## 3. 任务计划

### 3.1 任务分解

| ID | 任务 | 依赖 | 估时 | 产出 | DoD |
|---|---|---|---|---|---|
| **T1** | 评测集 50 条（40 合成 + 10 待你提供，缺则先用 40）+ `dataset.lock.json` | — | 6h | `evals/jd/dataset.jsonl` | D2 |
| **T2** | 评测器：字段级 F1、宏平均、replay/fixtures、`--real`、`--subset`、锁校验 | T1 | 6h | `scripts/eval.mjs` | D4 |
| **T3** | 基线：首次运行生成 `baseline.json` + 退化判定（-3pt 门） | T2 | 2h | `evals/jd/baseline.json` | D4 |
| **T4** | CI 门：`.github/workflows/ci.yml`（离线全绿）+ 敏感文件二次扫描 | T2 | 3h | workflow | D4 |
| **T5** | `preflight`：环境体检（Docker/daemon/端口/env/迁移/Key）与可执行建议 | — | 3h | `scripts/preflight.mjs` | D5 |
| **T6** | 只读 Demo：`/demo` + `DEMO_MODE=1` 写接口拦截 + 演示横幅 + 样例数据 | T2 | 6h | 路由 + 中间件 | D5 |
| **T7** | 一键启动文档与踩坑清单（三平台、镜像体积、常见错误） | T5 | 3h | README 章节 + `docs/getting-started.md` | D5 |
| **T8** | A13 凭证冒烟 + 用量记账接上；`/settings/diagnostics` 展示 | T2 | 5h | 页面 + 服务 | D4 |
| **T9** | B14 管线日志字段（stage/prompt_version/cache_hit） | T8 | 2h | 适配层 | D4 |
| **T10** | 汇总验收器 `npm run verify:i4` + 文档回填 | T1–T9 | 4h | 脚本 + 报告 | D4 |
| T11（Could） | Playwright E2E（3 条链路） | T4 | 8h | e2e 目录 | D3 |
| T12（Could） | LangFuse 可选接入（默认关闭、脱敏） | T8 | 6h | 适配层 | D4 |

### 3.2 顺序与关键路径

```
T1 → T2 → T3 → T4 → T6 → T10
       ↘ T5 → T7
       ↘ T8 → T9
（Could：T11 / T12 最后）
```

关键路径是 **T1→T2→T3**（没有评测集和评测器，后面全是空谈）。

### 3.3 工时对账

| 项 | 值 |
|---|---|
| 本规范（Must+Should） | **40h**（T1 6 + T2 6 + T3 2 + T4 3 + T5 3 + T6 6 + T7 3 + T8 5 + T9 2 + T10 4） |
| roadmap I4 预算 | 40h |
| Could 项（E2E 8h + LangFuse 6h） | 不计入，视 User 裁决再排 |

### 3.4 工时口径冲突（✅ 已裁决 Q-14：预算 40h）

| 来源 | 数字 |
|---|---|
| `roadmap` §5 容量预算表 | **26h** |
| 本规范按任务实际拆解 | **40h**（Must+Should） |

**差异原因**：roadmap 的 26h 是早期估算，只覆盖"测试 + 评测 + 一键启动 + Demo"；
而 roadmap I4 功能项后来又列了 **A13 用量记账 / B14 管线日志 / LangFuse** 等，本规范把它们纳入 Must（T8/T9，共 7h）。

**裁决结果（2026-11-15）：方案 A —— 预算 40h，roadmap 总工时 212h → 226h。**

~~三种处理方式~~（保留备查）：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A（建议）** | 预算改为 **40h**，roadmap 总工时 212h → 226h | 需要同意预算修订 |
| B | 守住 26h：T8/T9 移出 I4（延到 I5），T1/T2/T6/T7/T10 各压缩 1–2h | A13/B14 落空，I4 出口仍能达标 |
| C | 守住 26h 且保留 T8/T9：砍 T6 只读 Demo 到 4h、T7 文档到 2h、T1 评测集由 50→30 条 | 交付质量打折，不推荐 |

### 3.5 技术选型（✅ 已裁决：自研评测器 / 不接 LangFuse / 不做 Playwright）

| 决策 | 选项 | 建议 |
|---|---|---|
| 评测框架 | Promptfoo / 自研 60 行评测器 | **自研**：Promptfoo 面向 prompt 对比，这里是"字段级抽取质量"，自研更直白且零依赖（避免 Node 依赖链风险） |
| E2E | Playwright / 手工走查 | **手工 + verify 脚本**（Could），Playwright 内核 100MB+，与"本地优先小依赖"取向冲突 |
| 遥测 | LangFuse / 本地日志 | **本地日志**（Q-11 默认），LangFuse 可选关闭 |
| Demo 部署 | Vercel / 静态导出 | **Vercel**（`/demo` 走 serverless，无需数据库） |

### 3.6 风险与回退

| 风险 | 触发信号 | 回退 |
|---|---|---|
| 评测集质量差（gold 标错） | 宏平均异常低 | 抽查 5 条 gold；错标条目 re-review 后 bump 版本 |
| fixtures 与代码不同步 | replay 指标与真实模型差 > 10pt | 重新录制 fixtures；报告标注录制日期 |
| CI 跑不起来（GitHub Actions 无 Docker） | workflow 失败 | CI 不跑 DB 测试：单测用内存仓储；`verify:*` 只在本地/可选手动 |
| 干净机器仍踩坑 | 你在新机器复现失败 | 把该坑写进 `docs/getting-started.md` 踩坑清单（这是 I4 的核心产物之一） |
| Demo 泄露样例中的真实信息 | 人工检查 | 样例一律合成；`check-sensitive --all` 兜底 |

---

## 4. 如何验收评分

### 4.1 验收清单

- [ ] `npm run eval` 两次结果一致；`--subset`/`--real` 均可用
- [ ] 基线建立并可判断退化（AC-2 人为打坏能触发退出码 1）
- [ ] `dataset.lock.json` 阻止偷改评测集
- [ ] CI 在 GitHub 上全绿（离线、无 secrets）
- [ ] `npm run preflight` 在干净机器输出正确诊断
- [ ] 按 README 从零启动成功（你亲自在一台干净环境/新目录验证）
- [ ] `DEMO_MODE=1` 下 `/demo` 可看、写接口 403
- [ ] `/settings/diagnostics` 能看到真实调用日志与成本
- [ ] `npm run verify:i4` 全绿、报告留档

### 4.2 评分卡（100 分）

| 维度 | 权重 | 判据 |
|---|---|---|
| 评测可信度 | 30 | 50 条评测集 + 确定性 replay + 基线 + 退化门 |
| CI 与自动化 | 20 | CI 全绿且离线；pre-commit 双保险 |
| 可交付性 | 25 | 干净机器一键启动成功；踩坑清单覆盖真实坑 |
| 只读 Demo | 15 | 可公开访问、无写入路径、无真实数据 |
| 可观测性 | 10 | 用量/降级/成本可见且不泄露密钥 |

### 4.3 通过阈值

| 分数 | 结论 |
|---|---|
| ≥85 | **M1 关闭**（可交付里程碑达成） |
| 70–84 | 有条件通过：扣分项进 I5 首日 |
| <70 | 不通过（回归做 T2/T4/T5） |

**红线**：Demo 可写 / CI 需要真实密钥 / 评测不可复现 / README 一键启动失败 —— 任一即不通过。

### 4.4 证据与留档

| 项 | 位置 |
|---|---|
| 评测报告 | `evals/reports/eval-replay-<date>.txt`（不进 Git） |
| 基线 | `evals/jd/baseline.json`（进 Git，作为质量契约） |
| CI 运行链接 | GitHub Actions 页面 |
| 启动验证 | `docs/getting-started.md` 的"验证清单" + 你的实机结果 |
| Demo 链接 | 部署后 URL |

---

## 5. 实现状态（滚动更新）

| 任务 | 状态 | 证据 |
|---|---|---|
| T1 评测集 | ✅ 完成 | `evals/jd/dataset.jsonl` 40 条 + `dataset.lock.json`（sha256 防偷改）；生成器 `scripts/gen-eval-dataset.mjs` |
| T2 评测器 | ✅ 完成 | `scripts/eval.mjs`：rules/replay/real 三模式、`--subset`、`--report`、lock 校验；评分纯函数 `src/lib/eval/scoring.ts` + 7 例测试 |
| T3 基线 | ✅ 完成 | rules 模式宏平均 **91.1%** → `evals/jd/baseline.json`（退化 >3pt 即失败）；字段：company 100 / title 100 / cities 100 / deadline 80 / salary 100 / skills 69.8 |
| T4 CI 门 | ✅ 完成 | `.github/workflows/ci.yml`：core（零依赖纯净度+单测+doctor）+ full（npm ci/lint/typecheck/test/lock 校验/eval/敏感扫描），**离线无 secrets** |
| T5 preflight | ✅ 完成 | `scripts/preflight.mjs`：Node/依赖/.env/Docker(daemon)/端口/迁移 逐项诊断 + 可执行修复命令；沙箱 EPERM 不再误报"未安装" |
| T6 只读 Demo | ✅ 完成 | `/demo` 读 `evals/demo/sample.json`（不连库）+ `src/middleware.ts` 在 `DEMO_MODE=1` 下拦截所有写接口（403） |
| T7 启动文档 | ✅ 完成 | `docs/getting-started.md`：三步跑通 + 验证清单 + **10 条真实踩坑**（此项目实际遇到过） |
| T8 用量记账/诊断页 | ✅ 完成 | `src/lib/server/usage.ts`（best-effort 记账+汇总）+ `/settings/diagnostics`（模型/prompt 版本/用量/降级/最近 20 条调用） |
| T9 管线日志字段 | ✅ 完成 | 迁移 0007 加 `prompt_version`（= prompts 内容 sha256 前 8 位，改 prompt 自动变版本）；`onUsage` 在 `getModelRouter()` 注入 |
| T10 验收器 | ✅ 完成 | `npm run verify:i4` **20/20 通过**，`--report` 写 `evals/reports/F-09-i4-accept.txt`（含人工验证清单） |
