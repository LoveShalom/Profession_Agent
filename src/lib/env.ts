/**
 * 环境变量契约与校验（I0 / T2）
 *
 * 为什么自己写：I0 的核心必须在**零依赖**下可运行可测试（本机无网络、装不了 zod）。
 * 这里的声明式 spec + 校验引擎与 Zod 的用法一一对应，联网后可按 ADR-0002 的备注
 * 平移到 `z.object`，调用方（`loadEnv` / `assertEnv`）签名不变。
 *
 * 契约要点（F-01 §1.2-A）：
 * 1) **一次性列出全部非法项**，不是遇到第一个就抛（AC-12 的 doctor 依赖这一点）；
 * 2) 区分 error（必须修）与 warning（如疑似拼错的键名）；
 * 3) 缺省值集中在 spec 里，不散落在业务代码；
 * 4) 密钥字段标记 secret，任何输出都不回显明文。
 */

import { randomBytes } from 'node:crypto';
import { redactSecrets } from './errors.ts';

export type FieldKind = 'string' | 'number' | 'boolean' | 'url' | 'base64key32' | 'csv' | 'postgresUrl';

export interface EnvFieldSpec {
  key: string;
  kind: FieldKind;
  required?: boolean;
  default?: string;
  enum?: readonly string[];
  min?: number;
  max?: number;
  integer?: boolean;
  secret?: boolean;
  /** 当该键缺失时系统走哪条降级路径（写进提示，帮助用户理解"留空不是错"） */
  emptyMeans?: string;
  hint?: string;
}

/** 已知前缀：用于识别"疑似拼错的键名"（warning 级） */
const KNOWN_PREFIXES = [
  'LLM_',
  'EMBEDDING_',
  'LANGFUSE_',
  'ENABLE_',
  'ALLOW_',
  'EGRESS_',
  'DATABASE_',
  'ENCRYPTION_',
  'NEXT_PUBLIC_',
  'APP_',
];

export const ENV_SPEC: readonly EnvFieldSpec[] = [
  { key: 'NEXT_PUBLIC_APP_URL', kind: 'url', default: 'http://localhost:3000' },
  { key: 'APP_PORT', kind: 'number', default: '3000', min: 1, max: 65535, integer: true },
  { key: 'NODE_ENV', kind: 'string', default: 'development', enum: ['development', 'test', 'production'] },

  { key: 'DATABASE_URL', kind: 'postgresUrl', required: true },

  {
    key: 'ENCRYPTION_KEY',
    kind: 'base64key32',
    required: true,
    secret: true,
    hint: '由 npm run setup 自动生成；手工生成：node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
  },

  {
    key: 'LLM_PROVIDER',
    kind: 'string',
    default: 'deepseek',
    enum: ['deepseek', 'qwen', 'kimi', 'glm', 'siliconflow', 'openai', 'ollama', 'custom'],
  },
  { key: 'LLM_BASE_URL', kind: 'url', emptyMeans: '使用 provider 内置地址' },
  { key: 'LLM_API_KEY', kind: 'string', secret: true, emptyMeans: '规则模式（不调模型）' },
  { key: 'LLM_MODEL', kind: 'string', emptyMeans: '使用 provider 默认模型' },
  { key: 'LLM_MODEL_EXTRACT', kind: 'string', emptyMeans: '继承 LLM_MODEL' },
  { key: 'LLM_MODEL_GENERATE', kind: 'string', emptyMeans: '继承 LLM_MODEL' },
  { key: 'LLM_SAMPLE_K', kind: 'number', default: '3', min: 1, max: 5, integer: true },

  { key: 'EMBEDDING_PROVIDER', kind: 'string', emptyMeans: '检索降级为关键词检索（tsvector）' },
  { key: 'EMBEDDING_MODEL', kind: 'string', emptyMeans: '检索降级为关键词检索（tsvector）' },

  { key: 'ENABLE_AUTH', kind: 'boolean', default: 'false' },
  { key: 'ALLOW_PRIVATE_BASE_URL', kind: 'boolean', default: 'false' },
  { key: 'EGRESS_EXTRA_HOSTS', kind: 'csv', default: '' },

  { key: 'LANGFUSE_PUBLIC_KEY', kind: 'string', secret: true, emptyMeans: '关闭遥测' },
  { key: 'LANGFUSE_SECRET_KEY', kind: 'string', secret: true, emptyMeans: '关闭遥测' },
  { key: 'LANGFUSE_HOST', kind: 'url', emptyMeans: '关闭遥测' },
];

export interface EnvIssue {
  key: string;
  code: 'missing' | 'invalid' | 'unknown';
  severity: 'error' | 'warning';
  message: string;
  hint?: string;
}

export interface Env {
  appUrl: string;
  port: number;
  nodeEnv: 'development' | 'test' | 'production';
  databaseUrl: string;
  encryptionKey: string;

  llmProvider: string;
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  llmModelExtract?: string;
  llmModelGenerate?: string;
  sampleK: number;

  embeddingProvider?: string;
  embeddingModel?: string;

  enableAuth: boolean;
  allowPrivateBaseUrl: boolean;
  egressExtraHosts: string[];

  langfusePublicKey?: string;
  langfuseSecretKey?: string;
  langfuseHost?: string;

  /** 原始键值（只读，密钥已排除） */
  readonly raw: Readonly<Record<string, string>>;
}

export interface EnvLoadResult {
  ok: boolean;
  env: Env | null;
  issues: EnvIssue[];
}

export class EnvValidationError extends Error {
  readonly issues: EnvIssue[];
  constructor(issues: EnvIssue[]) {
    const errors = issues.filter((i) => i.severity === 'error');
    super(
      `环境变量校验失败（${errors.length} 项）：\n` +
        errors.map((i) => `  - ${i.key}: ${i.message}${i.hint ? `\n      → ${i.hint}` : ''}`).join('\n'),
    );
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off', '']);

function validateField(spec: EnvFieldSpec, raw: string | undefined): { value?: string; issue?: EnvIssue } {
  const value = raw === undefined ? undefined : raw.trim();
  const isEmpty = value === undefined || value === '';

  if (isEmpty) {
    if (spec.default !== undefined) return { value: spec.default };
    if (spec.required) {
      return {
        issue: {
          key: spec.key,
          code: 'missing',
          severity: 'error',
          message: '必填项缺失',
          hint: spec.hint,
        },
      };
    }
    return { value: undefined };
  }

  const invalid = (message: string): { issue: EnvIssue } => ({
    issue: { key: spec.key, code: 'invalid', severity: 'error', message, hint: spec.hint },
  });

  switch (spec.kind) {
    case 'string': {
      if (spec.enum && !spec.enum.includes(value)) {
        return invalid(`取值 "${value}" 不在允许范围：${spec.enum.join(' | ')}`);
      }
      return { value };
    }
    case 'number': {
      const num = Number(value);
      if (!Number.isFinite(num)) return invalid(`"${value}" 不是数字`);
      if (spec.integer && !Number.isInteger(num)) return invalid(`"${value}" 必须是整数`);
      if (spec.min !== undefined && num < spec.min) return invalid(`不能小于 ${spec.min}`);
      if (spec.max !== undefined && num > spec.max) return invalid(`不能大于 ${spec.max}`);
      return { value: String(num) };
    }
    case 'boolean': {
      const lower = value.toLowerCase();
      if (TRUE_VALUES.has(lower)) return { value: 'true' };
      if (FALSE_VALUES.has(lower)) return { value: 'false' };
      return invalid(`"${value}" 不是布尔值（可用 true/false、1/0、yes/no）`);
    }
    case 'url': {
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return invalid(`仅支持 http/https，当前为 ${parsed.protocol}`);
        }
        return { value };
      } catch {
        return invalid(`"${value}" 不是合法 URL`);
      }
    }
    case 'postgresUrl': {
      if (!/^postgres(ql)?:\/\//.test(value)) return invalid('必须以 postgres:// 或 postgresql:// 开头');
      return { value };
    }
    case 'base64key32': {
      if (!isEncryptionKey(value)) {
        return invalid('必须是 base64 编码的 32 字节密钥（长度 44，含结尾 =）');
      }
      return { value };
    }
    case 'csv': {
      const items = value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return { value: items.join(',') };
    }
    default:
      return { value };
  }
}

/** 生成一个合法的 ENCRYPTION_KEY（base64, 32 bytes） */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString('base64');
}

/** 校验 ENCRYPTION_KEY 是否合法 */
export function isEncryptionKey(value: string): boolean {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return false;
  try {
    return Buffer.from(trimmed, 'base64').length === 32;
  } catch {
    return false;
  }
}

/**
 * 校验并归一化环境变量。
 * @param source 默认为 process.env；测试可注入任意对象
 */
export function validateEnv(source: Record<string, string | undefined> = process.env): EnvLoadResult {
  const issues: EnvIssue[] = [];
  const normalized: Record<string, string> = {};

  for (const spec of ENV_SPEC) {
    const result = validateField(spec, source[spec.key]);
    if (result.issue) issues.push(result.issue);
    if (result.value !== undefined) normalized[spec.key] = result.value;
  }

  // 疑似拼错的键名（只看我们的前缀，避免把系统变量算进来）
  for (const key of Object.keys(source)) {
    if (ENV_SPEC.some((s) => s.key === key)) continue;
    if (!KNOWN_PREFIXES.some((p) => key.startsWith(p))) continue;
    if (key === 'NEXT_PUBLIC_APP_URL') continue;
    issues.push({
      key,
      code: 'unknown',
      severity: 'warning',
      message: '未识别的键名（可能是拼写错误，将被忽略）',
    });
  }

  const hasError = issues.some((i) => i.severity === 'error');
  if (hasError) return { ok: false, env: null, issues };

  const env: Env = {
    appUrl: normalized['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3000',
    port: Number(normalized['APP_PORT'] ?? 3000),
    nodeEnv: (normalized['NODE_ENV'] ?? 'development') as Env['nodeEnv'],
    databaseUrl: normalized['DATABASE_URL'] ?? '',
    encryptionKey: normalized['ENCRYPTION_KEY'] ?? '',

    llmProvider: normalized['LLM_PROVIDER'] ?? 'deepseek',
    llmBaseUrl: normalized['LLM_BASE_URL'],
    llmApiKey: normalized['LLM_API_KEY'],
    llmModel: normalized['LLM_MODEL'],
    llmModelExtract: normalized['LLM_MODEL_EXTRACT'],
    llmModelGenerate: normalized['LLM_MODEL_GENERATE'],
    sampleK: Number(normalized['LLM_SAMPLE_K'] ?? 3),

    embeddingProvider: normalized['EMBEDDING_PROVIDER'],
    embeddingModel: normalized['EMBEDDING_MODEL'],

    enableAuth: normalized['ENABLE_AUTH'] === 'true',
    allowPrivateBaseUrl: normalized['ALLOW_PRIVATE_BASE_URL'] === 'true',
    egressExtraHosts: (normalized['EGRESS_EXTRA_HOSTS'] ?? '').split(',').filter(Boolean),

    langfusePublicKey: normalized['LANGFUSE_PUBLIC_KEY'],
    langfuseSecretKey: normalized['LANGFUSE_SECRET_KEY'],
    langfuseHost: normalized['LANGFUSE_HOST'],

    raw: Object.freeze({ ...normalized }),
  };

  return { ok: true, env, issues };
}

/** 校验失败即抛（启动路径用）；错误信息包含全部非法项 */
export function assertEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = validateEnv(source);
  if (!result.ok || !result.env) throw new EnvValidationError(result.issues);
  return result.env;
}

/** 人类可读报告（doctor / setup 用）；secret 字段永不回显明文 */
export function formatEnvIssues(issues: EnvIssue[]): string {
  if (issues.length === 0) return '环境变量校验通过 ✅';
  const lines = issues.map((i) => {
    const icon = i.severity === 'error' ? '❌' : '⚠️';
    const hint = i.hint ? `\n     → ${i.hint}` : '';
    return `${icon} ${i.key}: ${i.message}${hint}`;
  });
  return lines.join('\n');
}

/** 供日志使用：把 env 里所有密钥字段脱敏后输出 */
export function describeEnv(env: Env): string {
  return redactSecrets(
    JSON.stringify(
      {
        appUrl: env.appUrl,
        port: env.port,
        nodeEnv: env.nodeEnv,
        llmProvider: env.llmProvider,
        llmBaseUrl: env.llmBaseUrl ?? '(内置默认)',
        hasApiKey: Boolean(env.llmApiKey),
        llmModel: env.llmModel ?? '(provider 默认)',
        sampleK: env.sampleK,
        enableAuth: env.enableAuth,
        allowPrivateBaseUrl: env.allowPrivateBaseUrl,
        embedding: env.embeddingProvider ?? '(未配置 → 关键词检索)',
        telemetry: env.langfuseHost ? 'enabled' : 'disabled',
      },
      null,
      2,
    ),
  );
}
