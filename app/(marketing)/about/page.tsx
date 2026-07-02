import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'About',
  description:
    'KeywordQuarry was built by an Amazon operator who spent 12+ years scaling a brand to $75M+ in Amazon sales.',
};

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight text-gray-900">
        About KeywordQuarry
      </h1>
      <div className="mt-6 space-y-4 text-[15px] leading-relaxed text-gray-600">
        <p>
          KeywordQuarry was built by an Amazon operator who spent 12+ years
          scaling a brand to <span className="font-semibold text-gray-900">$75M+ in Amazon sales</span> —
          with keyword research as the growth engine behind every launch.
        </p>
        <p>
          Along the way, the same problems kept coming up with every keyword
          tool on the market: competition numbers distorted by irrelevant
          products, data that updates once a month, bot-inflated keywords that
          look like gold rushes, and categories too broad to be useful.
        </p>
        <p>
          KeywordQuarry is the tool that should have existed: weekly-fresh
          demand data, competition measured from the top 3 products shoppers
          actually click, fake volume flagged and filtered, and every keyword
          mapped to its exact leaf category. Not theory from a software team —
          the exact methods that built a real brand, in a tool.
        </p>
      </div>
      <div className="mt-10 rounded-xl border border-gray-200 bg-gray-50 px-6 py-5">
        <p className="text-sm leading-relaxed text-gray-600">
          KeywordQuarry is an independent product. It is not affiliated with,
          endorsed by, or sponsored by Amazon.com, Inc. or its affiliates.
          “Amazon” is a trademark of Amazon.com, Inc.
        </p>
      </div>
      <div className="mt-10">
        <Link
          href="/sign-up"
          className="inline-block rounded-md bg-blue-600 px-6 py-3 text-base font-medium text-white hover:bg-blue-700"
        >
          Get started free
        </Link>
      </div>
    </div>
  );
}
