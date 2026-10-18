import { appWebSocketUrl, onAuthRequired } from "../api-client";
import { createRealtimeRuntime, type RealtimeRuntime } from "./connection";
import { useSyncExternalStore } from "react";

let runtime: RealtimeRuntime | undefined;
let currentUrl: string | undefined;
let identity: string | undefined;
let session = { generation: 0, ready: true };
const listeners = new Set<() => void>();
function notify(ready: boolean): void {
  session = { generation: session.generation + 1, ready };
  for (const listener of listeners) listener();
}
export function resetRealtimeRuntime(): void {
  runtime?.dispose();
  runtime = undefined;
  currentUrl = undefined;
}
onAuthRequired(() => {
  resetRealtimeRuntime();
  identity = undefined;
  notify(false);
});

export function setRealtimeIdentity(next: string | undefined): void {
  const ready = next !== undefined;
  if (next === identity && session.ready === ready) return;
  identity = next;
  resetRealtimeRuntime();
  notify(ready);
}

export function useRealtimeSession() {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => session,
    () => session,
  );
}

export function sharedRealtimeRuntime(): RealtimeRuntime {
  const url = appWebSocketUrl("/api/ws");
  if (runtime && url !== currentUrl) {
    resetRealtimeRuntime();
    notify(session.ready);
  }
  currentUrl = url;
  return runtime ??= createRealtimeRuntime({ url });
}
