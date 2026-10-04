// app/(app)/ask/railGroups.test.ts
import { describe, it, expect } from 'vitest';
import { groupConversations, groupLabelFor, localDayKey } from './railGroups';

// 2026-10-04T12:00Z is the same local calendar day in every zone within ±11h, so whole-day offsets
// from it give the same day difference wherever the tests run.
const NOON = Date.UTC(2026, 9, 4, 12);
const at = (daysAgo: number) => new Date(NOON - daysAgo * 86_400_000).toISOString();
const today = localDayKey(new Date(NOON));

describe('railGroups (spec 2026-10-04 §3)', () => {
  it('labels by whole local days: today, yesterday, up to seven days back, then older; a future time counts as today, an unparseable one as older', () => {
    expect(groupLabelFor(at(0), today)).toBe('Today');
    expect(groupLabelFor(at(1), today)).toBe('Yesterday');
    expect(groupLabelFor(at(2), today)).toBe('Previous 7 days');
    expect(groupLabelFor(at(7), today)).toBe('Previous 7 days');
    expect(groupLabelFor(at(8), today)).toBe('Older');
    expect(groupLabelFor(at(-1), today)).toBe('Today');
    expect(groupLabelFor('not a date', today)).toBe('Older');
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
