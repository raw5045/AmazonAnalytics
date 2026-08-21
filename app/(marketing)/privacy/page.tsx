/**
 * Privacy Policy — complete launch draft (2026-08-21), NOT legal advice.
 *
 * Drafted for beta launch as an individual operator (name + DBA). Two
 * identity slots remain as <Placeholder>: operator legal name and mailing
 * address (virtual mailbox pending). Every system claim in here is accurate
 * to the stack as built: Clerk holds all credentials (Google sign-in users
 * have no password anywhere), we store emails/names/in-app data/usage
 * counters, essential cookies only, processors listed exhaustively. Keep
 * this page truthful when the stack changes.
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
      <p className="mt-2 text-sm text-gray-500">Last updated: August 21, 2026</p>

      <Section n={1} title="What we collect">
        <p>
          <strong>Account information.</strong> Your name and email address,
          provided through Clerk, our authentication provider. If you sign
          in with Google, authentication happens entirely through Google and
          Clerk — <strong>we never receive or store your password</strong>.
          Password-based logins are likewise held and secured by Clerk, not
          by us.
        </p>
        <p>
          <strong>Data you create in the app.</strong> Watchlists, saved
          views, and custom categories.
        </p>
        <p>
          <strong>Usage data.</strong> Coarse activity counts (for example,
          how many searches an account runs per day), which we use for abuse
          prevention and to understand how the product is used. We also
          receive standard server logs from our hosting providers.
        </p>
        <p>
          <strong>Messages you send us.</strong> Contact-form submissions
          and email replies.
        </p>
        <p>
          We do <strong>not</strong> collect payment information (the beta
          is free), precise location, or advertising identifiers.
        </p>
      </Section>

      <Section n={2} title="How we use it">
        <p>
          We use your data to provide and improve KeywordQuarry, send you
          the emails described below, prevent abuse of the service, and
          respond to your messages. We do not sell your personal data, and
          we don&apos;t share it with anyone except the processors listed
          below.
        </p>
      </Section>

      <Section n={3} title="Processors we rely on">
        <p>These providers process data on our behalf to run KeywordQuarry:</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>Clerk — authentication and credential storage</li>
          <li>Neon — database hosting</li>
          <li>Vercel — application hosting</li>
          <li>Railway — background data processing</li>
          <li>Resend — email delivery</li>
          <li>Cloudflare — DNS and email routing for our support inbox</li>
          <li>Keepa — product-data enrichment (receives no personal data)</li>
        </ul>
        <p>
          The tutorial videos on our{' '}
          <Link href="/help" className="text-blue-700 underline">How it works</Link>{' '}
          page are embedded from YouTube using its privacy-enhanced player;
          if you play them, YouTube&apos;s own privacy policy applies to
          that playback.
        </p>
      </Section>

      <Section n={4} title="Cookies">
        <p>
          We use essential authentication and session cookies through Clerk
          to keep you signed in. We do not use advertising or third-party
          tracking cookies.
        </p>
      </Section>

      <Section n={5} title="Email">
        <p>
          We send three kinds of email: a one-time welcome email when you
          create an account, an optional weekly digest of how your watched
          keywords moved (every digest includes a one-click unsubscribe
          link), and occasional service notices. We don&apos;t send
          third-party marketing.
        </p>
      </Section>

      <Section n={6} title="Security">
        <p>
          All traffic to KeywordQuarry is encrypted in transit (TLS). Your
          credentials are held by Clerk, a dedicated authentication
          provider — we deliberately keep passwords out of our own systems —
          and we collect as little personal data as the product needs to
          work.
        </p>
      </Section>

      <Section n={7} title="Retention and deletion">
        <p>
          We keep your personal data for as long as your account exists.
          Deleting your account removes your personal data and the in-app
          data associated with it — watchlists, saved views, and custom
          categories — from our database. To request deletion, email{' '}
          <a href="mailto:support@keywordquarry.com" className="text-blue-700 underline">
            support@keywordquarry.com
          </a>{' '}
          and we&apos;ll process it promptly.
        </p>
      </Section>

      <Section n={8} title="Your rights">
        <p>
          Wherever you live, you can request access to, correction of, or
          deletion of your personal data by emailing{' '}
          <a href="mailto:support@keywordquarry.com" className="text-blue-700 underline">
            support@keywordquarry.com
          </a>
          , and we&apos;ll honor verified requests. Depending on your
          location, you may have additional statutory rights (for example
          under the California Consumer Privacy Act or the EU General Data
          Protection Regulation), including the rights to data portability
          and to lodge a complaint with a supervisory authority.
        </p>
      </Section>

      <Section n={9} title="Children">
        <p>
          KeywordQuarry is not directed at children under 16, and we do not
          knowingly collect personal data from children.
        </p>
      </Section>

      <Section n={10} title="Changes to this policy">
        <p>
          We may update this policy from time to time. We&apos;ll announce
          material changes in the service or by email.
        </p>
      </Section>

      <Section n={11} title="Controller and contact">
        <p>
          The data controller for KeywordQuarry is{' '}
          <Placeholder>OPERATOR LEGAL NAME</Placeholder>, doing business as
          KeywordQuarry, <Placeholder>MAILING ADDRESS</Placeholder>. Reach
          us any time at{' '}
          <a href="mailto:support@keywordquarry.com" className="text-blue-700 underline">
            support@keywordquarry.com
          </a>{' '}
          or via the{' '}
          <Link href="/contact" className="text-blue-700 underline">contact page</Link>.
        </p>
      </Section>
    </div>
  );
}
