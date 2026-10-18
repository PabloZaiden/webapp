import { useRef, useState } from "react";
import { createRefreshController } from "./refresh-controller";
import { useRealtime, type ResourceRealtimeEvent, type UseRealtimeOptions } from "./useRealtime";

export function useRealtimeRefresh<TEvent = ResourceRealtimeEvent>({
  refresh,
  ...options
}: UseRealtimeOptions<TEvent> & {
  refresh: (event?: TEvent, signal?: AbortSignal) => void | Promise<void>;
}) {
  const latest = useRef({ refresh, options });
  latest.current = { refresh, options };
  const [error, setError] = useState<Error>();
  const controller = useRef<ReturnType<typeof createRefreshController<TEvent>> | null>(null);
  controller.current ??= createRefreshController<TEvent>({
    refresh: async (event, signal) => {
      await latest.current.refresh(event, signal);
      if (!signal.aborted) setError(undefined);
    },
    onError: next => {
      setError(next);
      latest.current.options.onError?.(next);
    },
  });
  const owner = controller.current;
  const state = useRealtime<TEvent>({
    ...options,
    onSubscribed: async activation => {
      setError(undefined);
      const recovered = owner.activate();
      await latest.current.options.onSubscribed?.(activation);
      await recovered;
    },
    onStatus: status => {
      if (status !== "open") owner.deactivate();
      latest.current.options.onStatus?.(status);
    },
    onEvent: event => {
      try {
        latest.current.options.onEvent?.(event);
      } finally {
        void owner.invalidate(event);
      }
    },
  });
  return { ...state, error: error ?? state.error };
}
