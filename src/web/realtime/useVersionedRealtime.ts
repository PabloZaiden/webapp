import { useEffect, useMemo, useRef, useState } from "react";
import { useRealtime, type UseRealtimeOptions } from "./useRealtime";
import { useRealtimeSession } from "./shared";
import { createVersionedSyncController, type VersionedSyncOptions, type VersionedSyncState } from "./versioned-sync";

export type UseVersionedRealtimeOptions<TData, TEvent> =
  UseRealtimeOptions<TEvent> & Omit<VersionedSyncOptions<TData, TEvent>, "onChange">;

export function useVersionedRealtime<TData, TEvent>(options: UseVersionedRealtimeOptions<TData, TEvent>) {
  type Controller = ReturnType<typeof createVersionedSyncController<TData, TEvent>>;
  const latest = useRef(options);
  latest.current = options;
  const session = useRealtimeSession();
  const [result, setResult] = useState<{ owner: Controller; state: VersionedSyncState<TData> }>();
  const [failure, setFailure] = useState<{ owner: Controller; error: Error }>();
  const owner = useMemo(() => {
    const controller = createVersionedSyncController<TData, TEvent>({
      load: input => latest.current.load(input),
      version: event => latest.current.version(event),
      reduce: (data, event) => latest.current.reduce(data, event),
      onChange: state => setResult({ owner: controller, state }),
      maxBufferedEvents: options.maxBufferedEvents,
      maxBufferedBytes: options.maxBufferedBytes,
    });
    return controller;
  }, [session, ...(options.deps ?? [])]);
  const realtime = useRealtime<TEvent>({
    ...options,
    onSubscribed: activation => {
      setFailure(undefined);
      owner.activate(activation);
      return latest.current.onSubscribed?.(activation);
    },
    onStatus: status => {
      if (status !== "open") owner.deactivate();
      latest.current.onStatus?.(status);
    },
    onError: error => {
      setFailure({ owner, error });
      latest.current.onError?.(error);
    },
    onEvent: event => {
      owner.receive(event);
      latest.current.onEvent?.(event);
    },
  });
  useEffect(() => () => owner.deactivate(), [owner]);
  const state: VersionedSyncState<TData> = result?.owner === owner ? result.state : { status: "idle" };
  const error = state.error ?? (failure?.owner === owner ? failure.error : undefined);
  return { ...state, error, refresh: owner.refresh, realtimeStatus: realtime.status };
}
