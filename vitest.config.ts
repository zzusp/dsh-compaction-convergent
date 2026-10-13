import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: [
      {
        find: 'official-alpha2-compaction',
        replacement: fileURLToPath(new URL('./node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js', import.meta.url)),
      },
      {
        find: /^@deepseek-ai\/dsh-compaction-basic\/src\/(.+)\.ts$/,
        replacement: `${fileURLToPath(new URL('./src/', import.meta.url))}$1.ts`,
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
