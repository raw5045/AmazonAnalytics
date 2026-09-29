import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { mcpAllowedClientIds, mcpAudience, mcpClientCredentials, mcpClientLabel, mcpEnabled, mcpResourceUrl } from '@/lib/mcp/config';
import { connectAiEligible } from '@/lib/mcp/eligibility';
import { getMcpConnection } from '@/lib/mcp/connections';
import { ConnectionControls } from './ConnectionControls';
import { ExampleQuestions } from './ExampleQuestions';

export const metadata: Metadata = { title: 'Connect AI' };

const card = 'mt-4 rounded-lg border border-slate-200 bg-white p-4';
const mono = 'select-all break-all rounded bg-slate-100 px-1.5 py-0.5';

/** The pair a client needs; the secret line says to ask us when it is not configured. */
function ClientCredentials({ clientId, clientSecret }: { clientId: string; clientSecret: string | null }) {
  return (
    <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <dt className="text-slate-500">Client ID</dt>
      <dd>
        <code className={mono}>{clientId}</code>
      </dd>
      <dt className="text-slate-500">Client secret</dt>
      <dd>
        {clientSecret ? (
          <code className={mono}>{clientSecret}</code>
        ) : (
          <span className="text-slate-600">Ask through the Feedback button and we will send it.</span>
        )}
      </dd>
    </dl>
  );
}

export default async function ConnectAiPage() {
  const user = await requireAuthenticatedUser();
  const audience = mcpAudience();
  if (!connectAiEligible(user.role, audience)) notFound();
  const enabled = mcpEnabled();
  // Skip the connection lookup entirely while the kill switch is off — the
  // status/controls section this feeds is not rendered below.
  const connection = enabled ? await getMcpConnection(user.id) : null;
  const endpoint = mcpResourceUrl();
  const [claude, chatgpt] = mcpClientCredentials();
  const last = connection?.lastRequestAt
    ? `${connection.lastRequestAt.toISOString().replace('T', ' ').slice(0, 16)} UTC via ${mcpClientLabel(connection.lastClientId)}`
    : 'none yet';

  return (
    <div className="mx-auto max-w-3xl px-6 py-8 text-slate-800">
      <h1 className="text-2xl font-bold">Connect your AI</h1>
      <p className="mt-2 text-sm text-slate-600">
        Let Claude, Claude Code or ChatGPT read KeywordQuarry directly while you work. The connection is
        read-only: search, categories, keyword details and history. Beta, free while it lasts.
      </p>

      {!enabled ? (
        <section className={card}>
          <p className="text-sm text-slate-700">
            MCP is temporarily switched off. Connections and requests are paused until it is back; nothing about
            your account changed.
          </p>
        </section>
      ) : (
        <>
          <ExampleQuestions className={card} />

          <section className={card}>
            <h2 className="font-semibold">Server URL</h2>
            <code className="mt-1 block select-all break-all rounded bg-slate-100 px-2 py-1 text-sm">{endpoint}</code>
            <p className="mt-1 text-xs text-slate-500">Type it exactly, with no trailing slash.</p>
          </section>

          <section className={card}>
            <h2 className="font-semibold">Claude (claude.ai or the desktop app&rsquo;s Chat tab)</h2>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
              <li>Customize → Connectors → + → Add custom connector.</li>
              <li>Name it KeywordQuarry and paste the server URL above. Leave Advanced settings empty.</li>
              <li>Add, then Connect, and approve the KeywordQuarry sign-in screen.</li>
              <li>In a chat, open the + menu, enable the connector, and ask: &ldquo;run get_research_guide&rdquo;.</li>
              <li>The connector also shows up in the desktop app&rsquo;s Code tab, under + → Connectors.</li>
            </ol>
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer text-slate-600">Advanced settings (optional, older setups)</summary>
              <p className="mt-1 text-slate-600">
                Claude signs in on its own now. If a setup still asks for a client ID and secret, use these:
              </p>
              <ClientCredentials clientId={claude.clientId} clientSecret={claude.clientSecret} />
            </details>
          </section>

          <section className={card}>
            <h2 className="font-semibold">Claude Code (the desktop app&rsquo;s Code tab, or the terminal)</h2>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
              <li>In the Code tab: Plugins → Add → Add MCP server → Connect to a custom MCP.</li>
              <li>
                Name: KeywordQuarry. Type: Streamable HTTP. URL: the server URL above. Leave the bearer token and
                headers empty. Save.
              </li>
              <li>
                In a session, type <code className={mono}>/mcp</code>, choose KeywordQuarry, then Authenticate, and
                approve the KeywordQuarry sign-in screen in your browser.
              </li>
              <li>
                From a terminal instead:{' '}
                <code className={mono}>claude mcp add --transport http keywordquarry {endpoint}</code>, then{' '}
                <code className={mono}>/mcp</code>.
              </li>
            </ol>
          </section>

          <section className={card}>
            <h2 className="font-semibold">ChatGPT</h2>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
              <li>
                Requires a paid ChatGPT plan (Developer mode is not on the free plan); Claude custom connectors work
                on every plan.
              </li>
              <li>Settings → Security and login → turn on Developer mode.</li>
              <li>Settings → Apps → Create app: name KeywordQuarry, paste the server URL, Authentication: OAuth.</li>
              <li>
                Registration method: User-Defined OAuth Client; enter this client ID and secret:
                <ClientCredentials clientId={chatgpt.clientId} clientSecret={chatgpt.clientSecret} />
              </li>
              <li>Create, then Connect, and approve the KeywordQuarry sign-in screen.</li>
              <li>In a chat, open the + menu, choose Developer mode, select the app, and ask a keyword question.</li>
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
