# Server API

Use `createWebAppServer` with `defineRoutes`. Route patterns support exact path
segments, named dynamic segments (`:name`), and an optional trailing wildcard
(`*`):

```ts
const routes = defineRoutes({
  "/api/projects/:projectId/files/*": {
    auth: "public",
    sameOrigin: "never",
    GET: (_req, ctx) => jsonResponse({
      projectId: ctx.params.projectId,
      path: ctx.params["*"],
    }),
  },
});
```

Patterns are normalized for leading/trailing and repeated slashes. A trailing
`*` matches zero or more remaining segments and is only valid as the final
segment. Dynamic values are decoded one segment at a time; an encoded slash
within a named parameter remains part of that parameter, while wildcard
segments remain individually addressable for URL generation. Query strings and
fragments are request inputs, not route-pattern syntax.

```ts
import { z } from "zod";

const projectCreateSchema = z.object({ name: z.string() });
const projectUpdateSchema = z.object({ name: z.string().optional() });

const routes = defineRoutes<AppEvent>({
  "/api/projects": {
    auth: "user",
    requestSchema: projectCreateSchema,
    description: "List or create projects.",
    cliPath: "projects",
    tags: ["projects"],
    GET: (_req, ctx) => {
      return jsonResponse(ctx.filterOwned(projects));
    },
    async POST(req, ctx) {
      const user = ctx.requireUser();
      const body = await parseJson(req, projectCreateSchema);
      const project = createProject(user.id, body.name);
      ctx.userRealtime.publishEntityChanged("projects", project.id);
      return jsonResponse(project);
    },
  },
  "/api/projects/:id": {
    auth: "user",
    scopes: ["projects:write"],
    requestSchema: projectUpdateSchema,
    async PATCH(req, ctx) {
      const project = ctx.requireOwned(await findProject(ctx.params.id));
      const body = await parseJson(req, projectUpdateSchema);
      if (body.name !== undefined) project.name = body.name;
      project.updatedAt = new Date().toISOString();
      ctx.userRealtime.publishEntityChanged("projects", project.id);
      return jsonResponse(project);
    },
  },
  "/api/admin/summary": {
    auth: "admin",
    GET: () => jsonResponse(adminSummary()),
  },
});
```

Request schemas define the writable input fields, but handlers should still assign
those fields explicitly rather than spreading or merging parsed input into a
stored record. The example schemas use Zod's default object behavior, so
unknown properties are ignored and never persisted; keep `id`, `userId`,
timestamps, and other server-managed fields under application control.

`parseJson(req, schema)` parses and validates the body at runtime. Malformed JSON
returns a 400 `invalid_json` response, while a JSON value that does not satisfy
the schema returns a 400 `invalid_request_body` response with field details.
`parseJson`, `parseUnknownJson`, and `parseOptionalJson` use
`DEFAULT_JSON_BODY_MAX_BYTES` (64 KiB) when `maxBytes` is omitted, so JSON
request bodies are bounded before parsing or schema validation. Pass
`{ maxBytes, requireContentType: true }` when an endpoint needs a different
finite limit or must require a JSON content type. The parser rejects a
non-JSON content type with a 400 `invalid_request_content_type` response,
rejects an invalid `Content-Length` with a 400
`invalid_request_content_length` response, rejects declared and streamed
bodies over the selected limit with a 413 `request_body_too_large` response,
and cancels a streamed body as soon as the limit is exceeded. JSON media types
with a `+json` suffix are accepted.

Built-in endpoints use the 64 KiB default for small device, token, user,
preference, logging, and API-key requests. WebAuthn registration and
authentication response endpoints explicitly use
`MAX_WEBAUTHN_JSON_BODY_BYTES` (256 KiB) because attestation payloads can be
larger; the browser API-key exchange retains its separate 4 KiB limit. These
are finite, code-defined exceptions rather than unbounded fallbacks.

Use `parseOptionalJson(req, schema)` only for endpoints that deliberately allow
an empty body. It accepts the same optional parser settings. Only a zero-byte
body is considered absent; whitespace-only content is non-empty malformed JSON
and is rejected just like any other malformed body. `parseUnknownJson` returns
`unknown` and is intentionally unvalidated, so application handlers should
prefer a schema-backed parser.

The Notes TODO webhook uses an absent body (or an object without `title`) to
apply its source-based fallback title. When an owner does not exist, that
accepted delivery returns 202 with `accepted: false`; malformed or
schema-invalid bodies are rejected before this ownerless response or any
mutation is reached.

Route defaults are intentionally secure:

| Setting | Default | Meaning |
| --- | --- | --- |
| `auth` | `required` | Requires passkey session, API key or device bearer token once auth is configured |
| `sameOrigin` | `mutations` | Requires `Origin`/`Referer` for cookie/browser mutations |
| `scopes` | `[]` | Checked for API keys and device tokens; `*` grants all |
| `userParam` | unset | Optional route param name that must match the current user id |

Set `auth: "public", sameOrigin: "never"` only for deliberate unauthenticated endpoints such as health probes, webhooks or callback receivers.

Route definitions are compiled and validated when `createWebAppServer` is
constructed. A route must declare at least one supported handler (`GET`,
`POST`, `PUT`, `PATCH`, or `DELETE`). Duplicate parameter names, non-trailing
wildcards, missing `userParam` captures, mismatched API/CLI capture shapes,
duplicate normalized paths, and equally specific overlapping routes fail
startup instead of being resolved by declaration order.

Every dynamic path capture uses the same guarded decoder. A malformed percent
escape returns a structured 400 `invalid_path` response and does not invoke the
route handler. It is not converted into a generic 500.

If a route matches but does not register the request method, the server returns
405 `method_not_allowed` and an `Allow` header containing only that route's
registered methods. `HEAD` is the existing effective read-only form of a
registered `GET`: it uses that handler and strips the response body while
preserving its status and headers. Other unsupported methods never fall back to
the route's `GET` handler.

Route definitions can include optional metadata. This keeps the API route table
as the single source of truth for handlers, CLI endpoint listing, and schema
output; it does not generate prose documentation automatically:

| Field | Meaning |
| --- | --- |
| `description` | Human-readable route description |
| `cliPath` | CLI-friendly path; defaults to the API path without `/api/` |
| `tags` | Grouping labels exposed through the route catalog and schema output |
| `requestSchema`, `querySchema`, `responseSchema` | Optional schema objects for CLI/schema output; use the same runtime `requestSchema` with `parseJson` when a route accepts a body |
| `catalog: false` | Exclude a route from generated catalogs |

Use `createRouteCatalog(routes)` and `findRouteCatalogEntry(catalog, input)` to power app CLI commands without maintaining a second route catalog.

Prefer explicit `auth: "user"`, `auth: "admin"` or `auth: "owner"` on app routes. They enforce the role before the handler runs, including API-key and device bearer requests.

Route context is user-aware:

| Helper | Meaning |
| --- | --- |
| `ctx.requireUser()` | Returns the current user or throws 401 |
| `ctx.requireAdmin()` | Returns owner/admin users or throws 403 |
| `ctx.requireOwner()` | Returns the owner or throws 403 |
| `ctx.assertUser(userId)` | Throws unless the current user id matches |
| `ctx.filterOwned(records)` | Returns only records whose `userId` is the current user id |
| `ctx.requireOwned(record)` | Returns a user-owned record or throws 404 for missing/other-user records |
| `ctx.userRealtime.*` | Publishes realtime events only to sockets authenticated as the current user |

Use `ctx.filterOwned(records, getUserId)` and `ctx.requireOwned(record, getUserId)` when app records use a different ownership field. Return 404 for other-user resources so route responses do not reveal whether another user's id exists.

## Supplying a validated runtime config

`createWebAppServer` reads and validates `{PREFIX}_*` environment variables by
default. An application that has already resolved a `RuntimeConfig` can pass it
through `runtimeConfig` instead:

```ts
import { createWebAppServer, readRuntimeConfig } from "@pablozaiden/webapp/server";

const runtimeConfig = readRuntimeConfig({ appName: "My App", envPrefix: "MY_APP" });
const app = createWebAppServer({
  appName: "My App",
  envPrefix: "MY_APP",
  runtimeConfig,
  routes,
});
```

The supplied config is used during every framework initialization step,
including store selection, logging, authentication, document generation,
request handling, and lifecycle setup. Its `appName` and `envPrefix` must match
the constructor inputs. Do not mutate `app.config` after construction to
replace constructor options; omit `runtimeConfig` when the framework should read
the environment itself.

## Server lifecycle hooks

Applications can coordinate workers and other resources around the actual Bun
server with async lifecycle hooks:

```ts
const app = createWebAppServer({
  appName: "My App",
  envPrefix: "MY_APP",
  routes,
  lifecycle: {
    beforeStart: async () => {
      await prepareWorkers();
    },
    afterStart: async (server) => {
      await startWorkers(server.url);
    },
    beforeStop: async () => {
      await drainWorkers();
    },
    afterStop: async () => {
      await closeWorkers();
    },
  },
});

await app.start();
await app.stop(true);
```

Start hooks run in declaration order around `Bun.serve()`. Stop hooks run
deterministically even when a stop hook fails, and their failures are surfaced.
If `afterStart` fails, WebApp stops the newly started Bun server, runs the stop
hooks, disposes generated document resources, and rethrows the hook failure.

## Server logging

WebApp exposes one server-side `tslog` service for the framework and
application code. Use the root logger or a cached sub-logger from
`@pablozaiden/webapp/server`; do not add a second server logger in the app:

```ts
import { createLogger, log } from "@pablozaiden/webapp/server";

const projectsLog = createLogger("projects");

log.info("Application initialized");
projectsLog.debug("Loaded projects", { count: 12 });
```

The available levels, from most to least verbose, are `silly`, `trace`,
`debug`, `info`, `warn`, `error`, and `fatal`. The effective level is shared by
the root logger and all cached sub-loggers. It is selected from
`{PREFIX}_LOG_LEVEL`, a persisted administrator preference, or `info` by
default, in that order.

Every emitted entry is written through `tslog` to the appropriate stdout or
stderr stream. When in-memory capture is enabled, the same rendered entries
from both framework and application loggers are also retained in the
process-local buffer. Capture is disabled by default and can be initialized
with `{PREFIX}_IN_MEMORY_LOGS=true`; an administrator can then change the
runtime toggle from Developer Settings. The environment value is an initial
value, not a lock, and capture is cleared when disabled or when the process
starts.

Built-in endpoints include:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Health/version |
| `GET /api/config` | Safe framework config for UI |
| `/api/passkey-auth/*` | Passkey bootstrap/login/logout/delete |
| `/api/user-setup*` | One-time invite/reset setup links |
| `/setup` | Browser setup screen for one-time invite/reset links |
| `/api/users`, `/api/users/:id/*`, `/api/audit-events` | Admin user management and audit log |
| `/api/api-keys` | Browser-managed user API-key create/list/delete |
| `/api/auth/device`, `/api/auth/token`, `/api/auth/refresh`, `/api/auth/revoke` | Device auth and refresh-token flow |
| `/device` | Browser device-code approval screen |
| `/.well-known/jwks.json`, `/.well-known/openid-configuration` | Token verification metadata |
| `/api/preferences/theme`, `/api/preferences/log-level` | Settings persistence |
| `GET /api/server/logs` | Admin-only snapshot of the in-memory server logs |
| `PUT /api/server/logs/settings` | Admin-only runtime toggle for in-memory server logs |
| `/api/server/kill` | Admin-only server shutdown |
| `/api/ws` | Realtime websocket by default |

The effective log level in `GET /api/config` and `GET
/api/preferences/log-level` is resolved identically: an environment-provided
`{PREFIX}_LOG_LEVEL` wins over the persisted preference, and sets `fromEnv`
to `true`. PUT remains an authenticated, same-origin admin mutation and
returns a conflict when the environment controls the value.

`GET /api/server/logs` is restricted to admin users and returns
`{ enabled: boolean, logs: ServerLogEntry[] }`. Entries are returned in
chronological order and contain the timestamp, level, logger scope, message,
and the rendered `tslog` line. When capture is disabled, the endpoint returns
`200` with `enabled: false` and an empty list. `PUT /api/server/logs/settings`
accepts `{ "enabled": boolean }`, is restricted to admins, and uses the normal
same-origin policy for browser mutations. API-key and bearer callers continue
to use the existing token-auth behavior. The in-memory buffer is limited to
the newest 1,000 entries and 512 KiB of rendered UTF-8 lines; disabling capture
clears it. These endpoints expose entries emitted through the shared WebApp
logger and never make the logs durable.

## Client logging

WebApp also exposes a browser-side `tslog` service through
`@pablozaiden/webapp/web`. Use it for application code instead of adding a
second logger or writing application logs directly with `console.*`:

```tsx
import { createLogger, log } from "@pablozaiden/webapp/web";

const projectsLog = createLogger("projects");

log.info("Application UI initialized");
projectsLog.debug("Loaded projects", { count: 12 });
```

The client service provides the same seven levels as the server service and
writes to the browser console. `WebAppRoot` automatically synchronizes its
effective level with the shared framework configuration, including changes
made from Developer Settings. Client logs are browser-local and are not
included in the server's `/api/server/logs` snapshot.

Server-side applications that need credentials for internal runtimes should use
the server-only `createManagedApiKey`, `listManagedApiKeys`, and
`revokeManagedApiKey` helpers. Managed keys are persisted in the same API-key
store, authenticate through the normal bearer path, and are intentionally absent
from the browser-managed endpoint and Settings summaries.

## Framework-owned web document and PWA metadata

`createWebAppServer` owns the browser document. Apps do not provide `index.html`; the framework generates a Bun `HTMLBundle` internally so Bun hot reload and asset rewriting keep working. By default the frontend entrypoint is `./web/main.tsx` relative to the Bun entry file. The generated document also initializes the shared `data-wapp-mobile` state before client styles load so CSS and `WebAppRoot` use the same mobile breakpoint. The generated viewport keeps the app at `initial-scale=1` with `maximum-scale=1` and `user-scalable=no`; clients and mobile browsers that honor those viewport scaling tokens, including iPhone and iPad, cannot change the app scale with pinch-to-zoom while normal scrolling remains enabled. Clients that ignore the tokens are unaffected.

Do not replace this behavior with global touch event handlers, `preventDefault()` calls, or `touch-action: none`: those approaches can disable scrolling and other touch interactions. Applications should keep the document framework-owned rather than adding an app-owned `index.html`.

```ts
createWebAppServer({
  appName: "My App",
  envPrefix: "MY_APP",
  web: {
    entry: "./frontend.tsx",
    shortName: "MyApp",
    themeColor: "#111827",
    backgroundColor: "#ffffff",
    pwa: true,
    icons: {
      favicon: { src: "./src/web/icons/app-192.png", sizes: "192x192", type: "image/png" },
      appleTouch: { src: "./src/web/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
      manifest: [
        { src: "./src/web/icons/app-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
        { src: "./src/web/icons/app-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
      ],
    },
  },
  routes,
});
```

PWA metadata is enabled by default. Without `web.icons`, the framework serves `/site.webmanifest`, `/manifest.webmanifest`, and a generated SVG icon at `/webapp-icon.svg` using the app name initials. Apps with product artwork can override favicon, Apple touch icon, and manifest icons through `web.icons` while keeping the document framework-owned. Set `web.pwa: false` only for apps that intentionally should not be installable. The generated document includes the standard `webapp.theme` prepaint script; apps should use that framework preference instead of app-specific theme storage.

The sidebar brand icon is configured separately with `WebAppRoot.appIcon`.
When the sidebar and PWA should use the same artwork, import the local SVG or
PNG asset in both the frontend and server entrypoints; the server's `web.icons`
configuration remains server-owned.

For a functional PWA:

| Field | Default | Use when |
| --- | --- | --- |
| `web.entry` | `./web/main.tsx` | The app frontend entrypoint lives somewhere else, such as `./frontend.tsx` |
| `web.shortName` | `appName` | The installed app label should be shorter than the full name |
| `web.themeColor` | Not emitted unless set | Browser chrome/install metadata should match product branding; the generated default icon still uses `#111827` when unset |
| `web.backgroundColor` | `#ffffff` | The manifest background should match the app splash/background |
| `web.icons.favicon` | Generated initials SVG | Browser tabs should use product artwork instead of initials |
| `web.icons.appleTouch` | `favicon` or generated initials SVG | iOS home-screen/Dock should use product artwork |
| `web.icons.manifest` | Generated initials SVG | Installed PWA icons should use product artwork at install sizes |

Icon `src` values are resolved relative to the app package root, not the server file. Use paths such as `./src/web/icons/app-192.png` for assets under `src`. Manifest icons should include at least a `192x192` and `512x512` PNG for production apps. SVG defaults are fine for lightweight examples and development, but app-store/Dock integrations vary by platform, so production apps should provide PNG manifest and Apple-touch icons.

The framework serves the manifest at `/site.webmanifest` and `/manifest.webmanifest` and injects the manifest link at runtime so Bun does not rewrite manifest-relative icon URLs into broken asset paths. Favicon and Apple-touch links may be rewritten by Bun to `/_bun/asset/...`; that is expected and keeps hot reload/static asset handling native.

Service workers are not generated by the framework. Apps that need browser push, offline caches, app badge, or background sync should keep a deliberate app-owned service worker route such as `/service-worker`; normal installability does not require one.

## Public/static routes

Declare public non-API assets explicitly with `publicRoutes`:

```ts
createWebAppServer({
  // ...
  publicRoutes: {
    "/service-worker": serviceWorker,
  },
});
```

`createWebAppPublicAsset` keeps the same declaration shape for a compiled
entrypoint:

```ts
const serviceWorker = createWebAppPublicAsset({
  path: "/service-worker.js",
  entrypoint: "./src/web/service-worker.ts",
  contentType: "text/javascript; charset=utf-8",
  headers: { "cache-control": "no-cache" },
});

createWebAppServer({
  // ...
  publicRoutes: {
    "/service-worker.js": serviceWorker,
  },
});
```

The configured `path` is the primary entry URL. If the entrypoint emits CSS,
chunks, workers, WASM, or other file-loader outputs, WebApp retains the complete
build bundle and serves sidecars under stable paths derived from the primary
entry directory. Sidecar paths are registered before the SPA wildcard when the
server starts, so development requests reach the same artifact resolver as
compiled requests. The primary uses the explicit `contentType`; sidecars use
their output extension and artifact metadata. Custom headers, including cache
headers, apply to every artifact in the bundle.

Public asset responses are safe to request repeatedly. Response values are
cloned before framework or security headers are applied, while factories can
return a fresh value per request. An empty string, empty byte buffer, empty
blob, or response with no body is a valid successful asset; only `undefined`
means that a handler did not provide an asset. `HEAD` preserves the response
metadata and status while omitting the body.

Paths are normalized as URL paths, not filesystem paths; query, fragment,
traversal, ambiguous separator, and invalid URL-encoding forms are rejected.
Duplicate primary or sidecar paths, collisions with another public route or a
framework-owned route, and unsupported build output kinds fail explicitly
instead of silently overwriting an asset or falling through to the SPA. Only
declared public routes and their emitted artifacts are exposed; the entrypoint
directory and private workspace files are not treated as public directories.

Only declared public routes are served this way. Unknown `/api/*` paths still return `404`, while normal frontend `GET` and `HEAD` paths still return the React index. Other methods on unmatched frontend paths return `404` instead of the SPA fallback.

## App-owned websocket upgrades

Normal app state should use framework realtime. For raw transports such as terminals, VNC, or port-forward proxies, route handlers may call `ctx.server?.upgrade(...)` and return `undefined`:

```ts
"/api/terminal": {
  auth: "user",
  sameOrigin: "always",
  GET: (req, ctx) => ctx.server?.upgrade(req, {
    data: { webappSocketHandler: "terminal", sessionId: ctx.params.id },
  }) ? undefined : new Response("Upgrade failed", { status: 400 }),
}
```

Register matching handlers with `websockets`. Framework auth and same-origin checks run before the upgrade route handler.
