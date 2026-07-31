import type { AgentAction } from '@lobster/shared-types';
import { normalizeBrowserPermission } from './browser-config-guard.js';

const KINDS = [
  'click',
  'click_at',
  'hover',
  'type',
  'type_at',
  'select',
  'key',
  'scroll',
  'drag',
  'upload',
  'navigate',
  'back',
  'tab',
  'wait',
  'extract',
  'collect',
  'remember',
  'browser_config',
  'ask',
  'screenshot',
  'done',
] as const;

const BROWSER_CONFIG_OPS = [
  'clear_cookies',
  'clear_all_cookies',
  'clear_site_data',
  'clear_cache',
  'set_permission',
  'set_downloads',
  'open_settings',
  'set_theme',
  'set_privacy',
  'set_content_default',
] as const;

export const ACT_TOOL = {
  name: 'act',
  description:
    "Perform exactly one browser action. Set kind and only that action's relevant fields.",
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: KINDS },
      id: { type: 'integer', minimum: 0, description: 'Current observation element index.' },
      x: {
        type: 'integer',
        minimum: 0,
        maximum: 20_000,
        description: 'CSS viewport x coordinate.',
      },
      y: {
        type: 'integer',
        minimum: 0,
        maximum: 20_000,
        description: 'CSS viewport y coordinate.',
      },
      fromId: { type: 'integer', minimum: 0 },
      toId: { type: 'integer', minimum: 0 },
      text: { type: 'string', maxLength: 20_000 },
      submit: { type: 'boolean' },
      clear: { type: 'boolean' },
      button: { type: 'string', enum: ['left', 'right'] },
      count: { type: 'integer', enum: [1, 2] },
      values: { type: 'array', items: { type: 'string' }, maxItems: 20 },
      key: { type: 'string', maxLength: 80 },
      direction: { type: 'string', enum: ['up', 'down'] },
      amount: { type: 'integer', minimum: 1, maximum: 10_000 },
      paths: { type: 'array', items: { type: 'string' }, maxItems: 20 },
      url: { type: 'string', maxLength: 8_192 },
      operation: { type: 'string', enum: ['list', 'new', 'switch', 'close'] },
      index: { type: 'integer', minimum: 0 },
      ms: { type: 'integer', minimum: 0, maximum: 8_000 },
      description: { type: 'string', maxLength: 500 },
      factKey: { type: 'string', maxLength: 100, description: 'remember: short fact name.' },
      factValue: {
        type: 'string',
        maxLength: 1000,
        description: 'remember: the durable fact value.',
      },
      columns: {
        type: 'array',
        items: { type: 'string', maxLength: 100 },
        maxItems: 40,
        description: 'collect: column names, given once on the first collect of the run.',
      },
      rows: {
        type: 'array',
        maxItems: 200,
        items: { type: 'object', additionalProperties: { type: 'string' } },
        description:
          'collect: rows to add to the dataset, each a map of column name to cell value. Values must come verbatim from the page.',
      },
      op: {
        type: 'string',
        enum: BROWSER_CONFIG_OPS,
        description: 'browser_config: which configuration operation to run.',
      },
      domain: {
        type: 'string',
        maxLength: 253,
        description: 'browser_config: registrable domain (clear_cookies) or a permission target.',
      },
      origin: {
        type: 'string',
        maxLength: 2_048,
        description: 'browser_config: an https origin for clear_site_data / set_permission.',
      },
      permission: {
        type: 'string',
        maxLength: 40,
        description: 'browser_config set_permission: e.g. geolocation, notifications, camera.',
      },
      setting: { type: 'string', enum: ['granted', 'denied', 'prompt'] },
      behavior: { type: 'string', enum: ['allow', 'deny', 'default'] },
      value: {
        type: 'string',
        maxLength: 200,
        description: 'browser_config pref ops: the target value (e.g. theme "dark").',
      },
      question: { type: 'string', maxLength: 500 },
      sensitive: { type: 'boolean' },
      targetId: { type: 'integer', minimum: 0 },
      targetX: { type: 'integer', minimum: 0, maximum: 20_000 },
      targetY: { type: 'integer', minimum: 0, maximum: 20_000 },
      success: { type: 'boolean' },
      summary: { type: 'string', maxLength: 4_000 },
      note: { type: 'string', maxLength: 160 },
    },
    required: ['kind'],
  },
} as const;

/**
 * The action list the model is shown, built from what is ACTUALLY available this run.
 *
 * It used to be one fixed string that advertised `screenshot`, `click_at`, `type_at` and `upload`
 * unconditionally — all four of which are gated behind config no caller ever set. The model would
 * therefore choose an action it could not use, burn a step on `blocked: …`, and learn nothing. A
 * capability the run does not have is simply not described.
 */
export function buildActionReference(opts: { vision: boolean; uploads: boolean }): string {
  const lines = [
    'Actions (one per tool call):',
    '- click {id, button?, count?}; hover {id}; type {id,text,clear?,submit?}; select {id,values}',
    '- key {key}; scroll {direction,amount?,id?}; drag {fromId,toId}',
    '- navigate {url}; back {}; tab {operation,index?,url?}; wait {ms?}',
    '- extract {description}: read the current page as structured text (tables keep their rows, lists their items). Use it when the answer is longer than the element list shows.',
    '- collect {rows, columns?}: THE way to scrape. Add rows to a dataset the harness keeps for you — deduplicated, safe across pagination, and returned in full at the end. Give `columns` once on the first call. Collect each page as you go, then click Next and collect again; never re-type collected data into your final answer, and never invent a value you did not see on the page.',
  ];
  if (opts.vision) {
    lines.push(
      '- screenshot {description?}: capture the page visually. Use it when the element list is empty or the content is a canvas/image/custom widget you cannot otherwise read.',
      '- after a screenshot ONLY, in that same next step: click_at {x,y,...} or type_at {x,y,text,...} using CSS viewport coordinates from the image.',
    );
  }
  if (opts.uploads) {
    lines.push(
      '- upload {id,paths}: attach files to a file input (only paths under the allowed roots).',
    );
  }
  lines.push(
    '- remember {factKey,factValue}: save a durable per-site fact you\'ll want next time (e.g. "login = SSO via Google", "cookie-accept = button \'Agree\'"). NEVER remember secrets.',
    '- browser_config {op,...}: change browser settings directly (not the page). Live ops, applied instantly and invisibly with no page opened: clear_cookies {domain}; clear_all_cookies {}; clear_site_data {origin|domain}; clear_cache {}; set_permission {origin|domain, permission (geolocation|notifications|camera|microphone|clipboard-read|clipboard-write|midi), setting (granted|denied|prompt)}; set_downloads {behavior (allow|deny|default)}. Use clear_all_cookies when the user says all/every site\'s cookies — never go looking through the settings UI for it. Settings-page ops for the long tail: open_settings {value} where value is an area like "privacy", "appearance", "cookies", "content", "notifications", "downloads", "search", "site settings", or "new tab"; plus set_theme {value:"dark"|"light"}, set_privacy {}, set_content_default {}. These open a vetted settings page in a SEPARATE BACKGROUND tab (the user\'s tab is untouched); perceive it, operate the specific control, then CLOSE that tab. You can NEVER change fingerprint or proxy/network settings (user-agent, languages, timezone, screen, canvas/WebGL, WebRTC, proxy, DNS, fonts) — hard-blocked to protect the profile\'s identity; don\'t attempt them.',
    '- ask {question,sensitive?,targetId?}; done {success,summary}',
  );
  const secrets = opts.vision
    ? 'Use ask with sensitive:true plus targetId (or targetX+targetY after a screenshot)'
    : 'Use ask with sensitive:true plus targetId';
  lines.push(
    `For passwords/OTP/payment secrets, NEVER ask the human to paste a secret into ordinary chat. ${secrets} so the harness types it directly without exposing it to you. Captchas require a human handoff; do not attempt to bypass them.`,
  );
  return lines.join('\n');
}

export interface RawActionInput {
  [key: string]: unknown;
  kind?: unknown;
}

export type ParseActionResult = { ok: true; action: AgentAction } | { ok: false; error: string };

const str = (value: unknown, max = 20_000): string | undefined =>
  typeof value === 'string' && value.length <= max ? value : undefined;
const integer = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
const bool = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;
const note = (raw: RawActionInput): { note?: string } => {
  const value = str(raw.note, 160);
  return value ? { note: value } : {};
};
const id = (raw: RawActionInput, field = 'id'): number | undefined => {
  const value = integer(raw[field]);
  return value !== undefined && value >= 0 ? value : undefined;
};
const coordinate = (
  raw: RawActionInput,
  field: 'x' | 'y' | 'targetX' | 'targetY',
): number | undefined => {
  const value = id(raw, field);
  return value !== undefined && value <= 20_000 ? value : undefined;
};
const strings = (value: unknown, max = 20): string[] | undefined =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= max &&
  value.every((v) => typeof v === 'string')
    ? value
    : undefined;

export function parseAction(raw: RawActionInput): ParseActionResult {
  const kind = str(raw.kind, 40);
  if (!kind) return bad('missing "kind"');

  switch (kind) {
    case 'click': {
      const elementId = id(raw);
      if (elementId === undefined) return bad('click requires non-negative integer "id"');
      const button = raw.button === 'right' ? 'right' : raw.button === 'left' ? 'left' : undefined;
      const count = raw.count === 2 ? 2 : raw.count === 1 ? 1 : undefined;
      return ok({
        kind,
        id: elementId,
        ...(button ? { button } : {}),
        ...(count ? { count } : {}),
        ...note(raw),
      });
    }
    case 'click_at': {
      const x = coordinate(raw, 'x');
      const y = coordinate(raw, 'y');
      if (x === undefined || y === undefined)
        return bad('click_at requires non-negative integer x/y');
      const button = raw.button === 'right' ? 'right' : raw.button === 'left' ? 'left' : undefined;
      const count = raw.count === 2 ? 2 : raw.count === 1 ? 1 : undefined;
      return ok({
        kind,
        x,
        y,
        ...(button ? { button } : {}),
        ...(count ? { count } : {}),
        ...note(raw),
      });
    }
    case 'hover': {
      const elementId = id(raw);
      return elementId === undefined
        ? bad('hover requires non-negative integer "id"')
        : ok({ kind, id: elementId, ...note(raw) });
    }
    case 'type': {
      const elementId = id(raw);
      const text = str(raw.text);
      if (elementId === undefined) return bad('type requires non-negative integer "id"');
      if (text === undefined) return bad('type requires string "text" (max 20000 chars)');
      const submit = bool(raw.submit);
      const clear = bool(raw.clear);
      return ok({
        kind,
        id: elementId,
        text,
        ...(submit !== undefined ? { submit } : {}),
        ...(clear !== undefined ? { clear } : {}),
        ...note(raw),
      });
    }
    case 'type_at': {
      const x = coordinate(raw, 'x');
      const y = coordinate(raw, 'y');
      const text = str(raw.text);
      if (x === undefined || y === undefined || text === undefined)
        return bad('type_at requires x/y and text');
      const submit = bool(raw.submit);
      const clear = bool(raw.clear);
      return ok({
        kind,
        x,
        y,
        text,
        ...(submit !== undefined ? { submit } : {}),
        ...(clear !== undefined ? { clear } : {}),
        ...note(raw),
      });
    }
    case 'select': {
      const elementId = id(raw);
      const values = strings(raw.values);
      if (elementId === undefined || !values)
        return bad('select requires "id" and 1-20 string "values"');
      return ok({ kind, id: elementId, values, ...note(raw) });
    }
    case 'key': {
      const key = str(raw.key, 80);
      return key ? ok({ kind, key, ...note(raw) }) : bad('key requires a non-empty "key"');
    }
    case 'scroll': {
      if (raw.direction !== 'up' && raw.direction !== 'down')
        return bad('scroll requires direction up/down');
      const amount = integer(raw.amount);
      const elementId = id(raw);
      if (amount !== undefined && (amount < 1 || amount > 10_000))
        return bad('scroll amount must be 1..10000');
      return ok({
        kind,
        direction: raw.direction,
        ...(amount ? { amount } : {}),
        ...(elementId !== undefined ? { id: elementId } : {}),
        ...note(raw),
      });
    }
    case 'drag': {
      const fromId = id(raw, 'fromId');
      const toId = id(raw, 'toId');
      return fromId === undefined || toId === undefined
        ? bad('drag requires non-negative integer "fromId" and "toId"')
        : ok({ kind, fromId, toId, ...note(raw) });
    }
    case 'upload': {
      const elementId = id(raw);
      const paths = strings(raw.paths);
      return elementId === undefined || !paths
        ? bad('upload requires "id" and 1-20 string "paths"')
        : ok({ kind, id: elementId, paths, ...note(raw) });
    }
    case 'navigate': {
      const url = str(raw.url, 8192);
      return url ? ok({ kind, url, ...note(raw) }) : bad('navigate requires "url"');
    }
    case 'back':
      return ok({ kind, ...note(raw) });
    case 'tab': {
      const operation = raw.operation;
      if (
        operation !== 'list' &&
        operation !== 'new' &&
        operation !== 'switch' &&
        operation !== 'close'
      ) {
        return bad('tab requires operation list/new/switch/close');
      }
      const tabIndex = id(raw, 'index');
      const url = str(raw.url, 8192);
      if ((operation === 'switch' || operation === 'close') && tabIndex === undefined) {
        return bad(`tab ${operation} requires non-negative integer "index"`);
      }
      return ok({
        kind,
        operation,
        ...(tabIndex !== undefined ? { index: tabIndex } : {}),
        ...(url ? { url } : {}),
        ...note(raw),
      });
    }
    case 'wait': {
      const ms = integer(raw.ms);
      if (ms !== undefined && (ms < 0 || ms > 8_000)) return bad('wait ms must be 0..8000');
      return ok({ kind, ...(ms !== undefined ? { ms } : {}), ...note(raw) });
    }
    case 'extract': {
      const description = str(raw.description, 500);
      return description
        ? ok({ kind, description, ...note(raw) })
        : bad('extract requires "description"');
    }
    case 'collect': {
      const rows = Array.isArray(raw.rows) ? raw.rows : null;
      if (!rows || rows.length === 0) return bad('collect requires a non-empty "rows" array');
      if (rows.length > 200) return bad('collect accepts at most 200 rows per call');
      const columns = strings(raw.columns, 40);
      const clean: Array<Record<string, string>> = [];
      for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          return bad('each collect row must be an object of column -> value');
        }
        const entry: Record<string, string> = {};
        for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
          if (key.length > 100) return bad('collect column names must be 100 characters or fewer');
          // Coerce numbers/booleans rather than rejecting: a model emitting a bare price is being
          // reasonable, and failing the whole batch over it wastes a scraped page.
          if (typeof value === 'string') entry[key] = value.slice(0, 2_000);
          else if (typeof value === 'number' || typeof value === 'boolean')
            entry[key] = String(value);
          else if (value === null || value === undefined) entry[key] = '';
          else return bad(`collect value for "${key}" must be text, number, or boolean`);
        }
        if (Object.keys(entry).length > 40) return bad('collect rows may have at most 40 columns');
        clean.push(entry);
      }
      return ok({ kind, rows: clean, ...(columns ? { columns } : {}), ...note(raw) });
    }
    case 'remember': {
      const factKey = str(raw.factKey, 100);
      const factValue = str(raw.factValue, 1000);
      if (!factKey || !factValue) return bad('remember requires short "factKey" and "factValue"');
      return ok({ kind, factKey, factValue, ...note(raw) });
    }
    case 'browser_config': {
      const op = str(raw.op, 40);
      if (!op || !(BROWSER_CONFIG_OPS as readonly string[]).includes(op)) {
        return bad(`browser_config requires "op" one of: ${BROWSER_CONFIG_OPS.join(', ')}`);
      }
      const domain = str(raw.domain, 253);
      const origin = str(raw.origin, 2_048);
      const permission = str(raw.permission, 40);
      const value = str(raw.value, 200);
      const setting =
        raw.setting === 'granted' || raw.setting === 'denied' || raw.setting === 'prompt'
          ? raw.setting
          : undefined;
      const behavior =
        raw.behavior === 'allow' || raw.behavior === 'deny' || raw.behavior === 'default'
          ? raw.behavior
          : undefined;
      if (op === 'clear_cookies' && !domain) return bad('clear_cookies requires a "domain"');
      if ((op === 'clear_site_data' || op === 'set_permission') && !origin && !domain)
        return bad(`${op} requires an "origin" (or "domain")`);
      if (op === 'set_permission' && !permission)
        return bad('set_permission requires a "permission" name');
      if (op === 'set_permission' && !setting)
        return bad('set_permission requires setting granted/denied/prompt');
      if (op === 'set_downloads' && !behavior)
        return bad('set_downloads requires behavior allow/deny/default');
      if (op === 'open_settings' && !value)
        return bad('open_settings requires a "value" naming the settings area (e.g. "privacy")');
      return ok({
        kind,
        op: op as (typeof BROWSER_CONFIG_OPS)[number],
        ...(domain ? { domain } : {}),
        ...(origin ? { origin } : {}),
        ...(permission ? { permission: normalizeBrowserPermission(permission) } : {}),
        ...(setting ? { setting } : {}),
        ...(behavior ? { behavior } : {}),
        ...(value ? { value } : {}),
        ...note(raw),
      });
    }
    case 'ask': {
      const question = str(raw.question, 500);
      if (!question) return bad('ask requires "question"');
      const targetId = id(raw, 'targetId');
      const targetX = coordinate(raw, 'targetX');
      const targetY = coordinate(raw, 'targetY');
      const sensitive = bool(raw.sensitive);
      if (
        (targetId !== undefined || targetX !== undefined || targetY !== undefined) &&
        sensitive !== true
      )
        return bad('ask targets require sensitive:true');
      if ((targetX === undefined) !== (targetY === undefined))
        return bad('ask coordinate handoff requires both targetX and targetY');
      if (targetId !== undefined && targetX !== undefined)
        return bad('ask accepts targetId or targetX/targetY, not both');
      return ok({
        kind,
        question,
        ...(sensitive !== undefined ? { sensitive } : {}),
        ...(targetId !== undefined ? { targetId } : {}),
        ...(targetX !== undefined ? { targetX, targetY: targetY as number } : {}),
      });
    }
    case 'screenshot': {
      const description = str(raw.description, 500);
      return ok({ kind, ...(description ? { description } : {}) });
    }
    case 'done': {
      const success = bool(raw.success) ?? false;
      const summary = str(raw.summary, 4000) ?? '';
      return ok({ kind, success, summary });
    }
    default:
      return bad(`unknown kind ${JSON.stringify(kind)}`);
  }
}

function ok(action: AgentAction): ParseActionResult {
  return { ok: true, action };
}

function bad(error: string): ParseActionResult {
  return { ok: false, error };
}
