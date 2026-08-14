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
    // Do not prescribe scrolling at a browser that is not open. `perceive` already explains that the
    // window opens on the first browser action, and following that advice with "try scrolling,
    // waiting, or navigating" made step 1 of every run contradict itself.
    lines.push(
      raw.signals?.includes('browser-closed')
        ? '(no page yet — the browser opens on your first browser action)'
        : '(no interactive elements visible — try scrolling, waiting, or navigating)',
    );
    return lines.join('\n');
  }

  for (const el of raw.elements) {
    lines.push(renderElement(el));
  }
  if (raw.truncated > 0) {
    // Say how the cut was made. The list is ranked by likely relevance and the lowest-ranked are
    // dropped, so "scroll to narrow the view" described a spatial rule that does not exist — a model
    // hunting for a low-ranked control could scroll forever without changing its rank. Scrolling does
    // change WHICH elements are in view, so it is still useful; it is just not the whole story.
    // Two different cuts, and telling the model the wrong one sends it hunting the wrong way. The
    // ranked cut drops the least relevant, so scrolling to change WHAT is in view helps. The candidate
    // cap is hit during collection, before anything is ranked, so what it dropped is arbitrary — and
    // saying "lowest-ranked were cut" there is simply false.
    const arbitraryCut = raw.signals?.includes('too-many-candidates');
    lines.push(
      arbitraryCut
        ? `… ${raw.truncated} more element(s) not shown. This page has more controls than can be collected, so the ones omitted were NOT chosen by relevance and something you need may be missing entirely. Use \`extract\` to read the page as text, or scroll to collect a different part of it.`
        : `… ${raw.truncated} more element(s) not shown. This list is ranked by likely relevance, not page order, and the lowest-ranked were cut. If what you need is missing, scroll to bring a different part of the page into view, or use \`extract\` to read the page as text.`,
    );
  }
  return lines.join('\n');
}

function renderElement(el: PerceivedElement): string {
  // role is more semantic than tag for the model; fall back to tag for `generic`.
  const label = el.role === 'generic' ? el.tag : el.role;
  let line = `[${el.index}] ${label} ${JSON.stringify(el.name)}`;
  if (el.type && el.type !== el.role && el.tag === 'input') line += ` type=${el.type}`;
  if (el.submitsForm) line += ' submits-form';
  if (el.focused) line += ' focused';
  if (el.editable) line += ' contenteditable';
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
      x.submitsForm !== y.submitsForm ||
      x.focused !== y.focused ||
      x.editable !== y.editable ||
      x.state !== y.state ||
      x.href !== y.href
    ) {
      return false;
    }
  }
  return true;
}
