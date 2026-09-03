/**
 * What the model SEES each step: the rendered observation, the bounded evidence and progress
 * ledgers, the pruning that keeps the run's own conversation affordable, and the dataset the run
 * collects. Pure text/structure helpers — nothing here touches the driver or the provider.
 */
import type { ExecOutcome } from '../executor.js';
import type { LlmMessage } from '../llm/types.js';
import { renderObservation, sameElements } from '../perception/serialize.js';
import { EVIDENCE_PREAMBLE, PROGRESS_PREAMBLE, VERBATIM_OBSERVATIONS } from '../prompt.js';
import { redactUrl, urlIdentity } from '../security.js';
import type { RawPerception } from '../types.js';

export function firstLine(value: string): string {
  return value.split('\n', 1)[0] ?? '';
}

export function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Per-extract and whole-ledger budgets, in characters.
 *
 * The entry budget MUST NOT be smaller than what `extract` can produce (its own cap is 12,000), or a
 * single page is silently beheaded: the outcome line still reports "extracted 3933 characters" while
 * the model receives 3,000 of them. That is exactly how a 400-row index lost the row it was asked
 * for — the extractor found it at character ~3,700 and the ledger cut it off, so the agent scrolled
 * and re-extracted the same page repeatedly, each time being told it had succeeded.
 *
 * Affording this got much cheaper: since the ledger is now stripped from every tool message except
 * the newest, a bigger budget rides once per request rather than up to seven times.
 */
const MAX_EXTRACT_ENTRY_CHARS = 12_000;
const MAX_EXTRACT_LEDGER_CHARS = 16_000;

export function appendExtractedEvidence(
  existing: string[],
  step: number,
  url: string,
  description: string,
  text: string,
): string[] {
  // Clip LOUDLY. A bare ellipsis reads as a formatting flourish; a count reads as missing evidence and
  // is something the model can act on (narrow the read, or use `collect` page by page).
  const body =
    text.length > MAX_EXTRACT_ENTRY_CHARS
      ? `${text.slice(0, MAX_EXTRACT_ENTRY_CHARS)}\n[…${text.length - MAX_EXTRACT_ENTRY_CHARS} more characters of this page were cut from the record. If what you need is missing, read a narrower part of the page or use \`collect\` as you go.]`
      : text;
  const entry = `Extract ${step} — ${clip(description, 160)} — ${redactUrl(url)}\n${body}`;
  const next = [...existing, entry];
  let dropped = 0;
  while (next.length > 1 && next.join('\n\n').length > MAX_EXTRACT_LEDGER_CHARS) {
    next.shift();
    dropped += 1;
  }
  // Say what was lost. Dropping the earliest pages silently let a paginated read report a total that
  // quietly excluded page one; a visible notice lets the model re-read or switch to `collect`.
  if (dropped > 0) {
    next.unshift(
      `[${dropped} earlier extract(s) dropped to stay within the context budget — if you still need that data, re-read those pages or use \`collect\` so the harness keeps rows for you]`,
    );
  }
  if (next[0] && next[0].length > MAX_EXTRACT_LEDGER_CHARS) {
    next[0] = clip(next[0], MAX_EXTRACT_LEDGER_CHARS);
  }
  return next;
}

/**
 * Render the collected rows as a Markdown table, which the panel now renders properly and which the
 * user can copy straight into a spreadsheet. Falls back to listing rows when there are too many
 * columns for a table to stay readable.
 */
function renderDataset(
  rows: ReadonlyArray<Record<string, string>>,
  columns: readonly string[],
): string {
  const cols = columns.length ? columns : [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const header = `Collected ${rows.length} row(s):`;
  if (cols.length === 0) return header;
  const escape = (value: string): string => value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    `| ${cols.join(' | ')} |`,
    `| ${cols.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${cols.map((c) => escape(row[c] ?? '')).join(' | ')} |`),
  ];
  return `${header}\n\n${lines.join('\n')}`;
}

export function observationFingerprint(raw: RawPerception): string {
  return JSON.stringify([
    raw.urlIdentity ?? urlIdentity(raw.url),
    raw.scrollY,
    raw.text ?? '',
    raw.elements.map((element) => [
      element.role,
      element.name,
      element.value ?? '',
      element.state ?? '',
    ]),
  ]);
}

/**
 * Keep the run's own exchange bounded without breaking its structure.
 *
 * Page snapshots dominate an agent run's token cost, and every one of them stays relevant only for a
 * step or two. Older TOOL RESULTS are therefore reduced to their HEADER LINE — step number, URL and the
 * outcome of the action that produced them (see `buildStepPrompt`) — while every assistant turn, the
 * record of what the agent actually DID, is preserved in full. The shape of the conversation is never
 * altered, so the call/result pairing providers require survives.
 */
export function pruneObservations(messages: readonly LlmMessage[]): LlmMessage[] {
  const toolIndices = messages.flatMap((m, i) => (m.role === 'tool' ? [i] : []));
  // Prune in batches: shrinking exactly one more tool result every step rewrites one message per
  // request, and a rewritten message is a cache miss for itself and everything after it. Moving the
  // cut every PRUNE_BATCH steps keeps the prefix stable in between, at the price of up to
  // PRUNE_BATCH - 1 extra verbatim snapshots.
  const prunable = Math.max(0, toolIndices.length - VERBATIM_OBSERVATIONS);
  const pruned = prunable - (prunable % PRUNE_BATCH);
  const cutoff = pruned > 0 ? toolIndices[pruned]! : -1;
  // The newest message that carries the re-sent blocks keeps them; every older copy is stale by
  // definition, since both blocks are rebuilt in full on every step.
  const newestWithBlocks = messages.reduce(
    (found, message, index) => (hasResentBlocks(message) ? index : found),
    -1,
  );

  return messages.map((message, index) => {
    if (message.role === 'tool' && cutoff >= 0 && index < cutoff) {
      const headerLine = message.content.split('\n', 1)[0] ?? '';
      return {
        ...message,
        content: `${headerLine.slice(0, 300)}\n(older page snapshot omitted to save context)`,
      };
    }
    if (index !== newestWithBlocks && hasResentBlocks(message)) {
      return { ...message, content: stripResentBlocks(message.content) };
    }
    return message;
  });
}

/** How many aged tool results are pruned at once (see `pruneObservations`). */
const PRUNE_BATCH = 3;

/** Steps kept verbatim at each end of the ledger before the middle is elided. */
const LEDGER_HEAD = 3;
const LEDGER_TAIL = 8;

/**
 * The run's own history, bounded, as one re-sent block.
 *
 * `history` accumulated a line per step for the whole run and only its LAST entry was ever read, so
 * the model's only cross-step structure was six verbatim observations and a row of header lines.
 * That is enough to react and not enough to carry a plan: on a multi-phase task the model re-derives
 * what it was doing every few steps, or quietly stops doing it. Keeping both ends and eliding the
 * middle bounds the cost — the recent steps say where it is, the first ones say what it set out to
 * do — and turns the ledger from dead memory growth into the run's working state.
 */
export function runLedger(history: readonly string[]): string {
  const clip = (line: string): string => (line.length > 200 ? `${line.slice(0, 199)}…` : line);
  if (history.length <= LEDGER_HEAD + LEDGER_TAIL) return history.map(clip).join('\n');
  const omitted = history.length - LEDGER_HEAD - LEDGER_TAIL;
  return [
    ...history.slice(0, LEDGER_HEAD).map(clip),
    `… ${omitted} earlier step(s) omitted …`,
    ...history.slice(-LEDGER_TAIL).map(clip),
  ].join('\n');
}

function hasResentBlocks(message: LlmMessage): message is LlmMessage & { content: string } {
  if (message.role === 'assistant') return false;
  const content = message.content;
  return (
    typeof content === 'string' &&
    (content.includes(EVIDENCE_PREAMBLE) || content.includes(PROGRESS_PREAMBLE))
  );
}

/**
 * Remove the evidence-ledger and progress blocks from a step prompt that is no longer the newest.
 * (The per-site memory block that used to be stripped alongside them left with durable memory.)
 *
 * Both are rebuilt in full on EVERY step, so up to seven byte-identical copies of an 8,000-char
 * ledger could be live in one request — re-billed in full on the managed path, which places no cache
 * breakpoint on the message array.
 *
 * The cut is anchored on each block's preamble and ends at the FIRST closing fence after it. That
 * precision is the whole trick: the ledger shares `BEGIN/END_UNTRUSTED_WEB_CONTENT` with the page
 * snapshot, so a greedy match would delete the observation the step exists to deliver. Whatever is
 * removed is always a COMPLETE fenced unit — never content stripped of its "untrusted data" framing.
 */
function stripResentBlocks(content: string): string {
  const cut = (text: string, preamble: string, endFence: string): string => {
    const start = text.indexOf(preamble);
    if (start === -1) return text;
    const end = text.indexOf(endFence, start);
    if (end === -1) return text; // malformed: leave it whole rather than truncate mid-fence
    return `${text.slice(0, start)}(earlier copy of this block omitted; the current one is below)\n${text.slice(end + endFence.length + 1)}`;
  };
  return cut(
    cut(content, EVIDENCE_PREAMBLE, 'END_UNTRUSTED_WEB_CONTENT'),
    PROGRESS_PREAMBLE,
    'END_UNTRUSTED_WEB_CONTENT',
  );
}

/**
 * Attach a screenshot to the newest turn. Vision arrives as an extra content part on the message the
 * model is about to answer; a tool result cannot carry an image on every provider, so in that case a
 * trailing user turn carries it instead.
 */
export function attachImageToLastTurn(
  messages: readonly LlmMessage[],
  image: string,
): LlmMessage[] {
  const out = [...messages];
  const last = out.at(-1);
  if (last?.role === 'user') {
    out[out.length - 1] = { ...last, images: [{ mediaType: 'image/png', data: image }] };
    return out;
  }
  out.push({
    role: 'user',
    content: 'Visual observation of the current page:',
    images: [{ mediaType: 'image/png', data: image }],
  });
  return out;
}

/**
 * Renders each step's observation for the model, summarising a page whose interactive elements have
 * not changed instead of re-sending it.
 *
 * A summarised observation is only safe while a FULL one is still in the verbatim window. Older
 * tool results are pruned to their header line, so after enough consecutive unchanged steps —
 * collect, wait, a blocked action — every surviving result would say only "unchanged" and the model
 * would be acting on element indices it can no longer see anywhere. That is exactly how
 * hallucinated indices and "no element [n]" loops start.
 */
export interface ObservationRenderer {
  render: (raw: RawPerception) => string;
}

export function createObservationRenderer(): ObservationRenderer {
  let previous: RawPerception | null = null;
  let stepsSinceFullSnapshot = 0;
  return {
    render(raw) {
      const unchanged =
        previous !== null &&
        sameElements(previous, raw) &&
        stepsSinceFullSnapshot < VERBATIM_OBSERVATIONS - 1;
      const rendered = unchanged
        ? `url: ${raw.url} | ${JSON.stringify(raw.title)}\n(interactive elements unchanged from the previous step)`
        : renderObservation(raw);
      stepsSinceFullSnapshot = unchanged ? stepsSinceFullSnapshot + 1 : 0;
      previous = raw;
      return rendered;
    },
  };
}

/**
 * The step-budget nudge, or undefined while there is budget to spare. Escalate rather than repeat:
 * the same "wrap up" line from 75% to 100% carried no new information after the first time, so the
 * last quarter of a run read identically whether five steps remained or one.
 */
export function budgetNudge(step: number, maxSteps: number): string | undefined {
  if (step >= Math.ceil(maxSteps * 0.95)) {
    return `BUDGET: step ${step} of ${maxSteps} — this is your LAST chance to answer. Call \`done\` NOW with whatever you have, and say plainly what is missing.`;
  }
  if (step >= Math.ceil(maxSteps * 0.75)) {
    return `BUDGET: step ${step} of ${maxSteps}. Wrap up — consolidate what you already have and call \`done\`; do not start new exploration.`;
  }
  return undefined;
}

/** Rows the run has collected, in order, deduplicated by their full content. */
export interface RunDataset {
  readonly size: number;
  /** Fold a `collect` result in; reports how many rows were new and how many were duplicates. */
  merge: (collected: NonNullable<ExecOutcome['collected']>) => { added: number; skipped: number };
  /** The rows as a Markdown table (see `renderDataset`). */
  render: () => string;
}

export function createDataset(): RunDataset {
  const rows: Array<Record<string, string>> = [];
  const seen = new Set<string>();
  let columns: string[] = [];
  return {
    get size() {
      return rows.length;
    },
    merge(collected) {
      if (collected.columns?.length) columns = collected.columns;
      let added = 0;
      for (const row of collected.rows) {
        if (rows.length >= 5_000) break;
        // Dedupe on the whole row: re-visiting page 1 after paginating back is normal, and silently
        // doubling every row is worse than dropping a genuine duplicate.
        const key = JSON.stringify(row);
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(row);
        added += 1;
        for (const column of Object.keys(row)) {
          if (!columns.includes(column)) columns.push(column);
        }
      }
      return { added, skipped: collected.rows.length - added };
    },
    render() {
      return renderDataset(rows, columns);
    },
  };
}
