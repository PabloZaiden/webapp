# Server API

`@pablozaiden/webapp/server` does not import account stores, authentication
bonuses or a database. Construction/startup does not initialize account state.
`readRuntimeConfig` reads environment variables, not a persisted configuration
file. Its `dataDir` is a path value for apps, not a request to create storage.
Apps may explicitly call `readWebAppConfig` and select their own persistence.

## Composition

```ts
const app = createWebAppServer<Event, Identity>({
  appName: "Example",
  envPrefix: "EXAMPLE",
  web: { entry: new URL("./web/main.tsx", import.meta.url) },
  identity: {
    authenticate: request => appSessions.authenticate(request),
    authorize: (request, identity, operation) => appPolicy(identity, operation),
  },
  request: (request, server) => appDispatch(request, server),
  routes,
  websockets: { terminal: appTerminalHandlers },
  lifecycle: { beforeStart: initializeApp, afterStop: closeApp },
});
await app.start();
```

The identity result is `{ identity: TIdentity, credential: "ambient" |
"explicit" }` or `undefined`. Credential provenance changes transport/CSRF
requirements only, never identity privileges. The core does not know roles,
accounts, scopes, delegations or automation policy.

The app `request(req, server?)` hook returns a `Response` when handled and
`undefined` to continue. It runs after deliberate public assets, before generic
routes, health/config, realtime and document fallback. A successful
`server.upgrade(req,{data})` consumes the request even when the hook returns
`undefined`. App-owned auth endpoints, legacy dispatch and additional transports
can therefore compose without copying the generic frame.

Set `data.webappSocketHandler` to select an entry in `websockets`. Custom
handlers never fall back to the realtime bus when a callback is absent. App
handlers own authorization and cleanup of their transports.

Set `web: false` for API/WS-only processes. `web.paths` restricts document
fallback to explicit paths, for example `["/", "/login", "/account"]`, without
giving those paths authentication semantics. Documents and assets are public
presentation; private data still requires server policy. `requestFilter` may
deny a request before dynamic dispatch; static native bundle assets are not an
authorization boundary.

Native development documents use Bun's mounted HTML bundle/asset/HMR pipeline
after app dispatch. Compiled documents reuse embedded client artifacts.
Runtime document caches and opt-in log capture use private OS temporary
locations, not a writable application directory. Nested document fallbacks
resolve bootstrap/assets from the configured deployment base, including
explicit reverse-proxy prefixes; static client directories remain relocatable.
`createWebDocumentProvider` and `htmlResponse` are available for app-owned
document composition.

The framework owns the fixed-scale viewport: `initial-scale=1`,
`maximum-scale=1` and `user-scalable=no`, alongside `width=device-width` and
`viewport-fit=cover`. This policy is shared by development documents, compiled
servers, static clients and installed PWAs, including documents with PWA
metadata disabled. Browsers that honor the scaling tokens prevent
pinch-to-zoom; browsers that ignore them are unaffected. Normal scrolling
remains enabled. Do not replace this policy with app-owned HTML, global touch
handlers, `preventDefault()` or `touch-action: none`.

## Routes and authorization

```ts
const routes = defineRoutes<Event, Identity>({
  "/api/workspaces/:workspace": {
    policy: { capability: "read-workspace" },
    GET: (_request, context) =>
      jsonResponse(loadWorkspace(context.requireIdentity(), context.params["workspace"]!)),
  },
  "/api/ping": {
    auth: "public",
    sameOrigin: "never",
    GET: () => jsonResponse({ pong: true }),
  },
});
```

- `auth` is `"required"` (default), `"optional"` or `"public"`.
- A private route without a resolved identity fails closed with 401.
- `policy` is opaque app data. A route carrying policy without an authenticated
  identity and an `authorize` callback fails closed with 403.
- `authorize` runs for admitted identities before handlers/middleware. Public
  routes intentionally skip identity resolution.
- `ctx` exposes `params`, `identity`, `requireIdentity()`, `realtime`, and
  `server`. App code owns resource ownership checks.
- `routeMiddleware(req,ctx,operation,invoke)` runs after admission/policy.

`sameOrigin` is `"mutations"` by default, or `"always"` / `"never"`. Ambient
browser mutations and WebSockets require an allowed Origin/Referer. Explicit
credentials bypass this CSRF check, not authorization. Public webhook routes
must deliberately choose their own credential and transport policy.

Patterns support named segments and a final `*`, normalize slashes and decode
captures safely. Ambiguous/equally specific routes fail construction. Malformed
path encoding returns 400. Unsupported methods return 405/Allow. HEAD uses GET
and strips its body.

`parseJson(req,validator)`, `parseOptionalJson`, and `parseUnknownJson` bound
bodies to 64 KiB by default; malformed JSON/invalid schema input produces 400
and oversized input produces 413. Validators use a structural `safeParse`
contract (including Zod), not private schema-library types. Pass explicit finite
`maxBytes` for larger inputs; WebAuthn endpoints may use
`MAX_WEBAUTHN_JSON_BODY_BYTES`. Metadata alone does not validate bodies.
Assign only allowlisted mutable fields; never spread untrusted JSON into records.

## Metadata, realtime and lifecycle

`compileRouteTable`, matching and `createRouteCatalog` accept generic
`RoutePatternDefinition` records. They preserve opaque app metadata rather than
interpreting it. Generic `RouteDefinition` metadata includes description, tags,
schemas, per-method operations and partial-result headers. Catalog exposure and
its authorization belong to apps. `routeSchemaToJsonSchema` serializes JSON or
supported Zod schemas deliberately.

Core realtime upgrades are disabled unless an app chooses
`realtime: { access: "public" }` or provides `realtime.authenticate(req)`.
Admission returns `{ data?, options?, credential? }`; use
`options.authorize(publication)` to check current recipient and resource
authority before interest filtering. The `userId` target is an opaque,
server-selected recipient key, not a framework account. See [realtime](realtime.md).

`beforeStart`/`afterStart` and `beforeStop`/`afterStop` are awaited.
`app.stop(false)` drains; `app.stop(true)` closes active connections.
Shutdown errors remain observable, and SIGINT/SIGTERM await registered
lifecycles. Immediate process termination is not graceful shutdown.
`server.idleTimeout` accepts 0–255 seconds; TLS is opt-in through `server.tls`.

The only built-in metadata endpoints are GET/HEAD `/api/health` and
`/api/config`; config contains name/version/base path/realtime path/log-level
metadata, not auth/bootstrap/admin state. App request dispatch may replace them.
No omitted capability creates account, preferences, logging or shutdown routes.

Request-origin/trusted-proxy helpers, response security headers, bounded
parsing, CORS helpers and private-file mode helpers remain available.
`ensurePrivateDirectory`, `securePrivateDirectory` and `securePrivateFile`
enforce owner-only permissions and throw on protection failure. Optional log
capture is explicit, off by default, and uses disposable cache files rather
than account storage.
