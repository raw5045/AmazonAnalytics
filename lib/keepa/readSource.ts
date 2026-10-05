// lib/keepa/readSource.ts
/**
 * Which table the app reads Keepa facts from (spec 2026-10-05 §7). `weekly` = asin_weekly_data
 * at the keyword's current week (the pre-arc-6 model); `products` = the asin_products catalog
 * written by the Keepa service. Set KEEPA_READ_SOURCE=products on Vercel and the Railway worker
 * to flip; an env change, not a deploy. Read at call time so a flip needs no restart on the worker.
 */
export type KeepaReadSource = 'weekly' | 'products';

export function keepaReadSource(env: Record<string, string | undefined> = process.env): KeepaReadSource {
  return env.KEEPA_READ_SOURCE === 'products' ? 'products' : 'weekly';
}
