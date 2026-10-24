# Static clients and remote APIs

A framework application can keep its normal integrated Bun server, or publish
its compiled frontend on an ordinary HTTP(S) static host and connect to a
separate API. Static hosting does not run Bun, Node, or application endpoints.
The API still owns users, persistence, authorization and execution.

Clients do not register their hosting origin with the API. Both unified and
API-only servers accept independently authenticated clients from any host.
Browser API requests omit cookies and use explicit tokens; integrated browser
sessions keep their existing same-origin/CSRF protections.

## Connection and login

One frontend artifact supports both integrated and static deployments.
Its shared bootstrap reads directory-relative `webapp-client.json` before
importing the application. The static configuration enables remote mode;
the unified server supplies integrated mode with cookie authentication and
its trusted public path prefix. No second browser compilation is needed.
An optional distributed API URL supplies the initial default. A device-local
choice takes precedence and is scoped to the deployed client directory.
The connection screen works before login and when the API is unavailable.
Settings / General exposes the current connection, server selection and sign-out.
Changing servers reloads the client, retiring its entire JavaScript context,
connections, pending work and application-owned in-memory caches.

Remote login uses device authorization, not cross-origin passkey calls or
third-party cookies. The client opens the API's authorization page; the user
signs in with that server's passkey and approves the displayed code. The client
polls the existing device-token endpoint and receives its own revocable session.
If the browser blocks the new window, the connection screen retains a direct
authorization link. Cancel stops polling and pending credential-lock admission;
credentials written during cancellation are removed instead of signing in.
Changing servers also stops polling.

Default browser credential storage uses localStorage scoped to the exact API URL
and client deployment directory. Treat the static origin as trusted application
code: tokens are not encrypted or HttpOnly, and scripts served there can access
them. Deployment-directory keys are namespacing, not isolation from other scripts
on the same origin. Do not share that origin with untrusted uploads or
applications. Refresh-token rotation is serialized
across tabs using Web Locks; use current browsers and a secure context.
Signing out removes local credentials and revokes the remote session; revocation
failures are shown rather than silently claiming success.

Serve the browser client and public API over HTTPS. The browser client requires a
secure context for credential locking; HTTP localhost development is supported.
This browser requirement is not an API client-origin allowlist. A native wrapper
must establish a supported secure origin;
opening the artifact as `file://` is not a supported authentication contract.

## API and resource helpers

Applications should keep requests behind the framework helpers:

```tsx
import {
  appJson,
  appResourceUrl,
  appWebSocketConnection,
  ResourceImage,
} from "@pablozaiden/webapp/web";

const items = await appJson("/api/items");
const socket = await appWebSocketConnection("/api/terminal", { signal });
const download = await appResourceUrl("/api/items/export", "resource", { signal });
// Navigate to download.url; renew media URLs before download.expiresAt when set.

<ResourceImage src="/api/items/icon" alt="Item" />;
```

Remote requests attach bearer authorization only to the selected API. They omit
cookies, reject redirects and preserve an API URL's path prefix. Eligible
authentication failures renew the session once; network failures and unrelated
401 responses never blindly replay mutations.

`appAbsoluteUrl` and `appPagePath` continue to identify the **frontend** for
navigation. Do not use them for API downloads. `appPath` chooses the API origin
but does not authorize an HTML image, video, download or WebSocket by itself.
Use `ResourceImage` for private API images and the async helpers for direct
resources and sockets. Resource capabilities are short-lived and target-bound;
WebSocket capabilities are single-use. Neither helper puts access or refresh
tokens into URLs. Honor `expiresAt` when retaining a media URL.
The realtime connection deadline includes ticket acquisition, not only opening
the socket.

Keep application-owned private browser storage separate with
`clientScopedStorageKey(key)`. Integrated mode preserves existing keys; remote
mode namespaces them by API and client session. Generic appearance preferences
can remain local to the device.

Repeated `configureWebAppClient({})` calls preserve bootstrap configuration.
Configure only the values intentionally being changed. The normal integrated
entry point requires no remote-mode configuration.

## Native integration seam

Before calling `renderWebApp`, a future native wrapper can supply a platform
credential store and a system-browser launcher:

```ts
configureWebAppClient({
  mode: "remote",
  remote: {
    credentialStore: keychainStore,
    openAuthorizationUrl: openSystemBrowser,
  },
});
```

`WebAppClientCredentialStore` has asynchronous `read(baseUrl)`,
`write(credentials)` and `remove(baseUrl)` methods. Returned credentials must
belong to the requested API URL. A browser implementation is provided by default;
no native runtime, signing, packaging, deep-link or App Store integration is
included.
