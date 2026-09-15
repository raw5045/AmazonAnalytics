# In-App Feedback Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Feedback" button in the signed-in app header that opens a one-box modal and emails the message to support@ with the member's account email as reply-to and the page they were on attached.

**Architecture:** Four small server pieces mirror the existing contact-form pipeline without touching it — a validator (`lib/feedback/validate.ts`), a pure email builder (`lib/notifications/buildFeedbackEmail.ts`), a Resend sender (`lib/notifications/sendFeedbackEmail.ts`), and an authenticated route (`app/api/feedback/route.ts`). One client component (`app/(app)/_components/FeedbackButton.tsx`) renders the header button and a portal-mounted dialog and is wired into `app/(app)/layout.tsx`. No schema, worker, or marketing-site changes. Spec: `docs/superpowers/specs/2026-09-15-feedback-button-design.md`.

**Tech Stack:** Next.js 16 App Router (route handler + client component), React 19 `createPortal`, Resend, Vitest + Testing Library (jsdom), Tailwind classes matching the app header.

**Conventions (owner):** commits on `main`, local only — NEVER push without per-turn authorization; `git add` named files only; commit trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; run `pnpm typecheck` and `pnpm test` before each commit claim.

---

### Task 1: Validator (`lib/feedback/validate.ts`)

**Files:**
- Create: `lib/feedback/validate.ts`
- Test: `lib/feedback/validate.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// lib/feedback/validate.test.ts
import { describe, it, expect } from 'vitest';
import { validateFeedback, normalizePage } from './validate';

describe('validateFeedback', () => {
  const good = { message: 'The word-count filter feels slow on big categories.', page: '/explorer?words_min=3' };

  it('accepts a normal submission (message trimmed, page kept)', () => {
    expect(validateFeedback({ ...good, message: `  ${good.message}  ` })).toEqual({ ok: true, input: good });
  });
  it('rejects non-object payloads', () => {
    expect(validateFeedback(null).ok).toBe(false);
    expect(validateFeedback('hi').ok).toBe(false);
  });
  it('rejects a missing or short message', () => {
    expect(validateFeedback({ page: '/x' }).ok).toBe(false);
    expect(validateFeedback({ message: 'too short' }).ok).toBe(false);
  });
  it('rejects a message over 5,000 characters', () => {
    expect(validateFeedback({ message: 'x'.repeat(5001) }).ok).toBe(false);
  });
  it('accepts exactly 10 and exactly 5,000 characters', () => {
    expect(validateFeedback({ message: 'x'.repeat(10) }).ok).toBe(true);
    expect(validateFeedback({ message: 'x'.repeat(5000) }).ok).toBe(true);
  });
  it('nulls (does not reject) a missing or unusable page', () => {
    expect(validateFeedback({ message: good.message })).toEqual({ ok: true, input: { message: good.message, page: null } });
    expect(validateFeedback({ message: good.message, page: 'https://evil.example' })).toEqual({
      ok: true,
      input: { message: good.message, page: null },
    });
  });
});

describe('normalizePage', () => {
  it('keeps an in-app relative path with a query string', () => {
    expect(normalizePage('/explorer?rank_max=100&severity=none')).toBe('/explorer?rank_max=100&severity=none');
  });
  it('trims surrounding whitespace', () => {
    expect(normalizePage('  /watchlist ')).toBe('/watchlist');
  });
  it('rejects absolute and protocol-relative URLs', () => {
    expect(normalizePage('https://evil.example/x')).toBeNull();
    expect(normalizePage('//evil.example/x')).toBeNull();
  });
  it('rejects paths with embedded whitespace or control characters', () => {
    expect(normalizePage('/explorer?q=a b')).toBeNull();
    expect(normalizePage('/explorer\n?x=1')).toBeNull();
  });
  it('rejects non-strings, empty strings, and paths over 2,000 characters', () => {
    expect(normalizePage(undefined)).toBeNull();
    expect(normalizePage(42)).toBeNull();
    expect(normalizePage('')).toBeNull();
    expect(normalizePage('/' + 'x'.repeat(2000))).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run lib/feedback/validate.test.ts`
Expected: FAIL — cannot resolve `./validate`.

- [ ] **Step 3: Implement**

```ts
// lib/feedback/validate.ts
/**
 * Validation for POST /api/feedback (the signed-in feedback modal).
 * Message bounds mirror lib/contact/validate.ts. The page is a nicety:
 * anything that isn't a plain in-app relative path becomes null rather than
 * an error, so a bad page value never costs the user their message.
 */
export interface FeedbackInput {
  message: string;
  page: string | null;
}

export const MESSAGE_MIN = 10;
export const MESSAGE_MAX = 5000;
const PAGE_MAX = 2000;

export function validateFeedback(
  raw: unknown,
): { ok: true; input: FeedbackInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid payload' };
  const r = raw as Record<string, unknown>;
  const message = typeof r.message === 'string' ? r.message.trim() : '';
  if (message.length < MESSAGE_MIN || message.length > MESSAGE_MAX) {
    return { ok: false, error: 'message must be 10–5,000 characters' };
  }
  return { ok: true, input: { message, page: normalizePage(r.page) } };
}

/**
 * Accept only an in-app relative path ("/explorer?rank_max=100"): exactly one
 * leading "/", no whitespace or control characters, and short. Rejects
 * absolute URLs and protocol-relative "//host" forms — the email renders this
 * after the app's own base URL, so it must never point anywhere else.
 */
export function normalizePage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const p = raw.trim();
  if (p.length === 0 || p.length > PAGE_MAX) return null;
  if (!p.startsWith('/') || p.startsWith('//')) return null;
  if (/[\s\p{Cc}\p{Cf}]/u.test(p)) return null;
  return p;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run lib/feedback/validate.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/feedback/validate.ts lib/feedback/validate.test.ts
git commit -m "feat(feedback): request validator (message bounds, safe page path)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Email builder (`lib/notifications/buildFeedbackEmail.ts`)

**Files:**
- Create: `lib/notifications/buildFeedbackEmail.ts`
- Test: `lib/notifications/buildFeedbackEmail.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// lib/notifications/buildFeedbackEmail.test.ts
import { describe, it, expect } from 'vitest';
import { buildFeedbackEmail } from './buildFeedbackEmail';

const base = {
  message: 'Love the title-gap filter. Could the watchlist sort by delta?',
  page: '/explorer?title_match=any',
  user: { id: '11111111-2222-3333-4444-555555555555', email: 'jane@example.com', name: 'Jane Doe' },
  appUrl: 'https://keywordquarry.com',
};

describe('buildFeedbackEmail', () => {
  it('uses the name in the subject and the From line', () => {
    const e = buildFeedbackEmail(base);
    expect(e.subject).toBe('💬 Feedback from Jane Doe');
    expect(e.text).toContain('From: Jane Doe <jane@example.com>');
    expect(e.html).toContain('Jane Doe &lt;jane@example.com&gt;');
  });
  it('falls back to the email when the name is null', () => {
    const e = buildFeedbackEmail({ ...base, user: { ...base.user, name: null } });
    expect(e.subject).toBe('💬 Feedback from jane@example.com');
    expect(e.text).toContain('From: jane@example.com');
  });
  it('collapses control characters in the name (subject spoofing guard)', () => {
    const e = buildFeedbackEmail({ ...base, user: { ...base.user, name: 'Jane\r\nDoe' } });
    expect(e.subject).toBe('💬 Feedback from Jane Doe');
  });
  it('renders the absolute page link in text and as an anchor in html', () => {
    const e = buildFeedbackEmail(base);
    expect(e.text).toContain('Page: https://keywordquarry.com/explorer?title_match=any');
    expect(e.html).toContain('<a href="https://keywordquarry.com/explorer?title_match=any"');
  });
  it('says the page was not captured when null', () => {
    const e = buildFeedbackEmail({ ...base, page: null });
    expect(e.text).toContain('Page: (not captured)');
    expect(e.html).toContain('(not captured)');
    expect(e.html).not.toContain('<a href');
  });
  it('includes the account id and HTML-escapes the message', () => {
    const e = buildFeedbackEmail({ ...base, message: '<script>alert(1)</script> & "quotes"' });
    expect(e.text).toContain(`Account: ${base.user.id}`);
    expect(e.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;');
    expect(e.html).not.toContain('<script>');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run lib/notifications/buildFeedbackEmail.test.ts`
Expected: FAIL — cannot resolve `./buildFeedbackEmail`.

- [ ] **Step 3: Implement**

```ts
// lib/notifications/buildFeedbackEmail.ts
/**
 * Pure builder for the in-app feedback email delivered to the support inbox.
 * Mirrors buildWelcomeEmail.ts: no network, returns { subject, text, html }
 * so it can be unit tested. The sender sets reply-to = the account email so
 * the owner answers straight from Gmail (as support@).
 */
export interface FeedbackEmailInput {
  message: string;
  page: string | null;                                     // validated relative path or null
  user: { id: string; email: string; name: string | null };
  appUrl: string;                                          // e.g. https://keywordquarry.com
}

interface BuiltEmail {
  subject: string;
  text: string;
  html: string;
}

export function buildFeedbackEmail(i: FeedbackEmailInput): BuiltEmail {
  // The name lands in the subject line — collapse control characters so an
  // embedded newline can't spoof inbox previews (same guard as the contact
  // validator).
  const name = i.user.name?.replace(/[\r\n\t]+/g, ' ').trim() || null;
  const from = name ? `${name} <${i.user.email}>` : i.user.email;
  const pageUrl = i.page ? `${i.appUrl}${i.page}` : null;
  const subject = `💬 Feedback from ${name ?? i.user.email}`;

  const text = [
    `From: ${from}`,
    `Account: ${i.user.id}`,
    `Page: ${pageUrl ?? '(not captured)'}`,
    '',
    i.message,
    '',
    '—',
    'Reply to this email to answer them directly.',
  ].join('\n');

  const pageHtml = pageUrl
    ? `<a href="${escapeHtml(pageUrl)}" style="color:#2563eb;">${escapeHtml(pageUrl)}</a>`
    : '(not captured)';

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:0 auto;padding:24px;">
  <p style="margin:0 0 4px 0;color:#333;font-size:14px;"><strong>From:</strong> ${escapeHtml(from)}</p>
  <p style="margin:0 0 4px 0;color:#333;font-size:14px;"><strong>Account:</strong> ${escapeHtml(i.user.id)}</p>
  <p style="margin:0 0 16px 0;color:#333;font-size:14px;"><strong>Page:</strong> ${pageHtml}</p>
  <p style="margin:0;color:#111;font-size:14px;white-space:pre-wrap;">${escapeHtml(i.message)}</p>
  <hr style="margin:28px 0 12px 0;border:none;border-top:1px solid #e5e7eb;">
  <p style="margin:0;color:#9ca3af;font-size:12px;">Reply to this email to answer them directly.</p>
</div>`.trim();

  return { subject, text, html };
}

// Matches buildWelcomeEmail.ts's escapeHtml (incl. quotes) — values are
// interpolated into an href attribute above, so quotes must be escaped.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run lib/notifications/buildFeedbackEmail.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/notifications/buildFeedbackEmail.ts lib/notifications/buildFeedbackEmail.test.ts
git commit -m "feat(feedback): pure email builder (name/email, account id, page link, escaped message)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Sender (`lib/notifications/sendFeedbackEmail.ts`)

**Files:**
- Create: `lib/notifications/sendFeedbackEmail.ts`
- Test: `lib/notifications/sendFeedbackEmail.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// lib/notifications/sendFeedbackEmail.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mockSend };
    constructor(public apiKey: string) {}
  },
}));

import { sendFeedbackEmail } from './sendFeedbackEmail';

const input = {
  message: 'The watchlist digest arrived twice this week.',
  page: '/watchlist',
  user: { id: 'uuid-1', email: 'jane@example.com', name: 'Jane Doe' },
  appUrl: 'https://keywordquarry.com',
};

describe('sendFeedbackEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('RESEND_API_KEY', 're_test');
    vi.stubEnv('RESEND_FROM', 'KeywordQuarry <notifications@keywordquarry.com>');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('returns not-configured without calling Resend when the API key is missing', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    const r = await sendFeedbackEmail(input);
    expect(r).toEqual({ sent: false, reason: 'email not configured' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('delivers to the support inbox with reply-to = the account email', async () => {
    mockSend.mockResolvedValueOnce({ data: { id: 'email_1' }, error: null });
    const r = await sendFeedbackEmail(input);
    expect(r).toEqual({ sent: true });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const arg = mockSend.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.to).toEqual(['support@keywordquarry.com']);
    expect(arg.replyTo).toBe('jane@example.com');
    expect(arg.from).toBe('KeywordQuarry <notifications@keywordquarry.com>');
    expect(arg.subject).toBe('💬 Feedback from Jane Doe');
    expect(String(arg.text)).toContain('Page: https://keywordquarry.com/watchlist');
  });

  it('reports send failed when Resend returns an error', async () => {
    mockSend.mockResolvedValueOnce({ data: null, error: { message: 'nope' } });
    expect(await sendFeedbackEmail(input)).toEqual({ sent: false, reason: 'send failed' });
  });

  it('reports send failed when Resend throws', async () => {
    mockSend.mockRejectedValueOnce(new Error('network'));
    expect(await sendFeedbackEmail(input)).toEqual({ sent: false, reason: 'send failed' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run lib/notifications/sendFeedbackEmail.test.ts`
Expected: FAIL — cannot resolve `./sendFeedbackEmail`.

- [ ] **Step 3: Implement**

```ts
// lib/notifications/sendFeedbackEmail.ts
/**
 * Email an in-app feedback submission to the support inbox via Resend.
 * Sibling of sendContactEmail.ts, deliberately not shared: the contact path
 * stays untouched (see docs/superpowers/specs/2026-09-15-feedback-button-
 * design.md). Fail-soft logging, but RETURNS success/failure so the API
 * route can tell the user whether their message actually went through.
 *
 * Delivers to support@keywordquarry.com with reply-to = the member's
 * account email, so a Gmail reply goes straight back to them as support@.
 */
import { Resend } from 'resend';
import { buildFeedbackEmail, type FeedbackEmailInput } from './buildFeedbackEmail';

const SUPPORT_INBOX = 'support@keywordquarry.com';

export async function sendFeedbackEmail(
  input: FeedbackEmailInput,
): Promise<{ sent: boolean; reason?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM ?? 'KeywordQuarry <notifications@keywordquarry.com>';
  if (!apiKey) {
    console.warn('[sendFeedbackEmail] RESEND_API_KEY not set — cannot deliver feedback.');
    return { sent: false, reason: 'email not configured' };
  }

  const { subject, text, html } = buildFeedbackEmail(input);

  try {
    const resend = new Resend(apiKey);
    const result = await resend.emails.send({
      from,
      to: [SUPPORT_INBOX],
      replyTo: input.user.email,
      subject,
      text,
      html,
    });
    if (result.error) {
      console.error('[sendFeedbackEmail] Resend error:', result.error);
      return { sent: false, reason: 'send failed' };
    }
    return { sent: true };
  } catch (e) {
    console.error('[sendFeedbackEmail] send threw:', e);
    return { sent: false, reason: 'send failed' };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run lib/notifications/sendFeedbackEmail.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/notifications/sendFeedbackEmail.ts lib/notifications/sendFeedbackEmail.test.ts
git commit -m "feat(feedback): Resend sender to support@ with reply-to = account email" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Route (`app/api/feedback/route.ts`) + activity metric

**Files:**
- Create: `app/api/feedback/route.ts`
- Modify: `lib/activity/bump.ts:19` (`AppActivityMetric` union)
- Test: `app/api/feedback/route.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// app/api/feedback/route.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockRequireUser, mockSend, mockBump, AuthErrorMock } = vi.hoisted(() => ({
  mockRequireUser: vi.fn(),
  mockSend: vi.fn(),
  mockBump: vi.fn().mockResolvedValue(undefined),
  AuthErrorMock: class extends Error {
    constructor(public code: 'UNAUTHENTICATED' | 'FORBIDDEN', msg: string) {
      super(msg);
    }
  },
}));

vi.mock('@/lib/auth/requireAuthenticatedUser', () => ({ requireAuthenticatedUser: mockRequireUser }));
vi.mock('@/lib/auth/requireAdmin', () => ({ AuthError: AuthErrorMock }));
vi.mock('@/lib/notifications/sendFeedbackEmail', () => ({ sendFeedbackEmail: mockSend }));
vi.mock('@/lib/activity/bump', () => ({ bumpAppActivity: mockBump }));

import { POST } from './route';

const user = { id: 'uuid-1', email: 'jane@example.com', name: 'Jane Doe', role: 'standard_user' };

function makeRequest(body: unknown, raw = false) {
  return new Request('http://localhost/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

describe('POST /api/feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(user);
    vi.stubEnv('APP_PUBLIC_URL', 'https://test.example');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns 401 when not signed in', async () => {
    mockRequireUser.mockRejectedValueOnce(new AuthErrorMock('UNAUTHENTICATED', 'Not signed in'));
    const res = await POST(makeRequest({ message: 'A perfectly fine message.' }));
    expect(res.status).toBe(401);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns 400 on a short message and on a malformed body', async () => {
    expect((await POST(makeRequest({ message: 'short' }))).status).toBe(400);
    expect((await POST(makeRequest('{not json', true))).status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns 503 and does not bump the counter when the sender fails', async () => {
    mockSend.mockResolvedValueOnce({ sent: false, reason: 'send failed' });
    const res = await POST(makeRequest({ message: 'A perfectly fine message.', page: '/explorer' }));
    expect(res.status).toBe(503);
    expect(mockBump).not.toHaveBeenCalled();
  });

  it('sends with the account identity, validated page, and app URL, then bumps the counter', async () => {
    mockSend.mockResolvedValueOnce({ sent: true });
    const res = await POST(makeRequest({ message: '  A perfectly fine message.  ', page: '/explorer?rank_max=100' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockSend).toHaveBeenCalledWith({
      message: 'A perfectly fine message.',
      page: '/explorer?rank_max=100',
      user: { id: 'uuid-1', email: 'jane@example.com', name: 'Jane Doe' },
      appUrl: 'https://test.example',
    });
    expect(mockBump).toHaveBeenCalledWith('feedback_submission');
  });

  it('nulls an off-site page instead of rejecting the message', async () => {
    mockSend.mockResolvedValueOnce({ sent: true });
    const res = await POST(makeRequest({ message: 'A perfectly fine message.', page: 'https://evil.example' }));
    expect(res.status).toBe(200);
    expect(mockSend.mock.calls[0][0].page).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run app/api/feedback/route.test.ts`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Extend the activity metric union**

In `lib/activity/bump.ts`, change:

```ts
export type AppActivityMetric = 'contact_submission' | 'contact_honeypot';
```

to:

```ts
export type AppActivityMetric = 'contact_submission' | 'contact_honeypot' | 'feedback_submission';
```

(The `metric` column is `varchar(64)` — no migration. The abuse digest reads the two contact metrics by name and ignores others.)

- [ ] **Step 4: Implement the route**

```ts
// app/api/feedback/route.ts
/**
 * POST /api/feedback — signed-in feedback modal → email to the support inbox.
 *
 * Auth required; no honeypot (the modal only renders inside the
 * authenticated app shell). No rate limiting beyond the app-wide deferral —
 * volume is visible through the feedback_submission activity counter.
 * See docs/superpowers/specs/2026-09-15-feedback-button-design.md.
 */
import { NextResponse } from 'next/server';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { AuthError } from '@/lib/auth/requireAdmin';
import { validateFeedback } from '@/lib/feedback/validate';
import { sendFeedbackEmail } from '@/lib/notifications/sendFeedbackEmail';
import { bumpAppActivity } from '@/lib/activity/bump';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  let user;
  try {
    user = await requireAuthenticatedUser();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.code === 'UNAUTHENTICATED' ? 401 : 403 });
    }
    throw e;
  }

  const body = (await req.json().catch(() => ({}))) as unknown;
  const v = validateFeedback(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  const result = await sendFeedbackEmail({
    message: v.input.message,
    page: v.input.page,
    user: { id: user.id, email: user.email, name: user.name },
    appUrl: process.env.APP_PUBLIC_URL ?? 'https://keywordquarry.com',
  });
  if (!result.sent) {
    return NextResponse.json(
      { error: "Couldn't send your feedback right now — please try again later." },
      { status: 503 },
    );
  }
  void bumpAppActivity('feedback_submission'); // abuse-digest counter (fire-and-forget)
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run app/api/feedback/route.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add app/api/feedback/route.ts app/api/feedback/route.test.ts lib/activity/bump.ts
git commit -m "feat(feedback): authenticated POST /api/feedback → support inbox (+ activity counter)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Header button + modal (`FeedbackButton.tsx`) and layout wiring

**Files:**
- Create: `app/(app)/_components/FeedbackButton.tsx`
- Modify: `app/(app)/layout.tsx` (import + render between Admin and Support)
- Test: `app/(app)/_components/FeedbackButton.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// app/(app)/_components/FeedbackButton.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FeedbackButton } from './FeedbackButton';

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe('FeedbackButton', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/explorer?rank_max=100&words_min=3');
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders only the header button until clicked', () => {
    render(<FeedbackButton />);
    expect(screen.getByRole('button', { name: 'Feedback' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Feedback' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Send feedback')).toBeInTheDocument();
  });

  it('posts the trimmed message plus the current page, then shows the thanks state', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    render(<FeedbackButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Feedback' }));
    fireEvent.change(screen.getByLabelText('Your feedback'), {
      target: { value: '  The reviews filter is great, thanks!  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Thanks — got it.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/feedback');
    expect(JSON.parse(init.body as string)).toEqual({
      message: 'The reviews filter is great, thanks!',
      page: '/explorer?rank_max=100&words_min=3',
    });
  });

  it('blocks messages under 10 characters without a network call', () => {
    render(<FeedbackButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Feedback' }));
    fireEvent.change(screen.getByLabelText('Your feedback'), { target: { value: 'too short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByText('Please write at least 10 characters.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the server error and keeps the typed text', async () => {
    const msg = "Couldn't send your feedback right now — please try again later.";
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: msg }));
    render(<FeedbackButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Feedback' }));
    fireEvent.change(screen.getByLabelText('Your feedback'), {
      target: { value: 'Something worth keeping around.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText(msg);
    expect((screen.getByLabelText('Your feedback') as HTMLTextAreaElement).value).toBe(
      'Something worth keeping around.',
    );
  });

  it('closes on Escape and returns focus to the header button', () => {
    render(<FeedbackButton />);
    const trigger = screen.getByRole('button', { name: 'Feedback' });
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run "app/(app)/_components/FeedbackButton.test.tsx"`
Expected: FAIL — cannot resolve `./FeedbackButton`.

- [ ] **Step 3: Implement the component**

```tsx
// app/(app)/_components/FeedbackButton.tsx
'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * "Feedback" link in the app header → one-box modal → POST /api/feedback.
 *
 * The API attaches the account email (reply-to) and the page the member was
 * on (read from window.location at submit time), so nothing is re-typed.
 * The overlay is portaled into <body> so the sticky header's stacking
 * context can't clip it. Escape / backdrop / Cancel close it (not while
 * sending); focus returns to the header button. Typed text survives an
 * error and a Cancel; it is cleared only after a successful send.
 * See docs/superpowers/specs/2026-09-15-feedback-button-design.md.
 */
type Status = 'idle' | 'sending' | 'sent' | 'error';

const MESSAGE_MIN = 10;
const MESSAGE_MAX = 5000;

export function FeedbackButton() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  const close = useCallback(() => {
    if (status === 'sending') return;
    if (status === 'sent') setMessage('');
    setOpen(false);
    setStatus('idle');
    setError(null);
    buttonRef.current?.focus();
  }, [status]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = message.trim();
    if (trimmed.length < MESSAGE_MIN) {
      setError(`Please write at least ${MESSAGE_MIN} characters.`);
      setStatus('error');
      return;
    }
    setStatus('sending');
    setError(null);
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          page: window.location.pathname + window.location.search,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${res.status}`);
        setStatus('error');
        return;
      }
      setStatus('sent');
    } catch {
      setError('Network error — please check your connection and try again.');
      setStatus('error');
    }
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(true)}
        className="text-slate-300 hover:text-white"
      >
        Feedback
      </button>
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) close();
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              className="w-full max-w-md rounded-xl bg-white p-6 text-left shadow-xl"
            >
              {status === 'sent' ? (
                <>
                  <h2 id={titleId} className="text-lg font-semibold text-gray-900">
                    Thanks — got it.
                  </h2>
                  <p className="mt-2 text-sm text-gray-600">We&apos;ll reply by email if needed.</p>
                  <div className="mt-5 flex justify-end">
                    <button
                      type="button"
                      onClick={close}
                      className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                    >
                      Done
                    </button>
                  </div>
                </>
              ) : (
                <form onSubmit={handleSubmit}>
                  <h2 id={titleId} className="text-lg font-semibold text-gray-900">
                    Send feedback
                  </h2>
                  <p className="mt-1 text-sm text-gray-600">
                    What&apos;s confusing, missing, or would make KeywordQuarry more useful? We read
                    every message.
                  </p>
                  <textarea
                    autoFocus
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    maxLength={MESSAGE_MAX}
                    rows={6}
                    aria-label="Your feedback"
                    disabled={status === 'sending'}
                    className="mt-4 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
                  />
                  {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
                  <div className="mt-4 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={close}
                      disabled={status === 'sending'}
                      className="rounded-md px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={status === 'sending'}
                      className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
                    >
                      {status === 'sending' ? 'Sending…' : 'Send'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
```

- [ ] **Step 4: Wire it into the header**

In `app/(app)/layout.tsx`, add the import next to the TutorialsBanner import:

```ts
import { FeedbackButton } from './_components/FeedbackButton';
```

and render it between the Admin link and the Support link:

```tsx
          {/* One-box feedback modal → support@ with the account email as
              reply-to and the current page attached (2026-09-15 spec). */}
          <FeedbackButton />
          {/* Contact-a-human path (form → support@ loop); learning lives in
              the Tutorials tab — deliberately distinct jobs. */}
          <Link href="/contact" className="text-slate-300 hover:text-white">Support</Link>
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run "app/(app)/_components/FeedbackButton.test.tsx"`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add "app/(app)/_components/FeedbackButton.tsx" "app/(app)/_components/FeedbackButton.test.tsx" "app/(app)/layout.tsx"
git commit -m "feat(feedback): header Feedback button + one-box modal (portal, Escape, keeps text on error)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Verification (local) and review

- [ ] **Step 1: Typecheck and the full suite**

Run: `pnpm typecheck` → Expected: no output (clean).
Run: `pnpm test 2>&1 | grep -E "Test Files|Tests "` → Expected: all files passed; test count = previous total + 31 new.

- [ ] **Step 2: Lint the new files**

Run: `pnpm eslint lib/feedback app/api/feedback "app/(app)/_components/FeedbackButton.tsx" lib/notifications/buildFeedbackEmail.ts lib/notifications/sendFeedbackEmail.ts`
Expected: no errors.

- [ ] **Step 3: Dev-server smoke (route wiring + app shell compiles)**

Start the `web` dev server (preview tool, `.claude/launch.json`), then:
- `POST /api/feedback` with no session → 401 JSON (proves the route is mounted and auth-gated).
- Load `/explorer` → redirects to sign-in without a session; the header modal itself is exercised by the component tests and by the owner on prod after push (signing in locally needs the owner's Clerk session).

- [ ] **Step 4: Independent review**

Dispatch a code-reviewer subagent over the commit range (spec + plan + Tasks 1–5) with the spec as the reference. Fix anything Important or above, re-run the suite, then hand off to the owner for push authorization (`scripts/checkActiveJobs.ts` first).

---

## Self-review notes

- Spec coverage: validator (Part 1) → Task 1; builder (Part 2) → Task 2; sender (Part 3) → Task 3; route + metric (Part 4) → Task 4; UI + wiring (Part 5) → Task 5; testing list → each task's Step 1 plus Task 6; ship checklist → Task 6 + owner gates.
- Type consistency: `FeedbackInput { message, page }` (Task 1) feeds `FeedbackEmailInput { message, page, user, appUrl }` (Task 2) used verbatim by the sender (Task 3) and route (Task 4). `AppActivityMetric` gains exactly `'feedback_submission'`, the string the route bumps and the test asserts.
- No placeholders: every step carries its full code and exact command.
