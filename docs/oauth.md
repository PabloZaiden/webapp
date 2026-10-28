# Resource-bound OAuth

OAuth is an opt-in authorization-code server for HTTP resources such as MCP,
not the framework's device flow. It reuses framework accounts and authenticated
browser sessions. Resource access and consent remain separate from normal
application/browser authentication.

```ts
const app = createWebAppServer({
  appName: "Example",
  envPrefix: "EXAMPLE",
  auth: {
    oauth: {
      issuer: "https://example.com",
      resource: "https://example.com/mcp",
      scopes: {
        control: "Use application control",
        general: "Use explicitly approved general account access",
      },
      resourceScopes: ["control"],
      clients: [{
        clientId: "desktop",
        clientName: "Example desktop",
        redirectUris: ["http://127.0.0.1:8181/callback"],
        grantTypes: ["authorization_code", "refresh_token"],
      }],
      consentPath: "/#/oauth-consent",
      async getConsentContext({ user, client, resource, scopes }) {
        // Presentation data for this authenticated human, never credentials.
        return await domain.getConsentChoices({ user, client, resource, scopes });
      },
      async resolveScopes(requestedScopes) {
        // Validate dynamic names; return descriptions only for recognized scopes.
        // This is discovery/description, NOT an application authorization grant.
        return await domain.describeRequestedScopes(requestedScopes);
      },
      async authorizeConsent({ user, client, resource, scopes, approval }) {
        // approval is untrusted JSON from the application's consent form.
        // Check membership, explicit general approval and application policy here.
        const grant = await domain.approveGrant({ user, client, resource, scopes, approval });
        if (!grant) return false;
        return { scopes: grant.scopes, authorizationContext: { grantId: grant.id } };
      },
      async validateAuthorization(principal) {
        // Reconcile current application policy on EVERY resource access/refresh.
        return await domain.isGrantActive(principal.user.id, principal.authorizationContext);
      },
      async handleResource(request, principal) {
        return await resourceTransport.handle(request, principal);
      },
    },
  },
});
```

`OAuthConfig`, `OAuthClient`, `OAuthConsentRequest`, `OAuthConsentInput`, `OAuthPrincipal`,
`OAuthAuthorizationContext`, `OAuthService`, `parseOAuthClients()`, and `createOAuthClientSecret()` are
exported from `@pablozaiden/webapp/server`.

## Resource admission and application execution

The optional `handleResource(request, principal)` mount is reserved at the
configured resource's exact URL path. It authenticates every request and
requires `resourceScopes` before invoking application transport code. It does
not use an `auth: "public"` application route: normal route authentication
intentionally rejects OAuth tokens, including on public routes. Do not mount
the transport through a bearer passthrough or an unrestricted API key.
The framework reserves this resource path and protocol endpoints in Bun's
native document routing too, so GET/streaming requests cannot accidentally
receive the application HTML bundle. Auth-only web mode also serves the
configured consent UI path using its supplied authentication document.

### Compose another verified admission at the same resource

`publicRoutes` is **not** a pre-OAuth hook: the configured OAuth resource is
reserved before public routes. Instead, optional
`admitResource(request): Response | undefined | Promise<Response | undefined>`
runs at that exact resource path before OAuth verification. It requires a
configured `handleResource`. Return a final transport/denial response after
independently verifying an application-supported credential and its complete
grant. Return `undefined` to continue with the normal OAuth verifier and
`handleResource(request, oauthPrincipal)`. A callback error fails closed with
500; it never falls through to another authentication mode.

```ts
async admitResource(request) {
  const service = await control.verifyBoundServiceRequest(request);
  if (service instanceof Response) return service;
  if (!service) return undefined; // Includes OAuth tokens, not recognized as service credentials.
  return resourceTransport.handle(request, service);
},
handleResource(request, oauthPrincipal) {
  return resourceTransport.handle(request, oauthPrincipal);
},
```

For framework managed keys, the application's private verifier can call public
`authenticateApiKey(app.store, token)`, require the explicit limited control
scope, reject unrestricted keys, and reconcile its bound grant/key ID on every
request and approval. The callback must not consume the shared request body
without cloning it. It must not manufacture an OAuth identity, exchange keys
for OAuth/browser credentials, or forward service credentials to OAuth
clients. This is a server-code resource admission capability, not a bypass for
ordinary REST routes. A service key retains its existing framework scope
rules everywhere else; applications must not mark unrelated REST operations
with their control-only scope. OAuth resource and protocol endpoints still
never accept service keys as OAuth tokens.

For externally hosted transport integration, `app.oauth!.authenticate(request,
requiredScopes?)` returns `OAuthPrincipal | Response`. A successful principal
contains the current `user`, `clientId`, exact `resource`, granted `scopes`,
application `authorizationContext`, and `grantId`. An unsuccessful result is
an intentional HTTP response (401 invalid/expired credentials, 403 missing
scope, or 400 query-string token). Operational failures fail closed with 500.
Without an explicit scope argument the verifier requires `resourceScopes`.
Pass an explicit empty array only when the transport itself checks every
operation's scope before executing it.

Only opaque access tokens issued by this OAuth server are accepted. API keys,
device tokens, refresh tokens and tokens issued for a different resource or
issuer are rejected. OAuth tokens do not authenticate normal REST APIs,
framework Settings/account/key endpoints, client tickets, realtime, device
approval or browser API-key sign-in. There is no OAuth-to-browser/API-key
exchange and no client-credentials, device-code, implicit or wildcard grant.

Use the existing [delegated dispatcher](delegation.md) for constrained guest
operations. For explicitly approved account-level operations, the server-only
`dispatchAuthenticated` capability preserves the account's current role:

```ts
const result = await app.dispatchAuthenticated(operationRequest, {
  userId: verifiedPrincipal.user.id,
  authorize(operation, request) {
    // Canonical route path, effective method, params, auth, scopes and metadata.
    // Reconcile the explicit grant for this exact operation and all bound input.
    return control.authorize(verifiedPrincipal, operation, request.clone());
  },
  run(invocation, invoke) {
    return controlAuthority.run(invocation.authorization, invoke);
  },
  onError(error, operation) {
    return control.safeErrorResponse(error, operation);
  },
});
```

This is a trusted **server-code capability**, not a public endpoint, a bearer
credential or automatic escalation from OAuth scopes. A successful
`authorize` must return an application authority object; `false`/`undefined`
deny. The framework loads the enabled user from its account store, preserves
normal admin/owner, ownership and `userParam` checks, and rechecks account
version/role after asynchronous authorization. Only private application
operations can run. No delegation metadata is required; that is the
intentional difference from `dispatchDelegated`. The original request's
Authorization/cookie/Origin headers confer no authority on this path.

The normal compiled routes, route middleware, input validation, error
mapping, security headers, `HEAD` behavior and `requestFilter` are retained.
`run` establishes typed application operation authority before middleware and
the handler. `ctx.auth.kind` is `"server"` and helpers see the actual account,
not an invented owner. Built-in framework routes, browser documents and public
routes are never dispatched. No browser cookie or credential is minted.
The framework API-key/device scope check does not apply to this server-code
capability: its mandatory application `authorize` callback owns the admitted
operation policy. Never expose it as an arbitrary user-ID HTTP proxy.

Account checks also run when `run` hands off to middleware, immediately before
the handler (including after asynchronous middleware), and before returning
the result. A changed role, authentication version or disabled account denies
the stale invocation. These are authorization handoff boundaries, not a
rollback/cancellation system: application work that already began under valid
authority is not undone. Long-running domain mutations must enforce their own
transactional authorization at commit if they require stronger guarantees.

## Human consent integration

The application owns the consent UI at `consentPath`; the framework owns its
authenticated state transitions:

1. A client starts at `GET /api/oauth/authorize` with `response_type=code`,
   its registered `client_id`, exact `redirect_uri`, `resource`, explicit
   `scope`, `code_challenge`, `code_challenge_method=S256`, and optional `state`.
2. The framework redirects to `consentPath?request=<opaque handle>`.
   A canonical application hash route is also supported:
   `consentPath: "/#/oauth-consent"` redirects to
   `/?request=<opaque handle>#/oauth-consent`. Existing route queries are not
   accepted in configuration. Render the `oauth-consent` view through the
   normal `WebAppRoot.routes` integration and read the request handle
   with `new URLSearchParams(window.location.search).get("request")`. The hash
   stays unchanged; no custom hash parsing is needed. A regular path such as
   `/consent` remains valid.
   If necessary, show the existing framework login flow before reviewing it.
   The pending request survives login and server restarts.
3. Fetch `GET /api/oauth/consent?request=<handle>` using the authenticated
   same-origin browser session. It returns `request`, `client` (ID and name),
   `resource`, `scopes: [{scope, description}]` and `expiresAt`.
   The first authenticated review binds the request to that account and
   authentication version. Another account cannot review/approve it.
   Optional `getConsentContext({user, client, resource, scopes})` supplies
   `consentContext` in this response, for example eligible workspace/general
   choices. It runs only after authenticated review binds the account, outside
   the synchronous store transaction, with request/account validity rechecked
   afterward, including the observed account role. Its JSON-only presentation
   result is bounded to 8 KiB and is not persisted as grant authority. Do not
   include credentials or private secrets.
4. Render client, resource, descriptions and the application-specific choice.
   Do not automatically approve. POST `/api/oauth/consent` with JSON
   `{request, decision: "approve" | "deny", approval: {...}}`. Browser cookies
   and an exact same-origin `Origin` are required, even if ordinary same-origin
   protection is disabled. Bearer credentials and the emergency passkey bypass
   cannot approve; OAuth also requires passkeys to be enabled.
5. On explicit approval, `authorizeConsent` validates application choices and
   returns authority context and optionally a **subset** of requested scopes.
   `false` denies. Context must be JSON-only and at most 8 KiB. It is persisted
   but never included in the OAuth client's token response.
6. The decision response contains `{redirectUri}`. Navigate the browser to
   that URL. It contains the one-use code (or `access_denied`), the unchanged
   client `state` when present, and RFC 9207 `iss`. Pending requests cannot be
   decided twice.

Treat the handle, authorization code and redirect result as sensitive. Do not
log request URLs, headers, bodies, callback errors or grant data. Consent UI
should set `Referrer-Policy: no-referrer` and avoid third-party assets. The
framework's protocol responses are non-cacheable and set that referrer policy.
Keep application approval callbacks idempotent: a concurrent decision or an
account lifecycle change can win before the framework commits consent.
An application grant created by a losing callback must not itself confer
transport access.

`resolveScopes` validates/describes application-owned dynamic names (for
example resource-qualified workspace scopes); it does not grant access.
Static descriptions take precedence. `authorizeConsent` and
`validateAuthorization` must enforce the actual relationship and policy.
`resourceScopes` advertises only the minimal scopes required by the resource;
the authorization-server metadata advertises all static scope descriptions.
Dynamic scopes need not appear in metadata.
Only explicitly configured or resolved scope names are recognized. Unknown
names, including names resembling inherited object properties, receive the
normal `invalid_scope` redirect.

Clients do **not** need workspace identifiers or a privileged general scope
in advance. They may request only a base scope such as `control`. The consent
UI renders `consentContext` choices and submits the selected workspace/general
mode in `approval`; `authorizeConsent` independently validates that selection
and persists it in `authorizationContext`, retaining the base scope unchanged.
`validateAuthorization` and the application's per-operation admission must
reconcile that context every time. Presentation context is never approval.
Scopes may only be retained or narrowed at consent, not widened.

For private bounded application service credentials, the existing public
`authenticateApiKey(app.store, token)` returns
`{user, apiKeyId, scopes} | undefined`. Reinvoke it on every request/approval
and independently enforce the required limited control scope and application
binding. For OAuth, use
`app.oauth!.authenticate(resourceRequest, ["control"])` on each resource
request/approval and handle `Response` as denial/failure. These helpers do not
authorize a canonical application operation by themselves; feed verified
identity into the mandatory `dispatchAuthenticated.authorize` policy.

## Discovery, clients and token lifecycle

For root issuer `https://example.com` and resource `/mcp`, discovery is at
`/.well-known/oauth-authorization-server` and
`/.well-known/oauth-protected-resource/mcp`. The root protected-resource
metadata path is also served for this single resource. Path-bearing issuers
use RFC 8414's `/.well-known/oauth-authorization-server/<issuer-path>` and
prefix protocol endpoints with that issuer path. A 401/403 challenge includes
`resource_metadata`, required scopes and the appropriate bearer error.

The supported registration policy is **explicit pre-registration**. Redirect
URIs require HTTPS or literal loopback/localhost HTTP, have no fragments or
embedded credentials, and are compared exactly, including path, query and
port. No wildcard/loopback-port relaxation is implemented. No arbitrary
client metadata URL is fetched (no SSRF surface); CIMD and deprecated dynamic
registration are not advertised or implemented.

### Operator-owned client configuration

Applications can read a documented environment variable or configuration file
without adding a framework client CRUD endpoint. Use the public parser so
untrusted JSON is validated by the same registration policy as startup:

```ts
import { parseOAuthClients } from "@pablozaiden/webapp/server";

const rawClients: unknown = JSON.parse(process.env["EXAMPLE_OAUTH_CLIENTS"] ?? "[]");
const clients = parseOAuthClients(rawClients); // Supply as auth.oauth.clients.
```

For example, `EXAMPLE_OAUTH_CLIENTS` can contain:

```json
[{
  "clientId": "desktop",
  "clientName": "Example desktop",
  "redirectUris": ["http://127.0.0.1:8181/callback"],
  "grantTypes": ["authorization_code", "refresh_token"],
  "tokenEndpointAuthMethod": "none"
}]
```

The variable name and file-loading policy are application/operator-owned;
the framework does not automatically read any particular variable. Invalid
JSON or invalid client/redirect/authentication configuration fails startup,
not an empty-success fallback. Apply changed registrations by reloading the
application configuration/restarting. Removing a client invalidates its tokens.
Keep the fixed public client ID and exact callback URI consistent on both
sides, including the loopback port. An empty registry intentionally admits
no clients.

The public MCP TypeScript SDK can use a provider whose `clientInformation()`
returns `{client_id: "desktop", token_endpoint_auth_method: "none", issuer:
"https://example.com"}`, with the matching `redirectUrl` and client metadata.
Issuer-bind stored credentials/tokens and implement the provider's secure
session storage and browser handoff as required by that SDK version.
An executable real-HTTP probe with `@modelcontextprotocol/sdk@1.32.2` verified
discovery, S256, the exact registered redirect/resource, base-scope consent,
code exchange, refresh rotation and REST isolation. Its client wrapper
explicitly checked callback `state` and RFC 9207 `iss` before code exchange;
do not assume that SDK version performs the current specification's issuer
validation for you.

This is **not universal MCP-client auto-onboarding**. An SDK provider that
returns no registered client information, or a client that requires DCR/CIMD
and cannot accept operator-supplied registration, cannot complete this
implementation's flow unchanged. The same probe confirmed automatic dynamic
registration is rejected. No registration endpoint is advertised.

Public clients use `tokenEndpointAuthMethod: "none"`. Confidential clients use
`"client_secret_basic"` and a `clientSecretHash` generated by
`createOAuthClientSecret()`. Retain the returned plaintext secret securely
outside source control and configure only its hash on the server. These
secrets are not application service/API credentials. All clients require
PKCE S256.

The token endpoint accepts standard `application/x-www-form-urlencoded`
requests. Authorization-code exchange requires `grant_type=authorization_code`,
`code`, `code_verifier`, `redirect_uri`, `resource` and the public client's
`client_id` (or confidential HTTP Basic authentication). Refresh uses
`grant_type=refresh_token`, `refresh_token`, `resource`, client authentication,
and optional downscoping `scope`. Duplicate parameters and wrong
client/resource/redirect/verifier are rejected. Redirect errors are returned
only to an already validated registered redirect; invalid clients/redirects
receive local errors.

Pending requests last 10 minutes, codes at most 60 seconds, and access tokens
at most 10 minutes. Refresh tokens are issued only to clients registered with
`grantTypes` containing `"refresh_token"`. Every refresh rotates both
credentials and invalidates the previous access token. Families have an
absolute 30-day lifetime, not a sliding expiration. Validated code replay and
refresh replay revoke the family. Revocation is committed even when the
request returns `invalid_grant`. Authorization-code expiry prevents unused
codes from issuing credentials; a consumed code with verified client, resource,
redirect and PKCE bindings still revokes its family after code expiry.
Binding-verified refresh replay also revokes the family before an application
policy denial or failure can mask it, including when policy now accepts only
the successor's narrowed scopes.

`POST /api/oauth/revoke` accepts `token` and client authentication, revokes the
matching client's entire grant family, and is intentionally idempotent for
unknown tokens. Authenticated humans can list their active grants with
`GET /api/oauth/grants`. Each summary contains `id` (the stable public
`OAuthPrincipal.grantId`), `clientId`, `clientName`, `resource`, `scopes`,
`authorizationContext`, `createdAt` and `expiresAt`. The context is the
persisted application JSON from consent, enabling application-owned grant
labels such as workspace/general. Keep it safe for the authorizing human to
view, never put credentials/secrets in it, and validate it against the
application schema before rendering. Unknown/empty context must not imply a
broader grant. Summaries contain no credential values or hashes and are
available only to that human's authenticated browser session, not OAuth/API
bearers or another account.

Humans revoke their own grant with
`DELETE /api/oauth/grants?id=<grantId>` (same-origin required). Account
deletion/disabling and authentication-version changes immediately invalidate
issued credentials and consent requests; current application grants are
reconciled by `validateAuthorization`.

Presentation, consent, access verification and refresh also reject an account
role change across asynchronous policy hooks, even though changing a role does
not itself increment the account authentication version. The final account
check precedes returning an OAuth principal or committing credentials; policy
decisions made for the old role cannot authorize the new one.

## Persistence, deployment and validation

Both built-in stores implement `WebAppStore.oauth`. SQLite uses the same
private account database and immediate transactions for consent, one-use code
exchange, rotation and revocation. Both OAuth tables have expiry indexes so
cleanup does not scan all retained history while holding the writer lock.
Only token/code/handle hashes are stored;
there is no new signing key, crypto implementation or identity database.
Existing framework `node:crypto` helpers supply secure randomness, SHA-256 and
constant-time comparison. The memory store is deliberately volatile.

Custom account stores must implement the optional `OAuthStore` property before
enabling OAuth; the server fails closed if it is missing. Transactions must
be synchronous, atomic, isolated, roll back on exceptions, and share the
account store's consistency boundary. Persisted OAuth records must be runtime
validated; malformed state cannot silently become an empty successful grant.
Retain rotated/revoked records and consumed-code bindings until the family's
absolute expiry for replay detection. Consumed authorization records use their
`expiresAt` as this retention deadline, rather than the original pending-request
deadline, so normal cleanup cannot discard active-family replay protection.

Configure fixed externally visible issuer/resource URLs, HTTPS, durable
storage and the existing explicit proxy trust settings. Never derive the
issuer, resource, client registration or redirect URI from untrusted Host or
forwarded headers. No credential/request-body logging should be enabled at a
reverse proxy or application boundary either.

`tests/oauth.test.ts` exercises real HTTP discovery, consent, client binding,
PKCE, resource isolation, dynamic scopes, replay, account/application
invalidation and SQLite reconstruction. `tests/oauth-restart.test.ts` verifies
pending consent, codes, credentials and revocation across actual server process
restarts, including a path-bearing issuer. `tests/authenticated-dispatch.test.ts`
is a focused server-code public-contract test, not an end-to-end browser test.
The application must additionally validate its actual login/consent UI with
`Bun.WebView`; the framework adds no application-specific consent screen.

Compatibility target:
[MCP HTTP authorization, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).
Pre-registration is a supported registration mechanism in that specification;
this implementation deliberately does not claim optional CIMD, DCR or OIDC
capabilities.
