# GitHub Actions for framework apps

Use these templates for applications built with `@pablozaiden/webapp`. They follow the framework deployment pattern:

1. Pull requests install, build, test and smoke-test the Bun dev server.
2. Merges to `main` publish a `main` Docker image to GHCR.
3. Published GitHub releases upload standalone binaries.
4. Published GitHub releases publish semver Docker images to GHCR.

Replace these placeholders before committing:

| Placeholder | Example | Meaning |
| --- | --- | --- |
| `my-app` | `notes` | Binary name, Docker user/group and local container name |
| `MY_APP` | `NOTES` | `envPrefix` used by `createWebAppServer` |
| `My App` | `Notes` | Human-readable app name |
| `src/build.ts` | `apps/server/src/build.ts` | Build script path |
| `dist/my-app` | `apps/server/dist/my-app` | Default binary path produced by `bun run build` |

The templates assume these package scripts:

```json
{
  "scripts": {
    "dev": "bun --hot src/index.ts serve",
    "build": "bun src/build.ts",
    "test": "bun test"
  }
}
```

If the app uses TypeScript typechecking separately, add a `tsc` script and call it from the PR workflow before tests.

The smoke templates only hit health/static/public endpoints. `MY_APP_DISABLE_PASSKEY=true` authenticates as the existing owner when one exists; it does not create an owner in an empty data directory. If a smoke test needs protected app APIs, seed a test owner in `MY_APP_DATA_DIR` first or add a deliberate public smoke endpoint.

## Dockerfile

Place this at `Dockerfile` in the app repository root. It builds the app inside Docker, copies only the standalone Bun binary into a slim runtime image, runs as a non-root user, and exposes `/api/health` as the container healthcheck.

```dockerfile
FROM oven/bun:1 AS builder
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run build

FROM debian:bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    tini \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist/my-app /app/my-app

RUN groupadd --system my-app && \
    useradd --system --gid my-app --no-create-home my-app
RUN mkdir -p /app/data && chown -R my-app:my-app /app/data

ENV NODE_ENV=production
ENV MY_APP_HOST=0.0.0.0
ENV MY_APP_PORT=8080
ENV MY_APP_DATA_DIR=/app/data

EXPOSE 8080
USER my-app

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${MY_APP_PORT}/api/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/my-app", "serve"]
```

For apps that need extra OS packages, add them to the runtime `apt-get install` list. Keep `ca-certificates`, `curl` and `tini`.

### Prebuilt-binary Dockerfiles

The Dockerfile above builds the binary inside Docker, so it does not use `APP_BINARY`. The repository examples use a different pattern: they copy a prebuilt binary and require the caller to provide the artifact explicitly. Keep the platform and artifact mapping below in local commands and GitHub Actions:

| Docker platform | Bun build target | Required artifact suffix |
| --- | --- | --- |
| `linux/amd64` | `bun-linux-x64` | `linux-x64` |
| `linux/arm64` | `bun-linux-arm64` | `linux-arm64` |

For a prebuilt-binary Dockerfile, do not add an architecture-specific `APP_BINARY` default. Build and image commands should select the same platform and artifact, for example:

```bash
bun run --cwd examples/notes-todo build --target=bun-linux-x64
docker buildx build \
  --platform linux/amd64 \
  --build-arg APP_BINARY=examples/notes-todo/dist/notes-todo-linux-x64 \
  --file examples/notes-todo/Dockerfile \
  --tag webapp-notes-todo:amd64 \
  --load \
  .

bun run --cwd examples/notes-todo build --target=bun-linux-arm64
docker buildx build \
  --platform linux/arm64 \
  --build-arg APP_BINARY=examples/notes-todo/dist/notes-todo-linux-arm64 \
  --file examples/notes-todo/Dockerfile \
  --tag webapp-notes-todo:arm64 \
  --load \
  .
```

Validate `TARGETOS` and `TARGETARCH` in the Dockerfile before copying the artifact, so omitted, unsupported, or mismatched inputs fail during the build rather than at container startup. When building ARM64 images on an x64 GitHub runner, configure QEMU and Buildx before the build.

## Pull request workflow

Place this at `.github/workflows/pr.yml`.

The smoke job starts the native Bun hot-reload dev server, checks `/api/health`, validates that `/` returns HTML, and fetches the first JavaScript and CSS assets referenced by the page. Passkeys and same-origin checks are disabled only for CI startup smoke tests.

```yaml
name: Pull Request

on:
  pull_request:
    branches: [main]

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Checkout repository
        uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5

      - name: Setup Bun
        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Build
        run: bun run build

      - name: Run tests
        run: bun run test

  smoke-test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Checkout repository
        uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5

      - name: Setup Bun
        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Smoke test app startup
        shell: bash
        run: |
          set -euo pipefail
          MY_APP_DISABLE_PASSKEY=true \
          MY_APP_DISABLE_SAME_ORIGIN_CHECK=true \
          MY_APP_PORT=3018 \
          MY_APP_DATA_DIR="$(mktemp -d)" \
            bun run dev > /tmp/my-app-pr-smoke.log 2>&1 &
          app_pid="$!"
          trap 'kill "$app_pid" 2>/dev/null || true' EXIT

          for _ in {1..60}; do
            if curl -fsS http://127.0.0.1:3018/api/health >/dev/null; then
              break
            fi
            if ! kill -0 "$app_pid" 2>/dev/null; then
              cat /tmp/my-app-pr-smoke.log
              exit 1
            fi
            sleep 0.5
          done
          curl -fsS http://127.0.0.1:3018/api/health >/dev/null

          html="$(curl -fsS -D /tmp/my-app-root-headers http://127.0.0.1:3018/)"
          grep -qi '^content-type: text/html' /tmp/my-app-root-headers

          js="$(printf '%s' "$html" | sed -n 's/.*src="\([^"]*\.js\)".*/\1/p' | head -n1)"
          css="$(printf '%s' "$html" | sed -n 's/.*href="\([^"]*\.css\)".*/\1/p' | head -n1)"
          test -n "$js"
          test -n "$css"
          js="${js#./}"; js="${js#/}"
          css="${css#./}"; css="${css#/}"

          curl -fsS -D /tmp/my-app-js-headers "http://127.0.0.1:3018/$js" >/dev/null
          curl -fsS -D /tmp/my-app-css-headers "http://127.0.0.1:3018/$css" >/dev/null
          grep -qi '^content-type: .*javascript' /tmp/my-app-js-headers
          grep -qi '^content-type: text/css' /tmp/my-app-css-headers

      - name: Smoke test Docker image
        shell: bash
        run: |
          set -euo pipefail
          docker build -t my-app-pr-smoke .
          docker run --rm -d --name my-app-pr-smoke -p 3019:8080 \
            -e MY_APP_DISABLE_PASSKEY=true \
            -e MY_APP_DISABLE_SAME_ORIGIN_CHECK=true \
            my-app-pr-smoke
          trap 'docker logs my-app-pr-smoke || true; docker stop my-app-pr-smoke >/dev/null 2>&1 || true' EXIT

          for _ in {1..60}; do
            if curl -fsS http://127.0.0.1:3019/api/health >/dev/null; then
              break
            fi
            sleep 0.5
          done
          curl -fsS http://127.0.0.1:3019/api/health >/dev/null

          html="$(curl -fsS -D /tmp/my-app-docker-root-headers http://127.0.0.1:3019/)"
          grep -qi '^content-type: text/html' /tmp/my-app-docker-root-headers

          js="$(printf '%s' "$html" | sed -n 's/.*src="\([^"]*\.js\)".*/\1/p' | head -n1)"
          css="$(printf '%s' "$html" | sed -n 's/.*href="\([^"]*\.css\)".*/\1/p' | head -n1)"
          test -n "$js"
          test -n "$css"
          js="${js#./}"; js="${js#/}"
          css="${css#./}"; css="${css#/}"

          curl -fsS -D /tmp/my-app-docker-js-headers "http://127.0.0.1:3019/$js" >/dev/null
          curl -fsS -D /tmp/my-app-docker-css-headers "http://127.0.0.1:3019/$css" >/dev/null
          grep -qi '^content-type: .*javascript' /tmp/my-app-docker-js-headers
          grep -qi '^content-type: text/css' /tmp/my-app-docker-css-headers
```

Add route-specific checks after the asset checks, for example a public ping endpoint or a readonly API that works with passkeys disabled.

## Main branch Docker workflow

Place this at `.github/workflows/docker-main.yml`.

It publishes `ghcr.io/<owner>/<repo>:main` after merges to `main`, updates `package.json` to a pre-release version based on the latest GitHub release, and runs a container health smoke test.

Keep the `platforms` value explicit. The sample uses `linux/amd64` because `load: true` loads one runnable image for the smoke test; do not omit the value and rely on the runner architecture. To publish a multi-platform `main` image, configure QEMU, use `platforms: linux/amd64,linux/arm64`, and smoke-test platform-specific loaded images before pushing the multi-platform manifest, because Docker cannot load a multi-platform result into the local image store as one runnable tag.

```yaml
name: Docker Main

on:
  push:
    branches: [main]

jobs:
  docker:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5

      - name: Get latest release version
        id: latest-release
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          latest_tag="$(gh release view --json tagName -q '.tagName' 2>/dev/null || echo "v0.0.0")"
          latest_version="${latest_tag#v}"
          echo "version=${latest_version}" >> "$GITHUB_OUTPUT"

      - name: Update package.json version
        run: |
          timestamp="$(date -u +"%Y-%m-%d-%H-%M")"
          short_sha="${GITHUB_SHA::7}"
          version="${{ steps.latest-release.outputs.version }}-main-${timestamp}-${short_sha}"
          jq --arg v "$version" '.version = $v' package.json > package.json.tmp
          mv package.json.tmp package.json

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@4d04d5d9486b7bd6fa91e7baf45bbb4f8b9deedd # v4

      - name: Log in to Container Registry
        uses: docker/login-action@4907a6ddec9925e35a0a9e82d7399ccc52663121 # v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Normalize image name
        id: image
        run: echo "name=ghcr.io/${GITHUB_REPOSITORY,,}" >> "$GITHUB_OUTPUT"

      - name: Build Docker image
        uses: docker/build-push-action@d08e5c354a6adb9ed34480a06d141179aa583294 # v7
        with:
          context: .
          push: false
          load: true
          tags: ${{ steps.image.outputs.name }}:main
          cache-from: type=gha
          cache-to: type=gha,mode=max
          platforms: linux/amd64

      - name: Test container healthcheck
        shell: bash
        run: |
          set -euo pipefail
          docker run -d --name my-app-main-smoke -p 8080:8080 \
            -e MY_APP_DISABLE_PASSKEY=true \
            -e MY_APP_DISABLE_SAME_ORIGIN_CHECK=true \
            ${{ steps.image.outputs.name }}:main
          trap 'docker logs my-app-main-smoke || true; docker rm -f my-app-main-smoke >/dev/null 2>&1 || true' EXIT

          for _ in {1..30}; do
            status="$(docker inspect --format='{{.State.Health.Status}}' my-app-main-smoke 2>/dev/null || echo starting)"
            if [ "$status" = "healthy" ]; then
              break
            fi
            sleep 2
          done

          test "$(docker inspect --format='{{.State.Health.Status}}' my-app-main-smoke)" = "healthy"
          curl -fsS http://127.0.0.1:8080/api/health >/dev/null

      - name: Push Docker image
        run: docker push ${{ steps.image.outputs.name }}:main
```

## Binary release workflow

Place this at `.github/workflows/binary-release.yml`.

It delegates cross-platform binary builds to the reusable binary release workflow and uploads checksummed assets to the GitHub release.

```yaml
name: Binary Release

on:
  release:
    types: [published]

jobs:
  binaries:
    uses: pablozaiden/installer/.github/workflows/reusable-binary-release.yml@2e28bc9fbf69385ac5172e526a1268f72db02363
    permissions:
      contents: write
    with:
      prebuild_command: bun run build
      binaries: |
        [
          {
            "name": "my-app",
            "asset_prefix": "my-app",
            "build_command": "bun src/build.ts --target=$BUN_TARGET",
            "output_path": "dist/my-app-$RELEASE_TARGET"
          }
        ]
```

If `bun run build` already builds a local default binary and your `src/build.ts` supports `--target`, keep `prebuild_command: bun run build` to validate the app before producing release assets.

## Docker release workflow

Place this at `.github/workflows/docker-release.yml`.

It publishes versioned GHCR images when a GitHub release is published:

This release workflow is intentionally multi-platform. Keep both QEMU and Buildx setup steps and keep `platforms: linux/amd64,linux/arm64` explicit; the target platform, not the runner's architecture, determines the image binary.

```yaml
name: Docker Release

on:
  release:
    types: [published]

jobs:
  docker:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5

      - name: Update package.json version
        run: |
          version="${GITHUB_REF_NAME#v}"
          jq --arg v "$version" '.version = $v' package.json > package.json.tmp
          mv package.json.tmp package.json

      - name: Set up QEMU
        uses: docker/setup-qemu-action@68827325e0b33c7199eb31dd4e31fbe9023e06e3 # v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@4d04d5d9486b7bd6fa91e7baf45bbb4f8b9deedd # v4

      - name: Log in to Container Registry
        uses: docker/login-action@4907a6ddec9925e35a0a9e82d7399ccc52663121 # v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Normalize image name
        id: image
        run: echo "name=ghcr.io/${GITHUB_REPOSITORY,,}" >> "$GITHUB_OUTPUT"

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@030e881283bb7a6894de51c315a6bfe6a94e05cf # v6
        with:
          images: ${{ steps.image.outputs.name }}
          tags: |
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=semver,pattern={{major}}
            type=raw,value=latest

      - name: Build and push Docker image
        uses: docker/build-push-action@d08e5c354a6adb9ed34480a06d141179aa583294 # v7
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          platforms: linux/amd64,linux/arm64
```

## Build script for release assets

The binary release workflow expects the app build script to accept `--target` and include the target suffix in the output filename. A minimal `src/build.ts`:

```ts
import { buildWebAppBinary, getBunCompileTargetFromArgs } from "@pablozaiden/webapp/build";

const target = getBunCompileTargetFromArgs();
const suffix = target ? `-${target.replace("bun-", "")}` : "";

await buildWebAppBinary({
  entrypoint: "src/index.ts",
  outfile: `dist/my-app${suffix}`,
  target,
  define: {
    WEBAPP_VERSION: JSON.stringify(process.env["WEBAPP_VERSION"] ?? "0.0.0-development"),
  },
});
```

`getBunCompileTargetFromArgs` accepts one `--target=<value>` option and validates it against the framework's exported `BUN_COMPILE_TARGETS` list before the build starts. Omitted targets build for the local Bun runtime; malformed, duplicate, empty, or unsupported target options fail immediately.

`buildWebAppBinary` includes the framework browser build defaults, including Tailwind CSS v4 processing. Apps that need additional browser-only transforms can pass Bun plugins or defines through `web.build.plugins` and `web.build.define`; app plugins run before the framework defaults.

## Adaptation checklist

1. Replace `my-app` everywhere with the binary name.
2. Replace `MY_APP` everywhere with the app `envPrefix`.
3. Make sure `createWebAppServer({ envPrefix: "MY_APP" })` matches the workflow and Dockerfile env vars.
4. Keep `/api/health` available; it is provided by the framework server.
5. Add app-specific smoke checks after the generic health and asset checks.
6. Keep passkey/same-origin disable flags only in CI smoke jobs, not production deploys.
7. For monorepos, update `src/build.ts`, `dist/my-app` and build commands to the app package path.
