# @pablozaiden/webapp

Opinionated Bun + React framework for single-server TypeScript webapps: one Bun process serves the React UI, API routes, multi-user passkey auth, user-owned API keys, device auth, realtime websocket state, scoped settings, binary builds and Docker images.

## Quick start

Use one of the examples during framework development:

```bash
bun install
bun run dev:notes-todo
bun run dev:kitchen-sink
```

Both examples run with Bun native hot reload through `bun --hot`, with no standalone frontend build server and no external `WEB_DIST_DIR`.

## CLI credential support

The persisted CLI credential and device-auth CLI workflow exposed by
`@pablozaiden/webapp/cli` is supported only on Linux (x64 and arm64). This
includes device-code login, local credential persistence, bearer-token refresh,
and credential-backed API CLI calls.

Bun can compile binaries for macOS and Windows, but those compile targets do
not imply supported local credential persistence or device-auth CLI operation
on those systems. Generic CLI dispatch and public-token commands are separate
and are not covered by this Linux-only credential boundary. See
`docs/cli.md` before building an authenticated CLI workflow.

## Main exports

| Export | Use |
| --- | --- |
| `@pablozaiden/webapp/server` | `createWebAppServer`, route helpers, responses, SQLite store |
| `@pablozaiden/webapp/web` | `WebAppRoot`, `renderWebApp`, sidebar types, UI controls, realtime hooks |
| `@pablozaiden/webapp/contracts` | Shared auth/config/device/API-key types |
| `@pablozaiden/webapp/cli` | One-binary command helpers, device-auth credentials and generic API CLI caller |
| `@pablozaiden/webapp/build` | Bun single-binary compile helper |

See `docs/getting-started.md` for the minimum app shape and `examples/notes-todo` for a realistic app. Use `docs/github-actions.md` when adding CI, Docker and release workflows to an app built with the framework. Use `bun run screenshots` for reproducible manual visual captures. Release/publishing details for this package are in `docs/release.md`.
