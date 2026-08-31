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

/** The four optional knobs the agent proxy actually reads and clamps. */
const AGENT_TUNING_VARS = [
  'AGENT_ALLOWED_MODELS',
  'AGENT_MAX_OUTPUT_TOKENS',
  'AGENT_MODEL_SYNC_TIMEOUT_MS',
  'AGENT_UPSTREAM_TIMEOUT_MS',
] as const;

test('the operator OpenRouter credential is documented where the deploy docs send you', async () => {
  const backendRoot = process.cwd();
  const [example, deployReadme, service] = await Promise.all([
    readFile(resolve(backendRoot, '.env.example'), 'utf8'),
    readFile(resolve(backendRoot, '../../deploy/README.md'), 'utf8'),
    readFile(resolve(backendRoot, 'src/agent/agent-llm.service.ts'), 'utf8'),
  ]);

  // deploy/README.md points the operator at this file for "every secret". It did not list the one
  // credential the agent cannot run without, so an install that followed the documentation to the
  // letter produced a backend that started clean, passed the readiness probe, and answered 503 on
  // the first user request — with nothing anywhere saying which variable was missing.
  assert.match(deployReadme, /apps\/backend\/\.env\.example/);
  assert.match(
    example,
    /^OPENROUTER_API_KEY=/m,
    'the managed agent has exactly one server-side credential and it must be in the example env',
  );
  for (const name of AGENT_TUNING_VARS) {
    assert.ok(service.includes(name), `${name} is expected to be read by the proxy`);
    assert.ok(
      example.includes(name),
      `${name} changes how the agent proxy behaves and cannot only exist in the source`,
    );
  }

  // A PLACEHOLDER, never a key. `sk-or-v1-` followed by real entropy is what a leak looks like, and
  // this file is committed.
  assert.doesNotMatch(example, /^OPENROUTER_API_KEY=sk-or-v1-[A-Za-z0-9]{20,}$/m);
});
