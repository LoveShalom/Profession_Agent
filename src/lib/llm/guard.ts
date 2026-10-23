/**
 * 私网保护与出站白名单（I0 / T6）
 *
 * 两道边界（F-01 §1.3-B、AC-8、AC-10）：
 * 1. **私网默认拒绝**：base_url 指向 127.0.0.1 / 192.168.x / fc00:: 等地址时，必须显式
 *    开启 ALLOW_PRIVATE_BASE_URL=true 才放行（Ollama / vLLM 场景）。
 * 2. **出站白名单**：只允许访问用户配置的 provider 域名（+ 显式额外域名），
 *    其余一律拒绝——这是"数据不出机"承诺的可执行落点，也是红线④的检查依据。
 *
 * 零依赖，纯函数 + 一个记录拦截次数的守卫对象，便于测试与 doctor 汇报。
 */

import { ProviderError } from '../errors.ts';

/** 解析主机名：兼容 IPv6 字面量（[::1]）与 URL */
export function normalizeHostname(hostname: string): string {
  const lower = hostname.trim().toLowerCase();
  const unbracketed = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
  return unbracketed.replace(/\.$/, '');
}

function isIpv4Private(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // 0.0.0.0/8, 10/8, 127/8
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  return false;
}

function isIpv6Private(host: string): boolean {
  if (!host.includes(':')) return false;
  if (host === '::1' || host === '::') return true;
  const first = host.split(':')[0] ?? '';
  const prefix = parseInt(first || '0', 16);
  if (Number.isNaN(prefix)) return false;
  if ((prefix & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((prefix & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

/** 判断主机名是否属于私网 / 本机 */
export function isPrivateHostname(rawHostname: string): boolean {
  const host = normalizeHostname(rawHostname);
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (isIpv4Private(host)) return true;
  if (isIpv6Private(host)) return true;
  return false;
}

export interface BaseUrlCheck {
  ok: boolean;
  hostname: string;
  private: boolean;
  protocol: string;
  reason?: string;
  hint?: string;
}

/** 检查 base_url 是否可用（协议 + 私网策略） */
export function checkBaseUrl(baseUrl: string, options: { allowPrivate: boolean }): BaseUrlCheck {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return {
      ok: false,
      hostname: '',
      private: false,
      protocol: '',
      reason: `不是合法 URL：${baseUrl}`,
      hint: '示例：LLM_BASE_URL=https://api.deepseek.com/v1',
    };
  }

  const hostname = normalizeHostname(parsed.hostname);
  const protocol = parsed.protocol;
  const isPrivate = isPrivateHostname(hostname);

  if (protocol !== 'http:' && protocol !== 'https:') {
    return {
      ok: false,
      hostname,
      private: isPrivate,
      protocol,
      reason: `仅支持 http/https，当前为 ${protocol}`,
      hint: '本地模型通常为 http://127.0.0.1:11434/v1，云端为 https://…',
    };
  }

  if (isPrivate && !options.allowPrivate) {
    return {
      ok: false,
      hostname,
      private: true,
      protocol,
      reason: `拒绝私网地址：${hostname}`,
      hint:
        '若这是本地模型（Ollama / vLLM），请设置 ALLOW_PRIVATE_BASE_URL=true 后重启；' +
        '若并非本意，请检查 LLM_BASE_URL 是否填写正确。',
    };
  }

  return { ok: true, hostname, private: isPrivate, protocol };
}

/** 校验 base_url；不通过直接抛 ProviderError('config') */
export function assertBaseUrlAllowed(baseUrl: string, options: { allowPrivate: boolean }): BaseUrlCheck {
  const result = checkBaseUrl(baseUrl, options);
  if (!result.ok) throw ProviderError.config(result.reason ?? 'base_url 不合法', result.hint);
  return result;
}

export interface BlockedAttempt {
  url: string;
  hostname: string;
  at: number;
  reason: string;
}

/**
 * 出站白名单守卫。
 * 用法：把 fetch 包一层，或在每个网络出口显式调用 assertAllowed(url)。
 */
export class EgressGuard {
  readonly allowedHosts: readonly string[];
  private readonly blocked: BlockedAttempt[] = [];
  private readonly now: () => number;

  constructor(allowedHosts: readonly string[], now: () => number = Date.now) {
    this.allowedHosts = Object.freeze(
      [...new Set(allowedHosts.map((h) => normalizeHostname(h)))].filter(Boolean).sort(),
    );
    this.now = now;
  }

  isAllowed(url: string): boolean {
    try {
      const host = normalizeHostname(new URL(url).hostname);
      return this.allowedHosts.includes(host);
    } catch {
      return false;
    }
  }

  /** 不抛版本：用于 doctor 汇报 */
  check(url: string): { allowed: boolean; hostname: string; reason?: string } {
    let hostname = '';
    try {
      hostname = normalizeHostname(new URL(url).hostname);
    } catch {
      return { allowed: false, hostname: '', reason: `不是合法 URL：${url}` };
    }
    if (this.allowedHosts.includes(hostname)) return { allowed: true, hostname };
    return {
      allowed: false,
      hostname,
      reason: `域名 ${hostname} 不在出站白名单内（白名单：${this.allowedHosts.join(', ') || '空'}）`,
    };
  }

  /** 抛出版本：网络出口调用 */
  assertAllowed(url: string): void {
    const result = this.check(url);
    if (result.allowed) return;
    this.blocked.push({ url, hostname: result.hostname, at: this.now(), reason: result.reason ?? '未知原因' });
    throw ProviderError.config(
      `出站请求被拒绝：${result.reason ?? url}`,
      '数据不出机是本地优先的硬约束。若确需该域名，请加入 EGRESS_EXTRA_HOSTS 后重启。',
    );
  }

  /** 被拦截的记录（供 doctor / 审计展示） */
  blockedAttempts(): readonly BlockedAttempt[] {
    return this.blocked;
  }
}
