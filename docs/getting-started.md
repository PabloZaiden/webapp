# Getting started

Apps are one Bun application: backend routes, websocket, React UI and static assets are served by the same server. The framework does not support or require a standalone client dist directory.

```ts
import { z } from "zod";
import { createWebAppServer, defineRoutes, jsonResponse, parseJson } from "@pablozaiden/webapp/server";

const items: Array<{ id: string; userId: string; title: string }> = [];
const itemCreateSchema = z.object({ title: z.string() });

const routes = defineRoutes({
  "/api/items": {
    auth: "user",
    requestSchema: itemCreateSchema,
    description: "List or create items.",
    cliPath: "items",
    tags: ["items"],
    GET: (_req, ctx) => jsonResponse(ctx.filterOwned(items)),
    async POST(req, ctx) {
      const user = ctx.requireUser();
      const body = await parseJson(req, itemCreateSchema);
      const item = { id: crypto.randomUUID(), userId: user.id, title: body.title };
      items.push(item);
      ctx.userRealtime.publishEntityChanged("items", item.id);
      return jsonResponse(item);
    },
  },
  "/api/webhooks/:source/:token": {
    auth: "public",
    sameOrigin: "never",
    POST: () => jsonResponse({ ok: true }),
  },
});

const app = createWebAppServer({
  appName: "My App",
  envPrefix: "MY_APP",
  auth: { passkeys: true, apiKeys: true, deviceAuth: true },
  realtime: { path: "/api/ws" },
  routes,
});

await app.runFromCli();
```

The framework generates the HTML document, React mount point, fixed-scale viewport metadata, PWA manifest, default SVG icons, and the theme prepaint script. On iPhone, iPad, and other mobile browsers that honor viewport scaling tokens, the generated viewport prevents pinch-to-zoom while preserving normal scrolling; clients that ignore those tokens are unaffected. By default it uses `./web/main.tsx` relative to the Bun entry file as the frontend entrypoint, so apps only need to create that file. Override document defaults only when the app needs different metadata:

```ts
createWebAppServer({
  appName: "My App",
  envPrefix: "MY_APP",
  web: {
    entry: "./frontend.tsx",
    title: "My App",
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

Do not create an app-owned `index.html` or add global touch handlers to control zoom. The framework owns the viewport policy so the same metadata is emitted for development, compiled clients, and installed PWAs without disabling scrolling.

PWA support is on by default, with generated initials icons unless the app provides `web.icons`. Icon paths are relative to the app package root; production apps should provide at least 192x192 and 512x512 PNG manifest icons plus an Apple touch icon. Set `web.pwa: false` only for apps that deliberately should not be installable. The standard theme preference key is `webapp.theme`; apps should not use app-specific theme storage keys.

Apps should stay one app and one binary. Use subcommands for different modes:

```bash
my-app serve
my-app version
my-app api items
my-app notify --message "optional app-owned command"
```

For a non-interactive authenticated API command, pass the app's `envPrefix`
to `runApiCliCommand()` and provide the exact environment pair:

```bash
export MY_APP_BASE_URL=https://app.example.test
export MY_APP_API_KEY='key-from-settings'
my-app api items
```

The pair is used when no stored device credentials are available. A missing
or partial pair preserves anonymous CLI requests.

See `docs/cli.md` for framework CLI helpers and generic API command support.

Frontend entrypoints should use `renderWebApp` so Bun/browser hot reload reuses the existing React root instead of calling `createRoot()` twice. Import the framework CSS explicitly so Bun hot reload observes style changes:

```tsx
import { Page, Panel, WebAppRoot, renderWebApp } from "@pablozaiden/webapp/web";
import "@pablozaiden/webapp/web/styles.css";

function Home() {
  return (
    <Page>
      <Panel>Hello</Panel>
    </Page>
  );
}

renderWebApp(
  <WebAppRoot
    appName="My App"
    homeRoute={{ view: "home" }}
    sidebar={{ getNodes: () => [] }}
    routes={{ home: <Home /> }}
  />,
);
```

`renderWebApp` renders into `#root` by default and reuses the existing React root across hot reloads. Pass a custom element id or `Element` only when the app uses a different mount point.

### Transient notifications

The standard `renderWebApp` runtime provides the framework notification service
to the application tree. Use the public hook for short-lived action outcomes;
do not add an application-owned provider, queue, timer system, or notification
CSS:

```tsx
import { useToast } from "@pablozaiden/webapp/web";

function SaveButton() {
  const toast = useToast();

  async function save() {
    await saveRecord();
    toast.success("Saved");
  }

  return <button type="button" onClick={() => void save()}>Save</button>;
}
```

`useToast()` exposes `success`, `error`, `warning`, and `info` helpers. Each
returns a stable ID that can be passed to `dismiss`; `dismissAll` removes every
active notification. Pass an `id` to replace an existing notification and
reset its timer. Notifications dismiss after 8 seconds by default; provide a
positive `duration` in milliseconds for a custom timeout or use
`duration: 0` for a persistent notification that requires explicit dismissal.
The framework keeps at most five active notifications.

Use `ErrorState`, loading states, and field validation for persistent page or
form state. Use `ConfirmDialog` for destructive confirmation. Do not report the
same failure in both an inline error state and a toast unless both surfaces
serve distinct, intentional purposes.

`WebAppRoot` owns the shell and `.wapp-main-content`; each route component should return a `Page` wrapper so standard content margins, mobile padding and scroll behavior stay consistent. `Page` uses the padded layout by default. For routes whose child content fills the available shell viewport and owns its own spacing or scrolling, use the framework full layout instead of overriding framework CSS:

```tsx
function TerminalRoute() {
  return (
    <Page layout="full">
      <Terminal />
    </Page>
  );
}
```

The `full` layout removes the page gutters and provides a flex-sized, overflow-contained surface for viewport-sized content. Use it for terminals, editors, previews and similar surfaces; the child should provide any internal padding and scrolling it needs.

Use the framework URL helpers for browser API calls, websocket URLs and app-local links instead of deriving paths from `window.location` in each app. They honor `<base>`, explicit `publicBasePath` config, and reverse-proxy subpaths for direct path deep links such as `/workspaces`:

```tsx
import {
  appAbsoluteUrl,
  appFetch,
  appJson,
  appPath,
  appRequest,
  appWebSocketUrl,
  configureWebAppClient,
  setWebAppPublicBasePath,
} from "@pablozaiden/webapp/web";

configureWebAppClient();

const config = await appJson("/api/config");
setWebAppPublicBasePath(config.publicBasePath);

const downloadUrl = appPath("/api/items/export");
const shareUrl = appAbsoluteUrl("/#/items");
const socket = new WebSocket(appWebSocketUrl("/api/ws"));
const rawResponse = await appRequest("/api/items");
```

`appJson` is the framework helper for successful JSON responses and builds on `appFetch`. Both `appJson` and `appFetch` honor configured URLs, credentials, auth-required events, and `WebAppApiError` responses. Use `appFetch` when a successful response body does not need to be parsed, and use `appRequest` when the app needs a raw response without the framework's error normalization, such as downloads or custom error handling. `appJson` intentionally rejects successful empty or non-JSON responses instead of fabricating a default value.

Recommended dev script:

```json
{
  "scripts": {
    "dev": "bun --hot src/index.ts serve"
  }
}
```

The app configures an uppercase `envPrefix`; the framework reads only variables under that prefix:

| Variable | Default | Description |
| --- | --- | --- |
| `{PREFIX}_HOST` | `localhost` | Bind host |
| `{PREFIX}_PORT` | `3000` | Bind port |
| `{PREFIX}_DATA_DIR` | `./data` | Durable SQLite persistence directory for framework auth and app data |
| `{PREFIX}_LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error`; locks settings log-level control when set |
| `{PREFIX}_DISABLE_PASSKEY` | unset | Emergency bypass that logs in as the existing owner; it does not create users |
| `{PREFIX}_DISABLE_SAME_ORIGIN_CHECK` | unset | Development/testing escape hatch |
| `{PREFIX}_TRUST_PROXY` | `false` | Explicitly trust the documented `X-Forwarded-*` headers; keep disabled for direct deployments |
| `{PREFIX}_TRUST_PROXY_HEADERS` | `proto,host,prefix` when enabled | Comma-separated subset of supported forwarded values: `proto`, `host`, `prefix` |
| `{PREFIX}_TRUST_PROXY_CHAIN` | `first` | Select the left-most (`first`) or right-most (`last`) non-empty value from comma-separated forwarded headers |
| `{PREFIX}_PUBLIC_BASE_URL` | request origin | Authoritative absolute `http` or `https` origin (without a path, query, or fragment) for auth/device URLs; it overrides forwarded protocol and host values |
| `{PREFIX}_AUTH_ISSUER` | `urn:{prefix}:webapp` | JWT issuer override |

The configured data directory contains the framework-owned
`webapp.sqlite`. The example applications keep their application entities in
separate files in that same directory: Notes TODO uses `notes-todo.sqlite`
for sections, notes and todos, while Kitchen Sink uses `kitchen-sink.sqlite`
for projects. Keeping these files separate prevents example-specific tables
from being added to the framework authentication store.

Example application databases create or migrate their schema during startup.
Owner seed data is written transactionally and is idempotent across repeated
starts. Point the prefixed `*_DATA_DIR` at storage that survives process
restarts and redeployments; deleting or changing the directory intentionally
starts a new application state.

For a reverse-proxy deployment that strips and overwrites the forwarded
headers, configure the trust policy explicitly:

```bash
MY_APP_TRUST_PROXY=true
MY_APP_TRUST_PROXY_HEADERS=proto,host,prefix
MY_APP_TRUST_PROXY_CHAIN=first
MY_APP_PUBLIC_BASE_URL=https://app.example.test
```

The default is fail-closed: forwarded headers are ignored unless
`TRUST_PROXY=true`. The framework recognizes only `X-Forwarded-Proto`,
`X-Forwarded-Host`, and `X-Forwarded-Prefix`; it does not infer trust from
their presence and does not parse the RFC `Forwarded` header. A trusted prefix
is used for cookie paths and externally generated links. The proxy must remove
client-supplied values before writing these headers, and direct untrusted
access to the application port must be blocked. This configuration does not
provide a proxy-address allowlist.

For CI/CD setup in apps built with the framework, use `docs/github-actions.md`. It includes copy-paste GitHub Actions and a production Dockerfile template.
