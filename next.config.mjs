/**
 * Next.js 配置
 *
 * `serverExternalPackages: ['pg']`
 *   `pg` 是原生 Node 数据库驱动（含可选的原生扩展），让 Next 把它当作"外部包"、
 *   不参与 webpack 打包，是官方推荐做法。
 *
 * 为什么之前会有 `Critical dependency: the request of a dependency is an expression` 警告：
 * 为了在"`pg` 尚未安装"时也能通过构建，`db/postgres.ts` 曾用 `import(变量)` 动态导入，
 * webpack 无法静态分析。现在 `pg` 已是正式依赖，改为静态导入即可消除该警告。
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['pg'],
  eslint: {
    // lint 由 `npm run lint`（ESLint 9 flat config）单独负责，构建期不重复跑
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
