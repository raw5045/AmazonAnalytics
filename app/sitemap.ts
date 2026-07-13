import type { MetadataRoute } from 'next';

const BASE = process.env.APP_PUBLIC_URL ?? 'https://keywordquarry.com';

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = ['', '/help', '/pricing', '/about', '/contact', '/terms', '/privacy'];
  return routes.map((path) => ({
    url: `${BASE}${path}`,
    lastModified: new Date(),
    changeFrequency: path === '' ? 'weekly' : 'monthly',
    priority: path === '' ? 1 : 0.6,
  }));
}
