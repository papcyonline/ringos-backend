import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        'src/index.ts',
        'src/app.ts',
        'src/jobs/index.ts',
        'src/modules/ai/prompts/**',
        'src/shared/types.ts',
        'prisma/**',
        'scripts/**',
        'load-tests/**',
      ],
    },
  },
});
