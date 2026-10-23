// 违规夹具：业务代码里直接引用厂商 SDK（用于验证纯净度检查确实有效）
// 注意：tests/fixtures 已在 tsconfig 中排除，不参与 typecheck。
import OpenAI from 'openai';

export const client = new OpenAI({ apiKey: 'sk-should-not-exist' });
