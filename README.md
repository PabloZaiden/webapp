# @pablozaiden/webapp

Bun + React framing for a single server: shell, UI primitives, routing, assets,
lifecycle and interest-based realtime. The core has no account database,
authentication product, CLI or implicit browser persistence. Applications own
identity, authorization, accounts and storage.

```bash
bun install
bun run dev:kitchen-sink
bun run dev:notes-todo
```

Kitchen Sink is explicitly public and memory-only; changes disappear on restart.
Notes TODO explicitly selects application-owned SQLite and browser preferences.
Its optional password/session example is disabled unless configured; enrollment
is operator-authorized, never public signup.

| Export | Purpose |
| --- | --- |
| `/server` | Generic server, app request/WS/policy hooks, routes, responses, realtime |
| `/web` | Shell, Settings layouts, controls, requests/transports, preferences, live queries |
| `/contracts`, `/routing` | Neutral wire types, patterns and metadata |
| `/auth`, `/auth/browser` | Optional passkeys, passwords and browser sessions with app-owned state |
| `/build` | Browser assets, relocatable static clients and standalone binaries |

Use the full package prefix `@pablozaiden/webapp`. Applications declare both
`react` and `react-dom`. Development uses Bun native hot reload, not a separate
frontend server. Dependencies are pinned to GitHub commits; no npm publication
is required.

Start with [getting started](docs/getting-started.md), then
[server](docs/server.md), [optional authentication](docs/auth.md),
[Settings](docs/settings.md), [realtime](docs/realtime.md) and
[remote clients](docs/remote-clients.md). See [deployment](docs/deployment.md),
[CI](docs/github-actions.md), [release mechanics](docs/release.md), and the
canonical [skill](skills/webapp/SKILL.md).
