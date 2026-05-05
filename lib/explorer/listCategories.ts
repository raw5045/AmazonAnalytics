/**
 * Lists distinct top-clicked categories present in keyword_current_summary,
 * for the category dropdown in FilterSidebar.
 *
 * The DISTINCT scan over 3.84M rows takes 1-3s on cold cache, so this is
 * cached at the data-cache level with a 1-hour revalidation. The category
 * set only changes after a weekly import, so a fresh import will trigger
 * a refresh much sooner if we wire `revalidateTag('explorer-categories')`
 * into the import pipeline. For now the 1-hour TTL is plenty.
 */
import { unstable_cache } from 'next/cache';
import { neon } from '@neondatabase/serverless';
import { env } from '@/lib/env';

async function fetchCategories(): Promise<string[]> {
  const sql = neon(env.DATABASE_URL);
  const rows = (await sql`
    SELECT DISTINCT top_clicked_category_1_current AS category
    FROM keyword_current_summary
    WHERE top_clicked_category_1_current IS NOT NULL
    ORDER BY top_clicked_category_1_current
  `) as Array<{ category: string }>;
  return rows.map((r) => r.category);
}

export const listCategories = unstable_cache(fetchCategories, ['explorer-categories'], {
  revalidate: 60 * 60, // 1 hour
  tags: ['explorer-categories'],
});
