# 快速开始（干净机器一键跑通）

> 面向第一次接触本项目的人。目标：**10 分钟内**在本地跑起来，且不踩隐藏的坑。
> 有疑问先跑 `npm run preflight` —— 它会逐项告诉你缺什么、该敲什么命令。

---

## 0. 你需要什么

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 20（推荐 24） | `node -v` 检查 |
| Docker Desktop | 任意较新版本 | 提供 Postgres + pgvector；**也可以用外部 Postgres 代替** |
| 一个 LLM API Key | 可选 | 不配也能跑（规则模式 L4，字段多为"待确认"） |

支持 Windows / macOS / Linux。Windows 下命令用 PowerShell。

---

## 1. 三步跑起来

> **想跳过终端？** 双击项目根目录 `start.bat`：自动起数据层 → 迁移 → 构建(首次) → 打开浏览器。
> 更多（桌面快捷方式、开机自启、局域网、部署选择）见 [docs/local-deployment.md](./local-deployment.md)。

```powershell
# ① 安装依赖
npm install

# ② 环境体检（可选但强烈建议）
npm run preflight

# ③ 数据层 + 配置 + 迁移 + 开发服务器
npm run setup      # 启动 Docker 数据层、生成 .env（缺的键会补齐）、跑迁移
npm run dev
```

打开 http://localhost:3000

`setup` 是幂等的：重复执行不会破坏已有数据；它只在缺失时补键、只在未应用时跑迁移。

---

## 2. 打开后先看这四个入口

| 入口 | 用途 |
|---|---|
| `/jobs/new` | 粘贴一段 JD（或 `Ctrl+V` 截图）→ 抽取 → 确认 → 入库 |
| `/jobs/board` | 投递看板：拖动卡片改状态（回退/结束要填备注） |
| `/experiences` | 经历库：粘贴自述 → AI 归纳 STAR；可查看/编辑 |
| `/experiences/import` | 上传 PDF/DOCX 简历 → AI 切分多段 → 逐条确认导入 |

其他入口：`/jobs`（列表 + 状态筛选）、`/settings/llm`（模型凭证）、`/settings/workspace`（CSV 台账）、`/settings/diagnostics`（用量与降级）、`/demo`（只读演示）。

---

## 3. 环境变量（`.env`）

| 键 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | ✅ | 默认 `postgres://postgres:postgres@127.0.0.1:54322/postgres` |
| `ENCRYPTION_KEY` | ✅ | 32 字节 base64/hex；`setup` 会自动生成。**丢了就用设置页重新保存凭证** |
| `LLM_PROVIDER` / `LLM_MODEL` | 建议 | 文本模型，如 `deepseek` / `deepseek-chat` |
| `LLM_API_KEY` | 可选 | 不填走规则模式；填了走模型 |
| `LLM_VISION_PROVIDER` / `LLM_VISION_MODEL` / `LLM_VISION_API_KEY` | 可选 | 截图识别用；DeepSeek 用户填 `deepseek` / `deepseek-flash` |
| `WORKSPACE_DIR` | 可选 | CSV 台账目录，默认 `./data/workspace` |

> 也可以在 `/settings/llm` 里配模型凭证（AES-256-GCM 加密存库，**优先级高于 `.env`**），更适合不想把 Key 写在文件里的场景。

---

## 4. 验证清单（跑完应全绿）

```powershell
npm run doctor              # 配置与安全策略自检
npm run preflight           # 环境体检（Docker/端口/env/迁移）
node scripts/migrate.mjs    # 迁移幂等（应全部 ✅）
npm test                    # 单测（不需要数据库）
npm run lint && npm run typecheck
npm run eval                # 抽取质量评测（离线，宏平均应 ≥ 基线）
```

---

## 5. 只读演示模式（可选）

```powershell
$env:DEMO_MODE='1'; npm run dev     # Windows PowerShell
# DEMO_MODE=1 npm run dev            # macOS / Linux
```

- `/demo` 展示预生成样例（不连数据库、不需要 Key）
- 所有写接口返回 403 `E_DEMO_READONLY`
- 适合部署到 Vercel 给评审者看；样例数据全部虚构（`evals/demo/sample.json`）

---

## 6. 常见坑（都是真实踩过的）

| 现象 | 原因 | 处理 |
|---|---|---|
| `docker --version` 成功但连接失败 / 等待 120s | **Docker daemon 没启动**（CLI 在 ≠ 后台在跑） | 打开 Docker Desktop 等鲸鱼图标变绿；`npm run doctor` 会在 1s 内指出 |
| 端口 54322 被占用 | 上次容器没停 / 被别的服务占了 | `docker compose down` 后重来；或改 `POSTGRES_PORT` 并同步改 `DATABASE_URL` |
| `relation "jobs" does not exist` | 迁移没跑 | `node scripts/migrate.mjs`（幂等，可重复） |
| 打开页面提示"无法读取数据库" | 数据层没起 / DATABASE_URL 错 | `npm run preflight`，然后 `docker compose up -d` |
| 状态/技能列显示英文枚举 | 旧版本数据脏值（如 `offer`） | 迁移 0006 已归一为 `saved`；重跑迁移即可 |
| 上传简历报"缺少解析依赖" | 装了依赖但没重启 dev | 重启 `npm run dev`；生产构建要重新 `npm run build` |
| 中文文件写入后乱码 | PowerShell 重定向的编码问题 | 用编辑器保存 UTF-8；或在脚本里 `writeFileSync(..., 'utf8')` |
| **改了代码但页面没变化 / 看不到新按钮** | `start.bat` 之前只看"有没有 `.next`"，不会重建 | 已修：启动器会比较源码与构建时间，**源码更新时自动重新构建**；也可手动 `npm run app -- --rebuild` |
| `next build` 在某些受限环境失败（EPERM） | 沙箱/权限限制 | 在正常终端跑；这类环境改用 `npm run dev` + 验证脚本 |
| 编辑经历后指标消失 | 已修（F-05 保存透传 `draftMetrics`） | 更新到最新代码 |
| `.env` 改了没生效 | dev server 不重读 env | 重启 `npm run dev` |
| 双击 `start.bat` 报「'own' 不是内部或外部命令」「字符串缺少终止符」等碎片 | **`.bat` 含中文（cmd 按 GBK 解析 UTF-8 字节）+ 换行是 LF + 中途 chcp** | 已修：`start.bat` 改**纯 ASCII + CRLF**（`chcp 65001` 仅在纯 ASCII 下安全）。写 `.bat` 时务必 ASCII+CRLF |
| `npm run shortcut` 报「字符串缺少终止符」 | **Windows PowerShell 5.1 把 UTF-8 脚本按 ANSI(GBK) 读**，中文注释把引号吃掉 | 已修：`scripts/*.ps1` 改为**纯 ASCII**。以后写 `.ps1` 一律 ASCII 或存 UTF-8 with BOM |

---

## 7. 卸载 / 清理

```powershell
docker compose down -v     # 停容器并删除数据卷（⚠️ 会删库，先导出 CSV 台账）
node scripts/seed-f08.mjs --clean   # 清理 F-08 验收演示数据
```

数据只在本机：`data/`（台账/原始 JD/附件）与 Docker 卷。`data/` 已在 `.gitignore` 里，不会进 Git。
