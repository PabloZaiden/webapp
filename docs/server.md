# Server API

Use `createWebAppServer` with `defineRoutes`. Route patterns support exact path segments and `:params`.

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
Use `parseOptionalJson(req, schema)` only for endpoints that deliberately allow
an empty body. Only a zero-byte body is considered absent; whitespace-only
content is non-empty malformed JSON and is rejected just like any other
malformed body. `parseUnknownJson` returns `unknown` and is intentionally
unvalidated, so application handlers should prefer a schema-backed parser.

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

Route definitions can include optional metadata. This keeps the API route table as the single source of truth for handlers, CLI endpoint listing, schema output and docs:

| Field | Meaning |
| --- | --- |
| `description` | Human-readable route description |
| `cliPath` | CLI-friendly path; defaults to the API path without `/api/` |
| `tags` | Grouping labels for docs/CLI |
| `requestSchema`, `querySchema`, `responseSchema` | Optional schema objects for CLI/docs; use the same runtime `requestSchema` with `parseJson` when a route accepts a body |
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

Built-in endpoints include:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Health/version |
| `GET /api/config` | Safe framework config for UI |
| `/api/passkey-auth/*` | Passkey bootstrap/login/logout/delete |
| `/api/user-setup*` | One-time invite/reset setup links |
| `/setup` | Browser setup screen for one-time invite/reset links |
| `/api/users`, `/api/users/:id/*`, `/api/audit-events` | Admin user management and audit log |
| `/api/api-keys` | Browser-managed API key create/list/delete |
| `/api/auth/device`, `/api/auth/token`, `/api/auth/refresh`, `/api/auth/revoke` | Device auth and refresh-token flow |
| `/device` | Browser device-code approval screen |
| `/.well-known/jwks.json`, `/.well-known/openid-configuration` | Token verification metadata |
| `/api/preferences/theme`, `/api/preferences/log-level` | Settings persistence |
| `/api/server/kill` | Authenticated server shutdown |
| `/api/ws` | Realtime websocket by default |

The effective log level in `GET /api/config` and `GET
/api/preferences/log-level` is resolved identically: an environment-provided
`{PREFIX}_LOG_LEVEL` wins over the persisted preference, and sets `fromEnv`
to `true`. PUT remains an authenticated, same-origin admin mutation and
returns a conflict when the environment controls the value.

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
