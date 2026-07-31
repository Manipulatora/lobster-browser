// Renderer tests. The old renderer shipped with none, which is how a Markdown renderer that could not
// draw a table survived in a product whose whole job is presenting model output.
//
// Runs against a tiny DOM shim rather than jsdom: the renderer only ever touches createElement /
// createTextNode / appendChild / setAttribute / textContent, so a shim keeps this dependency-free and
// simultaneously PROVES the CSP-safety claim — there is no innerHTML on the shim to reach for.
import assert from 'node:assert/strict';
import { test } from 'node:test';

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
    find(renderMarkdown('![alt](https://e.com/a.png)'), 'img').getAttribute('alt'),
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
