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
