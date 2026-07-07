// Flat-config lint for the shared-frontend package. Scope is intentionally small —
// catch real TypeScript / React-hook mistakes, nothing stylistic. Formatting is
// handled by prettier; the SDK's SDK-only rules (unicorn, jsdoc, etc.) live on
// the root config and do not apply here.

import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import ts from 'typescript-eslint';

export default ts.config(
  {
    ignores: ['node_modules', 'dist', '.vitest', '.cache', '**/vitest.config.ts'],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      // The two classic React-hooks rules — canonical, catch real bugs, no
      // opinionated advice about setState-in-effect or "purity" (those live
      // in the plugin's recommended config in v7 and would need broader
      // component refactoring than this lint wire-up is scoped for).
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Allow intentionally-unused args when named `_foo` (common in mock
      // callback signatures), matching typescript-eslint's own convention.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
