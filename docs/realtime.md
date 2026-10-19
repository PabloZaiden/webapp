# Realtime

Application hooks share **one authenticated WebSocket per JavaScript runtime**.
Mounting or changing an interest sends dynamic subscription messages, not a
new connection. Raw terminal/preview transports are separate application protocols.
An open connection without subscriptions receives no application events.
Hooks wait for `WebAppRoot` to identify the authenticated user before opening
the shared transport; domain hooks may be declared above that root without
creating a redundant bootstrap connection.

The server advertises its `realtime.path` through `/api/config`; the shared
runtime uses that configured endpoint, including custom paths outside `/api`.
Do not configure endpoints separately on individual hooks.
An authentication-required response retires the old runtime and invalidates
the cached configuration so the root can show the sign-in flow. Obsolete
configuration responses cannot reactivate a previous authenticated session.

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
