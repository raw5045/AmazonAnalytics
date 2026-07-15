# Favicon + OG Image Bundle — Design Spec

**Date:** 2026-07-14
**Status:** Approved (brainstorming complete; concepts iterated visually with the owner)
**Scope:** Replace the Next.js scaffold favicon with the KeywordQuarry mark, add a
site-wide Open Graph / Twitter card image carrying the two primary selling points, and
fill the empty Clerk application slots (logo, favicon, support email) — the "favicon +
OG" bundle from the pre-launch backlog.

## Decisions (owner-approved)

| Question | Decision |
|---|---|
| Mark | **Owner's Draft 1**: white Q ring with a three-layer quarry-strata stack inside and the Q's tail drawn as a **key** (the "key"word pun), on a navy rounded tile |
| Favicon detail level | **Tiered** (revised 2026-07-14 after trade-off review): full-detail mark everywhere EXCEPT `favicon.ico`'s 16px layer, which uses the simplified cut (ring + key, same silhouette) so standard-DPI tabs stay crisp |
| In-product placement | **BrandMark component in all three spots**: marketing nav + app header (bare artwork on the navy bars, left of the wordmark), marketing footer, and a landing-hero accent — the hero accent is a try-and-judge: owner reviews it visually and may alter or remove it |
| Accent color | **Brand sky-400 `#38bdf8`** for the key (not the brighter draft cyan) — matches the "Quarry" wordmark accent so favicon, tab, and site read as one system. Amber stays reserved for CTAs/dividers |
| OG layout | **OG-2 "Big mark split"**: copy left, mark bleeding off the right edge |
| OG copy | Line 1 (headline): `Find the high-demand, low-competition Amazon keywords your next launch needs.` — with `high-demand, low-competition` in sky-400. Line 2 (subline): `Spot rising demand in days, filter out fake volume, and zero in on the keywords barely anyone is competing over.` Both verbatim — these are the two most important pieces of information per the owner |
| Clerk support email | **support@keywordquarry.com**, implemented via Cloudflare Email Routing forwarding to raw5045@gmail.com |

## Part 1 — Brand asset masters (committed SVGs)

Two hand-authored SVG files are the source of truth, committed at `public/brand/`.
The owner's raster drafts (AI-generated PNGs, shared in chat) are approximated by these
vector recreations, which the owner approved on screen.

### 1.1 `public/brand/mark.svg` — the mark (64×64 viewBox)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#0D1C36"/>
  <circle cx="29" cy="29" r="16" fill="none" stroke="#ffffff" stroke-width="7"/>
  <path d="M29 20 L38 24.5 L29 29 L20 24.5 Z" fill="#ffffff"/>
  <path d="M20 24.5 L29 29 L38 24.5 L38 29 L29 33.5 L20 29 Z" fill="#9aa3b5"/>
  <path d="M20 29.5 L29 34 L38 29.5 L38 34 L29 38.5 L20 34 Z" fill="#5d6879"/>
  <line x1="38.5" y1="38.5" x2="53" y2="53" stroke="#0D1C36" stroke-width="12" stroke-linecap="round"/>
  <circle cx="39.5" cy="39.5" r="6" fill="#38bdf8"/>
  <line x1="39" y1="39" x2="52" y2="52" stroke="#38bdf8" stroke-width="6.5" stroke-linecap="round"/>
  <line x1="47" y1="47" x2="44.2" y2="49.8" stroke="#38bdf8" stroke-width="4"/>
  <line x1="51" y1="51" x2="48.2" y2="53.8" stroke="#38bdf8" stroke-width="4"/>
</svg>
```

Anatomy: navy tile (`#0D1C36`, rx 14 ≈ 22% corner radius); white Q ring; strata stack
(white top diamond, `#9aa3b5` mid band, `#5d6879` low band); the navy 12-wide casing
line separates the ring from the key; key head + shaft + two teeth in sky-400. The
implementer may fine-tune coordinates to better match the owner's draft PNG (e.g.
tooth angles), but colors, structure, and the casing gap are fixed.

### 1.1b `public/brand/mark-simple.svg` — simplified cut (favicon.ico 16px layer ONLY)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#0D1C36"/>
  <circle cx="28" cy="28" r="15" fill="none" stroke="#ffffff" stroke-width="8"/>
  <line x1="38" y1="38" x2="51" y2="51" stroke="#0D1C36" stroke-width="13" stroke-linecap="round"/>
  <line x1="38" y1="38" x2="51" y2="51" stroke="#38bdf8" stroke-width="8" stroke-linecap="round"/>
  <line x1="50" y1="52.5" x2="45.5" y2="57" stroke="#38bdf8" stroke-width="5" stroke-linecap="round"/>
</svg>
```

Same silhouette as the full mark (ring + key tail + one tooth nub), no strata. Used
exclusively for the 16px layer inside `favicon.ico`; every other deliverable uses the
full-detail master.

### 1.2 `public/brand/og-master.svg` — the share card (1200×630)

OG-2 layout, real-pixel geometry (derived from the approved 580px mock × 2.07):

- Canvas: 1200×630, solid `#0B1E3A`.
- Left column, 52px left padding, vertically centered block:
  - Wordmark, y≈150: `Keyword` white + `Quarry` `#38bdf8`, Arial (or metric-compatible
    system sans), weight 800, 30px.
  - Headline, starting y≈220: 46px, weight 800, line-height 1.25, max-width 640px,
    white, with `high-demand, low-competition` in `#38bdf8`:
    `Find the high-demand, low-competition Amazon keywords your next launch needs.`
  - Amber divider: 110×8px, `#fcd34d`, radius 4, ~20px below the headline.
  - Subline: 25px, line-height 1.5, `#cbd5e1`, max-width 630px:
    `Spot rising demand in days, filter out fake volume, and zero in on the keywords
    barely anyone is competing over.`
- Right side: the mark's inner artwork (ring/strata/key, no tile) at ~520px, centered
  vertically, bleeding ~110px off the right edge. Key casing uses the canvas navy
  `#0B1E3A` so the gap reads correctly.
- Safe margins: nothing essential within 40px of any edge (X/LinkedIn crop tolerance).

### 1.3 Generated deliverables (committed binaries)

Produced from the masters by `scripts/generateBrandAssets.ts` (one-off, rerunnable,
deterministic; committed so builds never regenerate):

| File | Content |
|---|---|
| `app/icon.svg` | Copy of `mark.svg` (Next serves it as the scalable favicon) |
| `app/favicon.ico` | 16px raster of `mark-simple.svg` + 32/48 rasters of the full-detail mark (replaces the Next scaffold icon) |
| `app/apple-icon.png` | 180×180 raster of the mark |
| `app/opengraph-image.png` | 1200×630 raster of the OG master |
| `app/opengraph-image.alt.txt` | `KeywordQuarry — find the high-demand, low-competition Amazon keywords your next launch needs.` |
| `app/twitter-image.png` | Same image as opengraph-image.png (enables X's summary_large_image) |
| `public/brand/mark-512.png` | 512×512 raster of the mark — the upload asset for Clerk's Logo + Favicon slots |

Tooling: a devDependency SVG rasterizer chosen at plan time (`@resvg/resvg-js`
preferred — self-contained font loading, no native system-font dependence — with
`png-to-ico` for the .ico; `sharp` acceptable fallback). Text in the OG master must be
rendered with a pinned font so output is identical on every machine: an open-licensed
Arial-metric face (Arimo) supplied by the `@fontsource/arimo` devDependency and locked
via `pnpm-lock.yaml` (no font binaries committed to the repo). Where this spec says
"Arial", it means that pinned face.

## Part 2 — Code wiring

- Next metadata **file conventions** do the work: `app/icon.svg`, `app/favicon.ico`,
  `app/apple-icon.png`, `app/opengraph-image.png` (+ `.alt.txt`), `app/twitter-image.png`
  at the `app/` root are auto-injected site-wide. No per-page metadata changes; the
  existing `openGraph` text metadata in `app/(marketing)/page.tsx` and the root
  `metadataBase` stay as-is.
- `app/layout.tsx`: add a `viewport` export with `themeColor: '#0B1E3A'` (navy mobile
  browser chrome).

### 2.5 BrandMark component + in-product placements

One server-safe React component rendering the mark as inline SVG (no image request,
crisp at any size): `BrandMark({ size?: number, tile?: boolean })` — `tile: false`
(default) renders the bare ring/strata/key artwork for navy surfaces; `tile: true`
adds the rounded navy tile for light surfaces. Location follows repo convention for
cross-route-group shared components (both `(marketing)` and `(app)` import it; the
plan confirms the exact path, e.g. an app-root `app/BrandMark.tsx`).

Placements (all four approved):
1. **Marketing nav** (`app/(marketing)/layout.tsx` header): bare mark ~26px, left of
   the existing wordmark, vertically centered.
2. **Marketing footer** (same file, footer block): bare mark ~22px beside the footer
   wordmark.
3. **App header** (`app/(app)/layout.tsx`): bare mark ~24px, left of the wordmark in
   the navy bar.
4. **Landing hero accent** (`app/(marketing)/page.tsx`): a tiled mark (~72px) placed
   near the hero headline. **Try-and-judge:** the owner reviews this one visually
   after implementation and may resize, restyle, or remove it — the spec authorizes
   removal without a spec change.

Admin pages and emails stay untouched.

## Part 3 — Ops (dashboard) steps

1. **Cloudflare Email Routing** (dashboard, keywordquarry.com zone): enable Email
   Routing (Cloudflare auto-adds its MX + SPF records — the zone has no MX today, so
   no conflicts; records stay DNS-only by nature), create address
   `support@keywordquarry.com` → forward to `raw5045@gmail.com`, and complete the
   destination-address verification email that Cloudflare sends to the Gmail.
2. **Clerk application settings** (dashboard → the KeywordQuarry application):
   upload the mark as **Logo** and **Favicon** (PNG exports of `mark.svg`; a 512×512
   PNG deliverable from the script covers both), and set **Support email** to
   `support@keywordquarry.com` (after step 1 so the address actually works).
   These are native Clerk pages (not the Svix iframe), expected drivable via the
   owner's Chrome; owner clicks are the fallback.

## Part 4 — Verification

- Local: `pnpm dev` → tab shows the mark (hard-refresh; favicons cache aggressively);
  view-source shows the icon/OG link tags.
- Tests/build: `pnpm typecheck`, `pnpm test`, `pnpm build` all green (assets are
  static; only `app/layout.tsx` changes code-wise).
- Deployed (after owner-authorized push): favicon on keywordquarry.com; OG card
  validated with a link-preview tool AND a real paste into Slack or X; the image URLs
  from view-source (`/opengraph-image.png`, `/twitter-image.png`) load directly.
- Clerk sign-in card shows logo + favicon + "Contact support@keywordquarry.com".
- Email: send a test mail to support@keywordquarry.com, confirm it lands in Gmail.
- Visual pass on all four BrandMark placements (localhost, then prod): nav, footer,
  app header, hero accent — with the owner's keep/alter/remove verdict on the hero.

## Non-goals

- No dark-mode-specific favicon variant, no PWA manifest/maskable icons.
- No dynamic per-page OG images (one site-wide card).
- No mailbox for support@ (forwarding only).
