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

Device-auth CLI helpers can be composed into apps that need authenticated CLI calls. Public-token commands, such as webhook notification commands, can stay app-owned and do not need framework auth.

Route metadata can power generic API commands:

```ts
import { runApiCliCommand } from "@pablozaiden/webapp/cli";
import { createRouteCatalog } from "@pablozaiden/webapp/server";

const catalog = createRouteCatalog(routes);
const result = await runApiCliCommand({
  catalog,
  args,
  baseUrl: "http://localhost:3000",
  credentials,
});
```

`runApiCliCommand` can list endpoints, print schema metadata, call endpoints with `--method` and `--payload`, attach bearer credentials, and refresh once on `401`.

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
