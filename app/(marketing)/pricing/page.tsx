import type { Metadata } from 'next';
import Link from 'next/link';
import { Check } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'KeywordQuarry is free during beta. Full access, no credit card.',
};

const INCLUDED = [
  'Full Keyword Explorer — every keyword, every filter',
  'Weekly-fresh data + 52 weeks of history',
  'Top-3-clicked competition lens + title-gap flags',
  'Fake-volume detection and filtering',
  'Exact leaf categories + custom category buckets',
  'Watchlist with weekly email digest',
];

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-14 text-center sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight text-gray-900">Pricing</h1>
      <p className="mt-3 text-gray-600">Simple, for now: everything is free while we&apos;re in beta.</p>

      <div className="mx-auto mt-10 max-w-md rounded-xl border-2 border-blue-500 p-8 text-left">
        <p className="text-sm font-semibold text-blue-700">Beta</p>
        <p className="mt-2 text-4xl font-semibold text-gray-900">
          Free
          <span className="ml-2 text-base font-normal text-gray-500">during beta</span>
        </p>
        <ul className="mt-6 space-y-3">
          {INCLUDED.map((item) => (
            <li key={item} className="flex gap-2.5">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" aria-hidden />
              <span className="text-sm leading-relaxed text-gray-700">{item}</span>
            </li>
          ))}
        </ul>
        <Link
          href="/sign-up"
          className="mt-8 block rounded-md bg-blue-600 px-6 py-3 text-center text-base font-medium text-white hover:bg-blue-700"
        >
          Get started free
        </Link>
        <p className="mt-3 text-center text-xs text-gray-500">No credit card required.</p>
      </div>

      <p className="mx-auto mt-8 max-w-md text-sm text-gray-500">
        Paid plans will arrive after beta. Beta users will always get clear
        notice before anything changes.
      </p>
    </div>
  );
}
