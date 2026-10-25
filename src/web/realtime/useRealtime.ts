import { useEffect, useRef, useState } from "react";
import {
  realtimeInterestMatches, realtimeInterestSchema,
  type RealtimeAction, type RealtimeInterest, type RealtimeKind, type ResourceRealtimeEvent,
} from "../../contracts/realtime";
import type { RealtimeActivation, RealtimeStatus } from "./connection";
import { sharedRealtimeRuntime, useRealtimeSession } from "./shared";

export type { RealtimeAction, RealtimeKind, ResourceRealtimeEvent } from "../../contracts/realtime";
export type { RealtimeActivation, RealtimeStatus } from "./connection";
export { useRealtimeRefresh } from "./useRealtimeRefresh";
export { useLiveQuery } from "./useLiveQuery";
export { useVersionedRealtime } from "./useVersionedRealtime";
export type { UseVersionedRealtimeOptions } from "./useVersionedRealtime";
export { createVersionedSyncController, RealtimeResyncRequiredError } from "./versioned-sync";
export type { VersionedSnapshot, RealtimeDeltaVersion, VersionedSyncState, VersionedSyncOptions } from "./versioned-sync";
export { createRealtimeRuntime, RealtimeRuntime } from "./connection";
export type { RealtimeSource, RealtimeSubscriber } from "./connection";
export { createLiveQueryController } from "./query-controller";
export type { LiveQueryState, LiveQueryControllerOptions } from "./query-controller";

export interface RealtimeEventSelector<TEvent = ResourceRealtimeEvent> {
  resources?: string[];
  actions?: RealtimeAction[];
  ids?: string[];
  scopes?: string[];
  types?: string[];
  kinds?: RealtimeKind[];
  targets?: Record<string, string | string[] | undefined>;
  predicate?: (event: TEvent) => boolean;
}
function toRealtimeInterest<TEvent>(options: RealtimeEventSelector<TEvent>): RealtimeInterest {
  const targets = Object.fromEntries(Object.entries(options.targets ?? {}).filter((entry): entry is [string, string | string[]] => entry[1] !== undefined));
  return {
    kinds: options.kinds ?? (options.resources ? ["state"] : ["content", "action"]),
    resources: options.resources, actions: options.actions, ids: options.ids,
    scopes: options.scopes, types: options.types,
    ...(Object.keys(targets).length ? { targets } : {}),
  };
}
export function realtimeEventMatches<TEvent>(
  event: TEvent,
  selector: RealtimeEventSelector<TEvent> | undefined,
  routing: { kind: RealtimeKind; target: Record<string, string | undefined> },
): boolean {
  if (!selector) return true;
  return realtimeInterestMatches(toRealtimeInterest(selector), routing.kind, event, routing.target)
    && (selector.predicate?.(event) ?? true);
}
export interface UseRealtimeOptions<TEvent> extends RealtimeEventSelector<TEvent> {
  deps?: readonly unknown[];
  enabled?: boolean;
  onEvent?: (event: TEvent) => void;
  onSubscribed?: (activation: RealtimeActivation) => void | Promise<void>;
  onStatus?: (status: RealtimeStatus) => void;
  onError?: (error: Error) => void;
  trackLastEvent?: boolean;
}

export function useRealtime<TEvent = ResourceRealtimeEvent>(options: UseRealtimeOptions<TEvent>) {
  const [status, setStatus] = useState<RealtimeStatus>("connecting");
  const [lastEvent, setLastEvent] = useState<TEvent>();
  const [error, setError] = useState<Error>();
  const latest = useRef(options);
  latest.current = options;
  const session = useRealtimeSession();
  const key = JSON.stringify(toRealtimeInterest(options));
  const enabled = options.enabled !== false;
  useEffect(() => {
    const report = (value: unknown): void => {
      const next = value instanceof Error ? value : new Error(String(value));
      setError(next);
      latest.current.onError?.(next);
    };
    const changeStatus = (next: RealtimeStatus): void => {
      setStatus(next);
      latest.current.onStatus?.(next);
    };
    setLastEvent(undefined);
    setError(undefined);
    if (!enabled || !session.ready) {
      changeStatus("closed");
      return;
    }
    const parsed = realtimeInterestSchema.safeParse(JSON.parse(key));
    if (!parsed.success) {
      changeStatus("closed");
      report(new Error(`Invalid realtime interest: ${parsed.error.message}`));
      return;
    }
    const unsubscribe = sharedRealtimeRuntime().subscribe<TEvent>({
      interest: parsed.data,
      onStatus: changeStatus,
      onError: report,
      onSubscribed: activation => {
        setError(undefined);
        return latest.current.onSubscribed?.(activation);
      },
      onEvent: event => {
        if (!(latest.current.predicate?.(event) ?? true)) return;
        if (latest.current.trackLastEvent !== false) setLastEvent(event);
        latest.current.onEvent?.(event);
      },
    });
    return () => {
      unsubscribe();
      latest.current.onStatus?.("closed");
    };
  }, [enabled, key, session, ...(options.deps ?? [])]);
  return { status, lastEvent, error };
}
