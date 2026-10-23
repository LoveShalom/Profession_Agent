# F-02 验收步骤（JD 入库闭环）

> 对象：项目所有者本人手动执行。预计 **15–20 分钟**（含构建与页面走查）。
> 依据：[F-02 功能规范](../spec/features/F-02-jd-ingest.md)（AC-1 ~ AC-18）。
> 为什么需要你手动做一部分：代理环境禁止 spawn 管道（`spawn EPERM`），`next build` 与页面必须在你自己机器上跑。

---

## 0. 前置检查（30 秒）

```powershell
docker compose up -d          # 或 npm run setup
docker info --format "{{.ServerVersion}}"      # 有输出 = daemon 正常
npm install                   # 确保 pg / @types/pg / next 已装
```

```powershell
# 迁移应为 4 条（0004 补齐了 jobs.deadline_text —— 0001 漏写的字段）
docker compose exec -T db psql -U postgres -d postgres -c "select filename from schema_migrations order by 1;"
docker compose exec -T db psql -U postgres -d postgres -c "\d jobs" | Select-String "deadline_kind|deadline_text"
```

**期望**：4 条迁移；`deadline_text` 与 `deadline_kind` 两列都在。

---

## 1. 自动化层（离线，约 10 秒）

```powershell
npm test                  # 期望 244/244 通过
npm run typecheck         # 期望 0 error
npm run lint              # 期望 0 problem
npm run verify:f02        # 期望 12 项全 PASS（D1–D3b + L1–L4 + R1 跳过）
```

**`verify:f02` 各项含义**

| 编号 | 检查 | 期望 |
|---|---|---|
| D1 | 迁移版本 | `schema_migrations` = 4 条 |
| D2 | `job_skills` 约束 | 反幻觉 / 推测熟练度 / 置信度 3 条都在 |
| D2b | 唯一键 | `(job_id, skill, source)` |
| D3 | `jobs.deadline_kind` | 列存在 |
| D3b | 三态一致性约束 | 2 条 CHECK 都在 |
| L1 | 规则模式端到端 | 公司/岗位/城市/截止抽出，0 阻塞 |
| L1b | 技能属性 | Java 命中 must，每条都有依据短语 |
| L2 | 入库 + 去重 | 首次 `created`、再次 `duplicate` |
| L3 | 指纹归一化 | 后缀/括号/城市顺序不影响指纹 |
| L4 | K=3 一致性 | 2/3 一致 → 0.667 → 待确认 |

---

## 2. 构建层（关键，我这边跑不了）

```powershell
npm run build
```

**期望**：输出类似

```
Route (app)                              Size
┌ ○ /                                    ...
├ ○ /jobs                                 ...
├ ƒ /jobs/new                             ...
├ ƒ /api/parse-jd                         ...
└ ƒ /api/jobs                             ...
```

**失败对照**

| 报错 | 原因 | 处理 |
|---|---|---|
| `Cannot find module 'pg'` | 没装驱动 | `npm install` |
| `缺少 DATABASE_URL` / env 校验失败 | `.env` 不完整 | 按提示补 `.env`，或 `npm run setup` 重新生成 |
| `Module not found: '@/lib/...'` | tsconfig paths 未生效 | 确认 `tsconfig.json` 的 `paths` 未改动 |

---

## 3. 界面端到端（人工走查，约 10 分钟）

```powershell
npm run dev
```

打开 http://localhost:3000 ，然后按顺序走 7 步：

| # | 操作 | 期望 |
|---|---|---|
| 1 | 点「粘贴 JD 并解析」 | 进入 `/jobs/new` |
| 2 | 粘贴一段真实 JD（带薪资/技能/截止日期）→ 解析 | 出现「解析结果」卡片：level 徽标（L0 或「规则模式」）、路径、字数/PII 提示 |
| 3 | 看字段区 | 每个字段有**原文依据**；建议复核的字段**黄色高亮**；技能分三列（明确必须 / 明确加分 / 推测） |
| 4 | 改一个字段（例如薪资上限），勾选「我已核对以上字段」 | 入库按钮变为可用 |
| 5 | 点「确认入库」 | 提示「✅ 已入库」，可点「查看岗位列表」 |
| 6 | 回 `/jobs/new`，粘贴**同一段** JD 再入库 | 提示「⚠️ 该岗位已存在」，给出「查看已有 / 仍然新建一条」 |
| 7 | 粘贴一段**没有截止日期**的 JD | 截止显示「—」或「未提供」，**能正常入库**（这是 R-3 的核心场景） |

**额外检查（无 Key 也能验）**：把 `.env` 的 `LLM_API_KEY` 临时清空 → 重启 dev → 解析应显示「规则模式」横幅，字段大多标待确认，但**整条链路仍可走通**。

---

## 4. 接口层（可选，PowerShell）

```powershell
# 解析（不落库）
$body = @{ rawText = "某公司 招聘 后端开发工程师`n薪资 15k-25k`n技能要求：熟悉 Java`n截止 2026-11-20" } | ConvertTo-Json
$r = Invoke-RestMethod -Uri http://localhost:3000/api/parse-jd -Method Post -ContentType 'application/json' -Body $body
$r.level; $r.extraction.fields.company; $r.validation.needsReview

# 列表
Invoke-RestMethod -Uri 'http://localhost:3000/api/jobs?limit=5' | ConvertTo-Json -Depth 4
```

**期望**：`/api/parse-jd` 返回 `level` + `extraction` + `validation`，且**数据库条数不变**（解析不落库）。

---

## 5. 存档与签署

```powershell
node scripts/verify-f02.mjs --report evals\reports\F-02-accept.txt
node scripts/verify-f02.mjs --real --report evals\reports\F-02-accept-real.txt   # 可选，消耗约 1–2k token
docker compose exec -T db psql -U postgres -d postgres -c "\dt" *> evals\reports\F-02-tables.txt
```

**通过判定**

| 项 | 门槛 |
|---|---|
| 自动化层 | `npm test` 244/244；`typecheck`/`lint` 0；`verify:f02` 0 失败 |
| 构建层 | `npm run build` 成功，路由列表包含 `/jobs/new`、`/api/parse-jd`、`/api/jobs` |
| 界面层 | 7 步全部符合期望（尤其第 6 步去重、第 7 步无截止日期） |
| 接口层（可选） | `/api/parse-jd` 不落库；`/api/jobs` 能列出 |
| 真实模型（可选） | `--real` 时 `R1` PASS（level=L0） |

全部满足 → F-02 验收通过，可以进入 I2（经历库）。

---

## 6. 已知未完成项（不阻塞本次验收，但要记录）

| 项 | 说明 |
|---|---|
| T12a 评测基线 | 10 条 JD + Promptfoo 基线（宏平均 ≥80% 过程门），需安装评测依赖 |
| 岗位详情页 / 完整筛选排序 | 属 I2 的 T11（已从 I1 外移） |
| 岗位编辑/软删除 UI | 属 B2 的完整版，当前只有创建与列表 |
