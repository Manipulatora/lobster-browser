import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Fork workers can fail to initialize under constrained Windows build hosts. Worker threads
    // carry the same isolation contract without depending on child-process IPC.
    pool: 'threads',
  },
});
