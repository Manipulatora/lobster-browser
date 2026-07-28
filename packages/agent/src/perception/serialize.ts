import type { PerceivedElement, RawPerception } from '../types.js';

/**
 * Render an observation as the compact text the model reads. Token efficiency lives here: one short
 * line per element (`[i] role "name" …`), in-viewport elements only (perception already filtered), and
 * page scroll context so the model knows when to scroll instead of guessing.
 *
 * Example:
 *   url: https://shop.example/search  |  "Results"  |  scroll 300/2400 (more below)
 *   [0] link "Home"
 *   [1] searchbox "Search products" = "shoes"
 *   [2] button "Filter" (expanded)
 *   [3] checkbox "In stock" (checked)
 */
export function renderObservation(raw: RawPerception): string {
  const lines: string[] = [];
  const scrollHint = raw.canScrollDown
    ? ' (more below)'
    : raw.canScrollUp
      ? ' (top hidden above)'
      : '';
  const scroll =
    raw.docH > raw.viewportH
      ? `  |  scroll ${raw.scrollY}/${Math.max(0, raw.docH - raw.viewportH)}${scrollHint}`
      : '';
  lines.push(`url: ${raw.url}  |  ${JSON.stringify(raw.title)}${scroll}`);
  if (raw.viewportW) {
    lines.push(
      `viewport: ${raw.viewportW}x${raw.viewportH} CSS px${raw.devicePixelRatio ? ` (devicePixelRatio ${raw.devicePixelRatio})` : ''}`,
    );
  }

  if (raw.signals && raw.signals.length > 0) lines.push(`page signals: ${raw.signals.join(', ')}`);
  if (raw.text) lines.push(`visible text: ${JSON.stringify(raw.text)}`);

  if (raw.elements.length === 0) {
    lines.push('(no interactive elements visible — try scrolling, waiting, or navigating)');
    return lines.join('\n');
  }

  for (const el of raw.elements) {
    lines.push(renderElement(el));
  }
  if (raw.truncated > 0) {
    lines.push(`… ${raw.truncated} more element(s) not shown (scroll to narrow the view)`);
  }
  return lines.join('\n');
}

function renderElement(el: PerceivedElement): string {
  // role is more semantic than tag for the model; fall back to tag for `generic`.
  const label = el.role === 'generic' ? el.tag : el.role;
  let line = `[${el.index}] ${label} ${JSON.stringify(el.name)}`;
  if (el.type && el.type !== el.role && el.tag === 'input') line += ` type=${el.type}`;
  if (el.sensitive) line += el.filled ? ' = <sensitive:filled>' : ' = <sensitive:empty>';
  else if (el.value !== undefined) line += ` = ${JSON.stringify(el.value)}`;
  else if (el.filled) line += ' = <filled>';
  if (el.options?.length) line += ` options=${JSON.stringify(el.options)}`;
  if (el.href) line += ` href=${JSON.stringify(el.href)}`;
  if (el.context) line += ` context=${JSON.stringify(el.context)}`;
  if (el.state) line += ` (${el.state})`;
  return line;
}

/**
 * Cheap, SAFE diff signal: are two perceptions element-for-element identical (same visible tree, same
 * values)? When true the loop can tell the model "unchanged" instead of re-sending the whole snapshot —
 * a common case after a wait or a no-op click, with zero risk of stale indices (nothing moved).
 */
export function sameElements(a: RawPerception, b: RawPerception): boolean {
  if (a.url !== b.url) return false;
  if (a.title !== b.title || a.text !== b.text) return false;
  if ((a.signals ?? []).join('|') !== (b.signals ?? []).join('|')) return false;
  if (a.elements.length !== b.elements.length) return false;
  if (a.scrollY !== b.scrollY) return false;
  for (let i = 0; i < a.elements.length; i += 1) {
    const x = a.elements[i] as PerceivedElement;
    const y = b.elements[i] as PerceivedElement;
    if (
      x.role !== y.role ||
      x.name !== y.name ||
      x.value !== y.value ||
      x.filled !== y.filled ||
      x.state !== y.state ||
      x.href !== y.href
    ) {
      return false;
    }
  }
  return true;
}
