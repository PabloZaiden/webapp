# CLI helpers

Apps built with the framework should be one app and one binary. The binary can expose subcommands such as `serve`, `version`, `update`, app-specific commands, and optional framework-backed commands like `auth`, `status`, `api` and `schema`.

Use `@pablozaiden/webapp/cli` for small composable helpers, not a mandatory CLI framework:

```ts
import { dispatchCliCommand, printCliResult } from "@pablozaiden/webapp/cli";

const result = await dispatchCliCommand({
  args: Bun.argv.slice(2),
  help: "Usage: my-app <serve|version|notify>",
  defaultCommand: "serve",
  commands: {
    serve: async () => {
      await app.start();
      await new Promise(() => undefined);
      return { exitCode: 0 };
    },
    version: () => ({ exitCode: 0, output: version }),
    notify: (args) => runNotifyCommand(args),
  },
});

process.exitCode = printCliResult(result);
```

Device-auth and environment API-key helpers can be composed into apps that
need authenticated CLI calls. Public-token commands, such as webhook
notification commands, can stay app-owned and do not need framework auth.

Route metadata can power generic API commands:

```ts
import { runApiCliCommand } from "@pablozaiden/webapp/cli";
import { createRouteCatalog } from "@pablozaiden/webapp/server";

const catalog = createRouteCatalog(routes);
const result = await runApiCliCommand({
  catalog,
  args,
  envPrefix: "MY_APP",
  credentials,
});
```

`runApiCliCommand` can list endpoints, print schema metadata, call endpoints
with `--method` and `--payload`, attach bearer credentials, and refresh stored
device credentials once on `401`.

## Stateless API-key authentication

An app that passes its validated `envPrefix` to `runApiCliCommand` can make
non-interactive authenticated requests with an API key:

```bash
export MY_APP_BASE_URL=https://app.example.test
export MY_APP_API_KEY='key-from-settings'
my-app api items
```

The helper derives exactly `${PREFIX}_BASE_URL` and `${PREFIX}_API_KEY` from
the supplied prefix. When no stored device credentials are available, an
explicit `baseUrl` plus `${PREFIX}_API_KEY` takes precedence; otherwise the
complete environment pair supplies the request URL and bearer key. Values are
trimmed, and the base URL must use `http` or `https`; trailing slashes are
removed.

If either environment variable is missing or empty, the pair is ignored and
the request remains anonymous, using an explicit `baseUrl` or
`http://localhost:3000`. A partial pair is not an error. Stored device
credentials remain highest priority and continue to use their existing refresh
and `401` retry behavior.

The environment API-key path does not run interactive login or device
authorization, refresh tokens, write credential files, or retry rejected
requests. The key is supplied by the environment and kept in memory for the
request; it is not printed or persisted by the CLI. The server remains
responsible for API-key validity, expiry, and route scopes.

## Concurrent credential refreshes

`createJsonFileStore()` and `createDeviceCredentialsStore()` coordinate refreshes for
the same credential path with an adjacent lock file. When credentials are expired,
`refreshDeviceCredentials()` acquires that lock before calling the token endpoint,
reads the store again, and reuses credentials another process may have refreshed.
The write of newly refreshed credentials happens while the lock is held.

The `JsonFileStore<T>.withLock()` method is optional so existing custom stores that
only implement `path`, `read`, `write` and `clear` remain source-compatible. A
custom store must provide `read` and `withLock` to receive the same cross-process
refresh guarantee; otherwise the legacy refresh path is retained.

```ts
await store.withLock(async () => {
  // Work serialized for this store path.
}, {
  timeoutMs: 30_000,
  staleAfterMs: 300_000,
  pollIntervalMs: 25,
});
```

The defaults are a 30-second acquisition timeout, a five-minute stale threshold
and a 25-millisecond polling interval. A timeout throws `JsonFileStoreLockError`
with `code === "timeout"`. Release failures use `code === "release"`. Lock
metadata contains only ownership information (PID, timestamp and nonce), never
access or refresh tokens. The credentials directory and file retain `0700` and
`0600` permissions respectively.
