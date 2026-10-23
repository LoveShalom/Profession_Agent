/**
 * 服务端环境加载（F-02 / T9 路由层）
 *
 * 为什么单独一层：`assertEnv` 需要在**请求期**而不是模块加载期执行——
 * 模块加载期抛错会让 Next 的构建/预渲染失败；请求期抛错才是可诊断的运行时错误。
 */

import type { Env } from '../env.ts';
import { assertEnv } from '../env.ts';

let cached: Env | null = null;

/** 取（并缓存）校验通过的环境变量；非法时抛出带全部问题的错误 */
export function getEnv(): Env {
  if (cached) return cached;
  cached = assertEnv(process.env);
  return cached;
}

/** 测试/热更新用：清空缓存 */
export function resetEnvCache(): void {
  cached = null;
}
