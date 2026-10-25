# Realtime

Application hooks share **one authenticated WebSocket per JavaScript runtime**.
Mounting or changing an interest sends dynamic subscription messages, not a
new connection. Raw terminal/preview transports are separate application protocols.
An open connection without subscriptions receives no application events.
Hooks wait for `WebAppRoot` to identify the authenticated user before opening
the shared transport; domain hooks may be declared above that root without
creating a redundant bootstrap connection.

An [external client](remote-clients.md#external-sessions-and-transports) supplies
a `RealtimeSource` instead of using the native socket runtime. Existing hooks
keep their interest, status, activation and refresh semantics. The source owns
subscription acknowledgement and recovery; call `onSubscribed` after each
acknowledged activation, including recovery after a gap, so consumers refetch
authoritative state. Recoverable interruptions report status, while rejected
subscriptions and invalid frames report errors. `dispose()` must retire all of
that source's subscriptions/listeners; it must not dispose unrelated
application-owned connections. The framework does not add a second reconnect
loop around the external source.

The server advertises its `realtime.path` through `/api/config`; the shared
runtime uses that configured endpoint, including custom paths outside `/api`.
Do not configure endpoints separately on individual hooks.
An authentication-required response retires the old runtime and invalidates
the cached configuration so the root can show the sign-in flow. Obsolete
configuration responses cannot reactivate a previous authenticated session.

Connection loss and automatic reconnection are silent in the UI, including
extended interruptions. Recoverable transport failures are logged and exposed
through `onStatus`/`status`, not `onError`/`error`; applications should not turn
those status changes into global error notices. Previously loaded data remains
visible, and acknowledged reconnection refreshes authoritative state.

Network failures from the configured API client also retire an open shared
transport before rejecting the request. This suspends stale background reads
and recovers them through the same acknowledged reconnection, even when HTTP
fails before the WebSocket notices the interruption. Request construction
errors, HTTP error responses and cancellation do not trigger this recovery.
Successful response bodies are monitored through consumption, including JSON,
text, binary reads, clones and direct stream readers, without buffering the whole
response. A body transport failure retires the shared connection before the
consumer sees its rejection; malformed JSON, consumed/locked bodies and explicit
stream cancellation are not connection failures. Fetch URL, redirect/type metadata
and response-header immutability are preserved.
Explicit operations still reject normally, and mutations are never retried.
Invalid protocol frames, rejected subscriptions and consumer/synchronization
failures remain actionable errors.
An outbound frame exceeding the client's 2 MiB limit is an actionable terminal
error, not a reconnect loop. Temporary outbound-buffer pressure remains retryable.

## State collections

Use resource publications for invalidation, not transcript or action bodies:

```ts
ctx.userRealtime.publishEntityChanged("todos", todo.id);
ctx.userRealtime.publishDeleted("todos", todo.id);
ctx.userRealtime.publishSettingsChanged();
// Scheduled/background work supplies the authoritative owner explicitly:
app.realtime.publishChanged("todos", { target: { userId: todo.userId } });
```

Resource events contain `type`, `resource`, `action`, and optional `id`, `scope`,
and `payload`. `publishChanged`, `publishEntityChanged`, `publishDeleted`,
`publishSettingsChanged`, and `publishResource` publish **state** events.
They infer routing metadata from the event; contradictory explicit resource,
ID, or scope targets throw. `ctx.userRealtime` always overwrites the owner
target with the authenticated user, even if the caller supplied another ID.

```tsx
const query = useLiveQuery<Todo[]>({
  load: signal => appJson("/api/todos", { signal }),
  realtime: { resources: ["todos"] },
});
await query.mutate(
  signal => appJson<Todo>("/api/todos", {
    method: "POST", signal, body: JSON.stringify(input),
  }),
  (previous, todo) => previous ? [...previous, todo] : undefined,
);
```

`load(signal, previous?)` returns data rather than writing unrelated state.
Only the owning generation can commit its result. Matching invalidations
during a read mark it dirty and queue one follow-up; a dirty response is not
installed as synchronized. A failed superseded read also yields to that queued
follow-up, for example when a collection member is deleted while its detail
is loading. A failure without a newer invalidation settles visibly rather
than retrying indefinitely. Errors are returned as `query.error` and optionally
reported to `realtime.onError`. `refresh()` resolves after its reads settle;
read failures are exposed through state, not unhandled rejected promises.

`mutate(operation, reconcile?)` establishes a barrier **before** starting the
operation: it cancels older reads, pauses reads while mutations are pending,
guards optional response reconciliation, and requests an authoritative cut
after the last mutation settles. Mutation failures reject the returned promise.
Mutations are not retried; cancellation cannot promise that a server mutation
did not execute. Zero-argument operation callbacks are supported.

The loader's `previous` argument supports authoritative refetches of an
already-loaded paginated prefix. The application determines page depth,
ordering, unread counts, and domain reconciliation. Changing `deps` cancels
the old query lifecycle and resets data to the current `initialData` (or
`undefined`); reconnect preserves previous data. `refresh` and `mutate` are
stable callbacks. Omitting `realtime`, setting it to `false`, or disabling it
creates an ordinary query without an application subscription.
Ordinary queries do not wait for realtime identity and can load and refresh
on public pages or outside `WebAppRoot`. Session changes still cancel their
old lifecycle and reset the query's displayed data.

For an existing cancellable refresh operation:

```tsx
useRealtimeRefresh({
  resources: ["todos"],
  refresh: (_event, signal) => refreshData(signal),
});
```

It refreshes after **every acknowledged activation**, including an interest
added to an already-open socket, and coalesces concurrent invalidations. The
initial activation passes `undefined` as the event. An opaque callback's
independent state writes cannot be guarded by the framework: use `useLiveQuery`
or `createLiveQueryController` when reads must not overwrite mutations.

## Content and actions

Custom publications default to `kind: "content"`; transient actions explicitly
use `kind: "action"`. State subscribers never receive either accidentally.

```ts
app.realtime.publish(delta, {
  kind: "content",
  target: { userId: owner.id, chatId: chat.id },
});
app.realtime.publish(action, {
  kind: "action",
  target: { userId: owner.id, clientId: client.id },
});
```

```tsx
useRealtime<ChatDelta>({
  kinds: ["content"],
  types: ["chat.delta"],
  targets: { chatId },
  trackLastEvent: false,
  onEvent: applyDelta,
  onSubscribed: ({ generation }) => recover(generation),
  onError: setError,
});
```

Server selectors are `resources`, `actions`, `ids`, `scopes`, `types`, `kinds`,
and `targets`. Array entries are OR; different selectors/dimensions are AND.
Arbitrary targets such as `taskId`, `chatId`, `agentRunId`,
`provisioningJobId`, or `clientId` support either one string or an array.
Undefined target values are omitted by hooks. Resource interests default to
`kinds: ["state"]`; interests without resources default to content/action.
At least one concrete selector other than kinds is required.

`realtimeEventMatches(event, selector, { kind, target })` evaluates the same
selectors against an explicit publication kind and routing target. Supply the
actual routing metadata: targets and kinds cannot be inferred from an event
payload. The matcher also applies the optional local predicate.

`predicate` is a local refinement, not a server interest or authorization rule.
Client interests cannot select `userId`. Delivery first checks publication
ownership independently of interest matching, then optional server-side access
filters. Always supply an authoritative owner for private custom publications;
an intentionally untargeted publication is global to matching authenticated
connections. Interests do not grant access to a resource.

Overlapping interests produce one event frame listing each matching
subscription generation. Each logical subscriber receives it once.
Consumer exceptions are isolated and reported to that consumer's error handler.
Changing selectors replaces the logical interest without reopening the socket.

## Authoritative versioned projections

```tsx
const transcript = useVersionedRealtime<Transcript, Delta>({
  deps: [chatId],
  kinds: ["content"], types: ["chat.delta"], targets: { chatId },
  load: async ({ signal }) => {
    const snapshot = await appJson<Snapshot>(`/api/chats/${chatId}`, { signal });
    return { data: snapshot.transcript, ...snapshot.position };
  },
  version: event => event.position,
  reduce: (data, event) => applyTranscriptDelta(data, event),
});
```

`deps?: readonly unknown[]` declares the projection's identity, using React
dependency equality and a fixed dependency-list shape. Supply the entity key,
such as `deps: [chatId]` or `[jobId]`. Identity changes immediately stop exposing
the previous data/error, retire its controller and cancel pending requests, and
activate a new logical subscription on the existing shared socket. Late old
results cannot populate the new projection. Same-identity reconnects preserve
displayed data while establishing a new authoritative baseline.
`UseVersionedRealtimeOptions<TData,TEvent>` is exported for typed compositions.
Raw `useRealtime` also accepts `deps` when a logical consumer identity changes
without changing its server selectors.

The snapshot's `{ epoch: string, revision: number, data }` must be captured
from one consistent authoritative domain cut. Deltas expose
`{ epoch, baseRevision, revision }`; revisions are non-negative safe integers,
and each delta must advance its base. Do not fabricate revisions from socket
send counters, timestamps, ETags, or independently read metadata.

Acknowledgement starts a bounded temporary buffer and the authoritative load.
Baseline installation discards deltas already represented by the snapshot,
orders newer deltas by domain revision, and drains them in one synchronous
handoff. Duplicate revisions are ignored. Stale generation/read results
cannot commit. A gap, epoch change, or buffer overflow requests a new baseline.
Persistent inconsistency is surfaced as an error after bounded recovery.
There is no replay history. Defaults are 512 events and 2 MiB.
Reducers can throw `RealtimeResyncRequiredError` when a domain-specific base
length or projection bound requires an authoritative baseline. Other reducer
errors surface immediately. Recovery is bounded in either case. `refresh()`
during an active read marks it dirty and queues one follow-up baseline; its
promise covers that follow-up. Deactivation preserves displayed data while
discarding buffers and pending results; the next activation requires a fresh cut.
An obsolete read failure yields to an already-queued baseline, just like an
obsolete success. A failure of the final requested baseline remains visible
and does not start an unbounded retry loop.
Each read dispatch drops the preceding temporary buffer and epoch expectation:
the fresh authoritative cut must cover already-observed mutations. Only deltas
arriving during that read constrain its epoch. This permits a live owner to
retire into a cold persisted snapshot without preserving an obsolete stream
incarnation; late old-owner deltas request another fresh cut.

The same non-React owner is exported:

```ts
const sync = createVersionedSyncController<Data, Event>({
  load: ({ signal }) => loadSnapshot(signal),
  version: event => event.position,
  reduce,
  onChange: state => render(state),
  maxBufferedEvents: 512,
  maxBufferedBytes: 2 * 1024 * 1024,
});
// Connect it to useRealtime's callbacks:
// onSubscribed: activation => sync.activate(activation)
// onStatus: status => { if (status !== "open") sync.deactivate(); }
// onEvent: event => sync.receive(event)
```

It provides `activate({generation})`, `receive(event)`, `refresh()`,
`deactivate()`, `getState()`, and `dispose()`. State contains optional
`data`, `epoch`, `revision`, `error`, and status
`"idle" | "loading" | "live" | "error"`.

`createLiveQueryController({load,initialData?,onChange,onError?})` is the
invalidation-only equivalent. `prepare()` permits local mutations before
activation; `activate()` enables acknowledged reads; `suspend()` cancels reads
without abandoning mutation barriers. `invalidate()`, `mutate()`,
`reset(data?)`, `deactivate()`, and `getState()` complete its lifecycle.

## Wire protocol and lifecycle

The exported contract schemas runtime-validate JSON on both sides. The endpoint
accepts no query parameters and implements only the current protocol:

```json
{"type":"subscribe","subscriptionId":"detail","generation":1,"interest":{"kinds":["content"],"types":["chat.delta"],"targets":{"chatId":"chat"}}}
{"type":"subscribed","subscriptionId":"detail","generation":1}
{"type":"event","subscriptions":[{"subscriptionId":"detail","generation":1}],"event":{"type":"chat.delta"}}
{"type":"unsubscribe","subscriptionId":"detail","generation":2}
{"type":"unsubscribed","subscriptionId":"detail","generation":2}
{"type":"ping"}
{"type":"pong"}
```

Resubmitting `subscribe` with a newer generation updates an existing interest.
No late acknowledgement/event can reactivate an obsolete client generation.
The runtime restores current interests on reconnect and waits for their new
acknowledgements before recovery. One heartbeat probes every 15 seconds, with
a 5-second connection, pong, and subscription-ack deadline; one bounded
exponential retry timer owns reconnect. Online/bfcache restoration can reconnect,
but changing visibility alone does not replace a healthy socket.

Server limits default to 128 subscriptions, 64 KiB client messages and 1 MiB
outbound buffered data; configure them under `realtime` as `maxSubscriptions`,
`maxMessageBytes`, and `maxBufferedBytes`. Backpressure emits an error where
possible and closes with 1013, forcing recovery instead of silently dropping
events. Protocol errors close with 1008. Client buffering is also bounded.
Subscription limits cannot exceed the protocol maximum of 128. Retired
generations remain bounded at 32 times the configured subscription limit;
exhaustion requests reconnect so an old command cannot revive a retired interest.
Authentication changes invalidate the shared session, clear old interests,
cancel owned work, and require new baselines. The final subscriber releases
the socket, browser listeners, heartbeat and retry timers.
Idle retirement waits until the end of the current JavaScript turn, allowing
replacement of the sole logical interest without recreating the transport.
Explicit runtime disposal still tears down immediately.

## Portable admitted transports

`RealtimeTransport`, exported from `@pablozaiden/webapp/server`, is the minimal
server-side connection interface:

```ts
interface RealtimeTransport {
  readonly data: { userId?: string };
  send(payload: string): number | void;
  close(code?: number, reason?: string): void;
  getBufferedAmount(): number;
}
```

Bun `ServerWebSocket` satisfies it directly. An application can adapt one
admitted logical relay channel without exposing or fabricating a Bun socket:

```ts
app.realtime.add(channel, {
  authorize: publication =>
    publication.target.userId === grant.ownerId
    && grant.allowsScope(publication.target.scope),
  transform: publication => references.toGuest(publication),
  onDispose: () => relay.detach(channel),
});
// On each admitted channel payload:
app.realtime.message(channel, bytes); // string | Uint8Array
// On transport loss/revocation:
app.realtime.remove(channel);
```

The ordinary protocol, acknowledgements, interest matching, generations, limits
and backpressure behavior are unchanged. `send` may return Bun's numeric result
(`0` means lost, `-1` means queued) or `void`; adapters must report their real
queued byte count and close the logical channel when asked. Do not hide an
unbounded queue behind the adapter. `remove` retires framework state and runs
`onDispose` once; the caller still owns closing an externally removed transport.
Protocol/transport failures and server shutdown close and retire it.

Without `authorize`, connections retain ordinary `target.userId` ownership
targeting. Providing it **replaces** that default: the application must validate
the original publication's owner **and** current resource/membership scope.
It runs for every publication independently of client interests, which can
only narrow delivery. The connection's `data.userId` remains its guest actor.
Policy exceptions fail closed and close that connection.

`RealtimePublication<TEvent>` contains `{ event, target, kind }`. The optional
transform runs only after authorization, before matching interests. Return
`undefined` to omit delivery. Map explicit event/reference metadata and its
corresponding target fields together; never rewrite arbitrary text, logs or
payload strings. Authorization/disposal callbacks are synchronous; arrange
async transport teardown through the application's existing lifecycle owner.
Policy and transform inputs use `RealtimePublication<unknown>`: authorization
can inspect trusted target metadata, while event-dependent code must validate
or narrow the event before reading it. A transform returns a publication with
the bus's typed application event. The generic identifies produced/delivered
events, not an assumption that an external source already conforms to them.
This also preserves composition of event-agnostic routes in typed realtime
applications without casts or weakened callback parameter checks.

## Per-user external sources

Applications may merge an admitted remote feed into the user's existing
authenticated `/api/ws` connection, including the CLI `ws` command:

```ts
const source = app.realtime.attachSource({
  userId: authenticatedLocalUser.id,
  authorize: original => remoteMembership.allows(original.target),
  transform: original => references.fromSource(remoteIdentity, original),
  onDispose: () => upstream.close(),
});

// After validating an upstream protocol frame, supply trusted original owner
// and resource metadata from that admitted session, not client interests.
source.publish(event, { kind: "state", target: trustedRemoteTarget });
```

`RealtimeSourceOptions<TEvent>` requires the local `userId` and `authorize`;
`transform` and `onDispose` are optional. Source authorization sees upstream
metadata before transformation. Delivery goes directly into only that local
user's active connections, applies their connection policies and interests,
and uses their existing bounded send path. It does **not** call global
`publish`, broadcast to another local user, retain event history, or create a
second browser transport. State invalidations and narrow content/action
streams use the same interface.

The application owns source discovery, upstream subscriptions, protocol
validation and reconnect/admission. Call `source.invalidate()` after an upstream
gap/reconnect or changed grant: it closes the local recipient's active
connections with 1012 so normal reconnect establishes fresh interests and
authoritative snapshots. No automatic remote replay is implied.
`source.dispose()` idempotently detaches, invalidates, and runs cleanup;
subsequent publications are ignored. Dispose on upstream loss or revocation,
then establish a fresh admitted source after recovery. `app.realtime.dispose()`
releases all sources and portable connections and is also called on server
shutdown; the bus can accept fresh connections when the server restarts.

### Observe live local interests

A paired source can keep its admitted control/realtime transport connected
without subscribing to remote content while no local client needs it:

```ts
const stopObserving = app.realtime.observeInterests(
  authenticatedLocalUser.id,
  interests => upstreamSubscriptions.replace(
    references.toSource(remoteIdentity, interests),
  ),
  { onError: () => source.dispose() },
);

// Source teardown also releases its observer:
stopObserving();
```

The public signature is:

```ts
observeInterests(
  userId: string,
  listener: (interests: readonly RealtimeInterest[]) => void,
  options?: { onError?: (error: unknown) => void },
): () => void;
```

`RealtimeInterest` is exported from `@pablozaiden/webapp/contracts`;
`RealtimeInterestListener` and `RealtimeInterestObserverOptions` are server
exports. The listener receives an immediate synchronous authoritative snapshot,
including `[]`. It aggregates current acknowledged subscriptions from all
connections admitted as that `data.userId`, never another user's connections.
Equal interests collapse, selector order is canonicalized, and snapshots are
immutable independent copies. Generations and subscription IDs are local
protocol details, not additional interests.

Subscribe, replacement, unsubscribe and connection removal schedule a fresh
snapshot after acknowledgement, coalesced in one microtask per turn. Only an
actual change is delivered; closing one of two clients sharing an interest
does not retire the other's interest. The pending set contains at most one
entry per observed user, and the observer retains only its current snapshot
identity, not event or subscription history.

An empty snapshot means retire upstream subscriptions, **not** revoke pairing
or close the control transport. Map qualified resource selectors, IDs, scopes,
types and explicit targets at the application's source boundary; filter out
interests that do not select that source. Do not broaden content subscriptions
to every remote log, infer authorization from selectors, or globally republish
remote events. The original membership/source authorization still constrains
every forwarded publication. Re-admission/reconnect must reapply current
interests; registering a fresh observer supplies that snapshot immediately.

Callbacks run synchronously. If upstream application work is asynchronous,
its owner must serialize/cancel updates so an obsolete update cannot replace
newer interests. A callback exception logs an error, detaches that observer and
calls `onError` with the original failure. An initial exception is also rethrown
to the registering caller. Rejections from accidentally returned promises are
reported through the same error path. Use `onError` to fail closed by closing
or suspending upstream delivery; failure handlers must not re-log the same
failure unless they add meaningful context.

The idempotent returned function stops observation without changing client
subscriptions. Call it during source teardown. `app.realtime.dispose()` emits
a final empty snapshot when needed, detaches all observers and releases their
capacity; observers must be registered again after a runtime restart.
`realtime.maxInterestObservers` defaults to 1024 across the bus. It must be a
positive safe integer. Registration over that bound throws `RangeError` rather
than silently leaving a source with stale subscription state.
