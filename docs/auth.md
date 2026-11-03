# Optional authentication bonuses

The core has no accounts, roles, auth endpoints or login/admin pages. Apps
select identity/policy through the [server hooks](server.md). Import bonuses
explicitly from `@pablozaiden/webapp/auth`; nothing activates them automatically.
Browser ceremony functions are exported separately from `/auth/browser`.

Bonuses provide mechanisms, not account policy. Applications own enrollment
authorization, enabled-identity checks, storage, atomic updates, revocation,
attempt/concurrency limits, secrets, routes and screens. Account recovery,
public registration, email, device authorization, OAuth and API keys are not
framework products.

## Browser sessions

```ts
const sessions = createBrowserSessions({
  origin: "https://example.test",
  secret: durableSigningSecret, // Uint8Array, at least 32 bytes; or async getter
  cookie: { name: "example_session", path: "/", maxAgeSeconds: 86400 },
  getIdentity: id => accounts.findEnabled(id),
  getVersion: identity => identity.authVersion,
  isSessionValid: session => sessionInventory.isActive(session.id),
  onCreate: session => sessionInventory.create(session),
  onRevoke: session => sessionInventory.revoke(session.id),
});
```

`create(identityId,{expectedVersion?})` returns `{token,session,cookie}`. Pass
the identity epoch bound to successful verification to reject concurrent
replacement. `authenticate(req)` returns
`{identity,session}` or `undefined`; storage failures are not disguised as
authentication success. `logout(req)` invokes app revocation and returns an
expired cookie. Apps explicitly set `Set-Cookie`.

`BrowserSession` contains `id`, `identityId`, `version`, `issuedAt` and
`expiresAt` (milliseconds). Tokens use JOSE HS256, origin/cookie-specific issuer
and audience, random session IDs and expiry. Identity/version and optional
inventory are checked on every authentication. Keep signing keys durable and
private; rotating/removing them invalidates old signatures. Incrementing the
identity epoch invalidates all its sessions. Omit inventory only when stateless
sessions are intentional: clearing a cookie alone does not revoke a copied token.

Cookies are HttpOnly/SameSite=Lax, Secure on HTTPS, with explicit name/path/TTL
validation. HTTP is allowed only on loopback. `logout` and all bonus ceremonies
require an exact configured Origin. Applications retain ordinary CSRF/origin
checks on other cookie-authenticated mutations and WebSocket admission.

## Passwords

`createPasswordAuth({origin,getCredential,getCredentialByIdentity,
setCredential,allowAttempt})` uses Bun's Argon2id implementation, not custom
hashing. Password enrollment/change requires at least 12 characters, with a
1024-byte maximum. Attempts are admitted by the required app callback before
expensive hashing; bound both attempts and concurrent requests in the app.

- `getCredential(username)` and `getCredentialByIdentity(id)` return
  `{identityId,hash,version}` or `undefined`.
- `setCredential(id,expectedVersion,{hash,version})` must atomically insert/CAS
  and invalidate the app's affected browser sessions. It returns boolean;
  concurrent changes fail with 409 rather than overwriting.
- `allowAttempt({action,request,identityId?,username?})` returns boolean;
  actions are `"enroll"`, `"login"`, `"change"`.
- `enroll(req,authorizedIdentityId,password)` enrolls an already-authorized
  identity. Never expose it as implicit public signup.
- `verify(req,username,password)` returns `{identityId,version}` or undefined.
- `change(req,id,currentPassword,nextPassword)` verifies the current secret
  and advances the stored credential version.

Apps must bind successful verification to current account/session state and
coordinate changes atomically when creating sessions. Do not retain successful
verification as an indefinitely reusable authorization grant. Plaintext is never
persisted. Invalid credential failures are deliberately nonspecific.

## Passkeys

`createPasskeyAuth(options)` uses SimpleWebAuthn registration/authentication.
The app supplies exact `origin`, `rpID`, `rpName`, required `allowAttempt`, and:

| Callback | Contract |
| --- | --- |
| `getIdentity(id)` | Enabled `PasskeyIdentity` or undefined |
| `listCredentials(identityId)` / `getCredential(credentialId)` | App-owned credential material |
| `saveChallenge(record)` | Persist intended-use, expiring challenge |
| `consumeChallenge(id,purpose)` | Atomically consume one matching, unexpired challenge |
| `saveCredential(credential,expectedIdentityVersion)` | Atomically register/replace and check epoch; return false on conflict, true if unchanged, or the exact committed epoch if advanced |
| `updateCredential(expected,newCounter,expectedIdentityVersion)` | CAS old credential/counter and identity epoch |

`PasskeyIdentity` is `{id,username,displayName?,userHandle,version}`; userHandle
is a stable `Uint8Array<ArrayBuffer>`, not a newly generated migration identity.
`PasskeyCredential` contains `{credentialId,identityId,publicKey,counter,
transports?}`. Existing SimpleWebAuthn material maps directly; no full account
store contract is required.

`beginRegistration(req,authorizedIdentityId)` and
`beginAuthentication(req,identityId?)` return `{challengeId,options}`.
The app carries that opaque ID to
`finishRegistration(req,id,challengeId,response)` or
`finishAuthentication(req,challengeId,response)`.
Without an identity selection, authentication uses discoverable credentials and
does not enumerate stored descriptors. Non-discoverable credentials use an
identity-specific flow.
Finish returns the verified/CAS identity snapshot plus credential information,
never a post-verification reread that might upgrade old proof to a new epoch.
Bind it to `sessions.create(id,{expectedVersion:identity.version})`.
App-authorized enrollment/replacement is mandatory.

Challenges expire in five minutes by default (maximum ten), are intended-use
bound, and must be single-use across concurrent requests/processes. The helper
also checks expiry and identity epoch. Registration/login requires user
verification by default; deliberately select `requireUserVerification:false`
only when app policy permits presence-only credentials. Counter/epoch CAS must
fail closed when a credential is replaced or disabled during a ceremony.

`AuthBonusError` exposes a safe `status`, `code` and `message`; map it at app
routes. Parsing untrusted JSON is still the app route's responsibility.

### Retaining an existing auth protocol

`createPasskeyCeremonies({origin,rpID,rpName,requireUserVerification?})` is the
same underlying mechanism without challenge, account, cookie or session
assumptions:

- `beginRegistration({userHandle,username,displayName?},credentials?)` returns
  registration options.
- `verifyRegistration(response,expectedChallenge)` returns
  `{credential:{credentialId,publicKey,counter,transports},deviceType,backedUp}`.
- `beginAuthentication(credentials?)` returns authentication options.
- `verifyAuthentication(response,expectedChallenge,credential)` returns
  `{counter}`.

Descriptors/credentials accept `transports?:readonly string[]`; current
supported transport hints are normalized without mutating persisted legacy
metadata. Verification requires UV by default; `false` explicitly selects
preferred/presence-only policy. The app must preserve Origin checks,
single-use expiring challenges, rate/concurrency limits, enrollment authority,
credential CAS and session binding. The high-level helper delegates these
same four ceremonies, not a separate cryptographic implementation.

## Example and migration

Notes TODO demonstrates app-owned SQLite password/session state **only** when
`NOTES_TODO_AUTH=password`. On first opt-in startup the operator supplies
`NOTES_TODO_ENROLL_PASSWORD`; no HTTP registration endpoint is created.
Remove that environment secret after enrollment. Authentication is otherwise
off in this explicitly public development example.
The authentication database/directory are owner-only. Loopback authentication
uses the configured hostname; non-loopback binds require
`NOTES_TODO_PUBLIC_BASE_URL`.

These are new opt-in token/session formats, not compatibility shims for old
Webapp accounts. Apps preserving old cookies/keys/tables should move their
existing implementations into app ownership and compose the generic request
hook. Do not silently reset or reinterpret production credentials.
