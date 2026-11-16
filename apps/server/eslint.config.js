const eslint = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Named, not inferred: typescript-eslint refuses to guess once two packages' configs
    // are loaded in one process (an editor opened at the repository root, the lint test).
    languageOptions: { parserOptions: { tsconfigRootDir: __dirname } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', ignoreRestSiblings: true }],
      '@typescript-eslint/no-namespace': 'off',
    },
  },
  { ignores: ['dist/', 'src/__tests__/'] },
);
