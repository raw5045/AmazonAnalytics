# KeywordQuarry Marketing & Support Site — Design Spec

**Date:** 2026-07-01 · **Workstream:** A (pre-launch, most launch-gating) · **Approach:** routes inside the existing Next app (`app/(marketing)/`), not a separate site.

## Goal

Stand up KeywordQuarry's public marketing / support / legal surface so early-external users can discover it, understand the value, sign up, get help, and reach the required legal pages. The current `app/(marketing)/` group is a single bare splash; this replaces it with a real 7-page surface. **Launch-gating:** Terms + Privacy are required before real users; the landing + support pages drive signup and trust.

## Product framing

- **Name:** KeywordQuarry (standardize everywhere — the app title "Amazon SFR Analytics" becomes KeywordQuarry).
- **Audience:** Amazon sellers, brands, and agencies — from their first product to a mature catalog.
- **Value prop:** Find the high-demand, low-competition Amazon keywords a product launch needs.
- **Differentiators (the wedge):**
  1. Competition lens = averages reviews of the **top 3 _clicked_ products** for a keyword, not the whole results page.
  2. **Weekly-fresh** data → catch demand spikes in days, not months.
  3. **Fake/bot demand** detection + filtering.
  4. **Exact leaf-category** mapping + custom buckets.
  5. Founder credibility: built by an Amazon operator (**$75M+ in Amazon sales**).
- **Access model:** **Open signup** (existing Clerk flow). Abuse is handled by _monitoring_ (a daily admin digest — a separate feature, see Follow-ups), not by gating.

## Page inventory (v1 = 7 pages)

| Route | Page | Purpose | Auth |
|-------|------|---------|------|
| `/` | Home (landing) | Convert visitors → signup | Public; signed-in → redirect `/app` |
| `/help` | Help / FAQ | How the tools work + "what's SFR"; onboarding | Public |
| `/contact` | Contact / Support | Support email + contact form → Resend to admin | Public |
| `/about` | About | Founder story, mission, not-affiliated-with-Amazon | Public |
| `/pricing` | Pricing (beta stub) | "Free during beta"; seam for paid tiers (Workstream C) | Public |
| `/terms` | Terms of Service | Legal (scaffold + review caveat) | Public |
| `/privacy` | Privacy Policy | Legal (scaffold + review caveat) | Public |

## Routing & auth

- All 7 live in the `app/(marketing)/` route group and are **publicly accessible** (no Clerk gate) — critical for SEO and for signed-out visitors.
- **Only `/` redirects signed-in users → `/app`** (current behavior; keep). The other 6 pages must render for everyone, signed-in or out — do **not** put the redirect in the shared marketing layout, keep it in `/` (`page.tsx`) alone.
- Confirm `middleware.ts` treats `/help`, `/contact`, `/about`, `/pricing`, `/terms`, `/privacy` as public routes (like `/`, `/sign-in`, `/sign-up`).

## Landing page (`/`) — LOCKED design

Section order (top → bottom), with final copy:

1. **Hero** (centered)
   - Badge: `Free during beta`
   - H1: *Find the high-demand, low-competition Amazon keywords your next launch needs.*
   - Sub: *Spot rising demand in days, filter out fake volume, and zero in on the keywords barely anyone is competing over.*
   - Primary CTA: **Get started free** → sign-up. Secondary: **See how it works** → `/help` (later: video walkthroughs).
   - Trust line: *No credit card. Set up in 2 minutes.*

2. **"Built differently, on purpose"** — 2-column comparison (Other keyword tools ✕ vs KeywordQuarry ✓), 4 rows each:
   - Other: averages reviews across every product on the page (incl. irrelevant ones), distorting competition · data updates monthly, no easy way to spot trends · fake/bot demand slips through · stops at broad categories like "Health & Personal Care".
   - KeywordQuarry: averages reviews from the top 3 clicked products, so you know exactly how competitive a keyword is · fresh data every week, filters built to catch spikes in days · flags fake, bot-driven demand · maps keywords to exact leaf categories + custom buckets.

3. **Founder strip** (own element, not a comparison row)
   - *Built by an Amazon operator who scaled a brand to **$75M+ in Amazon sales** — with keyword research as the growth engine. Not theory from a software team: the exact methods, in a tool.*
   - Optional longevity add: "a brand he's grown for 12+ years to $75M+…". **Verify the figure is publicly defensible before ship.**

4. **"And it doesn't stop at finding them"** — 4 benefit boxes (new value beyond the comparison):
   - **Advanced filtering system to sort keywords** — Set a minimum demand, then sort by review count — non-competitive keywords with real search volume rise straight to the top.
   - **Spot easy ranking wins** — Surface keywords none of the top 3 products even use in their title — open lanes you can rank for fast.
   - **Perfect for new or experienced sellers** — Target keywords that can move 10 units a day or several hundred — dial the demand to fit your first product or your fiftieth.
   - **Track it, get alerted** — Star keywords to a watchlist and get a weekly email digest the moment they move.

5. **Closing CTA** — *Your first product or your hundredth — start here.* + Get started free.

6. **Footer** (shared) — KeywordQuarry · How it works · Pricing · Contact · Terms · Privacy.

**Real-build enhancements beyond the flat mockup:** brand accent color on hero + CTAs; larger hero type; **a real screenshot of the Explorer** slotted under the comparison (showing the avg-reviews, not-in-title, and leaf-category columns — the single most persuasive proof of the wedge; capture live at build); `See how it works` swaps to video once recorded.

## Other pages — content outlines

- **Help / FAQ** (`/help`): short intros to Explorer, Watchlist, Category Builder; "What is SFR (Search Frequency Rank)?"; how the competition lens works; how estimated volume works; common questions (data freshness, fake-volume flags, custom categories). Structure: sectioned page or accordion. Doubles as onboarding + the `See how it works` destination.
- **Contact / Support** (`/contact`): a support email (link) + a simple contact form (name, email, message) → `POST /api/contact` → Resend email to the admin address. Honeypot spam guard; success/error states; no login required.
- **About** (`/about`): the founder story expanded (the $75M+ operator narrative), why the tool exists, and a clear **"not affiliated with, endorsed by, or sponsored by Amazon"** disclaimer (Amazon is the data source).
- **Pricing** (`/pricing`): a single **"Free during beta"** card with the beta value; copy that makes the future paid transition a content change, not new plumbing (aligns with Workstream C's `plan`/entitlement seam). No billing yet.
- **Terms of Service** (`/terms`): standard SaaS scaffold — acceptance, description of service, account/eligibility, acceptable use, IP, data/"as-is" disclaimers, limitation of liability, termination, changes, contact — **plus the not-affiliated-with-Amazon clause**. **LEGAL CAVEAT below.**
- **Privacy Policy** (`/privacy`): what's collected and via whom — Clerk (auth/email/name), Neon (app data), Keepa (product data source), Resend (email delivery), cookies/analytics if any — how it's used, retention, user rights, contact. **LEGAL CAVEAT below.**

> **Legal caveat (ToS + Privacy):** we scaffold the pages and provide standard, reasonable placeholder content, but this is **not legal advice**. Before real users, the wording must be finalized via a reputable generator (Termly / iubenda / Termsfeed) or a lawyer, and must reflect the real company entity, jurisdiction, and data practices. The build ships the _pages and structure_; the authoritative wording is the owner's to finalize.

## Shared layout, nav, footer

- `app/(marketing)/layout.tsx`: marketing chrome wrapping all 7 pages.
  - **Nav:** KeywordQuarry wordmark (→ `/`) + links (How it works/Help, Pricing, About, Contact) + **auth-aware CTA** — signed-out: "Sign in" + "Get started free"; signed-in: "Go to app" (read Clerk auth server-side).
  - **Footer:** product blurb + columns (Product, Company, Legal) linking the pages + copyright + the Amazon disclaimer line.
- Mobile: nav collapses to a menu; keep it simple (the responsive caveat from dogfooding — verify on a real device / DevTools device-mode, since our browser tooling can't reflow).

## Visual / brand direction (launch-level)

- Clean and consistent with the app (blue accent, existing Tailwind). Wordmark "KeywordQuarry" as the logo for now (no custom mark required to launch).
- A fuller brand/design system (palette, type scale, a real logo, the "quarry/mining" theme) is **Workstream D** — out of scope here; we just need a coherent, professional marketing surface.

## SEO / meta

- Per-page `metadata` (title + description) — marketing pages need real SEO. Open Graph + Twitter card on `/` (title, description, an OG image — can be a simple branded card initially).
- `app/sitemap.ts` + `app/robots.ts` listing the public marketing routes.

## Architecture notes

- Server components throughout (fast, SEO-friendly); Tailwind for styling; auth-aware nav via Clerk's server `auth()`.
- **Contact form:** small client component (form + states) → `app/api/contact/route.ts` (validate, honeypot, rate-limit-lite) → Resend send to the admin address (reuse existing Resend setup). No new DB table needed (email-only); optionally persist later.
- No schema changes. No new env beyond a `CONTACT_TO`/support-email value (+ the existing Resend key).

## Testing / verification

- `pnpm typecheck` + `pnpm lint` + build.
- View live via browser; verify: signed-out vs signed-in nav states; `/` redirect for signed-in users while `/help` etc. stay accessible; contact form → Resend delivery; all footer/nav links resolve.
- Responsive: verify on a real device or DevTools device-mode (our Chrome tooling didn't reflow — see the dogfooding finding).

## Deferred / follow-ups (NOT in this build)

- **Custom domain** — buy + add in Vercel + DNS records; then swap the `amazon-analytics-beta.vercel.app` fallbacks to the real domain and fill company name/contact. ~20-min config, last step.
- **ToS/Privacy legal review** (generator or lawyer) before real users.
- **Real Explorer screenshot** on the landing — capture live during build.
- **"See how it works" → video walkthroughs** — once the UI is more final and videos are recorded.
- **Verify the $75M+ founder figure** is publicly defensible.
- **Daily admin abuse-digest** — a *separate feature* (scheduled admin email: total/new users, runaway usage flags, reusing Resend + Inngest). Its own brainstorm → spec → build; the safety net for open signup.
- **Full brand/design system** — Workstream D.

## Inputs needed from the owner (for the build)

1. Support / contact email address (for `/contact` + `/about`).
2. Company legal name + mailing address + jurisdiction (for ToS / Privacy / CAN-SPAM).
3. Brand primary color / any logo preference (else we match the app's blue).
4. Confirmation of the $75M+ figure wording (and whether to include "12+ years").
