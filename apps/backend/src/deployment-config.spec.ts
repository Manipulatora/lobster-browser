import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

test('the shipped one-hop proxy deployment binds the backend to loopback', async () => {
  const backendRoot = process.cwd();
  const [main, unit] = await Promise.all([
    readFile(resolve(backendRoot, 'src/main.ts'), 'utf8'),
    readFile(resolve(backendRoot, '../../deploy/systemd/lobster-backend.service'), 'utf8'),
  ]);

  assert.match(main, /app\.set\(['"]trust proxy['"],\s*1\)/);
  assert.match(
    unit,
    /^Environment=HOST=127\.0\.0\.1$/m,
    'a one-hop trusted-proxy configuration must not expose Node directly on every interface',
  );
});
