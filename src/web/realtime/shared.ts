import { appPath, appWebSocketUrl, onAuthRequired } from "../api-client";
import { onNetworkFailure } from "../network-failures";
import { createRealtimeRuntime, type RealtimeRuntime } from "./connection";
import { useSyncExternalStore } from "react";

let runtime: RealtimeRuntime | undefined;
let currentUrl: string | undefined;
let currentPath: string | undefined;
let identity: string | undefined;
let session = { generation: 0, ready: false };
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
onAuthRequired(() => setRealtimeIdentity(undefined));
onNetworkFailure((request, error) => {
  if (new URL(request.url).origin !== new URL(appPath("/api/config")).origin) return;
  // Suspend reads before their rejection can become a per-resource error.
  runtime?.recoverFromNetworkFailure(error);
});

export function setRealtimeIdentity(next: string | undefined, path?: string): void {
  const ready = next !== undefined && path !== undefined;
  if (next === identity && path === currentPath && session.ready === ready) return;
  identity = next;
  currentPath = path;
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
  if (!session.ready || currentPath === undefined) {
    throw new Error("Realtime configuration is not ready.");
  }
  const url = appWebSocketUrl(currentPath);
  if (runtime && url !== currentUrl) {
    resetRealtimeRuntime();
    notify(session.ready);
  }
  currentUrl = url;
  return runtime ??= createRealtimeRuntime({ url });
}
