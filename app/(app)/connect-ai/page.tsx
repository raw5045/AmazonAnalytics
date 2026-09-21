import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { mcpAllowedClientIds, mcpAudience, mcpResourceUrl } from '@/lib/mcp/config';
import { connectAiEligible } from '@/lib/mcp/eligibility';
import { getMcpConnection } from '@/lib/mcp/connections';
import { ConnectionControls } from './ConnectionControls';

export const metadata: Metadata = { title: 'Connect AI' };

const card = 'mt-4 rounded-lg border border-slate-200 bg-white p-4';

export default async function ConnectAiPage() {
  const user = await requireAuthenticatedUser();
  const audience = mcpAudience();
  if (!connectAiEligible(user.role, audience)) notFound();
  const connection = await getMcpConnection(user.id);
  const endpoint = mcpResourceUrl();
  const last = connection?.lastRequestAt
    ? `${connection.lastRequestAt.toISOString().replace('T', ' ').slice(0, 16)} UTC via ${connection.lastClientId ?? 'unknown client'}`
    : 'never';

  return (
    <div className="mx-auto max-w-3xl px-6 py-8 text-slate-800">
      <h1 className="text-2xl font-bold">Connect your AI</h1>
      <p className="mt-2 text-sm text-slate-600">
        Let ChatGPT or Claude read KeywordQuarry directly while you chat. The connection is read-only: search,
        categories, keyword details and history. Beta, free while it lasts.
      </p>

      <section className={card}>
        <h2 className="font-semibold">Server URL</h2>
        <code className="mt-1 block select-all rounded bg-slate-100 px-2 py-1 text-sm">{endpoint}</code>
        <p className="mt-1 text-xs text-slate-500">Type it exactly, with no trailing slash.</p>
      </section>

      <section className={card}>
        <h2 className="font-semibold">Claude (claude.ai)</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
          <li>Customize → Connectors → + → Add custom connector.</li>
          <li>Name it KeywordQuarry and paste the server URL above.</li>
          <li>Open Advanced settings and enter the client ID and secret we gave you.</li>
          <li>Add, then Connect, and approve the KeywordQuarry sign-in screen.</li>
          <li>In a chat, open the + menu, enable the connector, and ask: &ldquo;run get_research_guide&rdquo;.</li>
        </ol>
      </section>

      <section className={card}>
        <h2 className="font-semibold">ChatGPT</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
          <li>Settings → Security and login → turn on Developer mode.</li>
          <li>Settings → Apps → Create app: name KeywordQuarry, paste the server URL, Authentication: OAuth.</li>
          <li>Registration method: User-Defined OAuth Client; enter the client ID and secret we gave you.</li>
          <li>Create, then Connect, and approve the KeywordQuarry sign-in screen.</li>
          <li>In a chat, open the + menu, choose Developer mode, select the app, and ask a keyword question.</li>
        </ol>
      </section>

      <section className={card}>
        <h2 className="font-semibold">Status</h2>
        <p className="mt-1 text-sm">Last request: {last}</p>
        <div className="mt-3">
          <ConnectionControls initialStatus={connection?.status ?? 'enabled'} />
        </div>
      </section>

      {user.role === 'admin' && (
        <section className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
          <h2 className="font-semibold">Admin</h2>
          <p className="mt-1">
            Audience: <strong>{audience}</strong>. Allowed client ids:{' '}
            {mcpAllowedClientIds().length > 0 ? mcpAllowedClientIds().join(', ') : 'any (not pinned yet)'}.
          </p>
        </section>
      )}
    </div>
  );
}
