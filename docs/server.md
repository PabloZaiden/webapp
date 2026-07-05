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

## PWA metadata

`createWebAppServer` provides shell-level PWA metadata. PWA support is enabled by default with `appName`-derived manifest values, `/manifest.webmanifest`, `/` start/scope, `standalone` display, and conventional icon paths (`/web-app-manifest-192x192.png`, `/web-app-manifest-512x512.png`, and `/apple-touch-icon.png`).

```ts
createWebAppServer({
  appName: "My App",
  // ...
  pwa: {
    shortName: "MyApp",
    themeColor: "#111827",
    backgroundColor: "#ffffff",
    display: "standalone",
    icons: [
      { src: "/web-app-manifest-192x192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
      { src: "/web-app-manifest-512x512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
    appleTouchIcon: { href: "/apple-touch-icon.png", sizes: "180x180" },
    startUrl: "/",
    scope: "/",
  },
});
```

The framework serves the manifest with `application/manifest+json; charset=utf-8`.

For string, `Blob`, or `Response` HTML indexes, the framework also injects the installability tags into HTML shell responses:

```html
<link rel="manifest" href="/manifest.webmanifest" />
<link rel="icon" href="/web-app-manifest-192x192.png" type="image/png" sizes="192x192" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-title" content="MyApp" />
<meta name="theme-color" content="#111827" />
```

For Bun `HTMLBundle` indexes imported from `index.html`, Bun must serve the HTML and generated assets directly so module rewriting and transpilation keep working. In that mode the framework still serves `/manifest.webmanifest`, but it does not mutate the HTML response. Follow the Clanky-style static asset pattern instead: place `site.webmanifest`, favicons, and apple-touch icons next to `index.html`, then reference them with relative paths so Bun can bundle and rewrite them:

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

Icon files still need to exist in the app bundle or public routes; the framework advertises and serves metadata, but it does not generate image assets. Set `pwa: { enabled: false }` to opt out. Apps that already serve `/manifest.webmanifest` through `publicRoutes` can keep that override; explicit public routes take precedence over the generated manifest.

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

Only declared public routes are served this way. Unknown `/api/*` paths still return `404`, while normal frontend paths still return the React index.

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
