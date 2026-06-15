/**
 * Parse Next.js searchParams (string | string[] | undefined) into a
 * fully-populated ExplorerFilters object with all defaults applied.
 *
 * Pure function — used both by the server component (page.tsx) and by
 * unit tests for buildQuery. Invalid values fall back to defaults
 * silently rather than throwing; the explorer should never 500 on a
 * malformed URL — it should just render its default view.
 */
import type {
  ExplorerFilters,
  JumpKey,
  MatchMode,
  SeverityKey,
  SortKey,
  TitleMatchMode,
  WindowKey,
} from './types';
import { findJumpPreset, type JumpMetric } from './jumpPresets';

export const EXPLORER_DEFAULTS: ExplorerFilters = {
  window: '1w',
  q: null,
  rankMin: null,
  rankMax: null,
  jump: null,
  jumpMetric: 'rank',
  jumpFrom: null,
  jumpTo: null,
  category: null,
  leafCategories: [],
  severities: ['none', 'warning'],
  titleSlots: [1, 2, 3],
  titleMatchMode: null,
  matchMode: 'loose',
  sort: 'rank',
  page: 1,
  perPage: 100,
};

export type SearchParamsLike = Record<string, string | string[] | undefined>;

const WINDOW_VALUES: WindowKey[] = ['1w', '4w', '13w', '26w', '52w'];
const SORT_VALUES: SortKey[] = [
  'rank', 'rank_desc',
  'imp', 'decline',
  'title_gap',
  'avg_price_asc', 'avg_price_desc',
  'avg_reviews_asc', 'avg_reviews_desc',
  'added_asc', 'added_desc',
];
const SEVERITY_VALUES: SeverityKey[] = ['none', 'warning', 'critical'];
const JUMP_VALUES: JumpKey[] = [
  '500k_to_100k', '100k_to_50k', '100k_to_10k', '50k_to_10k',
  'v5k_to_15k', 'v15k_to_30k', 'v30k_to_100k', 'v15k_to_100k',
  'custom',
];
const TITLE_MODE_VALUES: TitleMatchMode[] = ['any', 'all'];
const MATCH_MODE_VALUES: MatchMode[] = ['strict', 'loose'];

function getOne(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function parseEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (!value) return fallback;
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function parseEnumNullable<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): T | null {
  if (!value) return null;
  return (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

function parseSeverities(value: string | undefined): SeverityKey[] {
  if (!value) return EXPLORER_DEFAULTS.severities;
  const parts = value.split(',').filter((p) => SEVERITY_VALUES.includes(p as SeverityKey)) as SeverityKey[];
  // Empty after filter = use defaults rather than "no severity allowed" (which would return zero rows)
  return parts.length > 0 ? parts : EXPLORER_DEFAULTS.severities;
}

/**
 * Comma-separated `leaf` URL param → string[]. URL-encoded commas
 * inside category names would be ambiguous, but Keepa leaves don't
 * contain commas so we treat `,` as the delimiter unambiguously.
 * Empty / missing → empty array.
 */
function parseLeafCategories(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseTitleSlots(value: string | undefined): number[] {
  if (!value) return EXPLORER_DEFAULTS.titleSlots;
  const parts = value
    .split(',')
    .map((p) => parseInt(p, 10))
    .filter((n) => n === 1 || n === 2 || n === 3);
  return parts.length > 0 ? parts : EXPLORER_DEFAULTS.titleSlots;
}

export function parseExplorerFilters(searchParams: SearchParamsLike): ExplorerFilters {
  const window = parseEnum(getOne(searchParams.window), WINDOW_VALUES, EXPLORER_DEFAULTS.window);
  const sort = parseEnum(getOne(searchParams.sort), SORT_VALUES, EXPLORER_DEFAULTS.sort);
  let jump = parseEnumNullable(getOne(searchParams.jump), JUMP_VALUES);
  let jumpMetric: JumpMetric = parseEnum(getOne(searchParams.jump_metric), ['rank', 'volume'] as const, 'rank');
  const jumpFrom = parsePositiveInt(getOne(searchParams.jump_from));
  const jumpTo = parsePositiveInt(getOne(searchParams.jump_to));
  // A preset is self-describing: infer the metric from it (so old/shared URLs
  // with just ?jump=v15k_to_30k work). jump_metric only governs 'custom'.
  if (jump && jump !== 'custom') {
    const found = findJumpPreset(jump);
    if (found) jumpMetric = found.metric;
  }
  // Drop a custom jump whose thresholds aren't valid for its metric:
  //   rank  improves as the number falls  -> from > to
  //   volume improves as the number rises -> from < to
  if (jump === 'custom') {
    const ordered = jumpFrom !== null && jumpTo !== null
      && (jumpMetric === 'rank' ? jumpFrom > jumpTo : jumpFrom < jumpTo);
    if (!ordered) jump = null;
  }
  const titleMatchMode = parseEnumNullable(getOne(searchParams.title_match), TITLE_MODE_VALUES);
  const matchMode = parseEnum(getOne(searchParams.match_mode), MATCH_MODE_VALUES, EXPLORER_DEFAULTS.matchMode);

  const q = (getOne(searchParams.q) ?? '').trim();

  const rankMin = parsePositiveInt(getOne(searchParams.rank_min));
  const rankMax = parsePositiveInt(getOne(searchParams.rank_max));

  const severities = parseSeverities(getOne(searchParams.severity));
  const titleSlots = parseTitleSlots(getOne(searchParams.titles));

  const page = parsePositiveInt(getOne(searchParams.page)) ?? EXPLORER_DEFAULTS.page;
  const perPageRaw = parsePositiveInt(getOne(searchParams.per_page)) ?? EXPLORER_DEFAULTS.perPage;
  // Hard cap — protect the DB from a hostile per_page value.
  const perPage = Math.min(perPageRaw, 500);

  return {
    window,
    q: q.length >= 3 ? q : null,
    rankMin,
    rankMax,
    jump,
    jumpMetric,
    jumpFrom: jump === 'custom' ? jumpFrom : null,
    jumpTo: jump === 'custom' ? jumpTo : null,
    category: getOne(searchParams.category) ?? null,
    leafCategories: parseLeafCategories(getOne(searchParams.leaf)),
    severities,
    titleSlots,
    titleMatchMode,
    matchMode,
    sort,
    page,
    perPage,
  };
}
