#!/usr/bin/env node
/**
 * Every class the desktop UI renders must still be defined in a stylesheet.
 *
 * WHY THIS EXISTS. A cleanup pass deleted CSS rules whose class no longer appeared in any markup.
 * That is a sound idea implemented against the wrong unit: it matched a dead class against a
 * selector LIST and dropped the whole rule. One of those lists was
 *
 *     .topbar__actions, .account-switcher, .nav-item, .btn, .icon-button, .profile-button,
 *     .search-field, .status, .proxy-cell, .profile-title-cell, .table-toolbar, .toolbar-total,
 *     .toolbar-actions, .modal-footer-actions, .check-row { display: inline-flex; align-items: center; }
 *
 * — fifteen selectors, one of them dead. Removing the rule stripped the layout off every button,
 * toolbar, search field and status pill in the product at once. Nothing caught it: TypeScript does
 * not read CSS, the bundler does not care, and the build was green. The only signal was opening the
 * app and seeing it broken.
 *
 * So this asserts the contract in the direction that matters: markup references a class, therefore
 * a stylesheet must define it. It is deliberately not the reverse — unused CSS is untidy, this is
 * about the app rendering at all.
 *
 * Run: `npm run gate:desktop-css`
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, '../../apps/desktop/src');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(APP);

// --- Classes DEFINED across every stylesheet ---------------------------------
const defined = new Set();
for (const file of files.filter((f) => extname(f) === '.css')) {
  const css = readFileSync(file, 'utf8');
  // Strip comments so a class named inside prose is not mistaken for a definition.
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
    defined.add(m[1]);
  }
}

// --- Classes USED in markup ---------------------------------------------------
// Only literal strings. A template literal or a conditional is resolved at runtime, and guessing at
// its branches would produce false failures on classes that are perfectly fine.
const used = new Map(); // class -> first "file:line"
for (const file of files.filter((f) => ['.tsx', '.ts'].includes(extname(f)))) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/className=(?:"([^"]*)"|\{'([^']*)'\}|\{`([^`${}]*)`\})/g)) {
      const value = m[1] ?? m[2] ?? m[3] ?? '';
      for (const cls of value.split(/\s+/).filter(Boolean)) {
        if (!used.has(cls)) used.set(cls, `${relative(APP, file).replace(/\\/g, '/')}:${i + 1}`);
      }
    }
    // `className={cond ? 'a b' : 'c d'}` and similar: pull every quoted run on a className line.
    //
    // Interpolations are blanked out first. `os-icon--apple-${x === 'i' ? 'intel' : 'arm'}` composes
    // ONE class at runtime; the quoted fragments inside it are values, not class names, and reading
    // them as classes reported `.i`, `.intel` and `.arm` as missing definitions. A check that cries
    // wolf three times is a check nobody reads.
    if (/className=\{/.test(line)) {
      const withoutInterpolations = line.replace(/\$\{[^}]*\}/g, '');
      for (const m of withoutInterpolations.matchAll(/'([a-z][\w -]*)'/g)) {
        for (const cls of m[1].split(/\s+/).filter(Boolean)) {
          if (/^[a-z][\w-]*$/.test(cls) && !used.has(cls)) {
            used.set(cls, `${relative(APP, file).replace(/\\/g, '/')}:${i + 1}`);
          }
        }
      }
    }
  });
}

// --- Report --------------------------------------------------------------------
const missing = [...used.entries()]
  .filter(([cls]) => !defined.has(cls))
  // Tailwind-ish and state classes are applied by libraries or exist only as modifiers on a base
  // class that IS defined; neither is a missing definition.
  .filter(([cls]) => !/^(is-|has-|js-)/.test(cls));

console.log(`classes defined in CSS: ${defined.size}`);
console.log(`classes used in markup: ${used.size}`);

if (missing.length === 0) {
  console.log('\nOK - every class rendered by the app has a definition.');
  process.exit(0);
}

console.log(`\n${missing.length} class(es) used in markup with NO CSS definition:\n`);
for (const [cls, where] of missing.sort()) console.log(`  .${cls.padEnd(34)} ${where}`);
console.log('\nEither the rule was deleted by mistake, or the markup should stop using the class.');
process.exit(1);
