/**
 * Built-in skill pack — reusable procedures distilled from common web tasks, so the agent invokes a
 * known recipe instead of re-deriving it from scratch each time (fewer tokens, more reliable). These
 * are read-only defaults; per-profile LEARNED skills live in the profile's encrypted memory and are
 * merged on top. A skill is learned only when the agent explicitly proposes one with the `learn` action
 * after finishing a task — never inferred from a page, and never from text a page supplied. A "skill" here is a short procedure the model reads as guidance — not
 * code — matching how strong agent harnesses expose progressive, on-demand expertise.
 */

export interface BuiltinSkill {
  name: string;
  /** When this skill applies — a short trigger the model can pattern-match against the task/page. */
  trigger: string;
  /** The procedure, as terse numbered guidance. */
  steps: string;
  /**
   * Where this procedure came from. Absent means a vetted built-in shipped with the product; `learned`
   * means the agent wrote it after finishing a task, having read pages it does not control. The two are
   * never presented to the model as equally authoritative.
   */
  origin?: 'learned';
  /** Host a learned skill was derived on. Set by the harness, never by the model. */
  domain?: string;
  /** When it was learned, so a stale procedure can be recognised as such. */
  learnedAt?: string;
}

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  {
    name: 'dismiss-cookie-banner',
    trigger: 'a cookie/consent banner covers the page',
    steps:
      'Look for a button labeled Accept, Accept all, Agree, or OK and click it. If only Reject/Manage is offered, Reject is usually fine to proceed.',
  },
  {
    name: 'search-a-site',
    trigger: 'you need to find something via an on-site search box',
    steps:
      'Click the search box (role searchbox or a magnifier icon), type the query, then act with submit:true to run it. Read the results page before clicking a result.',
  },
  {
    name: 'log-in',
    trigger: 'the task needs an authenticated session and a login form is shown',
    steps:
      'Type the username/email. For a password use ask with sensitive:true and targetId; then click Sign in. For OTP use the same secure handoff. If a CAPTCHA appears, ask the human to complete it in the visible browser.',
  },
  {
    name: 'paginate-results',
    trigger: 'the data you need spans multiple pages',
    steps:
      'Collect what is visible with `extract`, then click Next (or the next page number) and repeat. Stop when Next is disabled or the target item is found.',
  },
  {
    name: 'complete-multi-step-form',
    trigger: 'a form is split across Next/Continue steps or validates fields incrementally',
    steps:
      'Fill only visible required fields, advance once, then re-read validation and progress state. Never reuse old element ids. Review the final summary before the consequential submit.',
  },
  {
    name: 'create-account',
    trigger: 'the user asked to register, sign up, or create an account',
    steps:
      'Enter non-secret profile data, use secure human handoff for passwords/OTP, ask the human for CAPTCHA, and inspect terms/final details. The harness requires confirmation for the final create-account action.',
  },
  {
    name: 'email-verification',
    trigger: 'a site sent a link or one-time code by email',
    steps:
      'Use tabs to open the already-authenticated webmail only when the task authorizes it. Identify the sender/domain and newest matching message, extract only the needed link/code, return to the original tab, and submit it. Otherwise ask the human securely.',
  },
  {
    name: 'download-file',
    trigger: 'the task asks to download an invoice, report, export, image, or document',
    steps:
      'Confirm the correct record/date/name, click its Download/Export control once, wait for confirmation, and finish with what was downloaded. Do not repeatedly click while a download is starting.',
  },
  {
    name: 'upload-file',
    trigger: 'the task asks to attach or upload a local file',
    steps:
      'Use upload only on the intended file input and only from configured roots. Verify the displayed filename/preview before any final submit; the harness will confirm both upload and consequential send.',
  },
  {
    name: 'visual-widget-fallback',
    trigger:
      'the needed control is inside a canvas, inaccessible cross-origin frame, or custom visual widget',
    steps:
      'Request screenshot once, use the reported CSS viewport dimensions/DPR, then use one coordinate action. Re-observe immediately. Coordinate actions are risk-gated; use human handoff for CAPTCHA and secrets.',
  },
];

/**
 * Render skills as a compact block for the system prompt.
 *
 * A LEARNED skill never silently replaces a built-in: built-ins are vetted product content, learned
 * ones were written by the model after reading pages it does not control. They are name-spaced apart,
 * labelled, and only offered after a trustworthy current host is known and matches their scope. A run
 * starts before it necessarily has a page; treating an empty host as "match everything" would replay
 * page-derived instructions from every previously visited site into that first model turn.
 */
export function formatSkills(learned: BuiltinSkill[] = [], query = '', host = ''): string {
  const scoped = scopedLearnedSkills(learned, host);
  const all = [
    ...BUILTIN_SKILLS,
    ...scoped.filter((s) => !BUILTIN_SKILLS.some((b) => b.name === s.name)),
  ];
  const selected = query ? selectSkills(all, query) : all.slice(0, 6);
  if (selected.length === 0) return '';
  const render = (s: BuiltinSkill): string =>
    s.origin === 'learned'
      ? `- ${s.name} (learned on ${s.domain ?? 'this profile'}${s.learnedAt ? `, ${s.learnedAt.slice(0, 10)}` : ''}; a past run's note, not a rule) — when ${s.trigger}: ${s.steps}`
      : `- ${s.name} — when ${s.trigger}: ${s.steps}`;
  return 'Skills you can apply (use when the trigger matches):\n' + selected.map(render).join('\n');
}

/** `shop.example.com` matches a skill scoped to `example.com`, but never the reverse. */
export function hostMatches(host: string, domain: string): boolean {
  const h = normalizeSkillHost(host);
  const d = normalizeSkillHost(domain);
  if (!h || !d) return false;
  return h === d || (isIP(d) === 0 && h.endsWith(`.${d}`));
}

/**
 * Canonical hostname representation used for learned-skill storage and matching.
 *
 * `URL.hostname` normally hands the harness ASCII/punycode already, but persisted data can predate that
 * invariant or be malformed. Parsing through URL gives us the platform's IDNA conversion and rejects
 * paths, credentials, ports, whitespace and empty values. The round-trip equality check also prevents a
 * value such as `example.com/path` from being silently narrowed to a different scope.
 */
export function normalizeSkillHost(value: string): string | undefined {
  const candidate = value.trim().toLowerCase().replace(/\.$/, '');
  // Learned procedures are web-host scoped, never origin/authority scoped. In particular, reject a
  // port explicitly instead of trusting URL.port: URL parsing erases default ports (`:443`), which
  // would otherwise make malformed stored scope look valid after normalization.
  if (
    !candidate ||
    /[\\/@\s:[\]]/.test(candidate) ||
    candidate.startsWith('.') ||
    candidate.endsWith('.') ||
    candidate.includes('..')
  ) {
    return undefined;
  }
  try {
    const parsed = new URL(`https://${candidate}/`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return undefined;
    }
    const normalized = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (
      !normalized ||
      normalized.startsWith('.') ||
      normalized.endsWith('.') ||
      normalized.includes('..')
    ) {
      return undefined;
    }
    // A learned procedure scoped to a public/private suffix (for example `co.uk` or `github.io`)
    // would be disclosed to unrelated registrants/tenants through subdomain matching. Reuse the
    // maintained PSL boundary rather than maintaining a second, drifting suffix list here.
    try {
      return normalizeAllowedDomains([normalized])[0];
    } catch {
      return undefined;
    }
  } catch {
    return undefined;
  }
}

/** Only well-scoped learned procedures may enter a prompt; unknown host means none. */
function scopedLearnedSkills(skills: readonly BuiltinSkill[], host: string): BuiltinSkill[] {
  const currentHost = normalizeSkillHost(host);
  if (!currentHost) return [];
  return skills.filter(
    (skill) =>
      skill.origin === 'learned' &&
      Boolean(skill.domain) &&
      !BUILTIN_SKILLS.some((builtin) => builtin.name === skill.name) &&
      hostMatches(currentHost, skill.domain ?? ''),
  );
}

/** Progressive disclosure: only send procedures whose metadata overlaps the current task. */
export function selectSkills(skills: BuiltinSkill[], query: string, limit = 4): BuiltinSkill[] {
  const terms = new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  const scored = skills
    .map((skill, index) => {
      const haystack = `${skill.name} ${skill.trigger}`.toLowerCase();
      let score = 0;
      for (const term of terms) if (haystack.includes(term)) score += 1;
      if (
        /login|log in|sign in|account|password/.test(query.toLowerCase()) &&
        skill.name === 'log-in'
      )
        score += 4;
      if (/search|find|look up/.test(query.toLowerCase()) && skill.name === 'search-a-site')
        score += 3;
      if (
        /sign up|register|create.*account/.test(query.toLowerCase()) &&
        skill.name === 'create-account'
      )
        score += 4;
      if (
        /download|invoice|report|export/.test(query.toLowerCase()) &&
        skill.name === 'download-file'
      )
        score += 4;
      if (/upload|attach/.test(query.toLowerCase()) && skill.name === 'upload-file') score += 4;
      if (
        /verification|one.time|otp|email code/.test(query.toLowerCase()) &&
        skill.name === 'email-verification'
      )
        score += 4;
      return { skill, index, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((item) => item.skill);
  return scored;
}

/**
 * Procedures learned on THIS host, for injection when a run arrives on a site it has worked before.
 *
 * This is the path that makes learning worth anything: skills are chosen once from the task string at
 * run start, and a task almost never names the quirk a past run discovered ("the export button is
 * behind the Reports tab"). Scoping strictly to the visited host is also the containment rule — a
 * procedure written while reading one site can never surface on another.
 */
export function formatLearnedForHost(skills: readonly BuiltinSkill[], host: string): string {
  const scoped = scopedLearnedSkills(skills, host).slice(0, 4);
  if (scoped.length === 0) return '';
  return (
    `Procedures a past run recorded for this site (notes, not rules — verify against the page):\n` +
    scoped.map((s) => `- ${s.name} — when ${s.trigger}: ${s.steps}`).join('\n')
  );
}
import { isIP } from 'node:net';
import { normalizeAllowedDomains } from './policy.js';
