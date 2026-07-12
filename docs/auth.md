# Auth and security

The framework provides three auth modes designed to coexist.

## Users and passkeys

Passkeys are multi-user. The first run creates the immutable owner user and that user's passkey.

1. If no users exist, the UI asks for the owner username and passkey.
2. The owner cannot be deleted or demoted.
3. Owners and admins create users from Settings, which returns a one-time 24h setup link.
4. Users complete setup from `/setup?token=...`; usernames are lowercase, immutable and unique.
5. Admin resets clear the user's passkey, API keys and device sessions, then issue a new one-time setup link.
6. If the owner passkey is deleted, the owner setup screen is shown again.

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

`{PREFIX}_DISABLE_PASSKEY=true` is an emergency bypass that logs in as the existing owner only. It does not create the owner.

## API keys

API keys are user-owned bearer tokens for scripts and agents. They are stored hashed in SQLite and shown only once at creation. Route `scopes` are enforced for API-key requests; `*` grants all scopes.

Expired API keys do not authenticate, are omitted from user-facing lists, and are purged when key lists or expired keys are encountered.

Same-origin checks are skipped for API-key and device bearer requests unless a route sets `sameOrigin: "always"`, because non-browser clients usually do not send `Origin`.

## Device auth

Device auth is included in V1:

1. Client calls `POST /api/auth/device` with optional `client_id` and `scope`.
2. Server returns `device_code`, human `user_code`, `verification_uri`, and polling interval.
3. Browser user opens `/device?user_code=...` and approves from the same-origin UI.
4. Client exchanges the approved code at `/api/auth/token`.
5. Access tokens are JWT bearer tokens whose `sub` is the approving user id; refresh tokens rotate on every refresh.

Device codes are one-use. Device sessions are self-only in Settings, and only active refresh-token sessions are listed. Revoked or expired sessions are hidden; expired sessions are purged, while revoked session records can remain stored to detect stale refresh-token reuse. Reusing a consumed device code or stale refresh token returns `invalid_grant`.

## Same-origin policy

Cookie/browser mutations require matching `Origin` or `Referer` by default. Use `sameOrigin: "never"` only for deliberate public/server-to-server routes; use `sameOrigin: "always"` for especially sensitive endpoints even when bearer tokens are used.

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
state even when forwarded headers are present; trusted prefixes remain
policy-controlled for path-bearing cookies and links.

Trust mode is a deployment boundary setting, not a way to trust arbitrary
client input. The reverse proxy must strip client-supplied forwarded headers
and overwrite only the values configured above, preferably as sanitized
single-value headers. Do not expose the application directly to untrusted
clients when trust mode is enabled. This release does not implement a
proxy-address allowlist, so the network boundary and proxy sanitization are
required.
