// CSP-safe Markdown → DOM renderer. Builds nodes ONLY with createElement/createTextNode/textContent
// (never innerHTML), so there is no HTML-injection surface even on untrusted model output. Link hrefs
// are gated to http(s)/mailto. Returns a DocumentFragment to append into the answer container.

function safeHref(url: string): string | null {
  try {
    const u = new URL(url, 'https://x.invalid');
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:'
      ? url
      : null;
  } catch {
    return null;
  }
}

function inline(parent: Node, text: string): void {
  const re =
    /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)\s]+)\))|((?:\*|_)([^*_]+)(?:\*|_))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[1]) {
      const b = document.createElement('strong');
      b.textContent = m[2]!;
      parent.appendChild(b);
    } else if (m[3]) {
      const c = document.createElement('code');
      c.textContent = m[4]!;
      parent.appendChild(c);
    } else if (m[5]) {
      const href = safeHref(m[7]!);
      if (href) {
        const a = document.createElement('a');
        a.textContent = m[6]!;
        a.setAttribute('href', href);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noreferrer noopener');
        parent.appendChild(a);
      } else {
        parent.appendChild(document.createTextNode(m[6]!));
      }
    } else if (m[8]) {
      const it = document.createElement('em');
      it.textContent = m[9]!;
      parent.appendChild(it);
    }
    last = re.lastIndex;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

export function renderMarkdown(src: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = String(src ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^```(\w+)?\s*$/.exec(line);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) buf.push(lines[i++]!);
      i++;
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = buf.join('\n');
      pre.appendChild(code);
      frag.appendChild(pre);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const el = document.createElement('h' + h[1]!.length);
      inline(el, h[2]!.trim());
      frag.appendChild(el);
      i++;
      continue;
    }
    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
      frag.appendChild(document.createElement('hr'));
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const bq = document.createElement('blockquote');
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        const p = document.createElement('p');
        inline(p, lines[i]!.replace(/^>\s?/, ''));
        bq.appendChild(p);
        i++;
      }
      frag.appendChild(bq);
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.test(line);
    const ol = /^\s*\d+\.\s+(.*)$/.test(line);
    if (ul || ol) {
      const list = document.createElement(ul ? 'ul' : 'ol');
      const rowRe = ul ? /^\s*[-*+]\s+(.*)$/ : /^\s*\d+\.\s+(.*)$/;
      while (i < lines.length && rowRe.test(lines[i]!)) {
        const li = document.createElement('li');
        inline(li, rowRe.exec(lines[i]!)![1]!);
        list.appendChild(li);
        i++;
      }
      frag.appendChild(list);
      continue;
    }
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    const buf = [line];
    i++;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]!) &&
      !/^(#{1,4})\s+/.test(lines[i]!) &&
      !/^```/.test(lines[i]!) &&
      !/^>\s?/.test(lines[i]!) &&
      !/^\s*[-*+]\s+/.test(lines[i]!) &&
      !/^\s*\d+\.\s+/.test(lines[i]!)
    ) {
      buf.push(lines[i++]!);
    }
    const p = document.createElement('p');
    inline(p, buf.join(' '));
    frag.appendChild(p);
  }
  return frag;
}
