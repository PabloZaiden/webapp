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
`WebAppRoot` owns the shell and `.wapp-main-content`; each route component should return a `Page` wrapper so standard content margins, mobile padding and scroll behavior stay consistent.

Use the framework URL helpers for browser API calls, websocket URLs and app-local links instead of deriving paths from `window.location` in each app. They honor `<base>`, explicit `publicBasePath` config, and reverse-proxy subpaths for direct path deep links such as `/workspaces`:

```tsx
import {
  appAbsoluteUrl,
  appFetch,
  appPath,
  appRequest,
  appWebSocketUrl,
  configureWebAppClient,
  setWebAppPublicBasePath,
} from "@pablozaiden/webapp/web";

configureWebAppClient();

const config = await appFetch("/api/config").then((res) => res.json());
setWebAppPublicBasePath(config.publicBasePath);

const downloadUrl = appPath("/api/items/export");
const shareUrl = appAbsoluteUrl("/#/items");
const socket = new WebSocket(appWebSocketUrl("/api/ws"));
const rawResponse = await appRequest("/api/items");
```

`appFetch` is the framework JSON API helper and throws `WebAppApiError` for non-OK responses. Use `appRequest` when the app needs a raw `Response`, such as downloads, custom error handling, or compatibility wrappers.

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
| `{PREFIX}_DATA_DIR` | `./data` | SQLite persistence directory |
| `{PREFIX}_LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error`; locks settings log-level control when set |
| `{PREFIX}_DISABLE_PASSKEY` | unset | Emergency bypass that logs in as the existing owner; it does not create users |
| `{PREFIX}_DISABLE_SAME_ORIGIN_CHECK` | unset | Development/testing escape hatch |
| `{PREFIX}_PUBLIC_BASE_URL` | request origin | External URL for device auth links |
| `{PREFIX}_AUTH_ISSUER` | `urn:{prefix}:webapp` | JWT issuer override |

For CI/CD setup in apps built with the framework, use `docs/github-actions.md`. It includes copy-paste GitHub Actions and a production Dockerfile template.
