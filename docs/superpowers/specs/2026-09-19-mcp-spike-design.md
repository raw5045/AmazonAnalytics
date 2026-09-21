# MCP Spike (Arc 1, Phase 0) — Design Spec

**Date:** 2026-09-19
**Status:** Approved by owner 2026-09-19 ("please proceed"); implemented — see Results
**Scope:** Prove the external handshake end to end — claude.ai and ChatGPT →
Clerk OAuth → a KeywordQuarry MCP endpoint — with ONE trivial read-only tool,
deployed dark behind a switch and the admin role. No research service, no
data tools, no schema changes, no worker changes. Everything here is the
foundation the five real tools (arc 1) plug into.

Parent decisions: [2026-09-18-keywordquarry-research-mcp-design.md](2026-09-18-keywordquarry-research-mcp-design.md)
as amended in chat on 2026-09-18 — split (MCP first), admin-only until the
owner confirms, then all beta users free; Clerk stays the authorization
server; manual OAuth clients (no dynamic registration); audience stance =
our issuer + our custom scope + allowlisted client ids; app-level access
record is the disconnect source of truth.

## Facts verified before writing (2026-09-19)

| Fact | Source |
|---|---|
| `mcp-handler` 2.2.0, peer `@modelcontextprotocol/server@^2.0.0` (2.0.0 current), Node ≥ 20; stateless by default; serves 2026-07-28 and 2025-era clients from one handler | npm registry, package README |
| `withMcpAuth(handler, verifyToken(req, bearerToken) → AuthInfo \| undefined, { required, requiredScopes, resourceMetadataPath, resourceUrl })` — `resourceUrl` is the ORIGIN the challenge's `resource_metadata` URL is built on; `protectedResourceHandler({ authServerUrls, resourceUrl })` takes no scopes (the document is built by hand instead); `metadataCorsOptionsRequestHandler()`; tools read identity from `ctx.http?.authInfo` | mcp-handler 2.2.0 `dist/index.d.ts` + `index.mjs` (the npm package ships no AUTHORIZATION.md) |
| `auth({ acceptsToken: 'oauth_token' })` returns `{ isAuthenticated, tokenType, userId, scopes, … }` and never throws for a missing/invalid token | Clerk Next.js guide "Verify OAuth access tokens" |
| Production Clerk authorization server: issuer `https://clerk.keywordquarry.com`; PKCE S256; **`authorization_response_iss_parameter_supported: true`** (so ChatGPT uses its stable redirect URI); `registration_endpoint` absent (DCR off, keep it off); `client_id_metadata_document_supported` absent (CIMD not enabled → Claude Code's CIMD client is out of scope for the spike); RFC 7009 `revocation_endpoint` present; `token_endpoint_auth_methods_supported` includes `none`, `client_secret_basic`, `client_secret_post` | `https://clerk.keywordquarry.com/.well-known/oauth-authorization-server` (public) |
| Claude custom connectors accept a pre-registered client id + optional secret; callback `https://claude.ai/api/mcp/auth_callback`; Claude appends `offline_access` only if advertised | Anthropic connector auth docs |
| ChatGPT developer mode (owner is on Pro): predefined clients supported; stable redirect `https://chatgpt.com/connector_platform_oauth_redirect` when the AS supports RFC 9207 — it does | OpenAI Apps SDK auth docs |
| Clerk backend 3.2.11 treats both opaque `oat_…` tokens and JWT access tokens (`typ: at+jwt`) as OAuth machine tokens, so either format Clerk issues works with `auth({ acceptsToken: 'oauth_token' })` | `@clerk/backend/dist/chunk-*.mjs` (`isMachineToken`, `isOAuthJwt`) |
| The Clerk frontend-API host is derivable from the public publishable key (`pk_live_` + base64 of `clerk.keywordquarry.com$`), so no new env var is needed for the authorization-server URL | decoded locally |

## What gets built

### 1. Endpoint `POST/GET /api/mcp` (`app/api/mcp/route.ts`)

- `createMcpHandler(init, { serverInfo: { name: 'keywordquarry', version } })`
  wrapped in `withMcpAuth(handler, verifyMcpToken, { required: true,
  requiredScopes: [SCOPE], resourceMetadataPath: '/.well-known/oauth-protected-resource/api/mcp' })`.
- `export const runtime = 'nodejs'`, `export const maxDuration = 30`.
- When `MCP_ENABLED` is not `'1'`: respond `404` before anything else (dark
  deploy; nothing about the feature is discoverable). One caveat outside the
  route's control: `clerkMiddleware` authenticates every `/api/*` request with
  `acceptsToken: 'any'`, so a bearer OAuth token is still verified with Clerk
  before the route answers 404 — pre-existing behaviour for all API routes.
- One tool, `whoami`, `annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }`,
  no input, `outputSchema` `{ ok: true, account: <masked email>, datasetWeek, serverVersion }`,
  returning the same as `structuredContent` plus a one-line text. It reads
  the dataset week from `keyword_current_summary_meta` (one indexed row) so
  the spike also proves a DB round trip from the tool path.
- Server `instructions`: one sentence ("KeywordQuarry beta: this spike exposes
  a single diagnostic tool.").

### 2. Token verification (`lib/mcp/verifyMcpToken.ts`)

`verifyMcpToken(req, bearerToken)`:
1. No bearer → `undefined` (the wrapper answers `401` + `WWW-Authenticate`
   with `resource_metadata` and `scope`).
2. `const a = await auth({ acceptsToken: 'oauth_token' })` — Clerk verifies
   signature/expiry/instance. `!a.isAuthenticated || a.tokenType !== 'oauth_token'` → `undefined`.
3. Scope: when `a.scopes` lacks `keywordquarry:research:read` the verifier returns the token's `AuthInfo` (scopes as issued) *without* resolving an account, and the wrapper's `requiredScopes` check answers `403 insufficient_scope` with a `scope=` challenge. (Returning `undefined` here would produce a misleading `401 invalid_token`.)
4. Return `{ token, scopes, clientId, extra: { clerkUserId, account: null } }`
   (Clerk does not expose the token's expiry, so no `expiresAt`). The
   verifier never touches the database: the wrapper turns any throw into
   `401 invalid_token`, which would make a client discard a good token over
   a transient Neon hiccup.

The gate (`lib/mcp/handler.ts`, between the wrapper and the MCP server)
then applies policy to the valid token, in this order:

5. Client allowlist: if `MCP_ALLOWED_CLIENT_IDS` is set and the token's client
   id is not in it → `403 access_denied` (`reason: client_not_allowed`).
   Empty during the spike's first connect so the owner can read the client
   ids from the log; then pinned.
6. Local account (`resolveMcpAccount`): `users` row by `clerkUserId`. A
   database failure → `503 temporarily_unavailable` + `Retry-After: 30`,
   never a 401. No row → `403 access_denied` (`reason: no_account`, "sign
   in at keywordquarry.com first").
7. Beta audience: `MCP_AUDIENCE` `'admin'` (default) with `role ≠ 'admin'` →
   `403 access_denied` (`reason: admin_only`). `'all'` admits any account;
   the owner flips it after confirming.
8. Admitted: `extra.account = { localUserId, role, email }` is attached and
   the MCP server runs the tool.

The 403s carry no `WWW-Authenticate` challenge on purpose: the token is
valid, so a client must not loop through re-authorization.

Every step logs one structured line (`[mcp auth]` outcome + ids only, no
tokens). This module is the seam the arc-1 service reuses unchanged.

### 3. Discovery documents

- `app/.well-known/oauth-protected-resource/api/mcp/route.ts` (path-aware —
  the URL the 401 challenge names) and `app/.well-known/oauth-protected-resource/route.ts`
  (root — probed by older clients) both `GET` the same document from
  `lib/mcp/discovery.ts`: `{ resource: mcpResourceUrl(), authorization_servers: [clerkFrontendApiUrl()], scopes_supported: [SCOPE], bearer_methods_supported: ['header'], resource_name: 'KeywordQuarry' }`
  (built by hand: mcp-handler's `protectedResourceHandler` cannot add scopes);
  `OPTIONS` answers CORS preflight.
- `app/.well-known/oauth-authorization-server/route.ts` — a `GET` that
  fetches Clerk's own document and returns it unchanged (5-minute cache),
  for 2025-era clients that probe the resource origin instead of following
  `authorization_servers`. `OPTIONS` CORS.
- `mcpResourceUrl()` = `MCP_RESOURCE_URL` if set, else `APP_PUBLIC_URL + '/api/mcp'`
  (never the request's Host header). `clerkFrontendApiUrl()` decodes the
  publishable key.
- Both documents are public and carry no account data. The proxy matcher
  already skips dotted paths, so they bypass the browser sign-in redirect;
  `/api/mcp` stays under `clerkMiddleware` (needed for `auth()`) without
  `auth.protect()`, so a missing token yields the MCP `401`, never an HTML
  redirect.

### 4. Configuration (`lib/env.ts`, all optional, switches default off)

| Variable | Meaning |
|---|---|
| `MCP_ENABLED` | `'1'` serves the endpoint; anything else → 404 |
| `MCP_AUDIENCE` | `'admin'` (default) or `'all'` |
| `MCP_ALLOWED_CLIENT_IDS` | comma-separated Clerk OAuth client ids; empty = any client of our instance |
| `MCP_RESOURCE_URL` | override of the canonical resource URL (defaults from `APP_PUBLIC_URL`) |

Nothing required at build time, so the Vercel build is unaffected.

### 5. Owner setup (dashboards; click paths verified against vendor docs 2026-09-19)

1. **Clerk scope** — Clerk Dashboard → *OAuth applications* → **Scopes** tab →
   add `keywordquarry:research:read` (colons are fine; Clerk's own examples are
   `messages:read`, `tools:execute`). If the tab offers "advertise in OAuth
   metadata", turn it on.
2. **Clerk app "Claude"** — *OAuth applications* → **Add application** →
   *Create OAuth application* → Name `Claude`, Scopes: the new scope → **Add**.
   Copy the **Client Secret** from the modal (Clerk shows it once). On the app
   page copy the **Client ID** (Application credentials) and set **Redirect
   URIs** to `https://claude.ai/api/mcp/auth_callback`.
3. **Clerk app "ChatGPT"** — same, Redirect URI = the *Callback URL* ChatGPT's
   dialog shows in step 5 (expected `https://chatgpt.com/connector_platform_oauth_redirect`
   because Clerk advertises `authorization_response_iss_parameter_supported`;
   if the dialog shows `https://chatgpt.com/connector/oauth/<id>`, register that).
4. **Vercel** → Project → Settings → Environment Variables (Production):
   `MCP_ENABLED=1`, `MCP_AUDIENCE=admin`; leave `MCP_ALLOWED_CLIENT_IDS` unset
   for the first connect (the `[mcp auth]` log line shows each client id),
   then pin both ids. Redeploy after changing env.
5. **ChatGPT** (Pro plan qualifies) — Settings → *Security and login* →
   **Developer mode** on. Then Settings → *Apps* → **Create app**: Name
   `KeywordQuarry`, MCP Server URL `https://keywordquarry.com/api/mcp`,
   Authentication **OAuth**, Registration method **User-Defined OAuth Client**
   → copy the **Callback URL** (step 3) → OAuth Client ID + Client Secret from
   step 3 → tick "I understand…" → Create → Connect (Clerk consent screen). In
   a chat: *+* → Developer mode → select the app → "run whoami".
6. **claude.ai** (Pro plan; or Team/Enterprise: *Organization settings* →
   *Connectors* → Add → Custom → Web) — *Customize* → **Connectors** → **+** →
   **Add custom connector**: Name `KeywordQuarry`, Remote MCP server URL exactly
   `https://keywordquarry.com/api/mcp` (Claude and the MCP client SDK require
   it to equal the metadata's `resource`, i.e. `APP_PUBLIC_URL` + `/api/mcp`:
   no `www.`, no trailing slash) → **Advanced settings** → OAuth
   Client ID + Client Secret from step 2 → **Add** → **Connect** (Clerk consent
   screen). In a chat: *+* → Connectors → toggle it on → "run whoami".
   Authentication settings cannot be edited later; remove and re-add instead.
7. Watch Vercel → Logs for `[mcp auth]` lines (`outcome`, `clientId`,
   `clerkUserId`; never the token) and record the Results table below.

### 6. Tests (53, all unit; `pnpm vitest run lib/mcp app/api/mcp "app/.well-known"`)

- `lib/mcp/config.test.ts`: switch semantics, safe fallbacks + warnings for a
  mistyped audience or resource URL, resource URL from `APP_PUBLIC_URL`
  only, publishable-key decoding.
- `lib/mcp/verifyMcpToken.test.ts`: no token / Clerk rejects / wrong token
  type → `undefined`; missing scope → scopes returned as issued; the ok
  case returns token facts only and never touches the database; one
  structured log line per outcome that never reaches any console method
  with the token; `resolveMcpAccount` (row → account, none → null, failure
  propagates); `authorizeMcpClient` and `authorizeMcpAccount`.
- `lib/mcp/discovery.test.ts` + `app/.well-known/discoveryRoutes.test.ts`:
  JSON shapes, CORS preflight, the resource URL built from configuration
  alone, the AS proxy passing Clerk's body through and answering 502 on
  upstream failure; both PRM paths wired; the routes import nothing from Clerk.
- `app/api/mcp/route.test.ts` (node environment): `MCP_ENABLED` unset → 404
  before any auth work; 401 challenge with `scope` and `resource_metadata`
  (not derived from forwarded headers); 401 for a rejected token; 403
  `insufficient_scope`; 403 `access_denied` for an unlisted client (before
  any database work), a standard user (admin audience) and an unlinked
  login; 503 with `Retry-After` and no challenge when the account lookup
  fails; 401 when Clerk itself throws, with the token absent from every
  console method; then a real in-process
  `@modelcontextprotocol/client` connects through the route (only Clerk's
  `auth()`, the users lookup and the dataset-week read are mocked), lists
  exactly one tool with `readOnlyHint: true`, and `whoami` returns the
  structured output; `MCP_AUDIENCE=all` admits a standard user.
- `lib/mcp/datasetWeek.test.ts`: singleton read, null when empty.
- Existing suite untouched (811 tests green); `next build` registers
  `/api/mcp` and the three `.well-known` routes (`app-paths-manifest.json`).

### 7. Acceptance

- claude.ai and ChatGPT both complete the consent flow against Clerk, list
  `whoami`, and a call returns `ok: true` for the owner's admin account.
- A standard user's token is refused (`403 access_denied`, no re-auth challenge) while `MCP_AUDIENCE=admin`.
- A browser session cookie, a session JWT, or no token at the endpoint → `401`
  with a correct `WWW-Authenticate` challenge, never an HTML page.
- Record in this spec's "Results" section: which registration mode each client
  used, the exact redirect URIs, token format (JWT/opaque), the `auth()` fields
  observed, and handshake latency.

### 8. Non-goals (arc 1 and later)

The five research tools, result sets and cursors, rate limits and counters,
the digest columns, the connection page, disconnect UI, Claude Code / Cursor
(need CIMD or DCR), payments and entitlements.

## Rollback

Set `MCP_ENABLED` off (or unset) and redeploy: the endpoint 404s, the
discovery documents remain harmless public JSON. No data to clean up.

## Ship checklist (owner-gated)

1. Typecheck + full suite green; independent review pass.
2. Push on authorization (`scripts/checkActiveJobs.ts` first); deploy dark.
3. Owner completes §5; first connect with the allowlist empty; pin client ids.
4. Results recorded here; then arc 1 planning starts from the verified seam.

## Results

| Step | Outcome |
|---|---|
| Implementation | `lib/mcp/{config,verifyMcpToken,handler,discovery,datasetWeek}.ts`, `lib/mcp/tools/whoami.ts`, `app/api/mcp/route.ts`, three `app/.well-known/**/route.ts`; 53 unit tests incl. an in-process `@modelcontextprotocol/client` handshake + `whoami` call |
| Deploy (dark) | `4403aef` pushed 2026-09-19 12:42, Vercel + Railway green 12:44. Verified live: `/.well-known/oauth-protected-resource/api/mcp` serves the document (resource, Clerk issuer, scope); `POST /api/mcp` answers 404 with `MCP_ENABLED` unset |
| Clerk scope + OAuth apps (§5 steps 1–3) | done by owner 2026-09-19 (scope `keywordquarry:research:read` accepted with the colon; two apps, Claude + ChatGPT) |
| Vercel env (§5 step 4) | `MCP_ENABLED=1`, `MCP_AUDIENCE=admin` live 2026-09-19; verified from outside: `POST /api/mcp` without a token → `401` with `WWW-Authenticate: Bearer error="invalid_token", scope="keywordquarry:research:read", resource_metadata="https://keywordquarry.com/.well-known/oauth-protected-resource/api/mcp"`; the AS proxy answers in ~0.6 s cold; both PRM paths 200. `MCP_ALLOWED_CLIENT_IDS` to pin as `16oat62Xksi7U2Ri,WzrKBzjxqjhn2pUR` (owner sets it in Vercel + redeploys) |
| claude.ai connect + `whoami` | SUCCESS 2026-09-19 (owner): custom connector with the pre-registered Clerk client id + secret (no DCR), callback `https://claude.ai/api/mcp/auth_callback`, Clerk consent screen, `whoami` returned the correct account + dataset week. Token format: Clerk default (JWT) unless the owner changed the app setting. Clerk client id `16oat62Xksi7U2Ri` (owner, 2026-09-21) |
| ChatGPT connect + `whoami` | SUCCESS 2026-09-19 (owner): developer-mode app, Registration method "User-Defined OAuth Client" with the Clerk client id + secret (no DCR/CIMD), `whoami` correct. Callback URL used: the stable `https://chatgpt.com/connector_platform_oauth_redirect` (confirmed by the owner 2026-09-21, as RFC 9207 support predicted). Clerk client id `WzrKBzjxqjhn2pUR`. Clerk tolerated ChatGPT's RFC 8707 `resource=` parameter (the flow completed) |
| Standard user under `MCP_AUDIENCE=admin` | pending (expect `403 access_denied`; the client should show the message rather than re-prompt for consent) |
