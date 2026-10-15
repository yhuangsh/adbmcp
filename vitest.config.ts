import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Tests must never touch a real adb binary or device: everything is faked.
    testTimeout: 10_000,
  },
});
