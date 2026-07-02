/**
 * Terms of Service — launch scaffold, NOT legal advice.
 *
 * This page was drafted to get KeywordQuarry to launch with a reasonable,
 * standard-SaaS terms structure in place. It has not been reviewed by a
 * lawyer. Before onboarding real (non-beta-tester) users, run this through
 * a reputable generator (Termly, iubenda, Termsfeed) or have counsel review
 * it, and resolve every <Placeholder> below — company legal name,
 * jurisdiction, and mailing address are not yet decided.
 */
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: 'The terms that govern your use of KeywordQuarry.',
};

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-amber-100 px-1 font-mono text-[13px] text-amber-900">
      [{children}]
    </span>
  );
}

function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold text-gray-900">{n}. {title}</h2>
      <div className="mt-2 space-y-2 text-[15px] leading-relaxed text-gray-600">{children}</div>
    </section>
  );
}

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight text-gray-900">Terms of Service</h1>
      <p className="mt-2 text-sm text-gray-500">Last updated: July 1, 2026</p>

      <Section n={1} title="Acceptance of terms">
        <p>
          KeywordQuarry is operated by <Placeholder>COMPANY LEGAL NAME</Placeholder>.
          By accessing or using KeywordQuarry, you agree to be bound by these
          terms. If you don&apos;t agree to them, please don&apos;t use the
          service.
        </p>
      </Section>

      <Section n={2} title="The service">
        <p>
          KeywordQuarry provides keyword-research analytics derived from
          Amazon report data. The service is currently in beta and is
          provided on an as-is basis. Features may change, be added,
          suspended, or discontinued at any time as the product evolves.
        </p>
      </Section>

      <Section n={3} title="Accounts">
        <p>
          You must provide accurate information when creating an account and
          keep your login credentials safe. You&apos;re responsible for all
          activity that happens under your account. Accounts are for one
          person each, and you must be at least 18 years old to use
          KeywordQuarry.
        </p>
      </Section>

      <Section n={4} title="Acceptable use">
        <p>
          You may not scrape, bulk-export, or resell KeywordQuarry&apos;s
          data, attempt to reverse engineer the service, place abusive load
          on our systems, or otherwise interfere with the service&apos;s
          normal operation. You may not use KeywordQuarry for any unlawful
          purpose. We may suspend or terminate accounts that violate this
          policy.
        </p>
      </Section>

      <Section n={5} title="Intellectual property">
        <p>
          KeywordQuarry&apos;s service, software, and compiled datasets are
          owned by us or our licensors. The content you create in the
          app — watchlists, custom categories, and saved views — remains
          yours.
        </p>
      </Section>

      <Section n={6} title="Third-party data and Amazon">
        <p>
          KeywordQuarry&apos;s data is derived from third-party sources,
          including Amazon reports, and we don&apos;t guarantee its accuracy
          or completeness. KeywordQuarry is not affiliated with, endorsed
          by, or sponsored by Amazon.com, Inc. or its affiliates.
        </p>
      </Section>

      <Section n={7} title="Disclaimers">
        <p>
          The service is provided &quot;as is&quot; without warranties of
          any kind. Volume and competition figures are directional
          estimates, not guarantees. Nothing in KeywordQuarry constitutes
          business or financial advice — the decisions you make based on
          this data are your own.
        </p>
      </Section>

      <Section n={8} title="Limitation of liability">
        <p>
          To the maximum extent permitted by law, we are not liable for any
          indirect, incidental, or consequential damages arising from your
          use of KeywordQuarry. Our total liability for any claim is capped
          at the greater of $100 or the fees you paid us in the past 12
          months.
        </p>
      </Section>

      <Section n={9} title="Termination">
        <p>
          You may stop using KeywordQuarry at any time. We may suspend or
          terminate your access if you breach these terms. Sections that by
          their nature should survive termination — including intellectual
          property, disclaimers, and limitation of liability — continue to
          apply after your account is closed.
        </p>
      </Section>

      <Section n={10} title="Changes to these terms">
        <p>
          We may update these terms from time to time. We&apos;ll notify you
          of material changes through the service or by email. Continuing
          to use KeywordQuarry after changes take effect means you accept
          the updated terms.
        </p>
      </Section>

      <Section n={11} title="Governing law">
        <p>
          These terms are governed by the laws of <Placeholder>JURISDICTION</Placeholder>,
          without regard to conflict-of-law principles.
        </p>
      </Section>

      <Section n={12} title="Contact">
        <p>
          Questions about these terms? Reach out via the{' '}
          <Link href="/contact" className="text-blue-700 underline">contact page</Link>.
        </p>
      </Section>
    </div>
  );
}
