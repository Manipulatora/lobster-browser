# Lobster Browser — marketing site and dashboard

Angular 22 + Tailwind CSS v4 + ng-icons (Heroicons). Prerendered (SSG) for SEO, hydrated on the
client, zoneless. Deployed to `lobrowser.com` — see [`../../deploy/README.md`](../../deploy/README.md).

This app is intentionally **standalone**: it is not part of the root npm workspaces, so its
dependency tree (Angular CLI, Vite, Tailwind) stays isolated from the desktop/backend packages. It
pins its own TypeScript, which is the concrete reason hoisting it would break something.

```bash
cd apps/web
npm install
npm start          # dev server on http://localhost:4200
npm run build      # production build + prerender → dist/web
```

It is **not just a marketing site.** It carries the account surface: sign-up/sign-in, the desktop
launcher's browser handoff, and the Credit-and-packages dashboard. Those call the real backend at
`api.<hostname>`; see [`../../docs/BILLING_AND_AUTH.md`](../../docs/subsystems/billing-and-auth.md).

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
    api/     API_BASE_URL injection token + the HTTP client
    auth/    auth.store · token.store · auth.guard · desktop-handoff
  shared/                                  reusable, presentation-only
    ui/      logo · shiny-cta
    data/    site-nav.ts — nav links for header, mobile menu and footer
  features/                                one folder per page, lazy-loaded
    landing/  landing-page.ts + sections/ (hero, devices, platforms, faq)
              + xylophone-hero/ and hero-backdrop/ (WebGL) + device-mockup/
    pricing/  pricing-page.ts + .html + .css
    auth/     auth-modal · auth-route-page · auth-layout + pages/
    billing/  billing-page · billing.store · plan-confirm-dialog · credit.ts
```

**Adding a page:** create `features/<name>/<name>-page.ts`, then add one lazy entry to
`app.routes.ts` with a `title` and `data.description` (the SEO service picks up the rest).

**Adding a landing section:** drop a component into `features/landing/sections/` and add it to
`landing-page.ts`. Sections are self-contained, so they can be reordered or removed freely.

## Routes

| Route | Notes |
| --- | --- |
| `/` | Landing |
| `/pricing` | The package table |
| `/signup`, `/login` | **A modal, not a page.** Signing up is nearly always something a visitor does mid-read, and routing them away discards that context. Both are still real URLs because the desktop launcher opens them and people paste them; each resolves to a backdrop with the modal open. |
| `/auth/desktop` | Where the launcher's browser lands when its loopback listener could not be reached. |
| `/account/billing` | Credit balance, deposits, transactions, and buying a package. Behind `authGuard`. |
| `/auth/*` | Legacy `/auth/sign-in` and `/auth/sign-up` redirect rather than 404, because they were public. |

## Buying a package

The pricing CTA carries the chosen plan and term through the auth round trip and lands back on the
confirmation dialog, so a signed-out visitor who clicks "Pro" does not lose that choice.

The dialog states the plan and term, the exact debit, the unused-time credit as its own line, the
balance before and after, and the next billing date. **Every figure is priced by the server** through
`GET /billing/quote`, so the numbers shown are the numbers charged.

Upgrades and monthly→yearly extensions are allowed and credit unused time. **Downgrades and
year→month moves are refused**, not scheduled: the way to spend less is to turn auto-renew off and
buy the smaller package when the period ends, and the refusal says exactly that. Insufficient Credit
is a different next step rather than an error, and offers topping up.

## Pricing figures are real, and duplicated on purpose

| Tier  | Monthly | Yearly (−20%) | Profiles |
| ----- | ------- | ------------- | -------- |
| Free  | $0      | —             | 3        |
| Light | $10     | $96           | 10       |
| Plus  | $60     | $576          | 100      |
| Pro   | $100    | $960          | 200      |
| Max   | $200    | $1,920        | 1,000    |

The authority is `PLAN_CATALOG` in `packages/shared-types/src/account.ts`. `PLANS` in
`features/pricing/pricing-page.ts` **duplicates** it deliberately: this page is prerendered and
statically served, so fetching the catalog would ship an empty price table in the prerendered HTML
and shift the layout on hydration. A wrong number here is therefore a real defect — change both
together.

`YEARLY_DISCOUNT` is duplicated the same way, in `pricing-page.ts` and `billing-page.ts`, because
`GET /billing/overview` sends monthly prices only.

Lobee, the in-browser agent, is sold from **Plus** upward. That is not a marketing choice the page
makes on its own — `AGENT_ENABLED_TIERS` in `shared-types` is the same constant the server refuses
Free and Light with, so the page and the product cannot disagree.

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
`.section-lede` `.btn` (+ `.btn-sm|md|lg`, `.btn-primary|secondary|ghost|outline-rainbow`) `.chip`
`.field-label` `.field-input` `.field-error`, utilities `.bg-aurora` `.bg-grid`
`.text-gradient-brand`.

## Notes

- The API origin is an **injection token** (`API_BASE_URL`), not an `environment.ts` constant: the
  browser and the SSR server in the same build need different values, and a baked-in constant cannot
  express that. Production derives `api.<hostname>` in `app.config.ts`; the development default is
  `http://localhost:8080`.
- The bearer token lives in `localStorage`, which any script on the origin can read. That trade and
  why it was taken are in [`../../docs/BILLING_AND_AUTH.md`](../../docs/subsystems/billing-and-auth.md) §6.
- `/auth/forgot-password` is still a **UI-only shell** — there is no password-reset backend.
- Hero copy and the platform/outcome claims in the FAQ are the owner's call, not engineering's.
