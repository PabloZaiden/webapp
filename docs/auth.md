# Auth and security

The framework provides three auth modes designed to coexist.

## Store durability

The default `sqliteWebAppStore()` persists framework auth state under the
configured data directory. `memoryWebAppStore()` is process-local and volatile:
all users, preferences, passkeys, keys, device requests, signing keys, sessions,
and audit events are lost when the store instance or process is discarded.
It retains only the 1,000 most recently inserted audit events while running.
Do not use it for accounts or credentials that must survive restarts unless
the application reconstructs them through another trusted mechanism.

## Users and passkeys

Passkeys are multi-user. The first run creates the immutable owner user and that user's passkey.

1. If no users exist, the UI asks for the owner username and passkey.
2. The owner cannot be deleted or demoted.
3. Owners and admins create users from Settings, which returns a one-time 24h setup link.
4. Users complete setup from `/setup?token=...`; usernames are lowercase, immutable and unique.
5. Admin resets clear the user's passkey, API keys and device sessions, then issue a new one-time setup link.
6. If the owner passkey is deleted, the owner setup screen is shown again.

Setup-link completion verifies WebAuthn before opening a short SQLite
transaction in the default store. The transaction claims the unconsumed,
unexpired link, persists the verified passkey, increments the user's
`authVersion`, and commits all three changes together. Every `WebAppStore`
implementation must preserve this atomic contract. Only the transaction winner
receives a browser session and a setup completion audit event; a concurrent or
reused link is rejected without replacing the winner's passkey.

Account disabling is a store-level lifecycle operation rather than a public
framework endpoint. `WebAppStore.disableUser(userId, disabledAt)` atomically
sets `disabledAt`, increments `authVersion`, and revokes every unrevoked
refresh session for the user. It is idempotent for an already-disabled user
and rejects the immutable owner. Disabled users cannot use passkey sessions,
API keys, device-code exchange, refresh tokens, or already-issued bearer
access tokens.

Route handlers get `ctx.auth.user` plus helpers:

```ts
const user = ctx.requireUser();
const admin = ctx.requireAdmin();
ctx.assertUser(userId);
```

For app-owned data, prefer the ownership helpers so every route has the same self-only behavior:

```ts
GET: (_req, ctx) => jsonResponse(ctx.filterOwned(items));

PATCH: (_req, ctx) => {
  const item = ctx.requireOwned(items.find((candidate) => candidate.id === ctx.params.id));
  return jsonResponse(item);
}
```

`ctx.requireOwned()` returns 404 for missing resources and for resources owned by another user, avoiding cross-user existence leaks. For user-owned realtime updates, publish through `ctx.userRealtime` instead of the global `ctx.realtime`.

`{PREFIX}_DISABLE_PASSKEY=true` is an emergency bypass: it authenticates as the
stored owner, or creates an owner named `admin` when no owner exists. Use it
only with disposable or otherwise controlled data.

### Current user in application UI

Components rendered inside `WebAppRoot` can read the current user with the public
`useCurrentUser()` hook from `@pablozaiden/webapp/web`:

```tsx
import { useCurrentUser } from "@pablozaiden/webapp/web";

export function AccountLabel() {
  const user = useCurrentUser();
  if (!user) return null;
  return <span>{user.username} ({user.role})</span>;
}
```

It returns the existing `CurrentUser` contract (`id`, `username`, `role`,
`isOwner`, `isAdmin`), or `undefined` until configuration is available or when
no current user is present. It subscribes to the framework configuration context
without fetching configuration again or maintaining a separate user cache.
Calling it outside `WebAppRoot` throws.

Use this information for presentation and role-aware UI loading, not as an
authorization boundary. Server routes must still enforce their declared auth
policy and ownership checks; client-side role checks do not grant access.

## API keys

API keys are user-owned bearer tokens for scripts and agents. The plaintext token is
shown only once and is never stored; the default SQLite store persists its hash,
while the memory store retains it only for the current process. Route `scopes`
are enforced for API-key requests; `*` grants all scopes.

Expired API keys do not authenticate, are omitted from user-facing lists, and are purged when key lists or expired keys are encountered.

Server-side applications can create managed keys through the server-only helpers exported from
`@pablozaiden/webapp/server`:

```ts
import { createManagedApiKey, listManagedApiKeys, revokeManagedApiKey } from "@pablozaiden/webapp/server";

const created = createManagedApiKey(app.store, user, {
  name: "Runtime credential",
  managedBy: "my-application",
  scopes: ["*"],
});
const keys = listManagedApiKeys(app.store, user.id, "my-application");
revokeManagedApiKey(app.store, created.key.id, user.id);
```

Managed keys have an explicit `kind: "managed"` classification and optional opaque
`managedBy` metadata. The plaintext token is returned only by creation and is never
stored; applications must retain it securely. Managed keys use the same bearer
authentication, ownership, scope, expiration, disabled-user, and lifecycle invalidation
rules as user keys. They survive an ordinary restart when used with the default
SQLite store; applications should explicitly revoke each generation during
their own resource cleanup.

Managed keys have no browser/API CRUD endpoint. The normal `/api/api-keys` routes and
Settings UI expose only `kind: "user"` keys, and request input cannot create or convert a
managed key. User reset, passkey deletion, user deletion, and expiration cleanup cover
both kinds.

Custom `WebAppStore` implementations must persist `kind` and `managedBy`, migrate
pre-managed records as `kind: "user"`, include both kinds in expiration cleanup and
user deletion/reset cleanup, and preserve the owner filter used by the management
helpers. The built-in SQLite store performs this migration automatically.

API-key and device bearer requests use explicit credentials and do not require
a registered client origin, whether `Origin` is supplied or omitted. This
applies to routes with `sameOrigin: "always"` too. Cookie-authenticated requests
never gain a cross-origin exemption; scopes and user ownership still apply to
every authentication mode.

### Browser sign-in with an API key

When both passkeys and API keys are enabled, the `Passkey required` screen also
offers **Authenticate with API key**. The browser submits the key through the
same-origin `POST /api/passkey-auth/api-key` endpoint. A valid `*`-scoped key
can be user-owned or server-managed; key provenance does not affect eligibility.
Limited-scope keys are rejected because the result is an unrestricted
passkey-equivalent browser session.

Successful exchange issues the same signed `webapp_passkey_session` cookie as
passkey authentication. It is `HttpOnly`, `SameSite=Strict`, and uses the
request's configured secure and path attributes. The plaintext key is never
returned or stored by the browser. The key's existing `lastUsedAt` is updated,
but this flow does not emit a passkey `user_login` audit event or update
`lastLoginAt`.

The API key is reusable while it remains valid and can be exchanged repeatedly
until it is deleted, revoked, or expires. Deleting, expiring, or revoking it
after a browser session is issued does not invalidate that session; normal
browser-session expiration, logout, disabled-user checks, and user
`authVersion` invalidation still apply. The browser login request itself
retains the normal same-origin protection for cookie issuance.

## Device auth

Device auth is included in V1:

1. Client calls `POST /api/auth/device` with optional `client_id` and `scope`.
2. Server returns `device_code`, human `user_code`, `verification_uri`, and polling interval.
3. Browser user opens `/device?user_code=...` and approves from the same-origin UI.
4. Client exchanges the approved code at `/api/auth/token`.
5. Access tokens are JWT bearer tokens whose `sub` is the approving user id; refresh tokens rotate on every refresh.

Device approval is first-wins: a pending request can become approved once,
and a competing approver cannot replace the original approver. Device-code
exchange uses one SQLite transaction in the default store to verify the
approved, unexpired request, reject disabled or missing approvers, consume the
request, revoke active same-client sessions, and insert the new refresh
session. Every `WebAppStore` implementation must provide the same atomic
transition. The access token is issued only after that transition commits, so
a concurrent exchange produces one token set at most.

Device codes are one-use. Device sessions are self-only in Settings, and only
active refresh-token sessions are listed. Revoked or expired sessions are
hidden; expired device-auth requests are purged when a new authorization
request is created, before user-code collision checks. Verification and
exchange paths do not delete requests, so consumed or revoked state remains
available long enough to classify replays until the next creation cleanup.
Reusing a consumed device code or stale refresh token returns `invalid_grant`.

Refresh rotation also uses a conditional SQLite transition in the default
store. The old row must match the presented hash, be unrevoked, unexpired, and
belong to the requested client before it is revoked and replaced. A replayed
token revokes its entire family and never inserts a successor. A disabled or
missing user follows the same no-successor rule.

### CLI session lifetime and multiple computers

Device access tokens last 10 minutes. Each newly issued refresh token lasts
30 days, including after rotation; this is not a guarantee that an explicitly
revoked session remains usable for 30 days.

Completing device authorization revokes active refresh sessions for the same
user and `client_id`. The composable CLI defaults to
`<commandName>-cli-<hostname>`, using the operating system hostname, so computers
with different hostnames remain signed in independently without a manual
`--client-id`. Reauthenticating with the same client ID replaces that client's
previous session. Access-token authentication checks that its issuing session
is still active, so revocation, refresh rotation and replacement invalidate the
previous session's access tokens as well.
Listing device sessions also revokes duplicate active entries with the same
`client_id`; it is not a read-only operation.

Generated defaults longer than the server's 200-character limit use
`cli-<hash>` instead, with a base64url-encoded SHA-256 of the full
`<commandName>-cli-<hostname>` value. The fallback is deterministic and avoids
collisions caused by truncating hostnames or command names.

An explicit `auth --client-id` overrides the application's configured `clientId`,
which overrides the generated default. Computers with identical hostnames, or
independent profiles on the same computer, still need distinct explicit IDs
to coexist. The CLI persists the selected value with the credentials and
reuses it for refreshes, even if the hostname subsequently changes.
New `auth` invocations generate the default from the current hostname.

Older CLI versions used `<commandName>-cli` on every computer. After updating,
run `auth` again on each computer to obtain hostname-based credentials;
existing credentials keep their original client ID until reauthentication.

A normal server restart preserves both tokens and signing keys when using
SQLite with the same data directory. The memory store or a replaced data
directory does not. See the [CLI invalidation reproduction](auth-validation.md#cli-session-invalidation-reproduction)
for a local diagnostic contrasting restart persistence with same-client revocation.

### Signing-key persistence and custom stores

The default SQLite store persists the signing key and enforces one active key
across processes with a database-backed marker and unique partial index.
First-use initialization uses conflict-safe get-or-create semantics and every
caller imports the durable winner returned by the database. The memory store
keeps one key per store instance, so it is not stable across restarts or
multiple processes.

Custom `WebAppStore` implementations must provide the same conditional
transition result contract for device approval/denial/exchange, setup-link
completion, passkey persistence with auth-version invalidation, refresh
rotation, signing-key get-or-create, and account disabling. Callers must not
compose the read-only lookup methods with low-level writes to implement these
transitions.

## Same-origin policy

Cookie/browser mutations require matching `Origin` or `Referer` by default.
`sameOrigin: "always"` also checks non-mutating requests and WebSocket upgrades
that rely on browser sessions. Explicit API keys, device bearer tokens and
validated client tickets authenticate independently of the client's host.
Use `sameOrigin: "never"` only for intentionally origin-independent public
routes, not to enable token-authenticated API clients.

## Detached browser clients

Remote static clients use device authorization, not third-party cookies.
Enable `auth.deviceAuth`; neither integrated nor API-only serving requires
registering where clients are hosted. CLI clients and separately hosted web
clients can use the API from any origin with their own credentials.

The API answers valid preflights before authentication and returns
`Access-Control-Allow-Origin: *` on successful and unsuccessful cross-origin
responses, without `Access-Control-Allow-Credentials`. Browser clients must omit
cookies and provide their API key or device token explicitly. It exposes actual
response metadata headers, including
ETag, content-disposition/content-range, passkey-required and application
headers such as `X-Example-Partial`. CORS grants permission to read a response,
not permission to access private data. Normal route authorization, scopes,
ownership and cookie CSRF checks remain in force.

Keep authentication enabled even for a loopback API. With authentication
disabled, private unauthenticated reads may be accessible to arbitrary websites.
Authentication bypasses are suitable only for isolated, disposable validation.
Use HTTPS for public deployments and trust the host serving client code:
script-readable client credentials are not protected from that host or XSS.

The client starts `/api/auth/device` and polls `/api/auth/token` as an ordinary
device client. The user opens the returned API-origin verification URL and
authenticates/approves there using the API's normal passkey flow. The resulting
device tokens stay in that client's endpoint-specific credential storage.
`GET /api/config` recognizes bearer identity and reports its `currentUser`,
permissions and authenticated passkey-gate state; invalid bearer credentials
return 401 instead of silently bootstrapping a different cookie identity.

### Browser socket and resource capabilities

Browser WebSockets, image/media elements and downloads cannot attach an
Authorization header. Exchange a device access token for a narrowly scoped
capability instead:

```http
POST /api/auth/client-ticket
Origin: https://static.example.test
Authorization: Bearer <device-access-token>
Content-Type: application/json

{"url":"/api/files/report?format=text","kind":"resource"}
```

The JSON response has `{url: string, expiresAt: number}`. `expiresAt` is Unix
epoch milliseconds. `url` is the requested application-relative path/query
with an opaque `webapp_ticket` parameter appended. Input and output omit the
API deployment prefix: join them to the configured API base URL, including
that base's prefix. Absolute URLs, fragments, path traversal requiring URL
normalization and existing ticket parameters are rejected. The endpoint requires
a valid device bearer token; cookie sessions and API keys cannot issue tickets.
Client origins do not need prior registration. When a client supplies `Origin`,
its ticket is bound to that observed origin; a non-browser client may omit it.

- `kind: "websocket"` lasts at most 30 seconds, requires GET plus a WebSocket
  upgrade with the same `Origin` presence/value as issuance, and is single-use.
  Request a new ticket for each reconnect. Both framework realtime and
  application route upgrades use the same capability authentication and
  observed-origin binding, not an origin allowlist.
- `kind: "resource"` lasts at most 60 seconds and supports repeat GET/HEAD
  requests, including ranges. Requests may omit `Origin` for navigation and
  media; when present it must match the issuing origin.

Both kinds are bound to the exact target path/query, user and device session.
Every redemption revalidates the access token, active session and current user;
ordinary route scopes and ownership checks still apply. Revoked, replaced,
expired or rotated sessions cannot redeem existing tickets. Authentication
removes the ticket before handlers, query validators and socket upgrades see
the request. Resource responses use `private, no-store` and `no-referrer`.
The capability is not a refresh/access token, but is still sensitive until it
expires: do not persist or share it, and avoid recording it in proxy logs.

Tickets are process-local, expire lazily on the next issue/redemption, and are
cleared on server stop. Issuance is bounded to 128 outstanding tickets per
session and 4,096 per server; capacity exhaustion returns 429
`client_ticket_limit`. Sticky routing is required when an external load
balancer distributes one API deployment across several processes. Existing
cookie and explicit-header bearer clients need no tickets.

## Reverse-proxy request trust

Forwarded request headers are ignored by default. When
`{PREFIX}_TRUST_PROXY=true` is enabled, the policy explicitly selects the
supported `X-Forwarded-Proto`, `X-Forwarded-Host`, and
`X-Forwarded-Prefix` values through `{PREFIX}_TRUST_PROXY_HEADERS`. Comma
chains use the configured `{PREFIX}_TRUST_PROXY_CHAIN` value (`first` for the
left-most non-empty value or `last` for the right-most non-empty value).
Malformed or missing request values fall back to the direct request.

The same normalized request context drives expected same-origin origins,
WebSocket origin checks, passkey expected origins and RP IDs, the `Secure`
cookie attribute, cookie paths, setup links, and device/discovery URLs.
`{PREFIX}_PUBLIC_BASE_URL` is authoritative for origin, hostname, and secure
state even when forwarded headers are present. It must be an origin-only
absolute `http` or `https` URL; trusted prefixes remain policy-controlled for
path-bearing cookies and links.

Trust mode is a deployment boundary setting, not a way to trust arbitrary
client input. The reverse proxy must strip client-supplied forwarded headers
and overwrite only the values configured above, preferably as sanitized
single-value headers. Do not expose the application directly to untrusted
clients when trust mode is enabled. This release does not implement a
proxy-address allowlist, so the network boundary and proxy sanitization are
required.

Applications that generate their own public URLs should use
`getRequestOriginInfo` or `getRequestBaseUrl` from
`@pablozaiden/webapp/server` with the server's runtime config instead of
parsing `{PREFIX}_PUBLIC_BASE_URL` independently. The framework validates the
configured public base URL during startup and applies the same trusted-proxy
policy used by its authentication and origin checks.
