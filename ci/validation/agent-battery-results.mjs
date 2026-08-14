// Pure result/grading helpers for the live agent battery.
//
// Keeping these outside the executable harness lets ordinary CI prove that a provider outage cannot
// hide a real regression and that regex graders receive the same adversarial checks as function
// graders. Nothing in this module starts a browser, sidecar, or paid model call.

/** Evaluate either supported grader shape without leaking RegExp `lastIndex` between attempts. */
export function matchesExpectation(task, text, facts) {
  if (typeof task.expect === 'function') return Boolean(task.expect(text, facts));
  if (!(task.expect instanceof RegExp)) return false;
  task.expect.lastIndex = 0;
  const matched = task.expect.test(text);
  task.expect.lastIndex = 0;
  return matched;
}

/**
 * ALL attempts must pass. A real failure has priority over an environmental block so a provider
 * outage on retry 3 cannot turn an already-observed regression into a neutral result.
 */
export function chooseAttemptResult(attempts) {
  return (
    attempts.find((attempt) => attempt.verdict !== 'PASS' && attempt.verdict !== 'BLOCKED') ??
    attempts.find((attempt) => attempt.verdict === 'BLOCKED') ??
    attempts[0] ?? {
      verdict: 'TIMEOUT',
      detail: 'no attempt ran',
    }
  );
}

/** Resolve the process outcome with the same failure-before-block precedence. */
export function summarizeBattery(results, expectedTasks) {
  const failed = results.filter(
    (result) => result.verdict !== 'PASS' && result.verdict !== 'BLOCKED',
  );
  const blocked = results.filter((result) => result.verdict === 'BLOCKED');
  const invalidPlan = !Number.isSafeInteger(expectedTasks) || expectedTasks < 1;
  const incomplete = !invalidPlan && results.length < expectedTasks;
  const status =
    failed.length > 0 || invalidPlan
      ? 'FAIL'
      : blocked.length > 0 || incomplete
        ? 'BLOCKED'
        : 'PASS';
  return {
    status,
    exitCode: status === 'PASS' ? 0 : status === 'FAIL' ? 1 : 2,
    failed,
    blocked,
    incomplete,
    invalidPlan,
  };
}

const NON_BROWSER_ACTIONS = new Set(['ask', 'remember', 'learn', 'done']);

export function hasAnyBrowserAction(events) {
  return events.some(
    (event) =>
      event.type === 'step.action' &&
      typeof event.action?.kind === 'string' &&
      !NON_BROWSER_ACTIONS.has(event.action.kind),
  );
}

function sameTarget(left, right) {
  try {
    const actual = new URL(left);
    const expected = new URL(right);
    const normalizePath = (value) => value.replace(/\/+$/, '') || '/';
    return (
      actual.origin === expected.origin &&
      normalizePath(actual.pathname) === normalizePath(expected.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * A browser task must prove both that it issued a browser action and subsequently observed the page
 * it was asked to visit. `step.action` alone is emitted before policy/execution and therefore proves
 * intent, not capability.
 */
export function hasBrowserEvidence(events, expectedUrl) {
  const acted = hasAnyBrowserAction(events);
  const observed = events.some(
    (event) =>
      event.type === 'step.observation' &&
      typeof event.url === 'string' &&
      sameTarget(event.url, expectedUrl),
  );
  return acted && observed;
}

/** Explicit exception for a policy-denial task whose requested target must never be reached. */
export function hasBrowserAttempt(events, expectedUrl) {
  return events.some(
    (event) =>
      event.type === 'step.action' &&
      event.action?.kind === 'navigate' &&
      typeof event.action.url === 'string' &&
      sameTarget(event.action.url, expectedUrl),
  );
}

/** Provider/inference capacity is environmental BLOCKED, not an agent-capability FAIL. */
export function providerBlockReason(error) {
  if (typeof error !== 'string' || !error.trim()) return '';
  const detail = error.trim();
  const normalizedProviderFailure =
    /^(?:Chat failed:\s*)?(?:the model account has run out of credit(?: or hit its spend limit)?|the model credential was rejected|the model provider is rate-limiting this key|the model provider timed out|the model provider is unavailable)(?:\s*\(|$)/i;
  const explicitLlmTimeout = /^(?:Chat failed:\s*)?LLM request timed out(?:\s|$)/i;
  // Node's raw transport strings are ambiguous on their own: a browser/product fetch can fail too.
  // Ask mode adds this stage marker at the LLM boundary, making the otherwise-generic error safe to
  // classify. Agent-mode managed HTTP errors use the normalized phrases above.
  const chatStageTransport =
    /^Chat failed:\s*(?:fetch failed|connect\s+ECONN(?:RESET|REFUSED)\b|getaddrinfo\s+EAI_AGAIN\b)/i;
  return normalizedProviderFailure.test(detail) ||
    explicitLlmTimeout.test(detail) ||
    chatStageTransport.test(detail)
    ? detail.slice(0, 200)
    : '';
}
