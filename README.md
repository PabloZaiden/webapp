# @pablozaiden/webapp

Opinionated Bun + React framework for single-server TypeScript webapps: one Bun process serves the React UI, API routes, passkey auth, API keys, device auth, realtime websocket state, settings, binary builds and Docker images.

## Quick start

Use one of the examples while the package is private:

```bash
bun install
bun run dev:notes-todo
bun run dev:kitchen-sink
```

Both examples run with Bun native hot reload through `bun --hot`, with no standalone frontend build server and no external `WEB_DIST_DIR`.

## Main exports

| Export | Use |
| --- | --- |
| `@pablozaiden/webapp/server` | `createWebAppServer`, route helpers, responses, SQLite store |
| `@pablozaiden/webapp/web` | `WebAppRoot`, sidebar types, UI controls, realtime hooks |
| `@pablozaiden/webapp/contracts` | Shared auth/config/device/API-key types |
| `@pablozaiden/webapp/build` | Bun single-binary compile helper |

See `docs/getting-started.md` for the minimum app shape and `examples/notes-todo` for a realistic app. Use `bun run screenshots` for reproducible manual visual captures.
