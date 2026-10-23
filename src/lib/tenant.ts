/**
 * 租户与权限模式（I0 / T7）
 *
 * C-10 裁决后本项目是**本地优先**：默认单用户、无登录、数据只在本机。
 * 因此这里把"权限"收敛成一个显式开关，而不是到处 if (user)：
 *   - local-single-user（默认）：所有数据归属固定的 SINGLE_USER_ID，不阻断访问，RLS 由 service role 连接绕过
 *   - multi-account：启用 Supabase Auth + RLS，按 auth.uid() 隔离
 */

import type { Env } from './env.ts';

/** 本地单用户模式的固定归属 ID（写死便于 migration 播种与断言） */
export const SINGLE_USER_ID = '00000000-0000-4000-8000-000000000001';

export type TenantMode = 'local-single-user' | 'multi-account';

export interface Tenant {
  mode: TenantMode;
  /** 当前请求归属的用户 ID */
  userId: string;
  /** 是否需要登录才能访问 */
  authRequired: boolean;
  /** 是否启用行级安全策略（多账号模式才需要） */
  rlsEnabled: boolean;
}

export interface ResolveTenantOptions {
  /** 多账号模式下由会话传入；单用户模式忽略 */
  sessionUserId?: string;
}

export function resolveTenant(env: Env, options: ResolveTenantOptions = {}): Tenant {
  if (!env.enableAuth) {
    return { mode: 'local-single-user', userId: SINGLE_USER_ID, authRequired: false, rlsEnabled: false };
  }
  return {
    mode: 'multi-account',
    userId: options.sessionUserId ?? '',
    authRequired: true,
    rlsEnabled: true,
  };
}

/** 单用户模式下的断言：无会话也必须能拿到归属 ID */
export function requireUserId(tenant: Tenant): string {
  if (!tenant.userId) {
    throw new Error('多账号模式下缺少会话用户 ID：请先登录，或设置 ENABLE_AUTH=false 使用本地单用户模式。');
  }
  return tenant.userId;
}

export function describeTenant(tenant: Tenant): string {
  return tenant.mode === 'local-single-user'
    ? `本地单用户（数据归属 ${SINGLE_USER_ID}，无需登录）`
    : '多账号模式（Supabase Auth + RLS，按用户隔离）';
}
