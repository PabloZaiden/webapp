# Realtime

Every server has a typed `RealtimeBus`. Apps should prefer the framework event convention:

```ts
type AppEvent = ResourceRealtimeEvent;

const routes = defineRoutes<AppEvent>({
  "/api/todos": {
    async POST(req, ctx) {
      const user = ctx.requireUser();
      const todo = await createTodo(user.id, req);
      ctx.userRealtime.publishEntityChanged("todos", todo.id);
      return jsonResponse(todo);
    },
  },
});
```

Standard events have `type`, `resource`, `action`, optional `id`, optional `scope` and optional `payload`:

| Helper | Event |
| --- | --- |
| `publishChanged("todos")` | `{ type: "todos.changed", resource: "todos", action: "changed" }` |
| `publishEntityChanged("todos", id)` | `{ type: "todos.changed", resource: "todos", action: "changed", id }` |
| `publishDeleted("todos", id)` | `{ type: "todos.deleted", resource: "todos", action: "deleted", id }` |
| `publishSettingsChanged()` | `{ type: "settings.changed", resource: "settings", action: "changed" }` |

For records that belong to the signed-in user, use `ctx.userRealtime.publishChanged`, `publishEntityChanged`, `publishDeleted`, or `publishSettingsChanged`. These helpers target only websocket connections authenticated as that user, so other users do not receive entity ids or timing signals.

Frontend code can refresh declaratively:

```tsx
useRealtimeRefresh({
  resources: ["todos", "notes"],
  refresh: () => refreshData(),
});
```

Or combine initial loading and realtime refresh:

```tsx
import { appJson, useLiveQuery } from "@pablozaiden/webapp/web";

type Todo = { id: string; title: string };

const { data: todos } = useLiveQuery<Todo[]>({
  load: () => appJson<Todo[]>("/api/todos"),
  realtime: { resources: ["todos"] },
});
```

For targeted delivery, clients subscribe with filters and the server publishes to matching targets:

```tsx
useRealtimeRefresh({
  filters: { resource: "todos", scope: workspaceId },
  resources: ["todos"],
  scopes: [workspaceId],
  refresh,
});
```

```ts
ctx.realtime.publishEntityChanged("todos", todo.id, { scope: workspaceId });
```

Use scoped/global `ctx.realtime` for non-user scopes only when the server validates access to that scope. For per-user app data, prefer `ctx.userRealtime` instead of trusting a client-provided websocket filter.

## Server target matching

Standard event metadata is also the default websocket routing target. The server derives `resource`, `id`, and `scope` from the event, then merges any explicit `target` fields into that target. `userId` and custom dimensions such as `tenantId` narrow delivery without removing the event-derived fields. A target field whose value is `undefined` does not erase an inferred field.

The event metadata is authoritative for `resource`, `id`, and `scope`. Repeating one of those fields in `target` is allowed only when it has the same value; a conflicting value, or a target-only value that would make the event metadata inconsistent, throws before the event is serialized or sent. `ctx.userRealtime` always supplies the authenticated user's ID, even if a caller attempted to provide a different `userId`.

Websocket query filters are combined with the target using AND semantics. A socket must satisfy its authenticated user restriction and every defined filter field to receive the event. The `target` object is routing metadata and is not added to the event payload, so clients should select on the event's `resource`, `id`, and `scope` fields.

## Client refresh lifecycle

`useRealtime` and `useRealtimeRefresh` apply resource, action, ID, scope, type,
and predicate selectors before updating `lastEvent` or invoking event/refresh
callbacks. Rejected events do not cause an event-driven hook render and do not
replace the last accepted event. Selectors and callbacks stay current without
reconnecting the socket when their identity changes. Server-side `filters`
still control delivery; client-side selectors avoid unnecessary React work
for events that reach the browser.

Both hooks track the last accepted event by default. Set `trackLastEvent: false`
for callback-only consumers that do not render the event itself:

```tsx
type ChatDeltaEvent = {
  type: "chat.message.delta";
  chatId: string;
  delta: string;
};

useRealtime<ChatDeltaEvent>({
  types: ["chat.message.delta"],
  predicate: (event) => event.chatId === activeChatId,
  trackLastEvent: false,
  onEvent: applyChatDelta,
});
```

Matching events still invoke callbacks, but do not update event state in this
mode. Connection status remains reactive and reconnection behavior is unchanged.
Disabling tracking does not clear an event retained before the option changed;
a subscription started with tracking disabled has no `lastEvent`.

`useLiveQuery` keeps default tracking and also accepts this option in its
`realtime` configuration. Its authoritative data updates still render normally.
It combines the initial load with this refresh path:

```tsx
const query = useLiveQuery<Todo[]>({
  load: () => appJson<Todo[]>("/api/todos"),
  deps: [workspaceId],
  realtime: { resources: ["todos"], scopes: [workspaceId] },
});
```

The `load` callback is kept current without using its identity as a reload trigger. Automatic loads use normal React dependency semantics: only a value in `deps` changing starts a new load. Call `query.refresh()` for an explicit manual refresh.

Each started load has a generation. Only the newest generation can commit `data`, `error`, or the final `loading` state; an older promise that resolves or rejects later is ignored. Unmounting invalidates pending generations. Load failures are normalized to `Error` and remain available through `query.error`.

Realtime events are coalesced while work is active. At most one realtime load runs at a time, with one queued follow-up for a burst of additional matching events. The follow-up uses the latest loader and runs after active work settles, preventing an event burst from creating unbounded concurrent requests.

`ctx.realtime.publish(customEvent)` and `useRealtime({ onEvent })` still exist as low-level escape hatches. The hook reconnects with exponential backoff and uses the same origin as the page.
