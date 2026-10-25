# F-07 BYOK 设置页最小版

## 0. 元信息

| 项 | 内容 |
|---|---|
| 编号 / 名称 | F-07 BYOK 设置页最小版（模型凭证配置） |
| 所属增量 | **I2**（F-05 + F-06 + F-07 = 30h） |
| 优先级 | P1 |
| 关联功能编号 | A12（能力探测）、A13（凭证校验与用量记账） |
| 关联 ADR | [ADR-0007 BYOK 与适配层](../../docs/adr/0007-byok-provider-adapter.md) |
| 依赖 | **F-01**（`probe()` 冒烟校验、能力探测、密文存储表 `user_llm_credentials` 已建） |
| 负责人 / 状态 | 【待填】 / ⬜ 未开始 |
| 估时 | **4h** |

**一句话定义**：在网页里填自己的模型 Key，点保存就生效（并当场验证 Key 是否可用），不用改 `.env` 重启。

> 为什么不只是改 `.env`：非技术用户不会编辑环境变量；而"填了 Key 到底能不能用"必须**当场告诉你**，
> 而不是等到解析 JD 时才发现 Key 失效。

---

## 1. 功能规格与分支

### 1.1 用户故事

- **US-1**：作为用户，我在设置页选模型服务商、填 Key、点保存，系统当场验证并告诉我"连通（延迟 320ms）"。
- **US-2**：作为用户，我填错了 Key，希望立刻被拒绝并看到原因，而不是保存一个坏配置。
- **US-3**：作为用户，我希望页面上只显示 `sk-…abcd` 这样的尾号，**不要把我的 Key 明文显示出来**。
- **US-4**：作为用户，我想随时把 Key 清空，退回"规则模式"。

### 1.2 输入 / 输出契约

| 项 | 内容 |
|---|---|
| 输入 | `CredentialForm { provider: PresetName \| 'custom', baseUrl?: string, model?: string, apiKey?: string }` |
| 中间产物 | `ProbeResult { ok, latencyMs, capabilities, detail? }`（复用 F-01） |
| 输出 | `CredentialSummary { provider, baseUrl, model, keyLast4, status: 'active'\|'invalid'\|'untested', lastVerifiedAt, capabilities }` |
| 错误码 | `E_KEY_INVALID`（401/403）、`E_UNREACHABLE`（网络）、`E_MODEL_NOT_FOUND`（404）、`E_PRIVATE_HOST`（私网未开）、`E_ENCRYPTION`（主密钥缺失） |
| 契约版本 | `byok-settings-v1` |

### 1.3 分支与变体矩阵

| 分支 | 条件 | 行为 |
|---|---|---|
| 保存并验证 | 填了 Key | **先 probe 再落库**：`ok=false` → 拒绝保存并显示原因（不写坏配置） |
| 401/403 | Key 无效/权限不足 | `E_KEY_INVALID` + 提示"检查 Key 或该 Key 的模型权限" |
| 不可达 | DNS/超时 | `E_UNREACHABLE` + 提示检查 `baseUrl`/网络/代理 |
| 404 | 模型名写错 | `E_MODEL_NOT_FOUND` + 列出该 provider 的常见模型名 |
| 私网地址 | `127.0.0.1`/内网 IP 且未开开关 | `E_PRIVATE_HOST` + 提示 `ALLOW_PRIVATE_BASE_URL=true`（Ollama） |
| Ollama（无 Key） | provider=ollama | 允许 Key 为空，直接 probe `/models` |
| 自定义网关 | provider=custom | `baseUrl` 与 `model` 必填，否则表单校验报错 |
| 清空 Key | 用户点删除 | 删除凭证 → 回到 L4 规则模式 + 提示"已切回规则模式" |
| 换模型 | 修改 model/provider | 失效能力缓存（`capabilities` 重新探测） |
| 多套凭证 | 同 provider 不同 baseUrl | 允许并存（唯一键 `(user_id, provider, base_url)`），列表可选"当前使用" |
| 未加密主密钥 | `ENCRYPTION_KEY` 非法/缺失 | `E_ENCRYPTION`：拒绝保存明文（**绝不降级为明文存储**） |

### 1.4 状态与流转

```
未配置（L4 规则模式） --保存并通过 probe--> active（L0/L1 AI 模式）
      ↑                                          |
      └---------- 清空 / probe 失败 --------------┘
```

### 1.5 边界与非目标

- **不做**：多凭证负载均衡/故障转移（I5 之后）
- **不做**：用量配额与成本告警 UI（A13 的展示部分后置）
- **不做**：从 `.env` 反向导入到数据库（避免两处真相源）

---

## 2. 收集需求

### 2.1 需求来源与方法

| 来源 | 结论 |
|---|---|
| 用户需求（G-12 BYOK） | 使用者自己选模型 API |
| 用户需求（C-10 本地优先） | 作者不提供额度，用户自带 Key |
| tech_stack §5 密钥专项 | AES-256-GCM 密文、只写不回读、`key_last4` 展示 |

### 2.2 验收场景

- **AC-1 保存即生效**：填有效 Key → 保存 → 显示"连通（N ms）"→ 解析 JD 时走 L0（不再规则模式）。
- **AC-2 坏 Key 被拒**：填无效 Key → 保存失败 + 明确原因，**数据库不留坏凭证**。
- **AC-3 不回读明文**：页面与接口响应只出现 `keyLast4`；抓包验证无明文 Key。
- **AC-4 清空回退**：删除凭证 → 解析立刻回 L4 规则模式。
- **AC-5 私网提示**：填 `http://127.0.0.1:11434/v1` 且未开开关 → 提示如何开启。
- **AC-6 无主密钥保护**：`ENCRYPTION_KEY` 非法时拒绝保存（不落明文）。

### 2.3 非功能需求

| 项 | 要求 |
|---|---|
| 安全 | 密钥只写不回读；日志/遥测/错误信息全程脱敏（复用 F-01 的 7 类形态） |
| 性能 | 保存含 probe ≤ 5s（超时 5s 明确报错） |
| 可用性 | 表单校验即时反馈；失败原因可操作 |

### 2.4 优先级（MoSCoW）

- **Must**：表单、probe 冒烟、密文存储、只写不回读、清空回退。
- **Should**：能力摘要展示、多凭证并存、失效缓存。
- **Could**：用量与成本摘要展示。
- **Won't**：负载均衡、配额限制 UI。

### 2.5 待澄清问题

| 问题 | 影响 | 默认 |
|---|---|---|
| 凭证存 DB 还是只在 `.env`？ | 两处真相源 | **DB 为主**（设置页写入），`.env` 作为首启默认值；DB 有值时优先 |
| 是否支持"测试但不保存"按钮 | 体验 | 支持（复用 probe） |

---

## 3. 任务计划

| ID | 任务 | 依赖 | 估时 | 产出 | DoD |
|---|---|---|---|---|---|
| **T1** | API：`GET /api/settings/credentials`（脱敏摘要）、`POST`（加密 + probe + 落库）、`DELETE`；换模型时失效能力缓存 | F-01 | 2h | `src/app/api/settings/credentials/route.ts` + `src/lib/credentials/store.ts` | D4 |
| **T2** | 设置页 UI：provider 下拉（7 预设 + custom）、baseUrl/model/key 表单、保存前校验、结果展示、删除按钮 | T1 | 1.5h | `/settings/llm` | D3 |
| **T3** | 测试：AC-1~AC-6（含"坏 Key 不落库""响应无明文"） | T1/T2 | 0.5h | `tests/credentials.test.ts` | D4 |

**顺序**：T1 → T2 → T3。**出口**：在真实环境完成"填 Key → 保存 → 解析走 L0 → 清空 → 回 L4"往返。

---

## 4. 如何验收评分

### 4.1 验收清单

- [ ] AC-1~AC-6 全过
- [ ] 接口响应与页面均无明文 Key（抓包 + 响应体检查）
- [ ] 坏 Key 保存后数据库无残留
- [ ] 清空后 `doctor` 显示回到规则模式

### 4.2 评分卡（100 分）

| 维度 | 权重 | 判据 |
|---|---|---|
| 安全（最高权重） | 40 | 密文存储、不回读、脱敏、无主密钥不降级 |
| 验证有效性 | 25 | 坏 Key 被拒、好 Key 立即生效 |
| 体验 | 20 | 表单清晰、错误可操作、清空易发现 |
| 工程规范 | 15 | 测试、typecheck/lint 0 |

### 4.3 通过阈值

≥85 通过。**红线**：明文存储/回传 Key、坏配置被保存、无主密钥时降级为明文 → 任一即不通过。

---

## 5. I2 收尾记录（2026-10-25）

**已完成**：AES-256-GCM 加密（主密钥非法拒绝加密）、保存前 probe（坏 Key 不入库）、
只写不回读（仅 `keyLast4`）、`/api/settings/credentials`、`/settings/llm` 界面、
**DB 凭证优先于 `.env`**（`getModelRouter()`），删除即回退。

**验证**：7 例单测（加密往返/不含明文/篡改拒绝/覆盖优先级），界面由用户走查通过。
