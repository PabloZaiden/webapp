# Server API

Use `createWebAppServer` with `defineRoutes`. Route patterns support exact path segments and `:params`.

```ts
const routes = defineRoutes<AppEvent>({
  "/api/projects": {
    auth: "user",
    description: "List or create projects.",
    cliPath: "projects",
    tags: ["projects"],
    GET: (_req, ctx) => {
      return jsonResponse(ctx.filterOwned(projects));
    },
    async POST(req, ctx) {
      const user = ctx.requireUser();
      const body = await parseJson<{ name: string }>(req);
      const project = createProject(user.id, body.name);
      ctx.userRealtime.publishEntityChanged("projects", project.id);
      return jsonResponse(project);
    },
  },
  "/api/projects/:id": {
    auth: "user",
    scopes: ["projects:write"],
    async PATCH(req, ctx) {
      const project = ctx.requireOwned(await findProject(ctx.params.id));
      Object.assign(project, await parseJson<Partial<Project>>(req));
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
| `requestSchema`, `querySchema`, `responseSchema` | Optional schema objects for CLI/docs |
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

## App-owned web manifest metadata

`createWebAppServer` does not generate PWA manifests or inject installability tags. Apps that need install capabilities should own their manifest, icons, and HTML metadata directly.

When `index` is a Bun `HTMLBundle`, place `site.webmanifest`, favicons, and apple-touch icons next to `index.html`, then reference them with relative paths so Bun can bundle, rewrite, and serve those assets:

```html
<link rel="manifest" href="./site.webmanifest" />
<link rel="icon" href="./favicon.ico" sizes="any" />
<link rel="icon" type="image/svg+xml" href="./favicon.svg" />
<link rel="apple-touch-icon" href="./apple-touch-icon.png" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-title" content="MyApp" />
<meta name="theme-color" content="#111827" />
```

Use relative icon paths inside `site.webmanifest` as well:

```json
{
  "name": "My App",
  "short_name": "MyApp",
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#111827",
  "icons": [
    { "src": "./web-app-manifest-192x192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable" },
    { "src": "./web-app-manifest-512x512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ]
}
```

This colocated asset resolution is a Bun `HTMLBundle` feature. Apps that pass a string, `Blob`, or `Response` as `index` must serve `site.webmanifest`, icons, and other static assets explicitly through `publicRoutes` or another static file layer.

If an app prefers `/manifest.webmanifest` or needs to serve a manifest dynamically, declare it explicitly with `publicRoutes`. The framework treats it like any other public asset and does not add manifest-specific behavior.

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
