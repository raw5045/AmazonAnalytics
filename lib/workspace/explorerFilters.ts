/**
 * Research search → Explorer filters (spec 2026-09-30 §5). Pure, no I/O. Serves the
 * `explorerUrl` on every search answer (lib/research/service.ts) and the saved-view tools
 * (lib/workspace/service.ts). The caller runs the search's own validation first
 * (parseSearchInput → applyPresets → resolveScope); this module only maps.
 */
import { isDeepStrictEqual } from 'node:util';
import { filtersToQueryString } from '@/lib/explorer/export/query';
import { jumpPresetsFor } from '@/lib/explorer/jumpPresets';
import { EXPLORER_DEFAULTS } from '@/lib/explorer/parseFilters';
import type { ExplorerFilters, JumpKey, SortKey } from '@/lib/explorer/types';
import type { Filters, IntegerRange, Sort, Window } from '@/lib/research/contracts';

export interface ConvertInput {
  /** The search's effective filters, after applyPresets. */
  filters: Filters;
  sort: Sort;
  /** The window the search ran with (its effective comparisonWindow), so the Explorer shows the same change columns. */
  window: Window;
  /** Terminal leaves expanded from the taxonomy selections and explicit leaf paths only — never from custom selections, which pass by id. */
  leaves: string[];
}
export interface ConvertResult {
  filters: ExplorerFilters;
  /** What could not carry over, in plain words; the guide tells the AI to relay every entry. */
  notes: string[];
}

export const NOTE_BASELINE = "The Explorer's movement filter also counts keywords that had no earlier value, so it can show a few more rows than this search.";
export const NOTE_DELTA = 'The Explorer cannot filter on the size of the change itself; the from/to move was kept.';
export const NOTE_PRIOR_ONLY = 'The Explorer cannot filter on the earlier value alone; that part of the movement filter was dropped.';
export const NOTE_PRIOR_BAND = 'The Explorer takes a single from-value for a move; the other bound on the earlier value was dropped.';
export const NOTE_JUMP_INVALID = 'The Explorer only accepts a move from a worse rank to a better one, or from a lower volume to a higher one; this move was dropped.';
export const NOTE_WORD_COUNT_SORT = 'The Explorer cannot sort by word count; the view opens sorted by rank.';
export const NOTE_LINK_TOO_LONG = 'Too many leaf categories for a link; save it as a view instead.';
/** Vercel's CDN rejects URLs over 14 KB (§5.6); stay well under it. */
export const MAX_EXPLORER_URL_BYTES = 12_000;

/** Inclusive Explorer bounds for an exact research range: gt n → n+1, lt n → n−1 (§5.2). */
function inclusive(r: IntegerRange | null | undefined): { min: number | null; max: number | null } {
  if (!r) return { min: null, max: null };
  const min = r.gte !== undefined ? r.gte : r.gt !== undefined ? r.gt + 1 : null;
  const max = r.lte !== undefined ? r.lte : r.lt !== undefined ? r.lt - 1 : null;
  return { min, max };
}

const tighterMin = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));
const tighterMax = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.min(a, b));

/** Narrows the plain range on `metric` by an inclusive bound pair — a movement bound the jump cannot carry (§5.3). */
function tightenPlainRange(out: ExplorerFilters, metric: 'rank' | 'volume', bounds: { min: number | null; max: number | null }): void {
  if (metric === 'rank') {
    out.rankMin = tighterMin(out.rankMin, bounds.min);
    out.rankMax = tighterMax(out.rankMax, bounds.max);
  } else {
    out.volMin = tighterMin(out.volMin, bounds.min);
    out.volMax = tighterMax(out.volMax, bounds.max);
  }
}

/**
 * §5.3. The Explorer's jump is "was on one side of `from`, now past `to`": rank compiles to
 * `(prior > from OR prior IS NULL) AND current < to`, volume to `(prior < from OR prior IS NULL)
 * AND current > to`. Exact research comparators shift onto those strict bounds; whatever the
 * jump cannot carry either tightens the plain range (current side, exact) or is dropped with a note.
 */
function convertMovement(m: NonNullable<Filters['movement']>, out: ExplorerFilters, notes: string[]): void {
  if (m.delta) notes.push(NOTE_DELTA);
  const prior = m.prior;
  const current = m.current;
  const from = m.metric === 'rank'
    ? (prior?.gte !== undefined ? prior.gte - 1 : prior?.gt)
    : (prior?.lte !== undefined ? prior.lte + 1 : prior?.lt);
  const to = m.metric === 'rank'
    ? (current?.lte !== undefined ? current.lte + 1 : current?.lt)
    : (current?.gte !== undefined ? current.gte - 1 : current?.gt);
  const priorHasOtherSide = m.metric === 'rank'
    ? prior?.lt !== undefined || prior?.lte !== undefined
    : prior?.gt !== undefined || prior?.gte !== undefined;
  let mapped = false;
  if (from !== undefined && to !== undefined) {
    const valid = m.metric === 'rank' ? from > to : from < to;
    if (valid) {
      const preset = jumpPresetsFor(m.metric).find((p) => p.from === from && p.to === to);
      out.jump = preset ? (preset.id as JumpKey) : 'custom';
      out.jumpMetric = m.metric;
      out.jumpFrom = preset ? null : from;
      out.jumpTo = preset ? null : to;
      // The current-side bound the jump does not read is still exact as a plain range.
      const leftover = inclusive(current);
      tightenPlainRange(out, m.metric, m.metric === 'rank' ? { min: leftover.min, max: null } : { min: null, max: leftover.max });
      if (priorHasOtherSide) notes.push(NOTE_PRIOR_BAND);
    } else {
      notes.push(NOTE_JUMP_INVALID);
      tightenPlainRange(out, m.metric, inclusive(current));
    }
    mapped = true;
  } else {
    // No from/to pair the Explorer's jump can read. The schema guarantees a non-null `prior`
    // carries at least one bound, so any prior here is lost: with a current bound it is a move
    // the Explorer cannot express (e.g. a decline, or a bound on the side the jump never reads);
    // alone it is a bound on the earlier value only.
    if (prior) notes.push(current ? NOTE_JUMP_INVALID : NOTE_PRIOR_ONLY);
    if (current) {
      // A current-side bound is still exact as the plain range on the same metric.
      tightenPlainRange(out, m.metric, inclusive(current));
      mapped = true;
    }
  }
  if (mapped && m.baseline === 'observed_only') notes.push(NOTE_BASELINE);
}

/** §5.4. */
function convertSort(sort: Sort, notes: string[]): SortKey {
  switch (sort.field) {
    case 'estimatedMonthlySearches':
      return sort.direction === 'desc' ? 'rank' : 'rank_desc';
    case 'rank':
      return sort.direction === 'asc' ? 'rank' : 'rank_desc';
    case 'averageReviews':
      return sort.direction === 'asc' ? 'avg_reviews_asc' : 'avg_reviews_desc';
    case 'volumeDelta':
      return sort.direction === 'desc' ? 'imp' : 'decline';
    case 'wordCount':
      notes.push(NOTE_WORD_COUNT_SORT);
      return 'rank';
  }
}

export function toExplorerFilters(input: ConvertInput): ConvertResult {
  const f = input.filters;
  const notes: string[] = [];
  const out: ExplorerFilters = {
    ...EXPLORER_DEFAULTS,
    window: input.window,
    qExclude: [...f.excludeTerms],
    leafPaths: [],
    customCategoryIds: [],
    severities: [...f.severities],
    titleSlots: [...EXPLORER_DEFAULTS.titleSlots],
  };
  if (f.text) {
    out.q = f.text.value;
    out.qMode = f.text.mode;
  }
  ({ min: out.rankMin, max: out.rankMax } = inclusive(f.rank));
  ({ min: out.volMin, max: out.volMax } = inclusive(f.estimatedMonthlySearches));
  ({ min: out.reviewsMin, max: out.reviewsMax } = inclusive(f.averageReviews));
  ({ min: out.wordsMin, max: out.wordsMax } = inclusive(f.wordCount));
  out.category = f.broadCategory;
  if (f.titleGap) {
    out.titleSlots = [...f.titleGap.slots];
    out.titleMatchMode = f.titleGap.quantifier;
    out.matchMode = f.titleGap.mode;
  }
  out.customCategoryIds = f.categories.selections.filter((s) => s.kind === 'custom').map((s) => s.id);
  out.leafPaths = [...input.leaves];
  if (f.movement) convertMovement(f.movement, out, notes);
  out.sort = convertSort(input.sort, notes);
  return { filters: out, notes };
}

/** §5.5: the fields that differ from the Explorer defaults; never pagination; `jumpMetric` only with a jump. */
export function compactExplorerFilters(f: ExplorerFilters): Partial<ExplorerFilters> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(EXPLORER_DEFAULTS) as Array<keyof ExplorerFilters>) {
    if (key === 'page' || key === 'perPage') continue;
    if (key === 'jumpMetric' && f.jump === null) continue;
    if (!isDeepStrictEqual(f[key], EXPLORER_DEFAULTS[key])) out[key] = f[key];
  }
  return out as Partial<ExplorerFilters>;
}

const base = (appUrl: string) => appUrl.replace(/\/+$/, '');

/** §5.6: the Explorer opened with `filters`, or null when the link would be too long for Vercel's CDN. */
export function explorerUrlFor(appUrl: string, filters: ExplorerFilters): string | null {
  const url = `${base(appUrl)}/explorer?${filtersToQueryString(filters)}`;
  return Buffer.byteLength(url, 'utf8') > MAX_EXPLORER_URL_BYTES ? null : url;
}

export function savedViewUrlFor(appUrl: string, id: string): string {
  return `${base(appUrl)}/explorer?view=${id}`;
}

export function customCategoryUrlFor(appUrl: string, id: string): string {
  return `${base(appUrl)}/explorer?custom=${id}`;
}
