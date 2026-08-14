/**
 * Internal agent types (not wire contracts — those live in `@lobster/shared-types`). These describe
 * what the agent SEES (perception) and how a step is recorded, and are shared across the perception,
 * loop, and memory modules.
 */

/** One interactive/visible element the perception layer surfaces to the model. */
export interface PerceivedElement {
  /** Stable-within-observation index the model references in an action (`click 12`). */
  index: number;
  /** Lowercased tag name, e.g. `button`, `input`, `a`. */
  tag: string;
  /** Resolved ARIA-ish role, e.g. `button`, `link`, `textbox`, `checkbox`. */
  role: string;
  /** Accessible name (label/aria-label/placeholder/text/alt/title), trimmed + truncated. */
  name: string;
  /** `<input>`/`<button>` type attribute, when present. */
  type?: string;
  /** Effective HTML form semantics: activating this control submits its owning form. */
  submitsForm?: boolean;
  /** The element held DOM focus when this observation was captured. */
  focused?: boolean;
  /** Browser-verified `contenteditable` state for non-native text controls. */
  editable?: boolean;
  /** Current field value for inputs/textareas/selects (truncated). */
  value?: string;
  /** Whether the field has content without exposing sensitive content. */
  filled?: boolean;
  /** Password, OTP, payment, token, or similarly secret-bearing field. */
  sensitive?: boolean;
  /** Resolved link/form-action target when available, used by navigation policy before clicking. */
  href?: string;
  /** Select option values/labels, bounded by perception caps. */
  options?: string[];
  /** `top`, `frame:…`, or `shadow:…` context hint for debugging/recovery. */
  context?: string;
  /** Viewport-relative CSS-pixel center — the coordinate CDP `Input.*` uses to click. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Compact state hint: `disabled` | `checked` | `expanded` | `selected`, joined by `,`. */
  state?: string;
}

/** Page-level context captured alongside the element list. */
export interface PageMeta {
  url: string;
  /** Ephemeral SHA-256 identity of the unredacted URL; never rendered, emitted, or persisted. */
  urlIdentity?: string;
  title: string;
  scrollY: number;
  viewportH: number;
  viewportW?: number;
  devicePixelRatio?: number;
  docH: number;
  canScrollUp: boolean;
  canScrollDown: boolean;
  /** Terse visible-page text; never includes form control values. */
  text?: string;
  /** Situation flags such as `captcha`, `otp`, `dialog`, `login`, `canvas`. */
  signals?: string[];
}

/** Raw JSON returned by the injected extraction script (before indexing/coherence in the loop). */
export interface RawPerception extends PageMeta {
  elements: PerceivedElement[];
  /** Truncation notice: how many actionable elements were dropped past the cap (0 = none). */
  truncated: number;
}

/** A processed observation: the raw perception plus a rendered, token-efficient text view. */
export interface Observation {
  raw: RawPerception;
  /** The exact text handed to the model this step (full snapshot, or a diff vs. the previous). */
  rendered: string;
  /** True when `rendered` is a diff against the prior observation rather than a full snapshot. */
  isDiff: boolean;
}

/** One recorded step in a run (persisted terse; the verbose observation text is not kept). */
export interface StepRecord {
  index: number;
  url: string;
  /** The action the model took, JSON-stringified for compact storage. */
  action: string;
  /** Short outcome, e.g. `ok`, `navigated`, `error: element 12 not found`. */
  outcome: string;
  ts: string;
}
