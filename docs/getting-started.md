# Getting started

Use Bun 1.4+ and React 19. Applications declare `react` and `react-dom`; pin
Webapp to an immutable GitHub commit and update manifest/lock together.
One Bun process serves the UI, API and WebSockets. Do not add a separate
frontend development server.

```ts
// src/index.ts
import { createWebAppServer, defineRoutes, jsonResponse } from "@pablozaiden/webapp/server";
const app = createWebAppServer({
  appName: "Example",
  envPrefix: "EXAMPLE",
  web: { entry: new URL("./web/main.tsx", import.meta.url) },
  routes: defineRoutes({
    "/api/greeting": {
      auth: "public",
      GET: () => jsonResponse({ message: "Hello" }),
    },
  }),
  realtime: { access: "public" },
});
await app.start();
```

```tsx
// src/web/main.tsx
import { Page, WebAppRoot, renderWebApp } from "@pablozaiden/webapp/web";
import "@pablozaiden/webapp/web/styles.css";
renderWebApp(<WebAppRoot appName="Example" homeRoute={{view:"home"}}
  sidebar={{ getNodes: () => [] }}
  routes={{ home: <Page>Hello</Page> }} />);
```

Run `bun --hot src/index.ts`. The framework generates the HTML document,
renderer/bootstrap, icons and PWA manifest. Use `renderWebApp`, not a parallel
React root registry. `web:false` disables document generation for headless apps.

Public mode is deliberate here. Private routes default to required identity and
fail closed without an app identity adapter. The core creates no users or
database, owns no admin/login screens, and keeps browser preferences in memory.
Apps own those policies and explicitly select persistence.

## Existing examples

- **Kitchen Sink:** public core-only, ephemeral projects and UI preferences.
  `bun run dev:kitchen-sink` (port 3202). No data volume is needed; restart
  resets data.
- **Notes TODO:** public shared workspace by default, application-owned SQLite
  under `NOTES_TODO_DATA_DIR`, explicit browser preference adapter.
  `bun run dev:notes-todo` (port 3201). Mount the data directory when persistence
  matters; this example is not secure for public exposure without opt-in auth.

Notes TODO's optional password/session example is enabled only with:

```bash
NOTES_TODO_AUTH=password \
NOTES_TODO_HOST=localhost \
NOTES_TODO_ENROLL_PASSWORD='an operator-selected long password' \
bun run dev:notes-todo
```

The operator authorizes first enrollment at startup; remove the enrollment
environment secret after creation. Login/change/logout are app-owned endpoints.
There is no public signup, recovery or email. Use HTTPS/public origin settings
for remote deployment; authentication bonuses allow HTTP only on loopback.
Set `NOTES_TODO_PUBLIC_BASE_URL` when binding outside loopback. Auth state
uses an owner-only data directory and database.
An optional demo webhook requires `NOTES_TODO_WEBHOOK_TOKEN`.

Use [server](server.md), [auth bonuses](auth.md), [Settings/preferences](settings.md),
[realtime](realtime.md), [sidebar](sidebar.md), [UI guidelines](ui-guidelines.md),
[remote clients](remote-clients.md) and [deployment](deployment.md) as needed.
Before delivery run `bun run build && bun run test` and `bun run typecheck`.
Validate meaningful browser flows with disposable Bun.WebView captures; do not
add component/layout tests as substitutes for user-boundary evidence.
