import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@deepseek-ai\/dsh-compaction-basic\/src\/(.+)\.ts$/,
        replacement: `${fileURLToPath(new URL('./src/', import.meta.url))}$1.ts`,
      },
      {
        find: /^@deepseek-ai\/dsh-compaction-basic\/invariant$/,
        replacement: fileURLToPath(new URL('./src/invariant.ts', import.meta.url)),
      },
      {
        find: '@deepseek-ai/dsh-compaction-basic',
        replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    pool: 'forks',
    include: ['tests/**/*.spec.ts'],
  },
})
