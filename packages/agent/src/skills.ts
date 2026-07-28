/**
 * Built-in skill pack — reusable procedures distilled from common web tasks, so the agent invokes a
 * known recipe instead of re-deriving it from scratch each time (fewer tokens, more reliable). These
 * are read-only defaults; per-profile LEARNED skills (saved from successful runs) live in the profile's
 * memory and are merged on top. A "skill" here is a short procedure the model reads as guidance — not
 * code — matching how strong agent harnesses expose progressive, on-demand expertise.
 */

export interface BuiltinSkill {
  name: string;
  /** When this skill applies — a short trigger the model can pattern-match against the task/page. */
  trigger: string;
  /** The procedure, as terse numbered guidance. */
  steps: string;
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

/** Render skills (built-in + learned) as a compact block for the system prompt. */
export function formatSkills(learned: BuiltinSkill[] = [], query = ''): string {
  const merged = new Map(BUILTIN_SKILLS.map((skill) => [skill.name, skill]));
  for (const skill of learned) merged.set(skill.name, skill);
  const all = [...merged.values()];
  const selected = query ? selectSkills(all, query) : all.slice(0, 6);
  if (selected.length === 0) return '';
  return (
    'Skills you can apply (use when the trigger matches):\n' +
    selected.map((s) => `- ${s.name} — when ${s.trigger}: ${s.steps}`).join('\n')
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
