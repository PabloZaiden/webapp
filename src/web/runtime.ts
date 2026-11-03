import { useSyncExternalStore } from "react";
import { DEFAULT_LOG_LEVEL, VALID_LOG_LEVELS, type LogLevelName } from "../contracts";

export interface WebAppRuntimeSnapshot {
  /** Local cache/preference namespace, not an authorization claim. */
  readonly scope: string;
  readonly generation: number;
  readonly ready: boolean;
  readonly error?: Error;
  readonly logLevel: LogLevelName;
  readonly logLevelFromEnv?: boolean;
}

export interface WebAppClientRuntime {
  getSnapshot(): WebAppRuntimeSnapshot;
  subscribe(listener: () => void): () => void;
  refresh?(): Promise<void>;
}

const initial: WebAppRuntimeSnapshot = { scope: "", generation: 0, ready: true, logLevel: DEFAULT_LOG_LEVEL };
let runtime: WebAppClientRuntime = { getSnapshot: () => initial, subscribe: () => () => {} };
let unsubscribe: (() => void) | undefined;
const listeners = new Set<() => void>();

export function getWebAppRuntimeSnapshot(): WebAppRuntimeSnapshot {
  const value = runtime.getSnapshot();
  if (typeof value.scope !== "string" || !Number.isSafeInteger(value.generation) || value.generation < 0
    || typeof value.ready !== "boolean" || !VALID_LOG_LEVELS.includes(value.logLevel)
    || (value.error !== undefined && !(value.error instanceof Error))
    || (value.logLevelFromEnv !== undefined && typeof value.logLevelFromEnv !== "boolean")) throw new TypeError("Invalid webapp runtime snapshot.");
  return value;
}

export function subscribeWebAppRuntime(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function configureWebAppRuntime(next: WebAppClientRuntime): void {
  unsubscribe?.();
  runtime = next;
  getWebAppRuntimeSnapshot();
  const notify = () => { for (const listener of listeners) listener(); };
  unsubscribe = next.subscribe(notify);
  notify();
}

export async function refreshWebAppRuntime(): Promise<void> { await runtime.refresh?.(); }

export function useWebAppRuntime(): WebAppRuntimeSnapshot {
  return useSyncExternalStore(subscribeWebAppRuntime, getWebAppRuntimeSnapshot, getWebAppRuntimeSnapshot);
}
