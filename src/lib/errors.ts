/**
 * 统一错误类型与脱敏工具（I0 / T4、T6）
 *
 * 设计目标：
 * 1) 把"模型调用可能出现的所有失败"收敛成可判别、可分流、**可给用户修复建议**的类型，
 *    这样降级链（L0–L4）与 doctor 都能基于 kind 做决策，而不是靠字符串匹配。
 * 2) 提供一个"绝不泄漏密钥"的脱敏函数，日志/遥测/错误信息统一经它处理（AC-9 红线）。
 *
 * 零依赖：不引入任何第三方包，可直接被 Node 24 运行（原生类型剥离）。
 */

export type ProviderErrorKind =
  | 'auth' // 401 / 403：Key 无效或权限不足
  | 'rate_limit' // 429：限流
  | 'unreachable' // DNS / 连接 / 超时：地址或网络问题
  | 'capability' // 模型缺少所需能力（tool_calling / embedding ...）
  | 'schema' // 结构化输出校验失败（含修复重试后仍失败）
  | 'config' // 配置本身非法（如私网地址被拒）
  | 'server'; // 5xx：上游故障

export type CapabilityName = 'tool_calling' | 'json_schema' | 'stream' | 'embedding';

export interface ProviderErrorInit {
  status?: number;
  retryAfterMs?: number;
  missing?: CapabilityName;
  raw?: string;
  attempts?: number;
  hint?: string;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly missing: CapabilityName | undefined;
  readonly raw: string | undefined;
  readonly attempts: number | undefined;
  readonly hint: string | undefined;
  readonly reason: unknown;

  constructor(kind: ProviderErrorKind, message: string, init: ProviderErrorInit = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = init.status;
    this.retryAfterMs = init.retryAfterMs;
    this.missing = init.missing;
    this.raw = init.raw === undefined ? undefined : redactSecrets(init.raw).slice(0, 500);
    this.attempts = init.attempts;
    this.hint = init.hint;
    this.reason = init.cause;
  }

  /** 是否值得重试（用于指数退避） */
  get retryable(): boolean {
    if (this.kind === 'rate_limit' || this.kind === 'server' || this.kind === 'unreachable') return true;
    if (this.kind === 'auth' || this.kind === 'capability' || this.kind === 'config') return false;
    return false;
  }

  /** 是否应触发 L3 降级（规则模式） */
  get shouldDegrade(): boolean {
    return this.kind === 'auth' || this.kind === 'rate_limit' || this.kind === 'unreachable' || this.kind === 'server';
  }

  /** 给用户看的"下一步怎么做"（AC-4 / AC-5 要求错误信息含修复建议） */
  get userHint(): string {
    if (this.hint) return this.hint;
    switch (this.kind) {
      case 'auth':
        return '请在设置页检查 API Key 是否正确、是否有该模型权限；也可先切换到"无密钥规则模式"继续使用。';
      case 'rate_limit':
        return '上游限流，稍后重试；或在设置页切换到其他 provider / 降低采样次数（LLM_SAMPLE_K）。';
      case 'unreachable':
        return '请检查 LLM_BASE_URL 拼写、网络与代理设置；本地模型（Ollama）需同时开启 ALLOW_PRIVATE_BASE_URL=true。';
      case 'capability':
        return `当前模型缺少能力「${this.missing ?? 'unknown'}」，系统会尝试降级路径；如持续失败请换一个支持该能力的模型。`;
      case 'schema':
        return '模型输出未通过结构校验，已尝试自动修复；请重试，或改用支持 Function Calling 的模型。';
      case 'config':
        return '请按提示修正配置后重新运行。';
      default:
        return '上游服务异常，请稍后重试。';
    }
  }

  /** 结构化日志用（已脱敏） */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      kind: this.kind,
      message: redactSecrets(this.message),
      status: this.status,
      retryable: this.retryable,
      missing: this.missing,
      attempts: this.attempts,
      hint: this.userHint,
    };
  }

  static auth(status: number, message = 'API Key 无效或权限不足'): ProviderError {
    return new ProviderError('auth', message, { status });
  }

  static rateLimit(retryAfterMs?: number): ProviderError {
    return new ProviderError('rate_limit', '上游限流（429）', {
      status: 429,
      retryAfterMs,
      hint: retryAfterMs ? `上游要求 ${Math.ceil(retryAfterMs / 1000)} 秒后重试。` : undefined,
    });
  }

  static unreachable(cause: unknown, baseUrl: string): ProviderError {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return new ProviderError('unreachable', `无法连接到模型端点：${redactSecrets(detail)}`, {
      cause,
      hint:
        `目标地址：${baseUrl}。请检查 LLM_BASE_URL 的拼写、网络与代理设置；` +
        '若使用本地模型（Ollama / vLLM），需同时设置 ALLOW_PRIVATE_BASE_URL=true。',
    });
  }

  static capability(missing: CapabilityName): ProviderError {
    return new ProviderError('capability', `模型缺少必要能力：${missing}`, { missing });
  }

  static schema(raw: string, attempts: number): ProviderError {
    return new ProviderError('schema', `结构化输出校验失败（已尝试 ${attempts} 次）`, { raw, attempts });
  }

  static server(status: number, raw?: string): ProviderError {
    return new ProviderError('server', `上游服务错误（${status}）`, { status, raw });
  }

  static config(message: string, hint?: string): ProviderError {
    return new ProviderError('config', message, { hint });
  }
}

/** 判断是否为 ProviderError（跨模块边界时用） */
export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}

/**
 * 脱敏规则表：每个模式显式声明替换模板。
 *
 * ⚠️ 踩过的坑：不要用「回调里判断 p1/p2 是否存在」的写法。`String.replace` 的回调参数
 * 个数取决于正则**是否有捕获组**——无捕获组时传的是 `(match, offset, string)`，
 * 此时 offset 会被误当成 $1、整个输入被误当成 $2，结果是既没脱敏、还把原文复制一份。
 * 因此这里统一用字符串模板（$1/$2 仅在有捕获组的模式里出现）。
 */
const SECRET_PATTERNS: ReadonlyArray<{ re: RegExp; to: string }> = [
  // 多数兼容厂商（DeepSeek / Kimi / 硅基流动 / OpenAI …）；sk-ant-* 也含 '-'，被此条覆盖
  { re: /\bsk-[A-Za-z0-9_-]{8,}\b/g, to: '***' },
  { re: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, to: 'Bearer ***' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, to: '***' }, // AWS Access Key ID
  { re: /\bAIza[0-9A-Za-z_-]{20,}\b/g, to: '***' }, // Google API Key
  // JSON 形态：保留键名，抹掉值
  {
    re: /("?(?:api[_-]?key|access[_-]?token|token|secret|password|authorization)"?\s*[:=]\s*")[^"]{4,}(")/gi,
    to: '$1***$2',
  },
  // URL / env 形态：保留键名，抹掉值
  { re: /\b(api[_-]?key|access[_-]?token|token|secret|password)=([^\s&"']{4,})/gi, to: '$1=***' },
  // base64 的 32 字节密钥（ENCRYPTION_KEY）。注意不能用 \b 收尾：`=` 是非单词字符，边界不成立。
  { re: /[A-Za-z0-9+/]{43}=/g, to: '***' },
];

/** 脱敏：把密钥类内容替换为 ***。最后一道防线——即使调用方忘了处理，日志里也不会有明文。 */
export function redactSecrets(input: string): string {
  let out = input;
  for (const { re, to } of SECRET_PATTERNS) out = out.replace(re, to);
  return out;
}

/** 只保留密钥尾部 4 位，用于 UI 展示（key_last4） */
export function maskKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 4) return '****';
  return `****${trimmed.slice(-4)}`;
}
