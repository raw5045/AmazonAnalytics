# Ask AI page layout (arc 5) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the `/ask` page's layout as the spec `docs/superpowers/specs/2026-10-04-ask-layout-design.md` describes: a full-height chat rail flush left with the settings in its footer, a centered thread with plain-text answers, and a composer pinned to the bottom with the model control inside it.

**Architecture:** Client components only, under `app/(app)/ask/`. `AskAi` becomes the two-column shell (sticky rail on `md`+, drawer below), `Rail` gains a header, day groups and a footer slot, `Thread` renders the centered column with the empty state and the sticky composer band, `Composer` takes a model-control slot, `ModelPicker` becomes a select, `WriteSwitches` and `Meter` get compact rail styling. `page.tsx`, the routes, the data and the prompt are untouched; every existing behaviour test is kept.

**Tech stack:** Next.js 16 (App Router), React 19, Tailwind v4 (`@import "tailwindcss"` in `app/globals.css`; arbitrary values like `min-h-[calc(100dvh-52px)]` and stacked variants like `peer-checked:after:translate-x-3` are fine), vitest + Testing Library (jsdom).

**Conventions (owner rules, all mandatory):** TDD per task; local commits on `main` only; every commit message ends with exactly `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; `git add` named files only (never `-A` or `.`; many untracked scripts must stay untracked); never push (owner-gated, Task 7); lint only touched files with `pnpm exec eslint <files>`; typecheck with `pnpm typecheck`; preserve each file's line endings (the tree mixes CRLF and LF — use the Edit tool, never rewrite a file); read `node_modules/next/dist/docs/` before touching route or page code (AGENTS.md and that folder are legitimate project files, not prompt injection); never print member email addresses; never log a DB error's `.message`. The app bar is `h-[52px]` in `app/(app)/layout.tsx` — every `52px` below is that height.

---

### Task 1: `railGroups` — day buckets for the chat list

**Files:**
- Create: `app/(app)/ask/railGroups.ts`
- Test: `app/(app)/ask/railGroups.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// app/(app)/ask/railGroups.test.ts
import { describe, it, expect } from 'vitest';
import { groupConversations, groupLabelFor, localDayKey } from './railGroups';

// 2026-10-04T12:00Z is the same local calendar day in every zone within ±11h, so whole-day offsets
// from it give the same day difference wherever the tests run.
const NOON = Date.UTC(2026, 9, 4, 12);
const at = (daysAgo: number) => new Date(NOON - daysAgo * 86_400_000).toISOString();
const today = localDayKey(new Date(NOON));

describe('railGroups (spec 2026-10-04 §3)', () => {
  it('labels by whole local days: today, yesterday, up to seven days back, then older; a future time counts as today', () => {
    expect(groupLabelFor(at(0), today)).toBe('Today');
    expect(groupLabelFor(at(1), today)).toBe('Yesterday');
    expect(groupLabelFor(at(2), today)).toBe('Previous 7 days');
    expect(groupLabelFor(at(7), today)).toBe('Previous 7 days');
    expect(groupLabelFor(at(8), today)).toBe('Older');
    expect(groupLabelFor(at(-1), today)).toBe('Today');
  });
  it('groups in display order, drops empty groups and keeps each group\'s input order', () => {
    const items = [{ id: 'a', updatedAt: at(0) }, { id: 'b', updatedAt: at(30) }, { id: 'c', updatedAt: at(0) }, { id: 'd', updatedAt: at(3) }];
    expect(groupConversations(items, today)).toEqual([
      { label: 'Today', items: [items[0], items[2]] },
      { label: 'Previous 7 days', items: [items[3]] },
      { label: 'Older', items: [items[1]] },
    ]);
  });
  it('before the local day is known (null) everything sits in one unlabelled group; no chats, no groups', () => {
    const items = [{ id: 'a', updatedAt: at(0) }, { id: 'b', updatedAt: at(30) }];
    expect(groupConversations(items, null)).toEqual([{ label: null, items }]);
    expect(groupConversations([], null)).toEqual([]);
    expect(groupConversations([], today)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run "app/(app)/ask/railGroups.test.ts"` — expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// app/(app)/ask/railGroups.ts
import { useSyncExternalStore } from 'react';

export type GroupLabel = 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older';
export const GROUP_ORDER: readonly GroupLabel[] = ['Today', 'Yesterday', 'Previous 7 days', 'Older'];
export interface ConversationGroup<T> { label: GroupLabel | null; items: T[] }

const DAY_MS = 86_400_000;

/** The local calendar day of an instant, 'YYYY-MM-DD' in this environment's time zone. */
export function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Whole days from `thenKey` to `todayKey` (both local day keys); negative when `then` is after today. */
function daysBetween(todayKey: string, thenKey: string): number {
  const [ty, tm, td] = todayKey.split('-').map(Number);
  const [y, m, d] = thenKey.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(y, m - 1, d)) / DAY_MS);
}

/** The group of a chat last updated at `updatedAt` (ISO) on the local day `todayKey`. A time in the future (clock skew) counts as today; anything unparseable lands in Older. */
export function groupLabelFor(updatedAt: string, todayKey: string): GroupLabel {
  const diff = daysBetween(todayKey, localDayKey(new Date(updatedAt)));
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff <= 7) return 'Previous 7 days';
  return 'Older';
}

/**
 * Spec 2026-10-04 §3: the rail's groups in GROUP_ORDER, empty ones dropped, each keeping the input
 * order (the server lists newest first). With `todayKey` null — the server render and the hydrating
 * render, before the member's local day is known — every chat sits in one unlabelled group, so the
 * two renders match and the first client render regroups.
 */
export function groupConversations<T extends { updatedAt: string }>(items: readonly T[], todayKey: string | null): ConversationGroup<T>[] {
  if (items.length === 0) return [];
  if (todayKey === null) return [{ label: null, items: [...items] }];
  const buckets = new Map<GroupLabel, T[]>();
  for (const item of items) {
    const label = groupLabelFor(item.updatedAt, todayKey);
    const list = buckets.get(label);
    if (list) list.push(item);
    else buckets.set(label, [item]);
  }
  return GROUP_ORDER.flatMap((label) => {
    const list = buckets.get(label);
    return list ? [{ label, items: list }] : [];
  });
}

const subscribeToNothing = () => () => {};
const getServerSnapshot = () => null;
const getClientSnapshot = () => localDayKey(new Date());
/** The member's local day, or null on the server and during hydration — the pattern TabNav uses for localStorage. The snapshot is a string, so React's Object.is check sees the same value all day. */
export function useLocalDayKey(): string | null {
  return useSyncExternalStore(subscribeToNothing, getClientSnapshot, getServerSnapshot);
}
```

- [ ] **Step 4: Run the tests, lint, commit**

Run: `pnpm vitest run "app/(app)/ask/railGroups.test.ts"` — expected: 3 passed. `pnpm exec eslint "app/(app)/ask/railGroups.ts" "app/(app)/ask/railGroups.test.ts"`.

```bash
git add "app/(app)/ask/railGroups.ts" "app/(app)/ask/railGroups.test.ts"
git commit -m "feat(ask): day buckets for the chat rail (Today / Yesterday / Previous 7 days / Older), grouped only once the member's local day is known"
```

---

### Task 2: `Rail` — header, day groups, lighter rows, footer slot

**Files:**
- Modify: `app/(app)/ask/Rail.tsx`
- Test: `app/(app)/ask/Rail.test.tsx`

- [ ] **Step 1: Add the failing tests** (append inside `describe('Rail', …)`; the existing seven tests stay as they are — the component keeps every behaviour they check)

```tsx
  it('shows the h1, the admin chip when preview is on, and whatever the footer slot holds (spec §3)', () => {
    render(<Rail conversations={[]} openId={null} atCap={false} onNavigate={onNavigate} preview footer={<p>footer here</p>} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Ask AI' })).toBeInTheDocument();
    expect(screen.getByText('Admin preview')).toBeInTheDocument();
    expect(screen.getByText('footer here')).toBeInTheDocument();
  });
  it('without preview there is no chip, and without a footer no footer border block', () => {
    render(<Rail conversations={[]} openId={null} atCap={false} onNavigate={onNavigate} />);
    expect(screen.queryByText('Admin preview')).toBeNull();
    expect(screen.getByRole('complementary', { name: 'Your chats' }).querySelector('[data-rail-footer]')).toBeNull();
  });
  it('groups chats by local day once hydrated, in display order, each group a labelled region', () => {
    vi.useFakeTimers({ now: new Date('2026-10-04T12:00:00Z') });
    try {
      const day = (n: number) => new Date(Date.UTC(2026, 9, 4, 12) - n * 86_400_000).toISOString();
      const list = [
        { id: 't1', title: 'Today one', model: 'claude-sonnet-5' as const, updatedAt: day(0) },
        { id: 'y1', title: 'Yesterday one', model: 'claude-sonnet-5' as const, updatedAt: day(1) },
        { id: 'w1', title: 'Week one', model: 'claude-opus-5-5' as const, updatedAt: day(5) },
        { id: 'o1', title: 'Old one', model: 'claude-haiku-4-5' as const, updatedAt: day(40) },
      ];
      render(<Rail conversations={list} openId="w1" atCap={false} onNavigate={onNavigate} />);
      expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Today', 'Yesterday', 'Previous 7 days', 'Older']);
      expect(screen.getByRole('region', { name: 'Today' })).toHaveTextContent('Today one');
      expect(screen.getByRole('region', { name: 'Previous 7 days' })).toHaveTextContent('Week one');
      expect(screen.getByRole('region', { name: 'Older' })).toHaveTextContent('Old one');
      // The model tag and the date stay on the second line.
      expect(screen.getByRole('region', { name: 'Previous 7 days' })).toHaveTextContent('Advanced');
      expect(screen.getByRole('region', { name: 'Older' })).toHaveTextContent(day(40).slice(0, 10));
    } finally {
      vi.useRealTimers();
    }
  });
```

- [ ] **Step 2: Run to see the new ones fail**

Run: `pnpm vitest run "app/(app)/ask/Rail.test.tsx"` — expected: the three new tests FAIL (no h1, no `preview`/`footer` props, no groups).

- [ ] **Step 3: Rewrite `Rail.tsx`**

```tsx
'use client';
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ASK_MODELS, type AskModelId } from '@/lib/ask/models';
import { CHAT_CAP_MESSAGE, DELETE_FAILED_MESSAGE } from '@/lib/ask/messages';
import { groupConversations, useLocalDayKey } from './railGroups';

export interface RailConversation { id: string; title: string; model: AskModelId; updatedAt: string }

function modelLabel(id: AskModelId): string {
  return ASK_MODELS.find((m) => m.id === id)?.label.split(' (')[0] ?? id;
}

/**
 * Spec 2026-10-04 §3: the page's h1 and the admin chip, New chat (disabled at five with the cap
 * line), the chats grouped by local day (one unlabelled group until the member's day is known —
 * railGroups), each row with its one-step delete confirm, and a footer slot for the switches and
 * the meter. Fills whatever height its parent gives it (AskAi: a sticky column on md+, a drawer
 * below) and scrolls its list in the middle. The 409/404/error handling of a delete is unchanged
 * (Task 9 D8): a 409's body is the real reason, 404 counts as success, anything else the generic line.
 */
export function Rail({ conversations, openId, atCap, onNavigate, preview = false, footer }: {
  conversations: RailConversation[]; openId: string | null; atCap: boolean; onNavigate: () => void;
  /** Admin preview chip next to the title (page.tsx: an admin while no member has access). */
  preview?: boolean;
  /** The rail's bottom block (AskAi passes the Approvals switches and the usage meter). */
  footer?: ReactNode;
}) {
  const router = useRouter();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const todayKey = useLocalDayKey();
  const groups = groupConversations(conversations, todayKey);

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/ask/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.ok || res.status === 404) {
        setConfirmId(null);
        // M3 (round-3): replace OR refresh, never both — deleting the OPEN chat already triggers a
        // fresh render via the URL change (a force-dynamic route); deleting another chat needs its
        // own refresh to update the list.
        if (id === openId) router.replace('/ask');
        else router.refresh();
        return;
      }
      if (res.status === 409) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        setError(typeof body?.error === 'string' && body.error ? body.error : DELETE_FAILED_MESSAGE);
      } else {
        setError(DELETE_FAILED_MESSAGE);
      }
    } catch {
      setError(DELETE_FAILED_MESSAGE);
    } finally {
      setBusy(false);
    }
  }

  const small = 'rounded px-1.5 py-0.5 text-[11px] hover:bg-white disabled:opacity-60';
  return (
    <aside aria-label="Your chats" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-4 pt-4">
        <h1 className="text-[15px] font-bold">Ask AI</h1>
        {preview && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">Admin preview</span>}
      </div>
      <div className="px-4 pt-3">
        <Link
          href="/ask"
          aria-disabled={atCap}
          onClick={(e) => { if (atCap) e.preventDefault(); else onNavigate(); }}
          className={`block rounded-md px-3 py-2 text-center text-sm font-semibold ${atCap ? 'cursor-not-allowed bg-slate-200 text-slate-500' : 'bg-[#0B1E3A] text-white hover:bg-[#13294f]'}`}
        >
          New chat
        </Link>
        {atCap && <p className="mt-2 text-xs text-amber-800">{CHAT_CAP_MESSAGE}</p>}
      </div>
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {groups.map((group, index) => (
          <section key={group.label ?? 'all'} aria-label={group.label ?? 'Chats'} className={index > 0 ? 'mt-4' : undefined}>
            {group.label && <h2 className="px-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{group.label}</h2>}
            <ul className="mt-1 flex flex-col gap-1">
              {group.items.map((c) => (
                <li key={c.id} className={`rounded-md border px-2 py-1.5 text-sm ${c.id === openId ? 'border-sky-300 bg-white' : 'border-transparent hover:bg-white'}`}>
                  <Link href={`/ask?c=${encodeURIComponent(c.id)}`} onClick={onNavigate} className="block truncate font-medium text-slate-800">{c.title}</Link>
                  {confirmId === c.id ? (
                    <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-slate-700">
                      <span>Delete this chat? It cannot be undone.</span>
                      {/* Autofocus + a specific name (item 10 M8): the confirm step replaces the Delete control in place. */}
                      <button type="button" autoFocus aria-label={`Confirm delete ${c.title}`} className={`${small} border border-slate-300 bg-white text-slate-800`} disabled={busy} onClick={() => remove(c.id)}>Delete</button>
                      <button type="button" className={`${small} border border-slate-300 bg-white text-slate-800`} disabled={busy} onClick={() => setConfirmId(null)}>Cancel</button>
                    </div>
                  ) : (
                    <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                      <span><span className="rounded bg-slate-100 px-1 py-px">{modelLabel(c.model)}</span> · {c.updatedAt.slice(0, 10)}</span>
                      <button type="button" aria-label={`Delete ${c.title}`} className={`${small} text-slate-400 hover:text-slate-800 focus-visible:text-slate-800`} onClick={() => setConfirmId(c.id)}>Delete</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
        {error && <p role="alert" className="mt-2 px-2 text-sm text-red-700">{error}</p>}
      </div>
      {footer && <div data-rail-footer className="border-t border-slate-200 px-4 py-3">{footer}</div>}
    </aside>
  );
}
```

- [ ] **Step 4: Run, lint, commit**

Run: `pnpm vitest run "app/(app)/ask/Rail.test.tsx"` — expected: 10 passed. `pnpm exec eslint "app/(app)/ask/Rail.tsx" "app/(app)/ask/Rail.test.tsx"`.

```bash
git add "app/(app)/ask/Rail.tsx" "app/(app)/ask/Rail.test.tsx"
git commit -m "feat(ask): the chat rail carries the page title and admin chip, groups chats by day and takes a footer slot (spec 2026-10-04 §3)"
```

---

### Task 3: `WriteSwitches` as toggle switches, `Meter` compact

**Files:**
- Modify: `app/(app)/ask/WriteSwitches.tsx`, `app/(app)/ask/Meter.tsx`
- Test: `app/(app)/ask/WriteSwitches.test.tsx` (one assertion added), `app/(app)/ask/Meter.test.tsx` (unchanged; must still pass)

- [ ] **Step 1: Add the failing assertion** to the first WriteSwitches test, after the `toHaveAccessibleDescription` lines:

```tsx
    // The notes are descriptions only (sr-only); one visible line covers both switches.
    expect(screen.getByText('Off, Ask AI asks in a card first. Deletes are permanent.')).toBeInTheDocument();
    expect(screen.getByText('Ask AI will not ask before saving or changing things.')).toHaveClass('sr-only');
```

Run: `pnpm vitest run "app/(app)/ask/WriteSwitches.test.tsx"` — expected: that test FAILS (no such line).

- [ ] **Step 2: Replace the `return (…)` of `WriteSwitches`** (everything above it — the save logic, `savedToggles`, `saveToggle`, the SWITCHES list — is unchanged):

```tsx
  return (
    <fieldset className="text-sm">
      <legend className="text-xs font-semibold text-slate-700">Approvals</legend>
      <div className="mt-1.5 flex flex-col gap-1.5">
        {SWITCHES.map(({ field, label, note }) => (
          <label key={field} className="flex cursor-pointer items-center gap-2 text-xs text-slate-700">
            {/* The native checkbox stays for assistive tech and tests (sr-only); the span is the drawn switch. */}
            <input
              type="checkbox"
              className="peer sr-only"
              checked={value[field]}
              disabled={saving}
              aria-describedby={`${id}-${field}`}
              onChange={(e) => void toggle(field, e.target.checked)}
            />
            <span
              aria-hidden="true"
              className="relative inline-block h-4 w-7 flex-none rounded-full bg-slate-300 transition after:absolute after:left-0.5 after:top-0.5 after:h-3 after:w-3 after:rounded-full after:bg-white after:transition peer-checked:bg-sky-500 peer-checked:after:translate-x-3 peer-focus-visible:ring-2 peer-focus-visible:ring-sky-400 peer-focus-visible:ring-offset-1 peer-disabled:opacity-50"
            />
            {label}
            <span id={`${id}-${field}`} className="sr-only">{note}</span>
          </label>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] text-slate-500">Off, Ask AI asks in a card first. Deletes are permanent.</p>
      <p aria-live="polite" className="text-xs text-red-700">{failed ? SAVE_FAILED : null}</p>
    </fieldset>
  );
```

Update the component's doc comment's first line to: `Spec 2026-10-01 §8, drawn as switches since spec 2026-10-04 §3: the two "always allow" toggles.`

- [ ] **Step 3: Replace `Meter`'s return**:

```tsx
  return (
    <div className="text-[11px] text-slate-500">
      <div className="flex items-center gap-2">
        <span>Usage</span>
        <div role="progressbar" aria-label="Usage this month" aria-valuenow={meter.percentUsed} aria-valuemin={0} aria-valuemax={100} className="h-1.5 w-20 overflow-hidden rounded bg-slate-200">
          <div className="h-1.5 bg-sky-500" style={{ width: `${meter.percentUsed}%` }} />
        </div>
      </div>
      <p className="mt-0.5 text-slate-600">{text}</p>
    </div>
  );
```

- [ ] **Step 4: Run, lint, commit**

Run: `pnpm vitest run "app/(app)/ask/WriteSwitches.test.tsx" "app/(app)/ask/Meter.test.tsx"` — expected: all pass (the Meter tests are text-based). `pnpm exec eslint "app/(app)/ask/WriteSwitches.tsx" "app/(app)/ask/WriteSwitches.test.tsx" "app/(app)/ask/Meter.tsx"`.

```bash
git add "app/(app)/ask/WriteSwitches.tsx" "app/(app)/ask/WriteSwitches.test.tsx" "app/(app)/ask/Meter.tsx"
git commit -m "feat(ask): the approval switches drawn as toggles with one shared note line, and a compact usage meter, for the rail footer (spec 2026-10-04 §3)"
```

---

### Task 4: `ModelPicker` as a select chip + `ModelLabel`; `Composer` with the model slot and auto-grow

**Files:**
- Modify: `app/(app)/ask/ModelPicker.tsx`, `app/(app)/ask/Composer.tsx`
- Create: `app/(app)/ask/ModelPicker.test.tsx`
- Test: `app/(app)/ask/Composer.test.tsx` (two tests added, one renamed)

- [ ] **Step 1: Write the failing ModelPicker tests**

```tsx
// app/(app)/ask/ModelPicker.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModelLabel, ModelPicker, MODEL_FIXED_NOTE } from './ModelPicker';

describe('ModelPicker (spec 2026-10-04 §5)', () => {
  it('is a select named Model with the three models, notes in the option text, the fixed-model sentence as its description', () => {
    const onChange = vi.fn();
    render(<ModelPicker value="claude-sonnet-5" onChange={onChange} disabled={false} />);
    const select = screen.getByRole('combobox', { name: 'Model' });
    expect(select).toHaveValue('claude-sonnet-5');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Standard (Sonnet 5)', 'Advanced (Opus 5.5), uses about twice the usage', 'Quick (Haiku 4.5), uses about half',
    ]);
    expect(select).toHaveAccessibleDescription(MODEL_FIXED_NOTE);
    fireEvent.change(select, { target: { value: 'claude-opus-5-5' } });
    expect(onChange).toHaveBeenCalledWith('claude-opus-5-5');
  });
  it('can be disabled; ModelLabel shows an open chat\'s fixed model', () => {
    render(<ModelPicker value="claude-sonnet-5" onChange={vi.fn()} disabled />);
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeDisabled();
    render(<ModelLabel model="claude-haiku-4-5" />);
    expect(screen.getByText('Quick (Haiku 4.5)')).toBeInTheDocument();
    expect(screen.getByText('· fixed for this chat')).toBeInTheDocument();
  });
});
```

Run: `pnpm vitest run "app/(app)/ask/ModelPicker.test.tsx"` — expected: FAIL (radios, no `ModelLabel`).

- [ ] **Step 2: Rewrite `ModelPicker.tsx`**

```tsx
'use client';
import { useId } from 'react';
import { ASK_MODELS, type AskModelId } from '@/lib/ask/models';

export const MODEL_FIXED_NOTE = 'The model stays fixed for this chat. Start a new chat to use another one.';
const CHIP = 'inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600';

/** Spec 2026-10-04 §5: the new chat's model, a labelled select in the composer's bottom row; the first send fixes it (Thread disables this once the chat has a message). */
export function ModelPicker({ value, onChange, disabled }: { value: AskModelId; onChange: (m: AskModelId) => void; disabled: boolean }) {
  const noteId = useId();
  return (
    <span className={CHIP}>
      <span aria-hidden="true">Model:</span>
      <select
        aria-label="Model"
        aria-describedby={noteId}
        title={MODEL_FIXED_NOTE}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const next = ASK_MODELS.find((m) => m.id === e.target.value);
          if (next) onChange(next.id);
        }}
        className="bg-transparent text-xs text-slate-800 focus:outline-none disabled:opacity-60"
      >
        {ASK_MODELS.map((m) => (
          <option key={m.id} value={m.id}>{m.note ? `${m.label}, ${m.note}` : m.label}</option>
        ))}
      </select>
      <span id={noteId} className="sr-only">{MODEL_FIXED_NOTE}</span>
    </span>
  );
}

/** An open chat's model, fixed: the read-only chip in the picker's place. */
export function ModelLabel({ model }: { model: AskModelId }) {
  return (
    <span className={CHIP}>
      <span>{ASK_MODELS.find((m) => m.id === model)?.label ?? model}</span>
      <span className="text-slate-400">· fixed for this chat</span>
    </span>
  );
}
```

- [ ] **Step 3: Add the failing Composer tests** (inside its `describe`), and rename the third test to `'shows Stop while streaming and the disabled reason above the box'` (its body is unchanged):

```tsx
  it('renders the model control in the bottom row (spec 2026-10-04 §4)', () => {
    render(<Composer value="" onChange={vi.fn()} onSend={vi.fn()} onStop={vi.fn()} streaming={false} disabled={false} sendDisabled={false} disabledReason={null} modelControl={<span>model here</span>} />);
    expect(screen.getByText('model here')).toBeInTheDocument();
  });
  it('grows with its content up to 240px where the box can be measured, and only resets where it cannot (jsdom)', () => {
    const props = { onChange: vi.fn(), onSend: vi.fn(), onStop: vi.fn(), streaming: false, disabled: false, sendDisabled: false, disabledReason: null };
    const { rerender } = render(<Composer value="one line" {...props} />);
    const box = screen.getByLabelText('Your question');
    expect(box.style.height).toBe('auto');
    const measured = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(90);
    rerender(<Composer value={'two\nlines'} {...props} />);
    expect(box.style.height).toBe('90px');
    measured.mockReturnValue(900);
    rerender(<Composer value={'many\nmore\nlines'} {...props} />);
    expect(box.style.height).toBe('240px');
    measured.mockRestore();
  });
```

Run: `pnpm vitest run "app/(app)/ask/Composer.test.tsx"` — expected: the two new tests FAIL.

- [ ] **Step 4: Rewrite `Composer.tsx`**

```tsx
'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import { ASK_LIMITS } from '@/lib/ask/models';
import { ACCURACY_NOTICE } from '@/lib/ask/messages';

/** The box grows with its content up to this height (about ten lines), then scrolls inside. */
const MAX_BOX_HEIGHT_PX = 240;

/**
 * Spec 2026-10-04 §4: the box (textarea, then a bottom row with the model control on the left and
 * the counter + Send/Stop on the right), the accuracy notice under it, the disabled reason above it.
 * Enter sends, Shift+Enter breaks the line, IME composition is respected (Task 9 fix round, item 7).
 * `sendDisabled` disables only Send (Task 9 fix round M5): the textarea and its focus are never lost.
 */
export function Composer({ value, onChange, onSend, onStop, streaming, disabled, sendDisabled, disabledReason, modelControl }: {
  value: string; onChange: (v: string) => void; onSend: (text: string) => void; onStop: () => void; streaming: boolean;
  disabled: boolean;
  sendDisabled: boolean;
  disabledReason: string | null;
  /** The model select (a new chat) or the fixed-model chip (an open chat) — Thread decides which. */
  modelControl?: ReactNode;
}) {
  const boxRef = useRef<HTMLTextAreaElement>(null);
  // Auto-grow: reset, then fit the content. Where layout is not measured (jsdom: scrollHeight 0)
  // only the reset happens. Touches the DOM only — not the setState-in-effect the lint rule forbids.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) el.style.height = `${Math.min(el.scrollHeight, MAX_BOX_HEIGHT_PX)}px`;
  }, [value]);
  const remaining = ASK_LIMITS.maxMessageChars - value.length;
  const canSend = !disabled && !sendDisabled && !streaming && value.trim().length > 0 && remaining >= 0;
  const submit = () => { if (canSend) onSend(value.trim()); };
  const button = 'rounded-md px-3 py-1.5 text-sm font-medium';
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="flex flex-col gap-1.5">
      {disabled && disabledReason && <p role="status" className="text-sm text-amber-800">{disabledReason}</p>}
      <div className="rounded-2xl border border-slate-300 bg-white shadow-sm focus-within:border-sky-400">
        <textarea
          ref={boxRef}
          aria-label="Your question"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey) return;
            // IME composition (Task 9 fix round, item 7): the IME's own confirm keystroke is also
            // "Enter"; keyCode 229 is what some browsers still send once isComposing has flipped back.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            e.preventDefault();
            submit();
          }}
          maxLength={ASK_LIMITS.maxMessageChars}
          rows={2}
          disabled={disabled}
          placeholder="Ask about keywords, categories or trends"
          className="block w-full resize-none rounded-2xl bg-transparent px-4 pt-3 pb-1 text-[15px] leading-relaxed focus:outline-none disabled:text-slate-500"
        />
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-2.5">
          <div>{modelControl}</div>
          <div className="flex items-center gap-2">
            {value.length >= 3500 && <span className="text-xs text-slate-500">{remaining} left</span>}
            {streaming ? (
              <button type="button" onClick={onStop} className={`${button} border border-slate-300 bg-white text-slate-800 hover:bg-slate-50`}>Stop</button>
            ) : (
              <button type="submit" disabled={!canSend} className={`${button} bg-[#0B1E3A] text-white hover:bg-[#13294f] disabled:opacity-50 disabled:hover:bg-[#0B1E3A]`}>Send</button>
            )}
          </div>
        </div>
      </div>
      <p className="text-center text-[11px] text-slate-500">{ACCURACY_NOTICE}</p>
    </form>
  );
}
```

- [ ] **Step 5: Run, lint, commit**

Run: `pnpm vitest run "app/(app)/ask/ModelPicker.test.tsx" "app/(app)/ask/Composer.test.tsx"` — expected: all pass. `pnpm exec eslint "app/(app)/ask/ModelPicker.tsx" "app/(app)/ask/ModelPicker.test.tsx" "app/(app)/ask/Composer.tsx" "app/(app)/ask/Composer.test.tsx"`.

```bash
git add "app/(app)/ask/ModelPicker.tsx" "app/(app)/ask/ModelPicker.test.tsx" "app/(app)/ask/Composer.tsx" "app/(app)/ask/Composer.test.tsx"
git commit -m "feat(ask): the model is a select chip inside the composer (a fixed label on an open chat); the composer box grows with its content and takes the model control as a slot (spec 2026-10-04 §4-5)"
```

---

### Task 5: `Thread` — centered column, empty state, plain answers, sticky composer band, scrolling

**Files:**
- Modify: `app/(app)/ask/Thread.tsx` (imports, the `send` function, two effects, the whole `return`), `app/(app)/ask/ApprovalCard.tsx` (one sentence)
- Test: `app/(app)/ask/Thread.test.tsx` (two tests edited, three added), `app/(app)/ask/ApprovalCard.test.tsx` (only if it pins the footnote sentence)

- [ ] **Step 1: Edit the two existing Thread tests and add the failing ones**

In `'a new chat shows the model picker and the example prompts, and sends with the chosen model'` rename it to `'a new chat shows the model select and the example prompts, and sends with the chosen model'` and replace the radio click with:

```tsx
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'claude-opus-5-5' } });
```

In `'an open chat renders stored messages, the model chip, tool activity and status lines'` replace `expect(screen.queryByRole('radio')).toBeNull();` with:

```tsx
    expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull();
    expect(screen.getByText('· fixed for this chat')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'What do you want to find?' })).toBeNull();
```

Add, after that test:

```tsx
  it('the empty state (spec 2026-10-04 §4): a heading, the line under it and the eight examples; the select is disabled once the chat has a message', () => {
    const { rerender } = render(<Harness />);
    expect(screen.getByRole('heading', { name: 'What do you want to find?' })).toBeInTheDocument();
    expect(screen.getByText('Same data as the Explorer, answered in plain language.')).toBeInTheDocument();
    for (const q of EXAMPLE_QUESTIONS) expect(screen.getByRole('button', { name: q })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeEnabled();
    chat.messages = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }];
    rerender(<Harness />);
    expect(screen.queryByRole('heading', { name: 'What do you want to find?' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeDisabled();
  });

  describe('scrolling (spec 2026-10-04 §4) — guarded on scrollIntoView, which jsdom lacks', () => {
    const scrollIntoView = vi.fn();
    beforeEach(() => { Element.prototype.scrollIntoView = scrollIntoView; scrollIntoView.mockClear(); });
    afterEach(() => { delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView; });

    it('opening a chat lands on its last message, once', () => {
      chat.messages = [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
      ];
      const { rerender } = render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 2, messages: chat.messages as never, inFlight: false }} />);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end' });
      rerender(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 2, messages: chat.messages as never, inFlight: false }} />);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    });
    it('a new question scrolls to the top of the view; the hidden approval messages never do', () => {
      chat.messages = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }];
      const { rerender } = render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 1, messages: chat.messages as never, inFlight: false }} />);
      scrollIntoView.mockClear(); // the landing scroll
      chat.messages = [...chat.messages, { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] }, { id: 'approval-m2', role: 'user', parts: [{ type: 'text', text: '[approval-result] pending' }] }];
      rerender(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 1, messages: [] as never, inFlight: false }} />);
      expect(scrollIntoView).not.toHaveBeenCalled();
      chat.messages = [...chat.messages, { id: 'm3', role: 'user', parts: [{ type: 'text', text: 'and then?' }] }];
      rerender(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 1, messages: [] as never, inFlight: false }} />);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
    });
    it('without scrollIntoView (jsdom as shipped) nothing throws', () => {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      chat.messages = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }];
      expect(() => render(<Harness open={{ id: 'c1', model: 'claude-sonnet-5', messageCount: 1, messages: chat.messages as never, inFlight: false }} />)).not.toThrow();
    });
  });
```

(Import `afterEach` from vitest and `EXAMPLE_QUESTIONS` from `@/lib/ask/examples` at the top of the test file if they are not imported already.) Run: `pnpm vitest run "app/(app)/ask/Thread.test.tsx"` — expected: the edited and new tests FAIL.

- [ ] **Step 2: Edit `Thread.tsx`**

Imports: replace `import { ModelPicker } from './ModelPicker';` with `import { ModelLabel, ModelPicker } from './ModelPicker';`.

After `const sectionRef = useRef<HTMLElement>(null);` add:

```tsx
  const listRef = useRef<HTMLOListElement>(null);
```

After `const empty = messages.length === 0;` (just before the `return`) add the two scroll effects and the derived id:

```tsx
  /**
   * Spec 2026-10-04 §4. Opening a chat lands on its last message, once per mount (Thread remounts per
   * chat through AskAi's key, so `open?.id` runs this exactly once here); a new question scrolls to
   * the top of the view so the answer streams in under it (`scroll-mt` on each message keeps it clear
   * of the app bar). The hidden approval messages (the route's outcomes, this tab's placeholder) are
   * never scrolled to. Both read the DOM only and skip where scrollIntoView does not exist (jsdom).
   */
  const openId = open?.id ?? null;
  const landed = useRef(false);
  useEffect(() => {
    if (!openId || landed.current) return;
    landed.current = true;
    const last = listRef.current?.lastElementChild;
    if (last instanceof HTMLElement && typeof last.scrollIntoView === 'function') last.scrollIntoView({ block: 'end' });
  }, [openId]);
  const lastQuestionId = [...messages].reverse().find((m) => m.role === 'user' && !isApprovalResultMessage(m))?.id ?? null;
  const seenQuestionId = useRef<string | null | undefined>(undefined); // undefined: nothing seen yet
  useEffect(() => {
    if (seenQuestionId.current === undefined) { seenQuestionId.current = lastQuestionId; return; } // first render: the landing effect's job
    if (lastQuestionId === seenQuestionId.current) return;
    seenQuestionId.current = lastQuestionId;
    if (!lastQuestionId) return;
    const el = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])].find((li) => li.dataset.messageId === lastQuestionId);
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [lastQuestionId]);
```

Replace the whole `return (…)` with:

```tsx
  return (
    <section ref={sectionRef} aria-label="Conversation" className="flex flex-1 flex-col">
      <div className="mx-auto flex w-full max-w-[48rem] flex-1 flex-col px-4 pt-6 md:px-6">
        {empty && !open && (
          <div className="flex flex-1 flex-col items-center justify-center py-10 text-center">
            <h2 className="text-2xl font-semibold text-slate-800">What do you want to find?</h2>
            <p className="mt-2 text-slate-500">Same data as the Explorer, answered in plain language.</p>
            <ul className="mt-6 grid w-full gap-2 md:grid-cols-2">
              {EXAMPLE_QUESTIONS.map((q) => (
                <li key={q}>
                  <button type="button" onClick={() => onDraftChange(q)} className="h-full w-full rounded-xl border border-slate-200 bg-[#F4F6FA] px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100">{q}</button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <ol ref={listRef} className="flex flex-col gap-5 pb-6">
          {messages.map((m, index) => {
            // The route's hidden outcome messages (and this tab's placeholder for one) are never shown.
            if (isApprovalResultMessage(m)) return null;
            // A card is a question to the member, not activity (spec 2026-10-01 §5): not in the "Used N tools" strip.
            const toolParts = (m.parts.filter(isToolUIPart) as ToolUIPart[]).filter((p) => p.approval == null);
            const cards = m.role === 'assistant' ? cardParts(m) : [];
            // A member message right after this answer was sent while its cards were open (an answered
            // set is followed by the hidden placeholder or outcome message instead): that send denied them.
            const after = messages[index + 1];
            const deniedBySend = after !== undefined && after.role === 'user' && !isApprovalResultMessage(after);
            const isLive = streaming && m === last;
            const line = m.role === 'assistant' ? statusLineFor(m, isLive, m === last, status, stoppedIds) : null;
            return (
              <li key={m.id} data-message-id={m.id} className={`scroll-mt-16 ${m.role === 'user' ? 'self-end' : 'w-full self-start'}`}>
                <article
                  aria-label={m.role === 'user' ? 'You' : 'Ask AI'}
                  className={m.role === 'user' ? 'max-w-[36rem] rounded-2xl rounded-br-md bg-[#0B1E3A] px-4 py-2.5 text-[15px] leading-relaxed text-white' : 'text-[15px] leading-relaxed text-slate-800'}
                >
                  {m.role === 'assistant' && <ToolActivity parts={toolParts} streaming={isLive} />}
                  {m.parts.map((p, i) => (p.type === 'text' ? (m.role === 'user' ? <p key={i} className="whitespace-pre-wrap">{p.text}</p> : <AnswerMarkdown key={i} appOrigin={appOrigin}>{p.text}</AnswerMarkdown>) : null))}
                  {/* The cards read after the answer's lead-in, nearest the composer. Live on the last
                      answer whenever nothing is streaming — in useChat's error state too. */}
                  {cards.map((p) => (
                    <ApprovalCard
                      key={p.toolCallId}
                      part={shownCard(p, deniedBySend)}
                      names={names}
                      interactive={m === last && !streaming && !open?.inFlight}
                      busy={cardsBusy}
                      onAnswer={answerApproval}
                      record={answers[p.approval.id]?.remember}
                      writesOff={!writesEnabled}
                    />
                  ))}
                  {line && <p className={`mt-1 text-xs ${m.metadata?.status === 'failed' ? 'text-red-700' : 'text-slate-500'}`}>{line}</p>}
                </article>
              </li>
            );
          })}
          {bottomLine && <li className="text-sm text-slate-600">{bottomLine}</li>}
          {error && (
            <li role="alert" className="text-sm text-red-700">
              {cardsOutOfSync ? CHAT_GONE_MESSAGE : describeChatError(error)}
              {/* item 6: a first send that then errored still created the chat — a manual way back to it. */}
              {!open && streamedCid && <> <Link href={`/ask?c=${encodeURIComponent(streamedCid)}`} className="underline">Open this chat</Link></>}
            </li>
          )}
        </ol>
      </div>
      {/* Spec 2026-10-04 §4: the composer band sticks to the viewport bottom; the window stays the scroll container. */}
      <div className="sticky bottom-0 border-t border-slate-100 bg-white px-4 pb-3 pt-2 md:px-6">
        <div className="mx-auto max-w-[48rem]">
          <Composer
            value={draft}
            onChange={onDraftChange}
            onSend={send}
            onStop={onStop}
            streaming={streaming}
            disabled={!canSend}
            sendDisabled={cooldown || leaving}
            disabledReason={cantSendReasonEffective}
            // An open chat's model is fixed; a new chat picks one until its first message exists.
            modelControl={open ? <ModelLabel model={open.model} /> : <ModelPicker value={model} onChange={setModel} disabled={streaming || !empty} />}
          />
        </div>
      </div>
    </section>
  );
```

Update the component's doc comment: replace the sentence that starts `Spec §11.3. One hook instance per chat` with `Spec §11.3, laid out per spec 2026-10-04 §4. One hook instance per chat`.

In `ApprovalCard.tsx` change `You can turn this off in the chat&apos;s settings.` to `You can turn this off under Approvals in the side panel.` — and the same string in `ApprovalCard.test.tsx`, which pins it (line 20 as of 005587d: `expect(screen.getByText('You can turn this off in the chat's settings.'))`).

- [ ] **Step 3: Run the Thread suites, the card test, lint, commit**

Run: `pnpm vitest run "app/(app)/ask/Thread.test.tsx" "app/(app)/ask/Thread.live.test.tsx" "app/(app)/ask/ApprovalCard.test.tsx"` — expected: all pass. `pnpm exec eslint "app/(app)/ask/Thread.tsx" "app/(app)/ask/Thread.test.tsx" "app/(app)/ask/ApprovalCard.tsx"`.

```bash
git add "app/(app)/ask/Thread.tsx" "app/(app)/ask/Thread.test.tsx" "app/(app)/ask/ApprovalCard.tsx"
git commit -m "feat(ask): the thread is a centered column — plain answers, navy bubbles, a greeting with the examples on a new chat, the composer in a sticky band with the model inside, scroll to the question on send and to the end on open (spec 2026-10-04 §4)"
```

(`"app/(app)/ask/ApprovalCard.test.tsx"` goes in the `git add` too.)

---

### Task 6: `AskAi` — the shell: sticky rail, drawer below `md`, rail footer

**Files:**
- Modify: `app/(app)/ask/AskAi.tsx`
- Test: `app/(app)/ask/AskAi.test.tsx` (the first test replaced, one added; the rest unchanged), `app/(app)/ask/page.test.tsx` (unchanged; must pass)

- [ ] **Step 1: Replace the first AskAi test and add one**

Replace `'the narrow-screen Chats toggle expands and collapses the rail drawer (spec §11.2, item 11)'` with:

```tsx
  it('the narrow-screen Chats button opens the rail as a drawer; backdrop and Escape close it and return focus (spec 2026-10-04 §6)', () => {
    render(<AskAi conversations={[]} open={null} meter={meter} preview={false} appOrigin={appOrigin} writes={null} />);
    const toggle = screen.getByRole('button', { name: 'Chats' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'ask-ai-rail');
    const rail = document.getElementById('ask-ai-rail');
    expect(rail?.className).toContain('hidden');
    expect(screen.queryByRole('button', { name: 'Close chats' })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(rail?.className).not.toContain('hidden');
    fireEvent.click(screen.getByRole('button', { name: 'Close chats' }));
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(rail?.className).toContain('hidden');
    expect(toggle).toHaveFocus();
    fireEvent.click(toggle);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
  });

  it('the rail footer holds the approval switches (when writes are on) and the usage meter (spec 2026-10-04 §3)', () => {
    const { unmount } = render(<AskAi conversations={[]} open={null} meter={meter} preview appOrigin={appOrigin} writes={{ autoApproveChanges: false, autoApproveDeletes: false }} />);
    const rail = screen.getByRole('complementary', { name: 'Your chats' });
    expect(within(rail).getByRole('group', { name: 'Approvals' })).toBeInTheDocument();
    expect(within(rail).getByRole('progressbar', { name: 'Usage this month' })).toBeInTheDocument();
    expect(within(rail).getByText('Admin preview')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Ask AI' })).toBeInTheDocument();
    unmount();
    render(<AskAi conversations={[]} open={null} meter={meter} preview={false} appOrigin={appOrigin} writes={null} />);
    expect(screen.queryByRole('group', { name: 'Approvals' })).toBeNull();
    expect(screen.getByRole('progressbar', { name: 'Usage this month' })).toBeInTheDocument();
  });
```

Add `within` to the `@testing-library/react` import. Run: `pnpm vitest run "app/(app)/ask/AskAi.test.tsx"` — expected: the two FAIL.

- [ ] **Step 2: Rewrite `AskAi.tsx`** (the state and its comments are kept verbatim; only the imports, `onRailNavigate`, the new `closeRail`/Escape effect, the footer and the `return` change — shown whole for clarity)

```tsx
'use client';
import { useEffect, useRef, useState } from 'react';
import { ASK_LIMITS, DEFAULT_MODEL } from '@/lib/ask/models';
import type { MeterData } from '@/lib/ask/meter';
import type { AskUIMessage } from '@/lib/ask/conversations';
import { CHAT_FULL_MESSAGE, NO_BALANCE_MESSAGE } from '@/lib/ask/messages';
import { Meter } from './Meter';
import { Rail, type RailConversation } from './Rail';
import { Thread, type OpenConversation } from './Thread';
import { WriteSwitches, type WriteToggles } from './WriteSwitches';

export interface AskAiProps {
  conversations: RailConversation[];
  open: (OpenConversation & { messages: AskUIMessage[] }) | null;
  meter: MeterData;
  preview: boolean;
  /** The origin of env.APP_PUBLIC_URL (page.tsx), threaded down to AnswerMarkdown so it can tell an internal keyword link from an external one (Task 9 D9). */
  appOrigin: string;
  /** The account's two "always allow" toggles (spec 2026-10-01 §8); null hides the switches: writes off, or no account row yet (page.tsx). */
  writes: WriteToggles | null;
}

/** The same two toggles, or both null: a server render that brings these again changes nothing (spec 2026-10-01 §8). */
function sameWrites(a: WriteToggles | null, b: WriteToggles | null): boolean {
  return a === b || (!!a && !!b && a.autoApproveChanges === b.autoApproveChanges && a.autoApproveDeletes === b.autoApproveDeletes);
}

/**
 * Spec 2026-10-04 §2: the shell. A 260px rail, sticky under the 52px app bar at full height on md+
 * and a drawer over a backdrop below that; a white main column of at least the viewport's height
 * holding the Thread (which pins its own composer band). The window stays the scroll container.
 */
export function AskAi({ conversations, open, meter, preview, appOrigin, writes }: AskAiProps) {
  const atCap = conversations.length >= ASK_LIMITS.maxChats;
  const full = open !== null && open.messageCount >= ASK_LIMITS.maxMessagesPerChat;
  // The chat-cap reason is decided in Thread instead (fix round 2, item 6) — only it knows about a
  // chat id already learned from the stream, which the cap message must defer to.
  const cantSendReason = meter.exhausted ? NO_BALANCE_MESSAGE : full ? CHAT_FULL_MESSAGE : null;
  // The composer's draft lives here, not in Thread (Task 9 fix round, item 8 / M1): a first send
  // moves the URL to ?c=<id>, and Thread — keyed by the open chat's id — remounts when that happens.
  const [draft, setDraft] = useState('');
  // Below md the rail is a drawer (spec 2026-10-04 §6); on md+ the classes make it a static column
  // whatever this says. Closed by the backdrop, Escape, or picking a chat (onRailNavigate).
  const [railOpen, setRailOpen] = useState(false);
  const chatsButtonRef = useRef<HTMLButtonElement>(null);
  const closeRail = () => {
    setRailOpen(false);
    chatsButtonRef.current?.focus();
  };
  // Escape closes the drawer. The effect only adds and removes the listener; the handler sets state
  // (inline rather than through closeRail, so the effect's only dependency is railOpen).
  useEffect(() => {
    if (!railOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setRailOpen(false);
      chatsButtonRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [railOpen]);
  /**
   * Spec 2026-10-01 §8: the switches' values. (Comment kept verbatim from the current file — the
   * adjust-during-render re-seed from the server's values.)
   */
  const [toggles, setToggles] = useState(writes);
  const [serverWrites, setServerWrites] = useState(writes);
  if (!sameWrites(writes, serverWrites)) {
    setServerWrites(writes);
    setToggles(writes);
  }
  const onAlwaysApproved = (kind: 'changes' | 'deletes') =>
    setToggles((t) => t && { ...t, [kind === 'changes' ? 'autoApproveChanges' : 'autoApproveDeletes']: true });
  /** B1: Thread remounts only on a busy→idle transition. (Comment kept verbatim from the current file.) */
  const busy = !!open?.inFlight;
  const [wasBusy, setWasBusy] = useState(busy);
  const [epoch, setEpoch] = useState(0);
  if (busy !== wasBusy) {
    setWasBusy(busy);
    if (wasBusy) setEpoch((e) => e + 1); // bump only on busy -> idle
  }
  /** Nits round: "New chat" while already on /ask remounts the 'new' thread through this nonce. (Comment kept verbatim.) */
  const [newNonce, setNewNonce] = useState(0);
  const onRailNavigate = () => {
    setRailOpen(false);
    setNewNonce((n) => n + 1);
  };
  const footer = (
    <div className="flex flex-col gap-3">
      {toggles && <WriteSwitches value={toggles} onChange={(update) => setToggles((t) => t && update(t))} />}
      <Meter meter={meter} />
    </div>
  );
  return (
    <div className="flex min-h-[calc(100dvh-52px)] text-slate-800">
      {/* The rail: hidden below md unless open (then a drawer over the backdrop); a static column on md+. */}
      <div id="ask-ai-rail" className={`${railOpen ? 'fixed inset-0 z-40 flex' : 'hidden'} md:static md:z-auto md:flex md:w-[260px] md:flex-none`}>
        {railOpen && <button type="button" aria-label="Close chats" onClick={closeRail} className="absolute inset-0 bg-slate-900/40 md:hidden" />}
        <div className="relative flex h-dvh w-[260px] flex-none flex-col border-r border-slate-200 bg-[#F4F6FA] md:sticky md:top-[52px] md:h-[calc(100dvh-52px)]">
          <Rail conversations={conversations} openId={open?.id ?? null} atCap={atCap} onNavigate={onRailNavigate} preview={preview} footer={footer} />
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col bg-white">
        <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-2 md:hidden">
          <button
            ref={chatsButtonRef}
            type="button"
            onClick={() => setRailOpen((v) => !v)}
            aria-expanded={railOpen}
            aria-controls="ask-ai-rail"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700"
          >
            Chats
          </button>
          <span className="text-sm font-semibold">Ask AI</span>
        </div>
        <Thread
          key={open ? `${open.id}:${epoch}` : `new:${newNonce}`}
          open={open}
          defaultModel={DEFAULT_MODEL}
          cantSendReason={cantSendReason}
          atCap={atCap}
          appOrigin={appOrigin}
          draft={draft}
          onDraftChange={setDraft}
          onAlwaysApproved={onAlwaysApproved}
          // The server's current value, not the local toggles: writes switched off make a waiting card read-only.
          writesEnabled={writes !== null}
        />
      </div>
    </div>
  );
}
```

Where the plan says "Comment kept verbatim", paste the current file's full comment block for that state (the `toggles` block, the B1 block and the nonce block) — do not shorten them.

- [ ] **Step 3: Run the whole Ask suite, the page test, lint, typecheck, commit**

Run: `pnpm vitest run "app/(app)/ask"` — expected: all green (Rail, railGroups, WriteSwitches, Meter, ModelPicker, Composer, Thread, Thread.live, ApprovalCard, AskAi, page, ToolActivity, AnswerMarkdown, useWorkspaceNames). `pnpm exec eslint "app/(app)/ask/AskAi.tsx" "app/(app)/ask/AskAi.test.tsx"`. `pnpm typecheck`.

```bash
git add "app/(app)/ask/AskAi.tsx" "app/(app)/ask/AskAi.test.tsx"
git commit -m "feat(ask): the page shell — a sticky full-height rail flush left with the settings in its footer, a drawer below md, the thread in a white column (spec 2026-10-04 §2, §6)"
```

---

### Task 7: Final review, build, docs, owner-gated ship and smoke

**Files:**
- Modify: `docs/superpowers/specs/2026-10-04-ask-layout-design.md` (only if the landed shape differs), this plan (Results table)

- [ ] **Step 1: Whole-diff review** — dispatch the code reviewer over `git diff <base>..HEAD -- "app/(app)/ask"` against the spec; fix findings with the same implementer; re-review if substantial.
- [ ] **Step 2: `pnpm build`** — expected: clean (the route list is unchanged).
- [ ] **Step 3: Docs** — amend the spec where the landed shape differs; fill the Results table below; commit `docs(ask): arc 5 results`.
- [ ] **Step 4 (owner-gated): push** — `node --env-file=.env.local --import tsx scripts/checkActiveJobs.ts` (idle), then a bare `git push origin main` on the owner's explicit go; watch Vercel + Railway with `gh api repos/raw5045/AmazonAnalytics/commits/<sha>/status --jq '"overall: \(.state)", (.statuses[] | "\(.context): \(.state) @ \(.updated_at)")'`.
- [ ] **Step 5 (owner-gated): visual smoke** on production in the owner's Chrome — desktop ~1440 and ~1100 wide: rail flush left at full height, footer switches and meter, groups; a new chat: greeting + examples, the select; an open chat with tables and an approval card; send → the question scrolls to the top and the answer streams under it; Stop; open a long chat → lands at the end; the Tutorials banner shown and dismissed (the sticky maths); a phone (or DevTools device mode): the Chats drawer, backdrop, Escape, the sticky composer.

## Landed shape (2026-10-04) — where the code differs from the task text above

- Task 2: the confirm row and the normal second-line row are keyed (`key="confirm"` / `key="meta"`); unkeyed, React reused the Delete button's DOM node for "Confirm delete" and `autoFocus` never fired. AskAi's own h1 + chip moved into the rail with Task 2 (one h1 per page; `page.test.tsx` renders the real shell). Review round (b2067a0): rows show the member's local day once known (the groups are local, so the UTC date contradicted them after 8 PM Eastern); the list has `min-h-24` instead of `min-h-0` and the `<aside>` scrolls as a whole; group labels `text-slate-500`; the chat links pass `scroll={false}` (Next's navigation scroll runs after the thread's landing); a `renderToString` test pins the pre-hydration single "Chats" region; an unparseable date lands in Older.
- Task 3: the sr-only note span sits after the `</label>`, not inside it (inside, it joined the switch's accessible name and broke nine tests). The off track is `bg-slate-400` (contrast).
- Task 4: the select has `rounded-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-sky-400`, `min-w-0 truncate`, the chip `max-w-full`; the composer's bottom row has no `flex-wrap`, the slot is `min-w-0`, the right group `flex-none` — the chip is as wide as its longest option (~344px) and spilled out of the box below 375px. The two model lines of `Thread.test.tsx` landed with Task 4 to keep the suite green.
- Task 5: the scroll design was rewritten (spec §4 "Scrolling" carries the landed text): landing = `window.scrollTo({ top: scrollHeight })` in a `useLayoutEffect` once per mount (`scrollIntoView` block "end" left the last message under the sticky band); scroll-to-top for every new TURN START — a question, or the assistant message after a hidden approval message — tracked in a Set ref so ids present at mount and refused-then-removed messages never scroll; the streaming answer's `li` gets `min-h-[calc(100svh-20rem)]` (`GROWN`) via an adjust-during-render `grownId`, released as soon as the next question waits for its answer (otherwise scroll anchoring made the new turn jump when its first chunk landed), with an aria-hidden spacer while the first chunk is awaited; `{ scroll: false }` on both `router.replace` calls and the "Open this chat" link; `onFirstSendMove(id)` → AskAi `keepPlaceFor` → `landAtEnd` false for that chat only; smooth scrolling respects `prefers-reduced-motion`; a busy→idle remount of the same chat (the epoch key) also passes `landAtEnd` false so a reader is not moved mid-turn, the kept answer's id is seeded from the stored messages when the place is kept (the first-send move must not drop the streaming answer's height), and a rail click clears a pending keep-place. `ASK_MODELS` is no longer imported by Thread. Accepted: a full page load paints at the top before the landing; the cards' message is grown during a resend's waiting phase.
- Task 6: opening the drawer moves focus to its New chat link (a keyboard user's focus was otherwise invisible under the column); the drawer covers the app bar on phones by design. Follow-ups: focus containment, body scroll lock, focus return when a rail link closes the drawer.

**Results**

| Check | Result |
|---|---|
| Unit suites (`pnpm vitest run "app/(app)/ask"`) | 14 files / 200 tests green at c96bd7c (2026-10-04); full suite 197 files / 2,139 tests at b487147, the last commit adding 4 folder tests |
| Typecheck / lint (touched files) / build | typecheck clean; eslint clean on every changed file in every round; `pnpm build` exit 0 at f5ba0c9 and again at c96bd7c |
| Final review | Ship (2026-10-04): no Blocking or Important findings; its nits landed in c96bd7c (auto-grow as a layout effect, `wrap-anywhere` on bubbles and answers with `wrap-normal` on tables, two contrast tweaks, a NaN date guard, three pin tests); the rest are follow-ups in spec §10. Per task: Tasks 1-2, 3-4, 5 and 6 each had a spec + quality review and a nits round (14 commits in all, 91b3a46..c96bd7c) |
| Push + deploys | pending the owner's go |
| Visual smoke | pending (spec §9 list, in the owner's Chrome on production) |
