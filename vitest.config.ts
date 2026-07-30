import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url))

/**
 * Tests import workspace packages by their public name but resolve to TypeScript
 * source, so `npm test` needs no prior build step. Production code resolves to
 * the compiled `dist/` through each package's `exports` map instead.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@passvault/crypto': pkg('crypto'),
      '@passvault/tkpak': pkg('tkpak'),
      '@passvault/ingest': pkg('ingest'),
      '@passvault/db': pkg('db'),
      '@passvault/i18n': pkg('i18n'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/server/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/server/src/**'],
    },
  },
})
