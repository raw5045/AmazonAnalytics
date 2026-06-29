import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import { redirect } from 'next/navigation';

const TOOLS = [
  {
    href: '/explorer',
    title: 'Keyword Explorer',
    desc: 'Search, filter, and sort keywords by rank, estimated volume, and week-over-week movement.',
  },
  {
    href: '/watchlist',
    title: 'Watchlist',
    desc: 'Star keywords to track them and get a weekly digest email of their movement.',
  },
  {
    href: '/category-builder',
    title: 'Category Builder',
    desc: 'Group Amazon leaf categories into your own buckets to filter the explorer.',
  },
];

export default async function AppHome() {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-semibold">Welcome, {user.name ?? user.email}</h1>
      <p className="mt-3 max-w-2xl text-gray-600">
        Explore Amazon <strong>SFR</strong> data — Search Frequency Rank, a measure of how often
        shoppers search a term (lower rank = more searched). Track ranks over time, build a
        watchlist, and group categories your way.
      </p>

      <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-gray-500">
        Getting started
      </h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {TOOLS.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className="block rounded-lg border border-gray-200 p-4 transition-colors hover:border-blue-300 hover:bg-blue-50"
          >
            <div className="text-sm font-semibold text-gray-900">{t.title}</div>
            <p className="mt-1 text-xs text-gray-600">{t.desc}</p>
            <span className="mt-2 inline-block text-xs font-medium text-blue-700">Open →</span>
          </Link>
        ))}
      </div>

      {user.role === 'admin' && (
        <p className="mt-6">
          <Link href="/admin" className="text-sm text-gray-600 underline hover:text-gray-900">
            Go to admin →
          </Link>
        </p>
      )}
    </main>
  );
}
