import type { MetadataRoute } from 'next';

const BASE = process.env.APP_PUBLIC_URL ?? 'https://keywordquarry.com';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/admin', '/app', '/explorer', '/watchlist', '/category-builder', '/api'],
    },
    sitemap: `${BASE}/sitemap.xml`,
  };
}
