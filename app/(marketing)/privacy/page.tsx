/**
 * Privacy Policy — launch scaffold, NOT legal advice.
 *
 * This page was drafted to get KeywordQuarry to launch with a reasonable,
 * standard-SaaS privacy structure in place. It has not been reviewed by a
 * lawyer. Before onboarding real (non-beta-tester) users, run this through
 * a reputable generator (Termly, iubenda, Termsfeed) or have counsel review
 * it, and resolve every <Placeholder> below — company legal name, mailing
 * address, and jurisdiction-specific rights (GDPR/CCPA as applicable) are
 * not yet decided.
 */
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: 'How KeywordQuarry collects, uses, and protects your data.',
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

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight text-gray-900">Privacy Policy</h1>
      <p className="mt-2 text-sm text-gray-500">Last updated: July 1, 2026</p>

      <Section n={1} title="What we collect">
        <p>
          We collect the account information you provide through Clerk, our
          authentication provider — your name and email address. We also
          store the data you create inside KeywordQuarry, such as
          watchlists, saved views, and custom categories, along with basic
          usage and log data. We do not collect payment data during beta.
        </p>
      </Section>

      <Section n={2} title="How we use it">
        <p>
          We use your data to provide and improve KeywordQuarry, send emails
          you&apos;ve opted into (like the weekly digest), and respond to
          support requests. We do not sell your personal data.
        </p>
      </Section>

      <Section n={3} title="Processors we rely on">
        <p>We work with the following processors to run KeywordQuarry:</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>Clerk (authentication)</li>
          <li>Neon (database hosting)</li>
          <li>Vercel (application hosting)</li>
          <li>Railway (background jobs)</li>
          <li>Resend (email delivery)</li>
          <li>Keepa (product-data enrichment — receives no personal data)</li>
        </ul>
      </Section>

      <Section n={4} title="Cookies">
        <p>
          We use authentication and session cookies through Clerk to keep
          you signed in. We do not use advertising cookies.
        </p>
      </Section>

      <Section n={5} title="Email">
        <p>
          The weekly digest email is optional — you can opt in or out at any
          time. Every email we send includes a one-click unsubscribe link.
        </p>
      </Section>

      <Section n={6} title="Retention and deletion">
        <p>
          We keep your personal data for as long as your account exists.
          Deleting your account removes your personal data and the in-app
          data associated with it.
        </p>
      </Section>

      <Section n={7} title="Your rights">
        <p>
          You can request access to, correction of, or deletion of your
          personal data via the{' '}
          <Link href="/contact" className="text-blue-700 underline">contact page</Link>.
          Depending on where you live, you may also have{' '}
          <Placeholder>JURISDICTION-SPECIFIC RIGHTS — GDPR/CCPA AS APPLICABLE</Placeholder>.
        </p>
      </Section>

      <Section n={8} title="Children">
        <p>
          KeywordQuarry is not directed at children under 16, and we do not
          knowingly collect personal data from children.
        </p>
      </Section>

      <Section n={9} title="Changes to this policy">
        <p>
          We may update this policy from time to time. We&apos;ll announce
          material changes in the service or by email.
        </p>
      </Section>

      <Section n={10} title="Controller and contact">
        <p>
          The data controller for KeywordQuarry is{' '}
          <Placeholder>COMPANY LEGAL NAME</Placeholder>,{' '}
          <Placeholder>MAILING ADDRESS</Placeholder>. Until a dedicated
          support address is published, reach us via the{' '}
          <Link href="/contact" className="text-blue-700 underline">contact page</Link>.
        </p>
      </Section>
    </div>
  );
}
