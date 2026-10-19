import { useEffect, useRef, useState } from "react";
import { createLiveQueryController, type LiveQueryState } from "./query-controller";
import { useRealtime, type ResourceRealtimeEvent, type UseRealtimeOptions } from "./useRealtime";
import { useRealtimeSession } from "./shared";

export function useLiveQuery<TData, TEvent = ResourceRealtimeEvent>({
  load, initialData, deps = [], realtime,
}: {
  load: (signal: AbortSignal, previous?: TData) => Promise<TData>;
  initialData?: TData;
  deps?: readonly unknown[];
  realtime?: false | UseRealtimeOptions<TEvent>;
}) {
  const [state, setState] = useState<LiveQueryState<TData>>({ data: initialData, loading: initialData === undefined });
  const latest = useRef({ load, realtime });
  latest.current = { load, realtime };
  const realtimeEnabled = Boolean(realtime && realtime.enabled !== false);
  const session = useRealtimeSession();
  const owner = useRef<ReturnType<typeof createLiveQueryController<TData>> | null>(null);
  owner.current ??= createLiveQueryController<TData>({
    load: (signal, previous) => latest.current.load(signal, previous),
    initialData,
    onChange: setState,
    onError: error => {
      const options = latest.current.realtime;
      if (options) options.onError?.(error);
    },
  });
  const controller = owner.current;
  const subscribed = useRef(false);
  const reset = useRef(false);
  const initial = useRef(initialData);
  initial.current = initialData;
  useEffect(() => {
    if (reset.current) {
      // Query identity changed: never reconcile another route's data into this projection.
      controller.reset(initial.current);
    }
    if (realtimeEnabled && !session.ready) return () => controller.deactivate();
    controller.prepare();
    if (!realtimeEnabled || subscribed.current) {
      void controller.activate();
    }
    reset.current = true;
    return () => controller.deactivate();
  }, [controller, realtimeEnabled, session, ...deps]);
  const connection = useRealtime<TEvent>({
    ...(realtime || {}),
    enabled: realtimeEnabled,
    onSubscribed: async activation => {
      subscribed.current = true;
      const recovered = controller.activate();
      const options = latest.current.realtime;
      await (options && options.onSubscribed?.(activation));
      await recovered;
    },
    onStatus: status => {
      if (status !== "open" && realtimeEnabled) {
        subscribed.current = false;
        controller.suspend();
      }
      const options = latest.current.realtime;
      if (options) options.onStatus?.(status);
    },
    onEvent: event => {
      const options = latest.current.realtime;
      try {
        if (options) options.onEvent?.(event);
      } finally {
        void controller.invalidate();
      }
    },
  });
  return { ...state, error: state.error ?? connection.error, refresh: controller.invalidate, mutate: controller.mutate, realtimeStatus: connection.status, lastEvent: connection.lastEvent };
}
