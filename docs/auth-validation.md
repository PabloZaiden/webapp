# Auth validation checklist

Run this checklist before migrating an app or cutting a checkpoint.

## Passkeys

1. Start the app with passkeys enabled and an empty data dir.
2. Confirm the bootstrap screen appears before the shell.
3. Register a passkey with the browser/platform authenticator.
4. Confirm the app shell loads and Settings shows passkey configured.
5. Click Logout and confirm reload/login requires passkey authentication.
6. Authenticate with the registered passkey and confirm the shell loads again.
7. Delete passkey from Settings, confirm the dialog supports Escape, X and Cancel.
8. Confirm deleting returns to bootstrap on reload.

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
