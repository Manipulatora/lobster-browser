// Pure configuration helpers for the live battery. Keeping environment and run-policy parsing outside
// the executable harness makes the security boundaries testable without starting a browser or spending
// provider credit.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_AGENT_BATTERY_TOKEN_BUDGET = 250_000;

/** Parse the same bounds enforced by the agent runtime, while rejecting ambiguous/coerced values. */
export function parseBatteryTokenBudget(raw) {
  if (raw === undefined) return DEFAULT_AGENT_BATTERY_TOKEN_BUDGET;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) {
    throw new Error('must be a whole number between 1000 and 10000000');
  }
  const budget = Number(raw.trim());
  if (!Number.isSafeInteger(budget) || budget < 1_000 || budget > 10_000_000) {
    throw new Error('must be a whole number between 1000 and 10000000');
  }
  return budget;
}

function isProtectedCi(env) {
  const enabled = (value) =>
    typeof value === 'string' && value.trim() !== '' && !/^(?:0|false|no)$/i.test(value.trim());
  return enabled(env.CI) || enabled(env.GITHUB_ACTIONS);
}

/**
 * Resolve the managed inference proxy. CI must receive an explicit URL/token pair from its protected
 * environment; only an interactive local run may use the developer convenience file.
 */
export function loadBatteryProxy({
  env = process.env,
  homeDirectory = homedir(),
  readFile = readFileSync,
} = {}) {
  const url =
    typeof env.LOBSTER_AGENT_PROXY_URL === 'string' ? env.LOBSTER_AGENT_PROXY_URL.trim() : '';
  const token =
    typeof env.LOBSTER_AGENT_PROXY_TOKEN === 'string' ? env.LOBSTER_AGENT_PROXY_TOKEN.trim() : '';
  if (url || token) return url && token ? { url, token } : null;
  if (isProtectedCi(env)) return null;

  try {
    const raw = readFile(join(homeDirectory, '.config/lobster-agent-proxy.env'), 'utf8');
    const values = Object.fromEntries(
      raw
        .split('\n')
        .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
        .map((line) => [
          line.slice(0, line.indexOf('=')).trim(),
          line.slice(line.indexOf('=') + 1).trim(),
        ]),
    );
    if (!values.AGENT_PROXY_TOKEN) return null;
    return {
      url: `http://127.0.0.1:${values.PORT || 8790}/agent/llm`,
      token: values.AGENT_PROXY_TOKEN,
    };
  } catch {
    return null;
  }
}

/** Build the per-attempt policy. Private access is enabled only together with an exact fixture fence. */
export function buildBatteryRunConfig(task, { fixtureOrigin, tokenBudget } = {}) {
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1_000 || tokenBudget > 10_000_000) {
    throw new Error('a battery attempt requires a token budget between 1000 and 10000000');
  }
  const config = {
    mode: task.mode ?? 'agent',
    maxSteps: task.maxSteps,
    visionFallback: true,
    tokenBudget,
  };
  if (!task.local) return config;

  let fixture;
  try {
    fixture = new URL(fixtureOrigin);
  } catch {
    throw new Error('a local battery task requires a valid fixture origin');
  }
  if (fixture.protocol !== 'http:' || fixture.hostname !== '127.0.0.1') {
    throw new Error('the battery fixture origin must be loopback HTTP');
  }
  return {
    ...config,
    allowPrivateNetwork: true,
    allowedDomains: [fixture.hostname],
  };
}
