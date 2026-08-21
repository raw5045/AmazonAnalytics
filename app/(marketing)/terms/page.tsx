/**
 * Terms of Service — complete launch draft (2026-08-21), NOT legal advice.
 *
 * Drafted for beta launch as an individual operator (name + DBA). Three
 * identity slots remain as <Placeholder>: operator legal name, governing-law
 * state, and mailing address (virtual mailbox pending). Everything else is
 * final draft copy reviewed by the owner. A professional/counsel review is
 * still recommended before any paid plans launch; swap the operator name to
 * the LLC when one is formed.
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
      <p className="mt-2 text-sm text-gray-500">Last updated: August 21, 2026</p>

      <Section n={1} title="Acceptance of terms">
        <p>
          KeywordQuarry (&quot;the service&quot;) is operated by{' '}
          <Placeholder>OPERATOR LEGAL NAME</Placeholder>, doing business as
          KeywordQuarry (&quot;we&quot;, &quot;us&quot;). By accessing or
          using KeywordQuarry, you agree to be bound by these terms. If you
          don&apos;t agree to them, please don&apos;t use the service.
        </p>
      </Section>

      <Section n={2} title="The service and the beta period">
        <p>
          KeywordQuarry provides keyword-research analytics for Amazon
          sellers: search-frequency rankings, modeled search-volume
          estimates, competition signals, and related tools.
        </p>
        <p>
          The service is currently in <strong>beta</strong> and is free to
          use. During beta, features may change, be added, or be removed as
          the product evolves, and we don&apos;t guarantee uninterrupted
          availability. We may introduce paid plans in the future; if we do,
          we&apos;ll give you clear notice before anything you use becomes
          paid, and you&apos;ll never be charged without explicitly signing
          up for a paid plan.
        </p>
      </Section>

      <Section n={3} title="Accounts">
        <p>
          You must provide accurate information when creating an account and
          keep your login credentials safe. You&apos;re responsible for
          activity that happens under your account, and accounts are for one
          person each — please don&apos;t share logins. You must be at least
          18 years old to use KeywordQuarry.
        </p>
      </Section>

      <Section n={4} title="Acceptable use">
        <p>
          You may not scrape, crawl, bulk-export, or systematically copy
          KeywordQuarry&apos;s data; resell, redistribute, or make the data
          available to third parties as a dataset or competing service;
          access the service by any automated means; attempt to reverse
          engineer the service or its estimates; place abusive load on our
          systems; or use KeywordQuarry for any unlawful purpose. We may
          suspend or terminate accounts that violate this policy.
        </p>
        <p>
          Normal product use — researching keywords for your own products
          and business, including screenshots and excerpts you share in the
          ordinary course of that work — is always fine.
        </p>
      </Section>

      <Section n={5} title="Intellectual property and feedback">
        <p>
          KeywordQuarry&apos;s service, software, branding, and compiled
          datasets are owned by us or our licensors. The content you create
          in the app — watchlists, custom categories, and saved views —
          remains yours. If you send us feedback or suggestions, you agree
          we may use them to improve the service without obligation to you.
        </p>
      </Section>

      <Section n={6} title="Third-party data and Amazon">
        <p>
          KeywordQuarry&apos;s analytics are derived from Amazon reporting
          data combined with our own modeling, and we don&apos;t guarantee
          their accuracy or completeness. KeywordQuarry is an independent
          product: it is not affiliated with, endorsed by, or sponsored by
          Amazon.com, Inc. or its affiliates. &quot;Amazon&quot; and related
          marks are trademarks of Amazon.com, Inc.
        </p>
      </Section>

      <Section n={7} title="Estimates, not guarantees">
        <p>
          Search-volume figures in KeywordQuarry are <strong>modeled
          estimates</strong>, calibrated against real search data but
          carrying meaningful uncertainty — treat them as directional, not
          exact. Rankings, competition signals, and flags are likewise
          informational. Nothing in KeywordQuarry constitutes business,
          financial, or investment advice; decisions you make based on this
          data — product launches, inventory purchases, advertising spend —
          are your own and at your own risk.
        </p>
      </Section>

      <Section n={8} title="Disclaimer of warranties">
        <p>
          The service is provided &quot;as is&quot; and &quot;as
          available&quot; without warranties of any kind, express or
          implied, including merchantability, fitness for a particular
          purpose, and non-infringement.
        </p>
      </Section>

      <Section n={9} title="Limitation of liability">
        <p>
          To the maximum extent permitted by law, we are not liable for any
          indirect, incidental, special, or consequential damages — including
          lost profits, lost revenue, or business interruption — arising from
          your use of KeywordQuarry. Our total liability for any claim is
          capped at the greater of $100 or the fees you paid us in the 12
          months before the claim arose.
        </p>
      </Section>

      <Section n={10} title="Termination">
        <p>
          You may stop using KeywordQuarry at any time, and you can delete
          your account whenever you like. We may suspend or terminate your
          access if you breach these terms. Sections that by their nature
          should survive termination — including intellectual property,
          disclaimers, and limitation of liability — continue to apply after
          your account is closed.
        </p>
      </Section>

      <Section n={11} title="Changes to these terms">
        <p>
          We may update these terms from time to time. We&apos;ll notify you
          of material changes through the service or by email. Continuing to
          use KeywordQuarry after changes take effect means you accept the
          updated terms.
        </p>
      </Section>

      <Section n={12} title="Governing law">
        <p>
          These terms are governed by the laws of the State of{' '}
          <Placeholder>STATE</Placeholder>, without regard to
          conflict-of-law principles.
        </p>
      </Section>

      <Section n={13} title="Contact">
        <p>
          Questions about these terms? Email{' '}
          <a href="mailto:support@keywordquarry.com" className="text-blue-700 underline">
            support@keywordquarry.com
          </a>{' '}
          or use the{' '}
          <Link href="/contact" className="text-blue-700 underline">contact page</Link>.
          Postal address: <Placeholder>MAILING ADDRESS</Placeholder>.
        </p>
      </Section>
    </div>
  );
}
