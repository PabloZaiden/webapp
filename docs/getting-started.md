# Getting started

Apps are one Bun application: backend routes, websocket, React UI and static assets are served by the same server. The framework does not support or require a standalone client dist directory.

```ts
import webIndex from "./index.html";
import { createWebAppServer, defineRoutes, jsonResponse } from "@pablozaiden/webapp/server";

const routes = defineRoutes({
  "/api/items": {
    GET: () => jsonResponse([{ id: "one", title: "One" }]),
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
  routes,
});

await app.runFromCli();
```

Frontend entrypoints should import the framework CSS explicitly so Bun hot reload observes style changes:

```ts
import { WebAppRoot } from "@pablozaiden/webapp/web";
import "@pablozaiden/webapp/web/styles.css";
```

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
| `{PREFIX}_HOST` | `127.0.0.1` | Bind host |
| `{PREFIX}_PORT` | `3000` | Bind port |
| `{PREFIX}_DATA_DIR` | `./data` | SQLite persistence directory |
| `{PREFIX}_LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error`; locks settings log-level control when set |
| `{PREFIX}_DISABLE_PASSKEY` | unset | Development escape hatch |
| `{PREFIX}_DISABLE_SAME_ORIGIN_CHECK` | unset | Development/testing escape hatch |
| `{PREFIX}_PUBLIC_BASE_URL` | request origin | External URL for device auth links |
| `{PREFIX}_AUTH_ISSUER` | `urn:{prefix}:webapp` | JWT issuer override |
