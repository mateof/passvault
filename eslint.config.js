import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * Flat config, which is what ESLint 9 reads.
 *
 * The `lint` script existed from the first commit and had never run: ESLint 9 was installed,
 * no config file was, and `eslint .` exits reporting that rather than failing — so it looked
 * like a passing step. This is the file it was looking for.
 *
 * Deliberately not type-aware. The type-checked rules need a program per file and turn a
 * three-second lint into a minute, and `tsc --build` already runs in the same pipeline and
 * catches what they catch. Lint here is for what the compiler does not say.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'apps/web/dist/**',
      'data/**',
      'backups/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // An unused parameter named with a leading underscore is a documented signature, not a
      // mistake — a callback that takes (request, reply) and uses one of them still has to
      // declare both.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // `any` is a smell rather than an error here. Parsing JSON that arrived from a peer
      // genuinely produces one, and the alternative is a cast that hides the same thing.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // Tests reach for empty functions and throwaway shapes, and saying so once here is
    // better than a disable comment in every file that does.
    files: ['**/test/**/*.ts', '**/*.test.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
  {
    // The scripts run under Node, where `console` and `process` exist. Without the globals
    // the linter reports the runtime's own vocabulary as undefined.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
)
