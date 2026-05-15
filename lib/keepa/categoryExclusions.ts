/**
 * Single source of truth for the 24 top-level Amazon SFR categories we
 * exclude from Keepa enrichment.
 *
 * Three buckets:
 *   - Digital: non-physical goods (ebooks, apps, downloads, software).
 *     Keepa doesn't price-track these meaningfully; enrichment is wasted.
 *   - Grocery (Fresh + Protein): restricted categories where Keepa has
 *     limited / no data and our use case doesn't need them.
 *   - Gift cards: not real ASINs in the conventional sense; no useful
 *     price/review/category data to enrich.
 *
 * Used by:
 *   - scripts/countEnrichableAsins.ts — scope-funnel diagnostic
 *   - inngest/functions/enrichKeepaForWeek.ts — candidate filtering
 *   - scripts/backfillKeepaCurrentWeek.ts — dev smoke test
 *
 * Update procedure: edit the set below. If you remove an entry,
 * previously-skipped ASINs in that category will be picked up on the
 * next weekly enrichment cycle (no migration needed).
 */
export const EXCLUDED_CATEGORIES: ReadonlySet<string> = new Set([
  // ----- Digital (non-physical) -----
  'Digital_Video_Download',
  'Digital_Ebook_Purchase',
  'Digital_Music_Purchase',
  'Mobile_Apps',
  'Audible',
  'Digital_Video_Games',
  'Digital_Products_3',
  'Digital_Text',
  'Digital_Software',
  'Digital_Devices_4',
  'Digital_Text_2',
  'Digital_Periodicals',
  'Digital_Health_Services',
  'Digital_Products_9',
  'Digital_Products_10',
  'Video',
  'Software',

  // ----- Grocery: Fresh + Protein -----
  'Fresh_Perishable',
  'Fresh_Produce',
  'Fresh_Prepared',
  'Protein',

  // ----- Gift cards -----
  'Gift Card',
  'Consumables_Physical_Gift_Cards',
  'Consumables_Email_Gift_Cards',
]);

/** Predicate form: true iff this top-level category is on the exclusion list. */
export function isExcludedCategory(category: string | null | undefined): boolean {
  if (!category) return false;
  return EXCLUDED_CATEGORIES.has(category);
}

/** Array form, useful for parameterizing SQL `NOT IN (...)` clauses. */
export const EXCLUDED_CATEGORIES_ARRAY: readonly string[] = Array.from(EXCLUDED_CATEGORIES);
