# GitHub Actions for apps

Keep application CI/distribution policy app-owned. Webapp supplies a build
pipeline, not a CLI/updater/deployment service. Its own workflows validate
examples; they do not enable authentication bypasses or create account state.

## Pull requests

Use Bun, a strict TypeScript configuration and explicit scripts:

```json
{
  "scripts": {
    "dev": "bun --hot src/index.ts",
    "typecheck": "tsc --noEmit",
    "build": "bun src/build.ts",
    "test": "bun test"
  }
}
```

After checkout/setup-bun, run `bun install --frozen-lockfile`,
`bun run typecheck`, `bun run build`, and `bun run test`.
Compilation/transpilation does not replace typechecking.
Use pinned immutable workflow actions, least permissions and isolated data.
Smoke-test real compiled listeners, not a mocked framework dispatcher.

```bash
mkdir -p .cache/ci-state
MY_APP_HOST=127.0.0.1 MY_APP_PORT=3300 \
MY_APP_DATA_DIR="$PWD/.cache/ci-state" ./dist/my-app &
server_pid="$!"
trap 'kill "$server_pid" 2>/dev/null || true' EXIT
```

Poll an actual `/api/health` endpoint with a bounded deadline before smoke
requests. Public health/static routes need no account bypass. Private app
journeys should provision a disposable identity through app-owned authorized
setup, then exercise the real supported authentication contract.

## Docker and architectures

Build Linux x64 and arm64 binaries with explicit supported targets:

```bash
bun src/build.ts --target=bun-linux-x64
bun src/build.ts --target=bun-linux-arm64
```

Use the exported `BUN_COMPILE_TARGETS`/`getBunCompileTargetFromArgs` validation,
not hand-maintained target coercion. An amd64 image must receive the x64 binary;
an arm64 image must receive the arm64 binary. Example Dockerfiles reject
missing/mismatched binary paths and unsupported platform arguments.
With Buildx/QEMU, smoke-test each architecture and inspect container logs on
failure. Run non-root and mount only app-selected durable data.

The framework's [PR workflow](../.github/workflows/pr-checks.yml) installs,
typechecks, runs binary/remaining tests, builds examples and smokes compiled
listeners. [Main Docker Smoke](../.github/workflows/main-docker-smoke.yml)
validates both image architectures, argument errors and container health.

## Publishing

Publishing is a separate explicitly authorized step. Apps choose Docker-only,
standalone binaries or another distribution; using Webapp requires none of
them. Keep credentials in repository/organization secret stores, never
browser defines or artifacts. Do not publish/deploy merely to validate tooling.

Webapp itself is consumed from immutable GitHub commits. Update dependency
manifest/lock together and run final checks against that exact revision.
For named framework releases use [the release procedure](release.md); no npm
package or interim release is needed for coordinated consumer migrations.
