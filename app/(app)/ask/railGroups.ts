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
