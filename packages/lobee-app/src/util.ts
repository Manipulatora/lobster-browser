import type { AgentAction } from './types';

export const clip = (s: string, n: number): string =>
  s && s.length > n ? s.slice(0, n - 1) + '…' : s || '';

export const hostOf = (u: string): string => {
  try {
    return new URL(u).host;
  } catch {
    return u || '';
  }
};

function describeBrowserConfig(a: AgentAction): string {
  switch (a.op) {
    case 'clear_cookies':
      return `Cleared cookies for ${a.domain ?? 'a site'}`;
    case 'clear_all_cookies':
      return 'Cleared all browser cookies';
    case 'clear_site_data':
      return `Cleared site data for ${hostOf(String(a.origin ?? '')) || a.domain || 'a site'}`;
    case 'clear_cache':
      return 'Cleared the browser cache';
    case 'set_permission':
      return `Set ${a.permission ?? 'a'} permission → ${a.setting ?? 'prompt'}`;
    case 'set_downloads':
      return `Set downloads → ${a.behavior ?? 'default'}`;
    case 'open_settings':
      return `Opened ${a.value ?? 'browser'} settings`;
    case 'set_theme':
      return `Opened appearance settings${a.value ? ` (${a.value})` : ''}`;
    case 'set_privacy':
      return 'Opened privacy settings';
    case 'set_content_default':
      return 'Opened site-content settings';
    case 'set_pref':
      return `Set ${a.pref ?? 'a browser setting'} → ${a.value ?? 'default'}`;
    case 'get_pref':
      return `Read ${a.pref ?? 'a browser setting'}`;
    default:
      return 'Changed a browser setting';
  }
}

export function describeAction(a: AgentAction | undefined): string {
  if (!a) return 'Working';
  const note = typeof a.note === 'string' ? a.note.trim() : '';
  if (note) return note;
  if (a.kind === 'browser_config') return describeBrowserConfig(a);
  const text = typeof a.text === 'string' ? a.text : '';
  const map: Record<string, string> = {
    click: 'Clicked an element',
    click_at: 'Clicked the page',
    hover: 'Hovered an element',
    type: text === '[REDACTED]' ? 'Entered secure text' : `Typed “${clip(text, 40)}”`,
    type_at: text === '[REDACTED]' ? 'Entered secure text' : `Typed “${clip(text, 40)}”`,
    select: 'Chose an option',
    remember: 'Saved a note to memory',
    key: `Pressed ${a.key}`,
    scroll: `Scrolled ${a.direction}`,
    drag: 'Dragged an element',
    upload: 'Uploaded a file',
    navigate: `Opened ${hostOf(String(a.url ?? ''))}`,
    back: 'Went back',
    tab: `${a.operation} a tab`,
    wait: 'Waited',
    extract: 'Extracted info',
    ask: 'Asked you a question',
    screenshot: 'Looked at the page',
    done: 'Finished',
  };
  return map[a.kind] ?? a.kind;
}
