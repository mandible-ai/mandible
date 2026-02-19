// PURPOSE: Vitest configuration for mandible test suite
// PURPOSE: Targets 90%+ coverage on src/core/

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/core/**/*.ts', 'src/environments/**/*.ts'],
      exclude: ['src/**/index.ts', 'src/environments/dolt/**', 'src/environments/remote/**'],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
  },
});
