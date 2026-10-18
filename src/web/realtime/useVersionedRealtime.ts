import { useEffect, useRef, useState } from "react";
import { useRealtime, type UseRealtimeOptions } from "./useRealtime";
import { createVersionedSyncController, type VersionedSyncOptions, type VersionedSyncState } from "./versioned-sync";

export function useVersionedRealtime<TData, TEvent>(
  options: UseRealtimeOptions<TEvent> & Omit<VersionedSyncOptions<TData, TEvent>, "onChange">,
) {
  const latest = useRef(options);
  latest.current = options;
  const [state, setState] = useState<VersionedSyncState<TData>>({ status: "idle" });
  const controller = useRef<ReturnType<typeof createVersionedSyncController<TData, TEvent>> | null>(null);
  controller.current ??= createVersionedSyncController<TData, TEvent>({
    load: input => latest.current.load(input),
    version: event => latest.current.version(event),
    reduce: (data, event) => latest.current.reduce(data, event),
    onChange: setState,
    maxBufferedEvents: options.maxBufferedEvents,
    maxBufferedBytes: options.maxBufferedBytes,
  });
  const owner = controller.current;
  const realtime = useRealtime<TEvent>({
    ...options,
    onSubscribed: activation => {
      owner.activate(activation);
      return latest.current.onSubscribed?.(activation);
    },
    onStatus: status => {
      if (status !== "open") owner.deactivate();
      latest.current.onStatus?.(status);
    },
    onEvent: event => {
      owner.receive(event);
      latest.current.onEvent?.(event);
    },
  });
  useEffect(() => () => owner.deactivate(), [owner]);
  return { ...state, error: state.error ?? realtime.error, refresh: owner.refresh, realtimeStatus: realtime.status };
}
