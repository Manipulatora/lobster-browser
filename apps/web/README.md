# Lobster Browser — marketing site

Angular 22 + Tailwind CSS v4 + ng-icons (Heroicons). Prerendered (SSG) for SEO, hydrated on the
client, zoneless.

This app is intentionally **standalone**: it is not part of the root npm workspaces, so its
dependency tree (Angular CLI, Vite, Tailwind) stays isolated from the desktop/backend packages.

```bash
cd apps/web
npm install
npm start          # dev server on http://localhost:4200
npm run build      # production build + prerender → dist/web
```

## Stack

| Concern      | Choice                                                           |
| ------------ | ---------------------------------------------------------------- |
| Framework    | Angular 22, standalone components, **zoneless** change detection  |
| Rendering    | SSR + **prerendering** (`RenderMode.Prerender`) for static SEO    |
| Styling      | Tailwind v4, **CSS-first** config (`@theme` in `src/styles.css`)  |
| Icons        | `@ng-icons/core` + Heroicons **outline**, stroke thinned to 1     |
| Forms        | Typed reactive forms (`nonNullable.group`)                        |
| State        | Signals (`signal`, `computed`, `input`, `output`)                 |
| Control flow | Built-in `@if` / `@for` / `@switch` (no `*ngIf` / `*ngFor`)       |

## Layout

```
src/app/
  app.ts / app.config.ts / app.routes.ts   root shell, providers, top-level routes
  core/                                    app-wide singletons — used once
    layout/  site-shell · site-header · site-footer
    seo/     SeoService — syncs <meta> + canonical from route data
  shared/                                  reusable, presentation-only
    ui/      logo (add future primitives here)
    data/    site-nav.ts — nav links for header, mobile menu and footer
  features/                                one folder per page, lazy-loaded
    landing/  landing-page.ts + sections/   six independent sections
    pricing/  pricing-page.ts + pricing.data.ts + components/
    auth/     auth.routes.ts + auth-layout + pages/ + components/
```

**Adding a page:** create `features/<name>/<name>-page.ts`, then add one lazy entry to
`app.routes.ts` with a `title` and `data.description` (the SEO service picks up the rest).

**Adding a landing section:** drop a component into `features/landing/sections/` and add it to
`landing-page.ts`. Sections are self-contained, so they can be reordered or removed freely.

## Design system

All design decisions live in `src/styles.css` — tokens in `@theme`, shared classes in
`@layer components`. Author against the component classes rather than ad-hoc utilities; that is what
keeps the site consistent as it grows.

- **Light theme only.** No dark-mode variants anywhere.
- **Violet brand ramp** `brand-50…950`; text `ink` / `ink-soft` / `muted` / `faint`.
- **Hairline rules:** every border is `0.5px` (`.card`, `.rule`, `border-[0.5px]`). The global border
  colour is pinned to `--color-hairline` because Tailwind v4 defaults borders to `currentColor`.
- **Ultra-thin icons:** Heroicons ship `stroke-width="1.5"`; a global rule in `styles.css` overrides
  the SVG attribute to `1`.

Vocabulary: `.container-page` `.section` `.card` `.card-soft` `.rule` `.eyebrow` `.section-title`
`.section-lede` `.btn` (+ `.btn-sm|md|lg`, `.btn-primary|secondary|ghost`) `.chip` `.field-label`
`.field-input` `.field-error`, utilities `.bg-aurora` `.bg-grid` `.text-gradient-brand`.

## Notes

- Auth forms are **UI only** — submit handlers simulate latency and mark where the real API call
  goes. No backend is wired.
- Pricing figures are illustrative; the real product meters on **profile count** (`free`, `pro`,
  `team`, `enterprise`), with 3 profiles on the free tier.
