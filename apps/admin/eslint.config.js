import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import { browserCodeConfig } from '../../scripts/lib/eslintBrowserCode.mjs';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Named, not inferred: typescript-eslint refuses to guess once two packages' configs
    // are loaded in one process (an editor opened at the repository root, the lint test).
    languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
    },
  },
  // src/ outside the tests runs in a browser: no Node global, no Node built-in module
  browserCodeConfig,
  { ignores: ['dist/'] },
);
