# Deployment

## Single binary

Use `buildWebAppBinary` from `@pablozaiden/webapp/build`.

```ts
import { buildWebAppBinary, getBunCompileTargetFromArgs } from "@pablozaiden/webapp/build";

await buildWebAppBinary({
  entrypoint: import.meta.resolve("./src/index.ts").replace("file://", ""),
  outfile: "./dist/my-app",
  target: getBunCompileTargetFromArgs(),
  define: {
    WEBAPP_VERSION: JSON.stringify(process.env["WEBAPP_VERSION"] ?? "0.0.0-development"),
  },
});
```

`getBunCompileTargetFromArgs` accepts at most one `--target=<value>` argument. Supported compile targets come from the `BUN_COMPILE_TARGETS` export from `@pablozaiden/webapp/build`; use that collection when selecting a target. Empty, malformed, duplicate, and unsupported values fail before the builder creates output directories or invokes Bun. Omit the option for the default local Bun binary.

The compile-target list describes binaries Bun can produce; it is not a
promise that every target supports every framework workflow. The persisted CLI
credential and device-auth CLI workflow is supported only when the resulting
CLI runs on Linux. Use `bun-linux-x64` or `bun-linux-arm64` for supported
authenticated CLI binaries. `bun-darwin-x64`, `bun-darwin-arm64`, and
`bun-windows-x64` remain valid compile targets, but they do not represent
supported local credential persistence or device-auth CLI operation.

The binary builder compiles the browser bundle with the framework defaults needed for `webapp` apps, including Tailwind CSS v4 processing. If an app needs extra browser build behavior, add Bun plugins or browser-only defines under `web.build`:

```ts
await buildWebAppBinary({
  entrypoint: "src/index.ts",
  outfile: "./dist/my-app",
  web: {
    entry: "./frontend.tsx",
    build: {
      plugins: [myBrowserPlugin],
      define: {
        "process.env.MY_BROWSER_FLAG": JSON.stringify("enabled"),
      },
    },
  },
});
```

App-provided plugins run before the framework defaults. Use `web.build.disableDefaultPlugins` only for specialized builds that intentionally replace the framework browser pipeline.

Run the binary with the same CLI contract:

```bash
MY_APP_PORT=3300 ./dist/my-app serve
./dist/my-app version
./dist/my-app api items
```

The generic command contract and public-token commands are not the Linux-only
credential boundary. If `api` uses persisted device-auth credentials or
automatic bearer-token refresh, run it with a Linux x64 or Linux arm64 binary
and follow the credential-storage requirements in `docs/cli.md`.

Keep server and CLI modes in the same binary. App-specific commands and framework-backed commands should be subcommands of that binary rather than separate executables.

## Docker

The example Dockerfiles copy a Bun-compiled Linux binary into a runtime image. They intentionally require `APP_BINARY`; there is no architecture-specific default. Build the binary for the container architecture first, then pass both the Docker platform and matching binary path:

```bash
# Linux amd64 (Bun calls this target x64)
bun run --cwd examples/notes-todo build --target=bun-linux-x64
docker buildx build \
  --platform linux/amd64 \
  --build-arg APP_BINARY=examples/notes-todo/dist/notes-todo-linux-x64 \
  --file examples/notes-todo/Dockerfile \
  --tag webapp-notes-todo:local \
  --load \
  .

# Linux arm64
bun run --cwd examples/kitchen-sink build --target=bun-linux-arm64
docker buildx build \
  --platform linux/arm64 \
  --build-arg APP_BINARY=examples/kitchen-sink/dist/kitchen-sink-linux-arm64 \
  --file examples/kitchen-sink/Dockerfile \
  --tag webapp-kitchen-sink:local \
  --load \
  .
```

Use the same mapping for either example: Docker `linux/amd64` requires the Bun `bun-linux-x64` build and `*-linux-x64` artifact, while Docker `linux/arm64` requires `bun-linux-arm64` and `*-linux-arm64`. To build an x64 image from an ARM64 host, select `--platform linux/amd64` and the x64 artifact explicitly; Docker Desktop or Buildx may need emulation enabled. Omitting `APP_BINARY`, selecting an unsupported target, or pairing the wrong artifact with the target fails during the image build.

The example Dockerfiles default to `node:22-bookworm` as a readily available Linux runtime base because the app itself is already a self-contained Bun binary. The container writes application data to `/app/data`; mount a Docker volume there when data must persist beyond the container.

The container should set:

```dockerfile
ENV MY_APP_HOST=0.0.0.0
ENV MY_APP_PORT=3000
ENV MY_APP_DATA_DIR=/app/data
```

The framework has no external frontend asset directory, so the compiled binary contains the server and Bun HTML import graph.

## Reverse proxy and forwarded headers

When TLS or a public path is terminated by a reverse proxy, keep the
application port reachable only from that proxy and configure the trust policy
explicitly:

```bash
MY_APP_TRUST_PROXY=true
MY_APP_TRUST_PROXY_HEADERS=proto,host,prefix
MY_APP_TRUST_PROXY_CHAIN=first
MY_APP_PUBLIC_BASE_URL=https://app.example.test
```

The proxy must strip any client-provided `X-Forwarded-Proto`,
`X-Forwarded-Host`, and `X-Forwarded-Prefix` values before overwriting the
headers it is responsible for. Only enable the corresponding symbolic
headers in `MY_APP_TRUST_PROXY_HEADERS`. Sanitized single-value headers are
recommended; `MY_APP_TRUST_PROXY_CHAIN` exists only to make a comma-separated
chain deterministic. The framework does not infer trust from header presence,
does not parse the RFC `Forwarded` header, and does not provide a
proxy-address allowlist in this release.

Use `MY_APP_PUBLIC_BASE_URL` when the external origin must remain deterministic
regardless of request headers. A trusted prefix controls cookie paths and
framework-generated setup/device links. If trust is disabled, the framework
uses the direct request URL and host, which is the correct default for a
direct deployment.

Proxy configuration does not make application data persistent. Set
`MY_APP_DATA_DIR` to a durable directory and mount a persistent volume for
container deployments; the SQLite data must survive independently of the
reverse proxy or application process.

For full application CI/CD templates, including a production Dockerfile, PR checks, GHCR publishing on `main`, binary releases and Docker release images, see `docs/github-actions.md`.
