import { useCallback, useEffect, useRef, useState } from "react";

export type RealtimeStatus = "connecting" | "open" | "closed";
export type RealtimeAction = "created" | "updated" | "changed" | "deleted";

export interface ResourceRealtimeEvent<TPayload = unknown> {
  type: `${string}.${RealtimeAction}`;
  resource: string;
  action: RealtimeAction;
  id?: string;
  scope?: string;
  payload?: TPayload;
}

export interface RealtimeEventSelector<TEvent = ResourceRealtimeEvent> {
  resources?: string[];
  actions?: RealtimeAction[];
  ids?: string[];
  scopes?: string[];
  types?: string[];
  predicate?: (event: TEvent) => boolean;
}

function eventField(event: unknown, key: "type" | "resource" | "action" | "id" | "scope"): string | undefined {
  return typeof event === "object" && event !== null && key in event ? String((event as Record<string, unknown>)[key] ?? "") || undefined : undefined;
}

export function realtimeEventMatches<TEvent>(event: TEvent, selector?: RealtimeEventSelector<TEvent>): boolean {
  if (!selector) return true;
  const type = eventField(event, "type");
  const resource = eventField(event, "resource");
  const action = eventField(event, "action");
  const id = eventField(event, "id");
  const scope = eventField(event, "scope");
  if (selector.types?.length && (!type || !selector.types.includes(type))) return false;
  if (selector.resources?.length && (!resource || !selector.resources.includes(resource))) return false;
  if (selector.actions?.length && (!action || !selector.actions.includes(action as RealtimeAction))) return false;
  if (selector.ids?.length && (!id || !selector.ids.includes(id))) return false;
  if (selector.scopes?.length && (!scope || !selector.scopes.includes(scope))) return false;
  return selector.predicate?.(event) ?? true;
}

export function useRealtime<TEvent>({
  enabled = true,
  path = "/api/ws",
  filters,
  onEvent,
}: {
  enabled?: boolean;
  path?: string;
  filters?: Record<string, string | undefined>;
  onEvent?: (event: TEvent) => void;
}) {
  const [status, setStatus] = useState<RealtimeStatus>("connecting");
  const [lastEvent, setLastEvent] = useState<TEvent>();
  const retryRef = useRef(0);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled) {
      setStatus("closed");
      return;
    }
    let closed = false;
    let socket: WebSocket | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    function connect() {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filters ?? {})) {
        if (value) params.set(key, value);
      }
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}${path}${params.size ? `?${params.toString()}` : ""}`);
      setStatus("connecting");
      socket.onopen = () => {
        retryRef.current = 0;
        setStatus("open");
      };
      socket.onmessage = (message) => {
        try {
          const data = JSON.parse(String(message.data)) as { type: string; event?: TEvent };
          if (data.type === "event" && data.event) {
            setLastEvent(data.event);
            onEventRef.current?.(data.event);
          }
        } catch {
          // Ignore malformed realtime payloads from old clients/servers.
        }
      };
      socket.onclose = () => {
        setStatus("closed");
        if (!closed) {
          const delay = Math.min(1000 * 2 ** retryRef.current, 10000);
          retryRef.current += 1;
          timeout = setTimeout(connect, delay);
        }
      };
    }

    connect();
    return () => {
      closed = true;
      if (timeout) clearTimeout(timeout);
      socket?.close();
    };
  }, [enabled, JSON.stringify(filters), path]);

  return { status, lastEvent };
}

export function useRealtimeRefresh<TEvent = ResourceRealtimeEvent>({
  refresh,
  enabled = true,
  path,
  filters,
  resources,
  actions,
  ids,
  scopes,
  types,
  predicate,
  onEvent,
}: {
  refresh: (event: TEvent) => void | Promise<void>;
  enabled?: boolean;
  path?: string;
  filters?: Record<string, string | undefined>;
  onEvent?: (event: TEvent) => void;
} & RealtimeEventSelector<TEvent>) {
  const refreshRef = useRef(refresh);
  const onEventRef = useRef(onEvent);
  refreshRef.current = refresh;
  onEventRef.current = onEvent;
  const selector = { resources, actions, ids, scopes, types, predicate } satisfies RealtimeEventSelector<TEvent>;

  return useRealtime<TEvent>({
    enabled,
    path,
    filters,
    onEvent: (event) => {
      if (!realtimeEventMatches(event, selector)) return;
      onEventRef.current?.(event);
      void refreshRef.current(event);
    },
  });
}

export function useLiveQuery<TData, TEvent = ResourceRealtimeEvent>({
  load,
  initialData,
  deps = [],
  realtime,
}: {
  load: () => Promise<TData>;
  initialData?: TData;
  deps?: readonly unknown[];
  realtime?: false | Omit<Parameters<typeof useRealtimeRefresh<TEvent>>[0], "refresh">;
}) {
  const [data, setData] = useState<TData | undefined>(initialData);
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(initialData === undefined);
  const depsKey = JSON.stringify(deps);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await load());
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [load, depsKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const realtimeState = useRealtimeRefresh<TEvent>({
    ...(realtime === false ? {} : realtime),
    enabled: realtime !== false,
    refresh: () => void refresh(),
  });

  return { data, error, loading, refresh, realtimeStatus: realtimeState.status, lastEvent: realtimeState.lastEvent };
}
