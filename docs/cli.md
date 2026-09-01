# Composable application CLI

`createWebAppCli()` provides one lazy CLI for a one-app/one-binary deployment.
It owns top-level parsing, global `--profile`, generated help and usage,
dispatch, output, and exit codes. Server construction remains application-owned
and only occurs when the application's `start` callback chooses to construct it.

```ts
import { createWebAppCli } from "@pablozaiden/webapp/cli";
import { createRouteCatalog } from "@pablozaiden/webapp/server";
import { createAppRuntime } from "./app";

let runtime: ReturnType<typeof createAppRuntime> | undefined;
const getRuntime = () => runtime ??= createAppRuntime();

const cli = createWebAppCli({
  appName: "My App",
  commandName: "my-app",
  envPrefix: "MY_APP",
  version: "1.2.3",
  realtimePath: "/api/ws",
  start: async () => {
    await getRuntime().app.start();
  },
  routeCatalog: () => createRouteCatalog(getRuntime().routes),
  commands: {
    notify: {
      description: "Send an application notification.",
      usage: "notify --message TEXT",
      handler: async ({ args, profile }) => {
        return { exitCode: 0, output: `${profile}: ${args.join(" ")}` };
      },
    },
  },
});

process.exitCode = await cli.run();
```

## Server state and lifecycle

The framework stores application state under `$HOME/.<app-directory-name>` by
default. When `appDirectoryName` is omitted, the directory name is derived
from the uppercase `envPrefix` (`MY_APP` becomes `.my-app`). For an
application with `envPrefix: "MY_APP"`, setting `MY_APP_DATA_DIR` replaces that
directory completely. The directory contains the SQLite data, `config.json`,
the detached server PID file, and `logs/server.log`. `config.json` contains
only bootstrap configuration and is versioned separately from the application
database.

`serve` without a subcommand remains the foreground server command used by
Docker, systemd, launchd, and development shells. The detached lifecycle is
explicit:

```bash
my-app serve up
my-app serve up --dev
my-app serve status
my-app serve down
my-app serve config show
my-app serve config set host 127.0.0.1
my-app serve config set port 3000
my-app serve config set development.source-path /path/to/source
my-app serve config unset development.source-path
```

`serve up` refuses to stop a process it cannot identify as an instance of the
same application. It starts the replacement with detached standard streams,
writes a PID file, and waits for the public `/api/health` endpoint before
returning. If the port is already occupied by an unrecognized process, the
command fails without stopping it. `serve down` is idempotent and removes
stale PID metadata after the managed process has stopped.

`serve up --dev` requires a configured, existing `development.source-path`.
The application-provided build adapter runs before the current server is
stopped, so a failed build leaves the current server running. On success, the
generated server command starts without passing `--dev` to the child. Host and
port flags on `serve up`, `serve down`, and `serve status` are one-shot
overrides; `serve config set` persists values. Environment variables take
precedence over persisted host and port values.

Applications provide the development-specific build and generated command
without putting application paths in the framework:

```ts
createWebAppCli({
  // ...
  serve: {
    development: {
      build: async ({ sourcePath }) => {
        await buildApplication(sourcePath);
      },
      command: ({ sourcePath }) => [
        resolve(sourcePath, "dist", "my-app"),
        "serve",
      ],
    },
  },
});
```

The optional `serve.command` callback can replace the current-process command
used by the default `serve up` mode. The detached parent only resolves
configuration, builds when requested, and launches the command; it does not
construct the application server or initialize its database.

`healthPath` and `readinessTimeoutMs` customize the readiness probe when an
application does not expose its health endpoint at `/api/health`:

```ts
createWebAppCli({
  // ...
  serve: {
    healthPath: "/health",
    readinessTimeoutMs: 30_000,
  },
});
```

The built-in commands are:

- `help`
- `serve`
- `version`
- `config`
- `update`
- `logs`
- `api`
- `schema`
- `auth`
- `status`
- `profile`
- `ws`

Custom commands use the same typed command map. A custom command may replace a
built-in only by setting `override: true`; accidental name collisions fail
during CLI creation.

## Profiles and authentication

The CLI stores device bearer credentials in named profiles. It does not persist
cookies or arbitrary headers. `--profile NAME` selects a profile for one
command; `profile use NAME` changes the saved default.

```bash
my-app --profile production auth --base-url https://app.example.test
my-app --profile production status
my-app profile list
my-app profile use production
my-app profile remove production
```

`auth` performs the framework device-authorization flow and writes access and
refresh credentials only to the selected profile. Profile files reuse
`createJsonFileStore()` and its locking and permissions behavior.

When a selected profile has no credentials, authenticated commands can use the
exact `${PREFIX}_BASE_URL` and `${PREFIX}_API_KEY` environment pair. A partial
pair is ignored. Environment API keys remain in memory and are never written to
profile storage or printed.

`status` calls `GET /api/auth/status` and succeeds only when the server confirms
that the selected profile or environment credentials are authenticated. A
device-authenticated status request uses the same bounded recovery behavior as
`api`.

## API, schema, and logs

Pass a route catalog array or lazy catalog callback to expose application
routes through `api` and `schema`:

```ts
createWebAppCli({
  // ...
  routeCatalog: () => createRouteCatalog(routes),
});
```

The catalog and runtime server use the same route grammar. Static segments,
named parameters, and optional trailing wildcards are matched consistently;
query strings and fragments are ignored for catalog lookup. A custom `cliPath`
may use different parameter names from the API path, because captures are
mapped by position:

```ts
{
  "/api/projects/:projectId/files/*": {
    cliPath: "project/:id/files/*",
    GET: handler,
  },
}
```

Here `project/123/files/docs/readme.md` resolves to
`/api/projects/123/files/docs/readme.md`. Dynamic values are decoded safely
while matching and encoded again when the API URL is generated. Malformed
percent escapes are rejected as an unknown/invalid CLI endpoint rather than
being sent as a partially generated URL. Invalid or ambiguous route
definitions fail when the server/catalog is compiled.

`api` lists endpoints and calls a selected route with `--method` and `--payload`.
If a device bearer request receives `401`, the CLI makes at most one conditional
refresh and one retry. While holding the profile lock, it refreshes only when
the persisted access token is still the token that was rejected; if another
caller already replaced that token, it reuses the newer persisted credentials
without a redundant refresh. A final `401` is returned unchanged. Environment
API-key requests are never refreshed or retried. `schema` prints route and
schema metadata. `logs` reuses the same selected profile/environment
authentication and requests `GET /api/server/logs`.

## Updating installed binaries

Configure the framework update command with the application release metadata:

```ts
createWebAppCli({
  // ...
  update: {
    repository: "my-org/my-app",
    binaryName: "my-app",
    currentVersion: "1.2.3",
    productName: "My App",
    checksum: { required: true },
  },
});
```

`update --check` checks the latest release and `update --version VERSION`
installs a specific release. The command delegates release lookup, platform
selection, checksum verification, staging, replacement, rollback, and
companion-binary handling to `@pablozaiden/installer`. Applications only
provide the installer configuration; they do not implement update providers.
Updating requires an installed release binary, not a Bun source invocation.

## Raw realtime WebSocket command

`ws` connects to the configured realtime path, normally `/api/ws`, using the
selected profile or environment API-key authentication:

```bash
printf '%s\n' '{"type":"ping"}' | my-app --profile production ws
```

The command accepts JSON lines from stdin, sends each line as an unchanged text
frame, and writes received text frames unchanged to stdout. It does not accept
positional base URLs and does not interpret application event types. EOF,
`SIGINT`, and `SIGTERM` close normally; invalid input, binary frames, connection
errors, and abnormal closes produce a non-zero result.

## Credential store locking

`createJsonFileStore()` coordinates access with an adjacent lock file.
`createDeviceCredentialsStore()` uses it for refresh-token writes. Lock
metadata contains only process ownership information, never tokens. Stale-lock
recovery first claims the existing lock ownership atomically; it never deletes
the shared lock path solely because an earlier metadata read matched. Active
reclaim claims block new publishers, and a replacement lock is left intact if
ownership changes. Corrupted or structurally invalid reclaim-gate files are
discarded during acquisition so they cannot permanently block the credential
store.

```ts
await store.withLock(async () => {
  // Serialized work for this store path.
}, {
  timeoutMs: 30_000,
  staleAfterMs: 300_000,
  pollIntervalMs: 25,
});
```

On filesystems that support POSIX permissions, credential directories and
files use `0700` and `0600`; permission changes are best-effort elsewhere.
