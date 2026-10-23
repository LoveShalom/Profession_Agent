# P0 功能清单与规范索引

> 本文件是 **P0 阶段（工程地基 + JD 入库闭环）** 的功能总览与功能规范索引。
> 规范写法遵循 [_TEMPLATE.md](../../spec/features/_TEMPLATE.md)；功能编号、优先级与增量映射见 [logs/README.md](../../logs/README.md) §4 与 [roadmap.md](../../spec/roadmap.md) §2；架构决策另见同目录 `ADR-00xx`。
> 状态图例：⬜ 未开始 · 🟡 进行中 · 🔵 待验收 · ✅ 已验收

## 1. P0 范围

P0 = **I0（工程地基与 Provider 适配层）+ I1（JD 入库闭环）**，对应 mission 的阶段 P0–P1 前段。

| 编号 | 功能 | 增量 | 优先级 | 规范 | 状态 | 验收门（DoD） |
|---|---|---|---|---|---|---|
| T1 | 一键启动脚本（`npm run setup` / `start.bat`） | I0 | P0 | **[F-01](../../spec/features/F-01-bootstrap.md)** | ⬜ | D5 |
| B4 | LLM 调用封装（Provider 适配层，OpenAI 兼容 + `.env`） | I0 | P0 | **[F-01](../../spec/features/F-01-bootstrap.md)** | ⬜ | D4 |
| B17 | Provider 适配与凭证服务（仅适配层部分） | I0 | P0 | **[F-01](../../spec/features/F-01-bootstrap.md)** | ⬜ | D4 |
| B15 | 数据层约束（本地单用户；RLS 仅多账号启用） | I0 | P0 | **[F-01](../../spec/features/F-01-bootstrap.md)** §3.1-T7 | ⬜ | D1 |
| A12 | Provider 能力探测与降级链 | I0 | P0 | **[F-01](../../spec/features/F-01-bootstrap.md)** §1.3-C、§3.1-T5 | ⬜ | D4 |
| B1 | 用户认证（**本增量仅"开关 + 不阻断"**；完整流程移至 I2 前段） | I0 | P1 | **[F-01](../../spec/features/F-01-bootstrap.md)** §3.3 | ⬜ | D4 |
| A1 | JD 结构化抽取（字段字典 v1，18 字段） | I1 | P0 | **[F-02](../../spec/features/F-02-jd-ingest.md)** | ⬜ | D2 |
| A3 | 字段校验与兜底（confidence <0.7 待确认） | I1 | P0 | **[F-02](../../spec/features/F-02-jd-ingest.md)** | ⬜ | D2 |
| A15 | 自一致性置信度（K=3 一致率替代 LLM 自报） | I1 | P1 | **[F-02](../../spec/features/F-02-jd-ingest.md)** §1.3-C、§3.1-T6 | ⬜ | D4 |
| B5 | 结构化输出校验（Zod + Prompt-JSON 修复重试） | I1 | P0 | **[F-02](../../spec/features/F-02-jd-ingest.md)** | ⬜ | D4 |
| F1 | JD 粘贴与解析预览页 | I1 | P0 | **[F-02](../../spec/features/F-02-jd-ingest.md)** | ⬜ | D3 |
| F2 | 岗位列表（筛选/排序/搜索） | I1 | P0 | **[F-02](../../spec/features/F-02-jd-ingest.md)** ※移至 I2 首日 | ⬜ | D3 |
| F3 | 岗位详情 | I1 | P0 | **[F-02](../../spec/features/F-02-jd-ingest.md)** ※移至 I2 首日 | ⬜ | D3 |
| B2 | 岗位 CRUD + 软删除 | I1 | P0 | **[F-02](../../spec/features/F-02-jd-ingest.md)** | ⬜ | D1 |

> DoD 代码：D1 数据层 / D2 AI 抽取生成 / D3 UI / D4 服务 / D5 文档（定义见 [roadmap.md](../../spec/roadmap.md) §1.2）

## 2. 功能规范编写队列

每个功能**四节齐全才允许开工**：① 功能规格与分支 ② 收集需求 ③ 任务计划 ④ 如何验收评分。

| 顺序 | 编号 | 功能 | 所属增量 | 规范文件 | 状态 |
|---|---|---|---|---|---|
| 1 | **F-01** | 工程地基与 Provider 适配层 | I0 | [F-01-bootstrap.md](../../spec/features/F-01-bootstrap.md) | ✅ 已编写（12h，已对账） |
| 2 | **F-02** | JD 入库闭环 | I1 | [F-02-jd-ingest.md](../../spec/features/F-02-jd-ingest.md) | ✅ 已编写（30h，已对账） |
| 3 | F-03 | 经历录入与 STAR 结构化 | I2 | `spec/features/F-03-experience.md` | ⬜ 待写（**建议下一篇**） |
| 4 | F-04 | 简历导入解析 | I2 | `spec/features/F-04-resume-import.md` | ⬜ 待写 |
| 5 | F-05 | 状态流转与看板 | I3 | `spec/features/F-05-pipeline.md` | ⬜ 待写 |
| 6 | F-06 | 去重与入库判定 | I3 | `spec/features/F-06-dedupe.md` | ⬜ 待写 |
| 7 | F-07 | BYOK 设置页（最小版） | I2 | `spec/features/F-07-byok-mini.md` | ⬜ 待写 |
| 8 | F-08 | 质量基线与无状态展示页 | I4 | `spec/features/F-08-release.md` | ⬜ 待写 |

> **编号即编写顺序**：F-01（地基）→ F-02（JD 闭环）→ I2 → I3 → I4。F-01 先行的原因是 I0 一开工就要有规范可依（它是 I1 的硬依赖）。

## 3. P0 出口门

| 里程碑 | 条件 | 软锚日期 | 依据 |
|---|---|---|---|
| M0 项目骨架 | I0 全部功能项验收：干净机器 `npm run setup` 可跑、`.env` 换模型生效、数据只落本机 | 10/14 | [roadmap.md](../../spec/roadmap.md) §6 |
| M1 可交付 | I0–I4 验收：含简历导入、BYOK 最小版、状态流转、本地一键启动可复现 + 无状态展示页可打开 | 11/02 | 同上 |

**P0 阶段红线**：关键字段（薪资/截止）evidence 覆盖 <100%、密钥或原文泄漏进日志、主路径在任一降级路径下崩溃。

## 4. 约定

- 本文件只做**索引与状态**，不承载规范正文（避免多处维护）。
- 架构决策（选型、取舍、后果）写在同目录 `ADR-0001 ~ ADR-0010`，见 [tech_stack.md](../../spec/tech_stack.md) §4 的清单。
- 新功能先登记到本表，再创建规范文件；规范文件命名 `F-xx-<kebab-name>.md`。
