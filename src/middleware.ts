/**
 * 演示模式拦截（F-09 / I4 T6）
 *
 * `DEMO_MODE=1` 时所有写操作（POST/PATCH/PUT/DELETE）一律 403。
 * 只读演示页 `/demo` 本身不连数据库，这层拦截是"防手滑/防爬虫"的第二道保险。
 *
 * 说明：只在演示部署时设置该环境变量；本地正常开发不要设置。
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export function middleware(request: NextRequest): NextResponse {
  if (process.env.DEMO_MODE === '1' && WRITE_METHODS.has(request.method)) {
    return NextResponse.json(
      {
        ok: false,
        code: 'E_DEMO_READONLY',
        message: '这是只读演示站点，不支持写入。想完整使用请在本地运行本项目。',
      },
      { status: 403 },
    );
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/api/:path*'],
};
