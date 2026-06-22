# Auth and security

The framework provides three auth modes designed to coexist.

## Passkeys

Passkeys follow a single-passkey bootstrap model:

1. If no passkey exists, registration is allowed.
2. Once a passkey exists, protected routes require an authenticated passkey browser session, API key, or device bearer token.
3. Additional public registration is rejected after bootstrap.

Settings owns passkey logout/delete UX.

## API keys

API keys are bearer tokens for scripts and agents. They are stored hashed in SQLite and shown only once at creation. Route `scopes` are enforced for API-key requests; `*` grants all scopes.

Same-origin checks are skipped for API-key and device bearer requests unless a route sets `sameOrigin: "always"`, because non-browser clients usually do not send `Origin`.

## Device auth

Device auth is included in V1:

1. Client calls `POST /api/auth/device` with optional `client_id` and `scope`.
2. Server returns `device_code`, human `user_code`, `verification_uri`, and polling interval.
3. Browser user opens `/device?user_code=...` and approves from the same-origin UI.
4. Client exchanges the approved code at `/api/auth/token`.
5. Access tokens are JWT bearer tokens; refresh tokens rotate on every refresh.

Device codes are one-use. Reusing a consumed device code or stale refresh token returns `invalid_grant`.

## Same-origin policy

Cookie/browser mutations require matching `Origin` or `Referer` by default. Use `sameOrigin: "never"` only for deliberate public/server-to-server routes; use `sameOrigin: "always"` for especially sensitive endpoints even when bearer tokens are used.
