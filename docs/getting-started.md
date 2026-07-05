# Getting started

Apps are one Bun application: backend routes, websocket, React UI and static assets are served by the same server. The framework does not support or require a standalone client dist directory.

```ts
import webIndex from "./index.html";
import { createWebAppServer, defineRoutes, jsonResponse, parseJson } from "@pablozaiden/webapp/server";

const items: Array<{ id: string; userId: string; title: string }> = [];

const routes = defineRoutes({
  "/api/items": {
    auth: "user",
    description: "List or create items.",
    cliPath: "items",
    tags: ["items"],
    GET: (_req, ctx) => jsonResponse(ctx.filterOwned(items)),
    async POST(req, ctx) {
      const user = ctx.requireUser();
      const body = await parseJson<{ title: string }>(req);
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
  index: webIndex,
  auth: { passkeys: true, apiKeys: true, deviceAuth: true },
  realtime: { path: "/api/ws" },
  pwa: {
    shortName: "MyApp",
    themeColor: "#111827",
    backgroundColor: "#ffffff",
  },
  routes,
});

await app.runFromCli();
```

The `pwa` option is optional; by default the framework derives install metadata from `appName`, serves `/manifest.webmanifest`, and injects the manifest/icon/mobile head tags into the shell HTML. Configure `icons`, `appleTouchIcon`, `startUrl`, and `scope` when your app ships specific install assets.

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
