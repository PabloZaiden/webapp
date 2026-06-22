# Realtime

Every server has a typed `RealtimeBus`. Apps should prefer the framework event convention:

```ts
type AppEvent = ResourceRealtimeEvent;

const routes = defineRoutes<AppEvent>({
  "/api/todos": {
    async POST(req, ctx) {
      const todo = await createTodo(req);
      ctx.realtime.publishEntityChanged("todos", todo.id);
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

Frontend code can refresh declaratively:

```tsx
useRealtimeRefresh({
  resources: ["todos", "notes"],
  refresh: () => refreshData(),
});
```

Or combine initial loading and realtime refresh:

```tsx
const todos = useLiveQuery({
  load: () => api<Todo[]>("/api/todos"),
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

`ctx.realtime.publish(customEvent)` and `useRealtime({ onEvent })` still exist as low-level escape hatches. The hook reconnects with exponential backoff and uses the same origin as the page.
