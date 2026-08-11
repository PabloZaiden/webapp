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

The built-in commands are:

- `help`
- `serve`
- `version`
- `config`
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
that the selected profile or environment credentials are authenticated.

## API, schema, and logs

Pass a route catalog array or lazy catalog callback to expose application
routes through `api` and `schema`:

```ts
createWebAppCli({
  // ...
  routeCatalog: () => createRouteCatalog(routes),
});
```

`api` lists endpoints, calls a selected route with `--method` and `--payload`,
and refreshes device credentials once after a `401`. `schema` prints route and
schema metadata. `logs` reuses the same selected profile/environment
authentication and requests `GET /api/server/logs`.

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
metadata contains only process ownership information, never tokens.

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
