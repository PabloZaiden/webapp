# Trusted delegated operations

Delegation is a server-code capability for applications that authenticate a
remote principal through their own trusted transport. It does not add a public
HTTP endpoint, credential format, header override, or another route catalog.
`WebAppServer.dispatchDelegated()` matches the same compiled application routes
and invokes the same handler as ordinary HTTP.

## Declare the operation contract

```ts
const routes = defineRoutes({
  "/api/projects/:projectId/documents/:id": {
    auth: "user",
    sameOrigin: "mutations",
    delegation: {
      resource: "document",
      action: "read",
      bindings: [
        { source: "param", name: "projectId", resource: "project" },
        { source: "param", name: "id", resource: "document" },
      ],
    },
    operations: {
      POST: {
        delegation: {
          resource: "document",
          action: "write",
          bindings: [
            { source: "param", name: "projectId", resource: "project" },
            { source: "param", name: "id", resource: "document" },
          ],
        },
      },
      DELETE: { delegation: false },
    },
    GET: getDocument,
    POST: updateDocument,
    DELETE: deleteDocument,
  },
});
```

The exported `RouteDelegationMetadata` contains `resource: string`,
`action: string`, optional `bindings: readonly RouteResourceReference[]`, and
optional `collection: boolean`. Each binding contains
`{ source: "param" | "query" | "body"; name: string; resource: string }`.
Names and resource kinds are application-owned, not framework lookup rules.
The application validates every referenced resource and its relationship to
the authorized scope; declaring a binding does not grant access or parse input.

No declaration means **deny**. Method metadata overrides the route default;
`false` or an explicit `undefined` removes an inherited grant. The same
metadata is retained by `createRouteCatalog`, `resolveRouteOperation`, and CLI
schema output. Never put credentials or trusted approval results in metadata.

## Invoke through an admitted transport

```ts
// Only after the application verifies the remote identity and transport.
return await app.dispatchDelegated(request, {
  actor: verifiedGuest, // CurrentUser: role "user", isAdmin/isOwner false
  async authorize(operation, request) {
    // Canonical matched pattern, effective method, decoded params, auth,
    // scopes, resolved metadata and nonfalse delegation are provided.
    return await domain.authorizeGuestOperation(
      verifiedGuest,
      operation,
      request.clone(),
    ); // application authority object, or false/undefined to deny
  },
  run(invocation, invoke) {
    // invocation.authorization retains its inferred application type.
    return operationAuthority.run(invocation.authorization, invoke);
  },
});
```

`DelegatedDispatchOptions<TAuthorization extends object>` declares:

- `actor: CurrentUser`
- `authorize(operation: DelegatedOperation, request: Request)` returning an
  authority object or `false`/`undefined`, synchronously or asynchronously.
- Optional `run(invocation: DelegatedInvocation<TAuthorization>, invoke)`
  returning `Promise<Response | undefined>`.

`DelegatedInvocation<T>` contains `actor`, `operation`, and `authorization: T`.
`DelegatedOperation` extends `MatchedRouteOperation` with the admitted
`delegation`. Canonical operations contain `path`, `method`, decoded `params`,
`auth`, `scopes`, and resolved operation `metadata`. `HEAD` uses the effective
`GET` operation and retains the normal body-free response behavior. Applications
must validate query/body inputs, including all bindings, before approval. Clone
the request before reading its body if the handler will need it.

Only declared `auth: "user"` or `"required"` operations can be delegated.
Admin, owner, optional, public, undeclared, and framework built-in operations
are unavailable. The existing `requestFilter` also applies. An ordinary
HTTP request can never opt into delegation through headers, cookies, or body.
Admission failures use a structured 403 `delegation_forbidden` response.
Normal path decoding, unsupported-method responses and handler error mapping
remain in effect.

The grant callback runs before the handler or route middleware. The `run`
callback wraps that authenticated invocation, allowing an application-owned
typed `AsyncLocalStorage` authority without changing the actor. Handlers receive
`ctx.delegation`, whose authorization value is intentionally `unknown` at the
generic framework boundary. Use the typed application context installed by
`run` for domain operations.

`ctx.user`, `requireUser`, `assertUser`, ownership helpers and `userRealtime`
continue to refer to the **guest actor**, not a storage owner. Delegated
`requireAdmin` and `requireOwner` always reject. Select resource storage authority
explicitly in the domain; the framework never impersonates the owner or relaxes
ownership helpers. Background work must capture its own deliberate execution
authority rather than carrying an entire request grant indefinitely.

Delegation intentionally uses transport admission instead of browser-origin
admission. It does not forge `Origin`, bearer scopes, cookies, or passkey state.
The grant callback receives declared scopes along with domain metadata and
must authorize the full operation. Ordinary HTTP authentication, API-key/bearer
scope checks and same-origin policy are unchanged.

## Canonical request and response routing

`WebAppServerConfig.routeMiddleware` is the post-policy hook:

```ts
routeMiddleware: async (request, context, operation, invoke) => {
  if (references.isExternal(operation, request)) {
    return await references.forwardAndMap(request, context.requireUser(), operation);
  }
  return await invoke();
},
```

Its arguments are a `Request`, the normal `RouteContext`, a canonical
`MatchedRouteOperation`, and `() => Promise<Response | undefined>`. It runs
after normal authentication/scopes/same-origin checks or delegated admission,
and inside `run` when delegation is in effect. Its response uses the same
security headers, error mapping and `HEAD` behavior as the handler.

Applications may route source-qualified IDs and transform explicitly declared
reference fields at this boundary. Keep source selection per operation; do not
globally switch the browser/CLI API URL, replace arbitrary strings, or duplicate
the route table. Source identity, membership, storage, domain ID formats, and
reference mappings remain application responsibilities.
