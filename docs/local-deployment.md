# 本地一键启动与"部署"选择（隐私优先）

> 你的数据是**隐私数据**：简历、JD 原文、台账 CSV、附件截图、模型 Key。
> 所以"部署到哪"本质是**隐私边界选择**，不是纯技术选择。

---

## 1. 先看结论

| 方案 | 数据在哪 | 适合你吗 | 结论 |
|---|---|---|---|
| **A. 本地一键启动**（双击 `start.bat`） | 只在本机 | ✅ 完全适合 | **推荐先做这个** |
| B. 局域网访问（手机/平板打开） | 只在本机（同一 Wi-Fi） | ✅ 适合 | 可选，加 `--lan` |
| C. 只把只读 `/demo` 部署到 Vercel | 样例数据（全虚构） | ✅ 适合展示 | 可选，做作品集用 |
| D. 整套应用上 Vercel/云 DB | **上云** | ❌ 与"数据只在本机"冲突 | 不建议 |
| E. 自己的 VPS 自托管 | 你的服务器（公网暴露） | ⚠️ 现在**没有登录鉴权** | 暂缓，等 F-13 加鉴权 |

**核心判断**：你现在痛的是"每次都要敲终端"，不是"想在任何设备随时访问"。
那就用 **A**（双击启动），不需要为此把隐私数据搬到云上。

---

## 2. 方案 A：本地一键启动（已实现）

### 2.1 用起来

双击项目根目录的 **`start.bat`**，它会自动：

1. 检查依赖与 `.env`
2. Docker daemon 没起来 → 尝试拉起 Docker Desktop（最多等 120 秒）
3. `docker compose up -d db` 启动 Postgres
4. 等数据库端口就绪 → 跑迁移（幂等）
5. 没有构建产物就先 `next build`（首次约 1–2 分钟）
6. `next start` 启动应用 → **自动打开浏览器**

关闭窗口 = 停止应用；数据库容器继续在后台（`docker compose down` 可关）。

### 2.2 命令行等价写法

```powershell
npm run app            # = node scripts/local-start.mjs
npm run app -- --lan   # 允许局域网访问
npm run app -- --rebuild   # 改了代码后强制重建
npm run app -- --setup-only   # 只准备环境（旧 setup.bat 的行为）
```

### 2.3 做成桌面快捷方式（可选，一次配置）

```powershell
npm run shortcut       # 在桌面创建 "Profession Search Agent" 快捷方式
```

之后就是**双击桌面图标** → 浏览器自动打开，全程不用终端。

> `.bat` 与 `.ps1` 都是**纯 ASCII + CRLF** 的（cmd 按控制台代码页逐字节解析、PS 5.1 按 ANSI 读脚本，中文会导致解析错误）。
>
> 脚本是**纯 ASCII** 的：Windows PowerShell 5.1 会把 UTF-8 脚本按 GBK 读，中文注释会导致解析失败（本项目踩过）。

### 2.4 开机自启（可选）

```powershell
npm run autostart      # 创建登录时启动的计划任务（隐藏窗口）
npm run autostart -- --remove   # 取消
```

适合"希望它一直在后台，随时浏览器打开就用"的场景。

### 2.5 注意事项

- 首次构建较慢；之后启动只要几秒（有 `.next` 就跳过构建）
- 改了源码 → `start.bat --rebuild`（或 `npm run app -- --rebuild`）
- 端口冲突（3000 被占）→ `npm run app -- --port=3100`
- 数据层容器重启策略是 `unless-stopped`，开机后一般自己会起来

---

## 3. 方案 B：局域网访问（手机/平板）

```powershell
npm run app -- --lan
```

- 手机连同一个 Wi-Fi，打开 `http://<电脑IP>:3000`
- 电脑 IP：`ipconfig` 看 IPv4
- 首次会被 Windows 防火墙拦：允许 Node.js 在专用网络通信
- ⚠️ **不要在公共 Wi-Fi 下开**：当前没有登录鉴权，同网段任何人都能访问你的数据
- 手机截图识别、拖拽看板都能用；体验上比开电脑更顺手

---

## 4. 方案 C：只部署只读 Demo 到 Vercel（作品集）

适合"想给别人看产品长什么样，但不想暴露自己的求职数据"。

```powershell
npm run demo      # 本地验证演示模式
```

部署要点：

1. Vercel 项目设置环境变量 `DEMO_MODE=1`
2. `/demo` 读仓库内 `evals/demo/sample.json`（全虚构样例），**不连数据库**
3. `src/middleware.ts` 会拦截所有写接口 → 403 `E_DEMO_READONLY`
4. 完整应用（`/jobs`、`/experiences`）需要数据库与 Key，**不要部署**

> 如果 Vercel 构建失败：本项目 `next build` 在部分环境需要完整 Node 权限；可改用静态托管（把 `/demo` 单独导出）或只截图放作品集。

---

## 5. 方案 E：VPS 自托管（暂缓）

技术上可行（Docker 全栈 + Caddy/Nginx + HTTPS），但**现在有一个硬缺口：没有登录鉴权**。

在补上鉴权之前，把应用暴露到公网等于"任何人都能读到你的简历和投递记录"。所以：

| 前置条件 | 状态 |
|---|---|
| 登录/单用户口令 | ❌ 未做（F-13 发布与打磨） |
| HTTPS 反向代理 | ❌ 未做 |
| 备份策略 | 🟡 CSV 台账导出算半个（`/settings/workspace`） |

等 F-13 做完再加，届时数据在**你自己的 VPS**上，仍是"你控制的机器"。

---

## 6. 容器化全栈（高级可选）

`docker-compose.yml` 里有 `app` 服务（profile `full`）：

```powershell
docker compose --profile full up -d --build
```

- 数据仍在宿主机 `.data/pgdata`（volume 挂载）
- `.env` 通过 `env_file` 注入；DATABASE_URL 自动指向容器内 `db`
- 已加 `.dockerignore`：`.env`、`data/`、`node_modules/`、`.next/`、`evals/reports/` 都不会进镜像
- 适合"想固定环境、不想改 Node 版本"的场景；但每次改代码要重新 build 镜像，日常开发不如方案 A

---

## 7. 推荐决策

```
现在：方案 A（双击启动）            ← 已实现，立刻可用
想要手机用：方案 B（--lan，注意 Wi-Fi 安全）
想展示作品：方案 C（只读 Demo 上 Vercel）
想公网自托管：等 F-13 加鉴权后再做（方案 E）
```

**不要做的事**：为了"方便打开"把含真实数据的完整应用部署到公网。当前没有鉴权，一旦被扫到就是裸奔。
