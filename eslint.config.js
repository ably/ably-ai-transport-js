import { fixupConfigRules, fixupPluginRules } from '@eslint/compat';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import security from 'eslint-plugin-security';
import jsdoc from 'eslint-plugin-jsdoc';
import importX from 'eslint-plugin-import-x';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import tsParser from '@typescript-eslint/parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import { FlatCompat } from '@eslint/eslintrc';
import preferArrowFunctions from 'eslint-plugin-prefer-arrow-functions';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

export default [
  unicorn.configs.recommended,
  jsdoc.configs['flat/recommended-typescript'],
  importX.flatConfigs.recommended,
  security.configs.recommended,
  {
    ignores: [
      'demo/**',
      'src_old/**',
      'test_old/**',
      'demo_old/**',
      'examples_old/**',
      'rfc/**',
      '**/eslint.config.js',
      '**/dist',
      '**/node_modules',
      '**/ably-common',
      '**/specification',
      'scripts/**',
      '**/vitest.config.ts',
      '**/vitest.config.integration.ts',
      '**/vite.config.ts',
      '**/__mocks__',
      '**/coverage/',
      '.github',
      '.claude/worktrees/**',
      'react/**',
      'vercel/**',
    ],
  },
  ...fixupConfigRules(
    compat.extends(
      'eslint:recommended',
      'plugin:@typescript-eslint/recommended-type-checked',
      'plugin:@typescript-eslint/strict-type-checked',
      'plugin:@typescript-eslint/stylistic-type-checked',
    ),
  ),
  {
    plugins: {
      '@typescript-eslint': fixupPluginRules(typescriptEslint),
      jsdoc,
      'simple-import-sort': simpleImportSort,
      'prefer-arrow-functions': fixupPluginRules(preferArrowFunctions),
    },

    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },

      parser: tsParser,
      ecmaVersion: 5,
      sourceType: 'module',

      parserOptions: {
        project: ['./tsconfig.json'],
      },
    },

    settings: {
      jsdoc: {
        tagNamePreference: {
          default: 'defaultValue',
        },
      },
    },

    rules: {
      'eol-last': 'error',
      'security/detect-object-injection': 'off',
      'no-redeclare': 'off',
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      'unicorn/filename-case': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      '@typescript-eslint/promise-function-async': 'error',
      'arrow-body-style': ['error', 'as-needed'],
      'jsdoc/require-throws-type': 'off',

      'prefer-arrow-functions/prefer-arrow-functions': [
        'error',
        {
          allowedNames: [],
          allowNamedFunctions: false,
          allowObjectProperties: false,
          classPropertiesAllowed: false,
          disallowPrototype: false,
          returnStyle: 'unchanged',
          singleReturnOnly: false,
        },
      ],

      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'typeLike',
          format: ['PascalCase'],
        },
        {
          selector: 'memberLike',
          format: ['camelCase'],
          modifiers: ['private'],
          leadingUnderscore: 'require',
        },
        {
          selector: 'enumMember',
          format: ['PascalCase'],
        },
        {
          selector: 'memberLike',
          format: ['camelCase'],
          modifiers: ['public', 'protected'],
          leadingUnderscore: 'forbid',
        },
      ],
    },
  },
  {
    files: ['examples/**/*.ts'],

    rules: {
      // tsconfig target is es6 which does not support top-level await
      'unicorn/prefer-top-level-await': 'off',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],

    rules: {
      '@typescript-eslint/no-unused-vars': ['error'],
      'import-x/no-unresolved': 'off',
      'no-undef': 'off',
      'no-dupe-class-members': 'off',
      'require-await': 'off',
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/numeric-separators-style': 'off',
      'unicorn/prefer-event-target': 'off',
      'unicorn/no-static-only-class': 'off',
      'unicorn/no-nested-ternary': 'off',
      'unicorn/require-module-specifiers': 'off',

      '@typescript-eslint/no-extraneous-class': [
        'error',
        {
          allowStaticOnly: true,
        },
      ],

      'import-x/extensions': [
        'error',
        'always',
        {
          ignorePackages: true,
        },
      ],
    },
  },
];
