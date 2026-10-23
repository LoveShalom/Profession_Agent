// @ts-check
/**
 * ESLint 扁平配置（I0 / T1）
 *
 * ⚠️ 曾经踩过的坑（2026-10-21）：本文件最初只配了 ESLint core 规则，**没有配置 TypeScript parser**，
 * 于是 ESLint 用默认的 espree 去解析 .ts 文件，报出 24 个
 * "Parsing error: Unexpected token type / interface / {" ——误以为业务代码有问题，其实是配置缺了 parser。
 * 现改为：TS 文件用 @typescript-eslint/parser，JS/MJS 用默认 parser。
 *
 * 设计取舍：**不使用任何 recommended 预设**（如 tseslint.configs.recommended）。
 * 因为预设会引入大量风格规则（no-explicit-any / no-empty-object-type 等），
 * 与本项目"lint 只做质量门、不做风格警察"的定位冲突，且规则面不可控。
 * 这里只显式开启少数几条确定有价值的规则 + 厂商 SDK 禁令。
 *
 * 关键规则：no-restricted-imports —— 业务代码禁止直接引用任何厂商 SDK，
 * 所有模型调用必须经 `src/lib/llm`（对应 F-01 的 AC-13 与红线③）。
 */

import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

/** 厂商 SDK 名单：只允许出现在 src/lib/llm/ 下 */
const VENDOR_SDKS = [
  'openai',
  '@anthropic-ai/sdk',
  '@google/generative-ai',
  '@google/genai',
  'cohere-ai',
  'dashscope',
  'ollama',
  '@ai-sdk/openai',
  '@ai-sdk/anthropic',
  '@ai-sdk/google',
];

const VENDOR_MESSAGE = '业务代码不得直接引用厂商 SDK：所有模型调用必须经 src/lib/llm（Provider 适配层）。';

const vendorRestriction = {
  // paths 只支持精确包名（不支持通配）
  paths: VENDOR_SDKS.map((name) => ({ name, message: VENDOR_MESSAGE })),
  patterns: [
    {
      // 通配形态（子路径与厂商作用域包）
      group: [
        'openai/*',
        '@anthropic-ai/*',
        '@google/generative-ai/*',
        '@google/genai/*',
        '@zhipuai/*',
        '@moonshot-ai/*',
        '@ai-sdk/*',
      ],
      message: VENDOR_MESSAGE,
    },
  ],
};

export default [
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'out/**',
      'dist/**',
      'spec/**',
      'logs/**',
      'docs/**',
      'evals/**',
      '.data/**',
    ],
  },

  // ---------- 所有文件共用的基础规则 ----------
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-console': 'off',
    },
  },

  // ---------- JS / MJS：默认 parser 即可 ----------
  {
    files: ['**/*.{js,mjs,cjs}'],
    rules: {
      'no-undef': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // ---------- TS / TSX：必须换 parser，否则 espree 解析不了类型语法 ----------
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      // 类型语法交给 TS 自己检查，eslint core 的 no-undef / no-unused-vars 在 TS 下会误报
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },

  // ---------- 业务代码：禁止厂商 SDK（红线③，与 scripts/check-adapter-purity.mjs 双保险）----------
  {
    files: [
      'src/app/**/*.{ts,tsx}',
      'src/server/**/*.{ts,tsx}',
      'src/components/**/*.{ts,tsx}',
      'src/lib/pipeline/**/*.ts',
      'src/lib/scoring/**/*.ts',
      'src/lib/state-machine/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': ['error', vendorRestriction],
    },
  },

  // ---------- 适配层自身：允许引用厂商 SDK（但仍推荐零依赖的 OpenAI 兼容实现）----------
  {
    files: ['src/lib/llm/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
];
