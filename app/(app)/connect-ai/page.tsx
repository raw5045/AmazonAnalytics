import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { mcpAllowedClientIds, mcpAudience, mcpClientLabel, mcpEnabled, mcpResourceUrl, mcpWriteEnabled } from '@/lib/mcp/config';
import { connectAiEligible } from '@/lib/mcp/eligibility';
import { getMcpConnection } from '@/lib/mcp/connections';
import { askAiEnabled } from '@/lib/ask/config';
import { askAiEligible } from '@/lib/ask/eligibility';
import { getAccount } from '@/lib/ask/ledger';
import { errFields } from '@/lib/ask/logSafe';
import { ConnectionControls } from './ConnectionControls';
import { ExampleQuestions } from './ExampleQuestions';

export const metadata: Metadata = { title: 'Connect AI' };

const card = 'mt-4 rounded-lg border border-slate-200 bg-white p-4';

export default async function ConnectAiPage() {
  const user = await requireAuthenticatedUser();
  const audience = mcpAudience();
  if (!connectAiEligible(user.role, audience)) notFound();
  const enabled = mcpEnabled();
  const writes = mcpWriteEnabled();
  // Skip the connection lookup entirely while the kill switch is off — the
  // status/controls section this feeds is not rendered below.
  const connection = enabled ? await getMcpConnection(user.id) : null;
  const endpoint = mcpResourceUrl();
  const last = connection?.lastRequestAt
    ? `${connection.lastRequestAt.toISOString().replace('T', ' ').slice(0, 16)} UTC via ${mcpClientLabel(connection.lastClientId)}`
    : 'none yet';

  return (
    <div className="mx-auto max-w-3xl px-6 py-8 text-slate-800">
      <h1 className="text-2xl font-bold">Connect your AI</h1>
      <p className="mt-2 text-sm text-slate-600">
        {writes
          ? 'Let Claude or ChatGPT search KeywordQuarry directly while you work and, with your approval each time, save views, build custom categories and edit your watchlist. Beta, free while it lasts.'
          : 'Let Claude or ChatGPT read KeywordQuarry directly while you work. The connection is read-only: search, categories, keyword details and history. Beta, free while it lasts.'}
      </p>

      {/* Cross-link to the in-app chat (spec §11.6). Guarded like the tab check in
          app/(app)/layout.tsx: a failed account read must not break this page, so it is
          caught and logged log-safe (errFields never surfaces a DrizzleQueryError's own
          .message, which can embed bound SQL params) and treated as "not eligible". */}
      {askAiEnabled() && askAiEligible(user.role, await getAccount(user.id).catch((e) => {
        console.error('[connect-ai page]', JSON.stringify({ outcome: 'account_read_failed', ...errFields(e) }));
        return null;
      })) && (
        <p className="mt-2 text-sm">
          <Link href="/ask" className="text-blue-700 underline">Prefer to chat here? Try Ask AI.</Link>
        </p>
      )}

      {!enabled ? (
        <section className={card}>
          <p className="text-sm text-slate-700">
            MCP is temporarily switched off. Connections and requests are paused until it is back; nothing about
            your account changed.
          </p>
        </section>
      ) : (
        <>
          <ExampleQuestions className={card} writes={writes} />

          <section className={card}>
            <h2 className="font-semibold">Server URL</h2>
            <code className="mt-1 block select-all break-all rounded bg-slate-100 px-2 py-1 text-sm">{endpoint}</code>
            <p className="mt-1 text-xs text-slate-500">Type it exactly, with no trailing slash.</p>
          </section>

          <section className={card}>
            <h2 className="font-semibold">Claude (claude.ai or the desktop app)</h2>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
              <li>Customize → Connectors → + → Add custom connector.</li>
              <li>Name it KeywordQuarry, paste the server URL above, and click Add.</li>
              <li>Connect, then approve the KeywordQuarry sign-in screen.</li>
              <li>In a chat, open the + menu, enable the connector, and ask: &ldquo;run get_research_guide&rdquo;.</li>
            </ol>
            <p className="mt-2 text-xs text-slate-500">Works the same in the desktop app&rsquo;s Chat and Code tabs.</p>
          </section>

          <section className={card}>
            <h2 className="font-semibold">ChatGPT</h2>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
              <li>Requires a paid ChatGPT plan with Developer mode on (Settings → Security and login → Developer mode).</li>
              <li>Go to chatgpt.com/plugins, click +, name it KeywordQuarry, paste the server URL above, and Create.</li>
              <li>Connect, then approve the KeywordQuarry sign-in screen.</li>
              <li>In a chat, open the + menu, choose Developer mode, pick KeywordQuarry, and ask a keyword question.</li>
            </ol>
          </section>

          <section className={card}>
            <h2 className="font-semibold">If it won&rsquo;t connect</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              <li>
                Check status.claude.com or status.openai.com first. An outage there shows up as &ldquo;Connection
                issue&rdquo; on this connector too.
              </li>
              <li>
                Sign in with the email you use for KeywordQuarry. The connection only works for KeywordQuarry
                accounts.
              </li>
              <li>Remove the connector and add it again.</li>
              <li>Still stuck? Tell us through the Feedback button.</li>
            </ul>
          </section>

          <section className={card}>
            <h2 className="font-semibold">Status</h2>
            <p className="mt-1 text-sm">Last request: {last}</p>
            <div className="mt-3">
              <ConnectionControls initialStatus={connection?.status ?? 'enabled'} />
            </div>
          </section>
        </>
      )}

      {user.role === 'admin' && (
        <section className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
          <h2 className="font-semibold">Admin</h2>
          <p className="mt-1">
            Audience: <strong>{audience}</strong>. Allowed client ids:{' '}
            {mcpAllowedClientIds().length > 0 ? mcpAllowedClientIds().join(', ') : 'any client of our sign-in server'}.
          </p>
        </section>
      )}
    </div>
  );
}
