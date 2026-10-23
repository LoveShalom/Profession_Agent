// 合规夹具：业务代码只依赖适配层暴露的接口
import { createLLM } from '../../../../../src/lib/llm/index.ts';
import type { Env } from '../../../../../src/lib/env.ts';

export function buildService(env: Env) {
  return createLLM(env, { skipProbe: true });
}
