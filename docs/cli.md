# CLI helpers

## Platform support for credential workflows

The persisted CLI credential and device-auth CLI workflow is supported only on
Linux (x64 and arm64). This includes `runDeviceAuthCommand()`,
`createDeviceCredentialsStore()`, and credential-backed
`runApiCliCommand()` calls that read, refresh, and rewrite stored bearer
credentials.

This does not make every CLI helper or the server-side device-auth endpoints
Linux-only. Generic command dispatch and public-token commands can remain
app-owned. It does mean that applications must not present local persisted
device-auth credentials as a supported workflow on macOS or Windows.

Bun's compile-target list describes binaries Bun can produce; it does not
define the supported operating systems for this credential workflow. A
Darwin or Windows binary may be a valid compile output without being a
supported authenticated CLI binary for this framework.

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

## Credential storage on Linux

The default file-backed store uses `HOME` and the application-provided
`appDirectoryName`:

```ts
import { createDeviceCredentialsStore } from "@pablozaiden/webapp/cli";

const credentialsStore = createDeviceCredentialsStore({
  appDirectoryName: "my-app",
});
```

With that configuration, the default paths are:

- Credential file: `$HOME/my-app/device-auth.json`
- Refresh lock: `$HOME/my-app/device-auth.json.lock`

In general, replace `my-app` with the configured `appDirectoryName`. The
default file name is `device-auth.json`; an application that supplies
`fileName` replaces that final path segment. The store creates the credential
directory with `0700` permissions and the credential file with `0600`
permissions where the filesystem supports POSIX modes.

The store requires a non-empty `HOME` value when it resolves the default path.
If an application deliberately uses a different environment variable, it may
pass that variable's name through `envHome`; a non-empty value from that
explicit configuration is used before `HOME`. This is application
configuration, not an automatic `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, or
`os.homedir()` fallback. If no usable home value is available, path resolution
fails with `HOME is not set`.

The normal workflow is:

1. `runDeviceAuthCommand()` starts the device flow, prints the verification
   link and user code, polls the token endpoint, and writes credentials only
   after authorization succeeds.
2. A credential-backed `runApiCliCommand()` reads the stored credentials,
   sends a bearer token, and retries once with refreshed credentials when
   required.
3. Concurrent refreshes for the same file use the adjacent lock file. Lock
   metadata contains ownership information only, not access or refresh tokens.

Do not rely on this persisted credential workflow on macOS or Windows. The
server-side device-auth protocol can still be used by clients outside this
local file-backed workflow, but this framework's documented CLI credential
workflow is Linux-only.

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
access or refresh tokens. The credentials directory and file attempt to retain `0700` and `0600` permissions
respectively where the filesystem supports POSIX modes.
