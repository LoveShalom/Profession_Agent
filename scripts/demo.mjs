#!/usr/bin/env node
/**
 * 只读演示模式启动（F-09 / I4 T6）
 *
 * 为什么要这个脚本：Windows/macOS 设置环境变量的语法不同（set / export），
 * 为了不给项目加 cross-env 依赖，用一个 5 行的 Node 启动器统一。
 */
import { spawn } from 'node:child_process';

const child = spawn('npx', ['next', 'dev'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, DEMO_MODE: '1' },
});

child.on('exit', (code) => process.exit(code ?? 0));
