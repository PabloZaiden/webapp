# @pablozaiden/webapp

Opinionated Bun + React framework for single-server TypeScript webapps: one Bun process serves the React UI, API routes, multi-user passkey auth, user-owned and server-managed API keys, device auth, stateless CLI API-key auth, realtime websocket state, scoped settings, binary builds and Docker images.

## Quick start

Use one of the examples during framework development:

```bash
bun install
bun run dev:notes-todo
bun run dev:kitchen-sink
```

Both examples run with Bun native hot reload through `bun --hot`, with no standalone frontend build server and no external `WEB_DIST_DIR`.

## Application dependencies

Each application package must declare `react` and `react-dom`; they are peer dependencies of the framework. Bun resolves `react-dom/client` from the application package context, so workspace installs do not need to hoist React packages to a repository root. Native startup and binary builds fail early with the application context when `react-dom` is not installed.

## Main exports

| Export | Use |
| --- | --- |
| `@pablozaiden/webapp/server` | `createWebAppServer`, route helpers, responses, request-origin helpers, SQLite store |
| `@pablozaiden/webapp/web` | `WebAppRoot`, `renderWebApp`, `useToast`, sidebar types, UI controls, realtime hooks |
| `@pablozaiden/webapp/contracts` | Shared auth/config/device/API-key types |
| `@pablozaiden/webapp/cli` | Lazy `createWebAppCli`, profiles, persistent state/config, detached server lifecycle, device/environment auth, API/schema/logs/update and raw WebSocket commands |
| `@pablozaiden/webapp/build` | Bun single-binary compile helper |

## Headless and restricted servers

Set `web: false` when a process should expose API or websocket transports
without generating or mounting the browser application. A `requestFilter` can
then enforce a deny-by-default network surface before public routes, framework
endpoints, application routes, or websocket upgrades are dispatched:

```ts
createWebAppServer({
  appName: "Worker",
  envPrefix: "WORKER",
  web: false,
  requestFilter: (request) => {
    const path = new URL(request.url).pathname;
    return path === "/api/health" || path.startsWith("/api/worker/");
  },
  routes,
});
```

Returning `false` produces a `404` response. `requestFilter` intentionally
requires `web: false`; otherwise Bun may serve an HTML bundle directly without
passing through the application request dispatcher.

## Motion primitives

The web export includes `Presence`, `Collapsible`, `AsyncState`, `AnimatedList`,
`Tabs`, `TabPanels`, and `TabPanel`. Use stable React keys with `AnimatedList`;
it preserves removed keyed children for the exit duration and marks them
inaccessible while they leave. The primitives honor
`prefers-reduced-motion`; transient appearance animations use opacity-only
fades, while structural primitives such as `Collapsible` animate their layout.

```tsx
<AnimatedList>
  {records.map((record) => (
    <DataListRow key={record.id} title={record.title} />
  ))}
</AnimatedList>
```

Use `layout="contents"` when animated children should participate directly in
the surrounding layout rather than through the list wrapper.

See `docs/getting-started.md` for the minimum app shape and `examples/notes-todo` for a realistic app. Use `docs/github-actions.md` when adding CI, Docker and release workflows to an app built with the framework. Release/publishing details for this package are in `docs/release.md`.

CLI API callers can use a stored device session or the stateless
`${PREFIX}_BASE_URL` and `${PREFIX}_API_KEY` environment pair; see
`docs/cli.md` for precedence and anonymous fallback behavior.
