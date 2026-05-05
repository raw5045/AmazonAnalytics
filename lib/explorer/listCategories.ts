/**
 * Lists distinct top-clicked categories present in keyword_current_summary,
 * for the category dropdown in FilterSidebar.
 *
 * Cached per server-component render via Next.js's React `cache()` so multiple
 * components (e.g., a future header chip + the sidebar) share one query per
 * request. Spec section 1.5 explicitly calls out "1-hour" caching but for
 * Plan 3.2 V1 we do request-scoped only — short, simple, and the GROUP BY
 * is fast on the indexed (current_week_end_date, top_clicked_category_1_current)
 * index. Promote to a longer cache once we observe load.
 */
import { cache } from 'react';
import { neon } from '@neondatabase/serverless';
import { env } from '@/lib/env';

export const listCategories = cache(async (): Promise<string[]> => {
  const sql = neon(env.DATABASE_URL);
  const rows = (await sql`
    SELECT DISTINCT top_clicked_category_1_current AS category
    FROM keyword_current_summary
    WHERE top_clicked_category_1_current IS NOT NULL
    ORDER BY top_clicked_category_1_current
  `) as Array<{ category: string }>;
  return rows.map((r) => r.category);
});
