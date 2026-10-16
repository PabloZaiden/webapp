import { useCallback, useEffect, useRef, useState } from "react";
import { appWebSocketUrl } from "../api-client";
import { createLogger } from "../logger";
import { connectRealtime, type RealtimeStatus } from "./connection";

export type { RealtimeStatus } from "./connection";

const log = createLogger("webapp:realtime");

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

export interface UseRealtimeOptions<TEvent> extends RealtimeEventSelector<TEvent> {
  enabled?: boolean;
  path?: string;
  heartbeat?: boolean;
  filters?: Record<string, string | undefined>;
  onEvent?: (event: TEvent) => void;
  onOpen?: () => void | Promise<void>;
  trackLastEvent?: boolean;
}

export function useRealtime<TEvent>({
  enabled = true,
  path = "/api/ws",
  heartbeat = path === "/api/ws",
  filters,
  onEvent,
  onOpen,
  trackLastEvent = true,
  ...selector
}: UseRealtimeOptions<TEvent>) {
  const [status, setStatus] = useState<RealtimeStatus>("connecting");
  const [lastEvent, setLastEvent] = useState<TEvent>();
  const eventOptionsRef = useRef({ onEvent, onOpen, selector, trackLastEvent });
  eventOptionsRef.current = { onEvent, onOpen, selector, trackLastEvent };

  useEffect(() => {
    if (!enabled) {
      setStatus("closed");
      return;
    }
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters ?? {})) {
      if (value) params.set(key, value);
    }
    return connectRealtime({
      url: appWebSocketUrl(`${path}${params.size ? `?${params.toString()}` : ""}`),
      heartbeat,
      onStatus: setStatus,
      onOpen: () => {
        void (async () => {
          try {
            await eventOptionsRef.current.onOpen?.();
          } catch (error) {
            log.error("Realtime subscription recovery failed", { error: String(error) });
          }
        })();
      },
      onMessage: (data) => {
        if (
          typeof data !== "object" || data === null
          || !("type" in data) || data.type !== "event"
          || !("event" in data) || !data.event
        ) {
          return;
        }
        const event = data.event as TEvent;
        const options = eventOptionsRef.current;
        if (!realtimeEventMatches(event, options.selector)) {
          return;
        }
        if (options.trackLastEvent) {
          setLastEvent(event);
        }
        options.onEvent?.(event);
      },
    });
  }, [enabled, JSON.stringify(filters), path, heartbeat]);

  return { status, lastEvent };
}

export function useRealtimeRefresh<TEvent = ResourceRealtimeEvent>({
  refresh,
  enabled = true,
  path,
  heartbeat,
  filters,
  resources,
  actions,
  ids,
  scopes,
  types,
  predicate,
  onEvent,
  onOpen,
  trackLastEvent,
}: {
  refresh: (event: TEvent) => void | Promise<void>;
} & UseRealtimeOptions<TEvent>) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  return useRealtime<TEvent>({
    enabled,
    path,
    heartbeat,
    filters,
    resources,
    actions,
    ids,
    scopes,
    types,
    predicate,
    trackLastEvent,
    onOpen,
    onEvent: (event) => {
      onEvent?.(event);
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
  const loadRef = useRef(load);
  loadRef.current = load;

  type RefreshSource = "manual" | "realtime";
  const mountedRef = useRef(true);
  const nextGenerationRef = useRef(0);
  const currentGenerationRef = useRef(0);
  const activeGenerationsRef = useRef(new Set<number>());
  const realtimeInFlightRef = useRef(false);
  const realtimeQueuedRef = useRef(false);

  const startLoad = useCallback((source: RefreshSource): Promise<void> => {
    if (!mountedRef.current) return Promise.resolve();

    const generation = nextGenerationRef.current + 1;
    nextGenerationRef.current = generation;
    currentGenerationRef.current = generation;
    activeGenerationsRef.current.add(generation);
    if (source === "realtime") {
      realtimeInFlightRef.current = true;
      realtimeQueuedRef.current = false;
    }
    setLoading(true);

    return (async () => {
      try {
        const nextData = await loadRef.current();
        if (mountedRef.current && generation === currentGenerationRef.current) {
          setData(nextData);
          setError(undefined);
        }
      } catch (err) {
        if (mountedRef.current && generation === currentGenerationRef.current) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        const isCurrent = generation === currentGenerationRef.current;
        activeGenerationsRef.current.delete(generation);
        if (source === "realtime") {
          realtimeInFlightRef.current = false;
        }
        if (!mountedRef.current) return;
        if (realtimeQueuedRef.current && activeGenerationsRef.current.size === 0 && !realtimeInFlightRef.current) {
          realtimeQueuedRef.current = false;
          void startLoad("realtime");
        } else if (isCurrent && !realtimeQueuedRef.current) {
          setLoading(false);
        }
      }
    })();
  }, []);

  const refresh = useCallback(() => startLoad("manual"), [startLoad]);

  const requestRealtimeRefresh = useCallback(() => {
    if (!mountedRef.current) return;
    if (realtimeInFlightRef.current || activeGenerationsRef.current.size > 0) {
      realtimeQueuedRef.current = true;
      setLoading(true);
      return;
    }
    void startLoad("realtime");
  }, [startLoad]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      nextGenerationRef.current += 1;
      currentGenerationRef.current = nextGenerationRef.current;
      realtimeQueuedRef.current = false;
    };
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, ...deps]);

  const realtimeState = useRealtimeRefresh<TEvent>({
    ...(realtime === false ? {} : realtime),
    enabled: realtime !== false,
    refresh: requestRealtimeRefresh,
    onOpen: () => {
      requestRealtimeRefresh();
      return realtime === false ? undefined : realtime?.onOpen?.();
    },
  });

  return { data, error, loading, refresh, realtimeStatus: realtimeState.status, lastEvent: realtimeState.lastEvent };
}
