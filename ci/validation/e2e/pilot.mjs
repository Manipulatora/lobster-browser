/**
 * The deterministic pilot: a fake "model" that reads a REAL observation and returns a REAL action.
 *
 * The point of docs/LOBEE_AGENT_ROADMAP.md §7.2 is to separate browser regressions from model
 * variance. A scripted list of actions cannot do that — the moment perception shifts an index, a
 * scripted click silently hits the wrong control and the test still "passes". So the pilot is
 * grounded exactly like a model is: it receives the rendered observation text, parses the numbered
 * element list, and selects a target BY ROLE AND NAME. If perception stops surfacing a control, or
 * renumbers it, or mislabels it, the pilot cannot find its target and the scenario fails loudly.
 *
 * It implements `LlmClient`, so it drives the production `runAgent` loop — the same policy gates,
 * approval binding, journal boundaries, and executor preflight a real run uses.
 */

/** One line of a rendered observation: `[3] button "Accept all" (expanded)`. */
const ELEMENT_LINE = /^\[(\d+)\]\s+(\S+)\s+"((?:[^"\\]|\\.)*)"(.*)$/;

export function parseObservation(text) {
  const elements = [];
  let url = '';
  for (const line of String(text).split('\n')) {
    if (!url && line.startsWith('url: ')) url = line.slice(5).split('  |  ')[0].trim();
    const m = ELEMENT_LINE.exec(line.trim());
    if (!m) continue;
    elements.push({
      index: Number(m[1]),
      role: m[2],
      name: JSON.parse(`"${m[3]}"`),
      rest: m[4] ?? '',
    });
  }
  return { url, elements, raw: String(text) };
}

/** The last thing the loop showed the model: its newest user or tool turn. */
function latestObservationText(request) {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const message = request.messages[i];
    if (message.role === 'user' || message.role === 'tool') return String(message.content ?? '');
  }
  return '';
}

/**
 * `LlmClient` whose `complete` delegates to a scenario-supplied planner.
 *
 * The planner receives the parsed observation plus a mutable per-run scratchpad and returns an
 * `AgentAction`. Returning `undefined` is a scenario bug and fails the run rather than silently
 * finishing.
 */
export class PilotLlm {
  /** @param {(view: ReturnType<typeof parseObservation>, state: Record<string, any>, step: number) => object | undefined} plan */
  constructor(plan, { model = 'pilot/deterministic' } = {}) {
    this.plan = plan;
    this.model = model;
    this.state = {};
    this.step = 0;
    /** Every observation the loop rendered, for post-run assertions. */
    this.observations = [];
    /** Every action the pilot returned. */
    this.actions = [];
    this.requests = [];
  }

  async complete(request) {
    this.requests.push(request);
    const text = latestObservationText(request);
    this.observations.push(text);
    const view = parseObservation(text);
    this.step += 1;
    // `plan` may be async: a scenario that needs to change the page WHILE the model is deciding
    // (the exact window the executor's pre-dispatch target check defends) has to do it here, between
    // the observation the action is built from and the dispatch of that action.
    const action = await this.plan(view, this.state, this.step);
    if (!action) {
      throw new Error(
        `pilot has no action for step ${this.step}\n--- observation ---\n${text.slice(0, 4000)}`,
      );
    }
    this.actions.push(action);
    return {
      toolCall: { id: `pilot-${this.step}`, name: 'act', input: action },
      usage: { tokensIn: 100, tokensOut: 20 },
    };
  }
}

/** Find one element by role and a name predicate. Returns undefined when perception lost it. */
export function find(view, roles, matches) {
  const roleSet = new Set([].concat(roles));
  const test =
    typeof matches === 'function'
      ? matches
      : (name) => name.toLowerCase().includes(String(matches).toLowerCase());
  return view.elements.find((el) => roleSet.has(el.role) && test(el.name, el));
}

/** Assert-style lookup: throws with the whole observation when the control is missing. */
export function need(view, roles, matches, what) {
  const el = find(view, roles, matches);
  if (!el) {
    throw new Error(
      `perception did not surface ${what ?? `${roles} matching ${matches}`}\n--- observation ---\n${view.raw.slice(0, 4000)}`,
    );
  }
  return el;
}
