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

Keep server and CLI modes in the same binary. App-specific commands and framework-backed commands should be subcommands of that binary rather than separate executables.

## Docker

Examples include Dockerfiles that copy a Bun-compiled Linux binary into a runtime image. Build the binary for the container architecture first, then build the image:

```bash
bun run --cwd examples/notes-todo build --target=bun-linux-arm64
docker build -f examples/notes-todo/Dockerfile -t webapp-notes-todo:local .

bun run --cwd examples/kitchen-sink build --target=bun-linux-arm64
docker build -f examples/kitchen-sink/Dockerfile -t webapp-kitchen-sink:local .
```

The example Dockerfiles default to `node:22-bookworm` as a readily available Linux runtime base because the app itself is already a self-contained Bun binary. Use `--target=bun-linux-x64` and pass `--build-arg APP_BINARY=examples/notes-todo/dist/notes-todo-linux-x64` when building an x64 container from a different host. The container should set:

```dockerfile
ENV MY_APP_HOST=0.0.0.0
ENV MY_APP_PORT=3000
ENV MY_APP_DATA_DIR=/data
```

The framework has no external frontend asset directory, so the compiled binary contains the server and Bun HTML import graph.

For full application CI/CD templates, including a production Dockerfile, PR checks, GHCR publishing on `main`, binary releases and Docker release images, see `docs/github-actions.md`.
