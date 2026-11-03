# Client transport and runtime composition

The same shell/live-query stack works with integrated HTTP, a detached API, or
an external/native transport. None of those modes activates device login,
refresh tokens, credential files or browser storage.

`initializeWebAppClient()` reads neutral `webapp-client.json` before importing
app code in generated clients. `getWebAppClientBootstrap()` returns that parsed
deployment data so the app does not fetch it again. Integrated/remote/external
are deployment tags, not authentication methods. `initializeWebAppClient(opts)`
instead accepts explicit configuration for custom startup.

```ts
configureWebAppClient({
  apiBaseUrl: selectedEndpoint,
  request: request => appAuthenticatedTransport(request),
  connect: (path, { signal }) => appSocketTransport(path, signal),
  resourceUrl: (path, { kind, signal }) => appResourceCapability(path, kind, signal),
  saveResource: (path, options) => appSave(path, options),
  runtime: appRuntime,
});
```

Hooks are independently optional. Use only what the app requires.
`WebAppClientRuntime` supplies `getSnapshot`, `subscribe` and optional `refresh`.
Snapshots are stable immutable values:

```ts
{
  scope: string, generation: number, ready: boolean,
  error?: Error, logLevel: LogLevelName, logLevelFromEnv?: boolean
}
```

The default is ready, local, memory-only. `scope` is a local cache/preference
namespace, never an authorization claim. Publish a new generation when identity,
credentials or endpoint changes; dispose app-owned resources. The core aborts
old request signals, rejects stale completions, closes its sockets/realtime and
remounts the shell's route content. Apps must also retire caches they own outside
the shell. `useWebAppRuntime` exposes the snapshot directly.

The already-neutral `WebAppExternalClient` remains an alternative for complete
external integrations: session snapshot/subscription/refresh, request,
createRealtimeSource, connect, optional resourceUrl/saveResource. Its session is
the same presentation model, with no user/role requirement.

## Requests, duplex channels and resources

Prefer `appJson`, `appFetch`, `appRequest` and URL helpers. `WebAppApiError`
normalizes failed JSON requests. No generic code refreshes credentials or
replays failed mutations. Apps can handle their own authentication headers,
resource tickets and endpoint validation in transport hooks.

`appDuplexConnection` returns `WebAppDuplex`: ready, bufferedAmount,
subscribe({onMessage,onClose,onError}), send and close. Native WebSockets use
`nativeWebAppDuplex`. Ordinary realtime uses this same transport, preserving
acknowledgements, reconnection and live queries. An app may instead supply
`createRealtimeSource`.

`appResourceUrl(path,kind,{signal})` returns `{url,expiresAt,dispose?}`.
The custom resource hook receives `kind:"resource"|"websocket"` so apps can
issue narrowly scoped capabilities without exposing bearer credentials.
Dispose handles on replacement, stale completion and unmount. `ResourceImage`
uses the configured request/resource transport, never a separate auth client.
Transport-provided image URLs use anonymous CORS by default, so private images
can load from another origin without cross-origin cookies or relaxing resource
policy headers. HTTP resource endpoints must allow that client's origin through
CORS after authorizing the resource. Explicit `crossOrigin` image options are
preserved; direct `blob:` and `data:` sources remain unchanged.
`appSaveResource` supports app/native handoff; acceptance is not proof of a
completed saved file.

`fetchAppRequest`, `nativeWebAppDuplex`, `createRealtimeRuntime`,
`setRealtimeIdentity`, `setExternalRealtimeSource` and `resetRealtimeRuntime`
are public primitives when an integration needs them. Do not intercept global
fetch/WebSocket or synthesize fake server accounts/configuration to use the UI.
Native toolbar/header behavior remains owned by the shared shell.

## Static clients

`buildWebAppClient` emits a complete relocatable directory (including bootstrap)
for root or nested hosting. Publish the entire directory. Pass its returned
artifact to `buildWebAppBinary({web:{client}})` to embed identical frontend
bytes. The integrated server changes only its public runtime bootstrap.
Apps own any connection picker, saved endpoint/credentials, protected resources
and API-origin authentication pages. See [deployment](deployment.md).
