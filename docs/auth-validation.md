# Authentication integration validation

Validate only capabilities an app deliberately enables. No framework account,
owner-bootstrap, admin, device, OAuth or recovery workflow exists by default.
Tests should prove user-facing contracts through real listeners/processes,
not reproduce helper implementation details or add route-role matrices.

## Core and app policy

1. A minimal public app renders and receives live updates with private routes
   failing closed when no identity adapter is installed.
2. Both ambient and explicit credentials receive the same app authorization.
   Ambient mutations and WS reject foreign origins.
3. App-owned resource ownership runs before realtime interests filter delivery.
   Expired/revoked identities cannot continue receiving protected publications.
4. Identity/endpoint changes advance runtime generation, retire old transport
   work and remount app content. Caches owned outside the shell are retired too.
5. Storage-disabled browser operation works without a preference adapter.
   With an explicit adapter, existing theme/sidebar namespaces survive reload.

## Optional bonuses

Use isolated app-owned state and production helper interfaces.

1. Enrollment requires an app-authorized identity; no unintended public
   registration, account recovery or email route appears.
2. Password login, invalid credentials, app attempt limiting, password change,
   session invalidation and logout work through real app endpoints.
3. Real WebAuthn registration/authentication validates RP/origin, signed
   challenges and app credential CAS. Replay or obsolete epochs fail.
4. Restart with the same app-selected storage/signing key preserves intended
   credentials and sessions; disable/replacement/revocation rejects old access.
5. Expiry, signing-secret rotation and unavailable identities fail closed.
   App inventory callbacks must perform actual revocation when promised.
6. Review desktop/mobile app login/account UI, including errors and destructive
   confirmations, with disposable Bun.WebView captures.

`tests/auth-bonus.test.ts` is an end-to-end child-process journey with real
password hashes, signatures and persisted app-selected state. It is not a
database/account system for consumers to import.
