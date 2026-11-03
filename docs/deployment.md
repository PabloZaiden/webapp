# Build and deployment

## Standalone binaries

```ts
import { buildWebAppBinary, getBunCompileTargetFromArgs } from "@pablozaiden/webapp/build";
await buildWebAppBinary({
  entrypoint: "src/index.ts",
  outfile: "dist/example",
  target: getBunCompileTargetFromArgs(),
});
```

Applications declare `react` and `react-dom`. The builder resolves
`react-dom/client` from the application context, including strict workspace
layouts, and bundles its browser dependency. Framework peers accept compatible
React 19 versions so consumers keep one renderer/hooks singleton.

Run the app directly: `EXAMPLE_PORT=3300 ./dist/example`. There is no framework
CLI. App-owned command parsing/process management may wrap the same entrypoint.
The framework still owns ordinary server lifecycle and graceful cleanup.

`BUN_COMPILE_TARGETS` lists supported targets. `getBunCompileTargetFromArgs`
accepts at most one `--target=<value>` and rejects malformed/unsupported values
before output or compilation. macOS/Linux arm64/x64 are supported; Docker
examples deliberately target Linux amd64/arm64.

`web.build.plugins` and browser-only `web.build.define` extend the default
Tailwind v4 pipeline. `disableDefaultPlugins` is only for deliberately replaced
pipelines. Backend-only defines belong in the top-level binary build options.
Browser defines, static configuration and all public artifacts are public:
never embed credentials or server secrets.

## One client artifact

```ts
const client = await buildWebAppClient({
  entry: "src/web/main.tsx", outdir: "dist/client", appName: "Example",
  apiBaseUrl: "https://api.example.test",
});
await buildWebAppBinary({
  entrypoint: "src/index.ts", outfile: "dist/example",
  web: { client },
});
```

Publish the entire client directory for root or nested static hosting.
Relative asset URLs and hash navigation avoid a base-path rebuild. The binary
embeds the same renderer/application scripts, chunks, CSS and runtime artifacts;
its neutral bootstrap selects integrated deployment without rebuilding them.
`clientMode:"external"` instead emits a bootstrap with no API server.
Static mode does not imply bearer/device authentication: apps configure
[their own transports and runtime](remote-clients.md).

`web.paths` controls which routes serve documents, replacing old
auth-presentation modes. App-owned account or connection-picker pages must
implement their own auth semantics and data guards.

Document configuration includes title/short name, theme/background color,
icons and optional PWA generation. Native Bun and compiled routes share
security headers and public-asset paths. App-owned runtime assets are explicit
`web.assets`/`web.publicAssets` entries; use the same entries in development and
builds. Manifests preserve emitted primary files and sidecars (CSS, workers,
WASM/fonts/imports/source maps), MIME types and relative paths, not basenames.
Keep asset imports relative when nested hosting matters.

## Storage and containers

Core startup creates no SQLite or account configuration. The core-only Kitchen
Sink uses no data volume; its projects/preferences disappear on restart.
Notes TODO explicitly selects SQLite domain data and browser preferences.
`NOTES_TODO_DATA_DIR` must be a durable mounted directory when deployed; the
optional auth database/secret is also application-owned there. Public examples
are not authorization templates for Internet-facing private apps.

Example Dockerfiles run the compiled binary directly as a non-root user.
Pass explicit `APP_BINARY` matching the platform:

```bash
bun run --cwd examples/notes-todo build --target=bun-linux-x64
docker build --platform linux/amd64 \
  --build-arg APP_BINARY=examples/notes-todo/dist/notes-todo-linux-x64 \
  -f examples/notes-todo/Dockerfile -t notes-example .
```

Missing/mismatched binaries and unsupported platforms fail the build.
For arm64 use `bun-linux-arm64` and `linux/arm64`. Apps choose whether data,
credentials or operational metadata needs a volume; never assume a framework
account database exists. Use owner-only directories/files and fail closed if
protection or migration fails. See [CI guidance](github-actions.md).

## Origins and proxies

Set `{PREFIX}_HOST`, `{PREFIX}_PORT`, `{PREFIX}_PUBLIC_BASE_URL` and deliberate
trusted proxy configuration as required. Trust Forwarded/X-Forwarded headers
only behind an explicitly trusted proxy; otherwise use the direct request
origin. The public base URL is deployment metadata, not client identity.

Cookie-authenticated mutations/WebSockets still require same-origin policy;
cross-origin explicit credentials still require app authorization. CORS is
opt-in, never a replacement for authentication. Use HTTPS for deployed bonus
authentication (HTTP is permitted only on loopback), and ensure configured
origin/RP ID/cookie paths match the app-owned auth endpoints.

Bind shared networks deliberately. Use app-owned backup, migration, key
rotation and session revocation procedures. The framework does not migrate old
account stores or silently reset old credentials.
