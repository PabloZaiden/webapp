# Auth validation checklist

Run this checklist before releasing a framework app or cutting a checkpoint.

## Passkeys

1. Start the app with passkeys enabled and an empty data dir.
2. Confirm the owner bootstrap screen appears before the shell.
3. Register the owner username and passkey with the browser/platform authenticator.
4. Confirm the app shell loads and Settings shows the owner account and passkey configured.
5. Click Logout and confirm reload/login requires passkey authentication.
6. Authenticate with the registered passkey and confirm the shell loads again.
7. Delete passkey from Settings, confirm the dialog supports Escape, X and Cancel.
8. Confirm deleting the owner passkey shows owner re-setup on reload.

## Users and roles

1. As owner/admin, create a non-admin user and copy the one-time setup link.
2. Open `/setup?token=...` in a fresh context and register that user's passkey.
3. Confirm the new user can sign in and does not see admin-only settings.
4. Confirm app data is empty for a newly-created non-owner user unless explicitly provisioned.
5. Promote the user to admin and confirm user management appears.
6. Demote the user and confirm admin settings disappear.
7. Reset the user and confirm old sessions/API keys/device sessions no longer work.
8. Confirm owner cannot be reset, deleted, or demoted.

## App data isolation

1. Create data as owner and as a non-owner user.
2. Confirm list endpoints return only the current user's data.
3. Confirm item endpoints return 404 for another user's IDs.
4. Confirm user-owned realtime events reach only sockets authenticated as the owning user.
5. Confirm public endpoints intentionally attach data to the correct owner/user and never broadcast user-owned IDs globally.

## API keys

1. Create an API key from Settings and copy the token.
2. Confirm the token is shown once.
3. Call a protected API route with `Authorization: Bearer <token>`.
4. Delete the key from Settings and confirm the confirmation dialog appears.
5. Confirm the deleted token no longer authenticates.
6. Create a managed key through the server-only helper and confirm it authenticates through the same bearer path.
7. Confirm managed keys and `managedBy` metadata are absent from the normal API-key list and Settings UI.
8. Restart against the same data directory and confirm a non-expired managed key still authenticates.
9. Revoke the managed key through the server-only helper and confirm it no longer authenticates.

## Browser API-key sign-in

1. Use an app with `auth: { passkeys: true, apiKeys: true }`, a configured user/passkey, and a user-owned `*` API key.
2. Log out, confirm the `Passkey required` screen offers **Authenticate with API key**, and confirm the API-key field is masked.
3. Enter the key and confirm the application shell loads with the same user and protected permissions as passkey authentication.
4. Repeat with a server-managed `*` key and confirm key provenance does not change the result.
5. Try an invalid, expired, disabled-user, or limited-scope key and confirm login fails without revealing the submitted key.
6. Repeat the exchange with the same key and confirm it remains reusable until it is deleted, revoked, or expires.
7. Delete or expire the source key after a successful exchange and confirm the already-issued browser session continues to work.
8. Confirm the exchange updates the key's `lastUsedAt` but does not add a passkey `user_login` audit event or change `lastLoginAt`.
9. Confirm the endpoint rejects missing or mismatched `Origin`/`Referer` and that a successful HTTPS/proxied exchange sets `HttpOnly`, `SameSite=Strict`, `Secure`, and the configured cookie path.

## CLI API-key authentication

1. Set `${PREFIX}_BASE_URL` and `${PREFIX}_API_KEY` for an app whose CLI passes
   its `envPrefix` to `runApiCliCommand()`.
2. Run a protected API command and confirm it reaches the configured server
   without starting an interactive device flow.
3. Remove either variable and confirm the request falls back to anonymous
   behavior.
4. Use an expired, invalid, or insufficient-scope key and confirm the CLI
   reports the server rejection without refreshing or retrying the key.

## CLI device-token recovery and lock coordination

1. Store a non-expired device access token, make its protected API request
   return `401`, and confirm the CLI refreshes once and retries with the
   replacement access token.
2. Make the retry return `401` as well and confirm the CLI returns that final
   response without issuing another refresh or entering a retry loop.
3. Start competing CLI callers with the same rejected token and confirm only
   one refresh-token request is sent; all callers use the resulting persisted
   credentials.
4. Replace the persisted token while a forced refresh waits for the profile
   lock and confirm the waiting caller uses the newer token without a
   redundant refresh.
5. Leave a stale profile lock from a terminated process, start competing
   callers, and confirm only one callback enters at a time. Confirm stale
   recovery cannot remove a lock published by the current owner.

## Device auth

1. Call `POST /api/auth/device` with `client_id` and `scope`.
2. Open `verification_uri_complete` in the browser.
3. Confirm the device approval screen shows client, scope, status and expiry.
4. Approve the request and exchange `device_code` at `/api/auth/token`.
5. Use the access token on a scoped route.
6. Refresh with `/api/auth/refresh` and confirm a new refresh token is returned.
7. Reuse the old refresh token and confirm `invalid_grant`.
8. Reuse the consumed device code and confirm `invalid_grant`.
9. Revoke the active device session from Settings and confirm refresh fails.
10. Create a new authorization request after an older request expires and confirm expired device requests are cleaned up without removing active requests.

## Atomic credential transitions

1. Open one device verification link in two browser contexts, approve it with different users, and confirm the first approval remains the approver.
2. Submit the same approved device code from two clients at once and confirm only one receives tokens, the request becomes consumed, and only one active same-client session remains.
3. Submit the same setup link from two fresh contexts with valid passkeys and confirm only one completion succeeds; the other cannot replace the stored passkey.
4. Present one refresh token from two clients at once and confirm only one successor is created. Confirm the replay response is `invalid_grant` and the refresh family is revoked according to the documented policy.
5. Start two first-use signing-key callers against the same data directory and confirm both use the same `kid`; restart the app and confirm the `kid` is unchanged.
6. Disable a non-owner user through the account lifecycle operation and confirm all active refresh sessions are revoked, device exchange and refresh return intentional 4xx errors, and a previously-issued bearer token no longer authenticates.
7. Confirm successful transitions create their existing audit events only after the durable state change; losing, expired, consumed, replayed, and disabled requests create no success-shaped event.
