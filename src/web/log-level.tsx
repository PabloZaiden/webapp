import { refreshWebAppRuntime, useWebAppRuntime } from "./runtime";
import type { LogLevelName } from "../contracts";

export interface WebAppLogLevelState {
  level: LogLevelName;
  fromEnv: boolean;
  loading: boolean;
  error?: Error;
  retry(): Promise<void>;
}
export function useLogLevel(): WebAppLogLevelState {
  const snapshot = useWebAppRuntime();
  return {
    level: snapshot.logLevel, fromEnv: snapshot.logLevelFromEnv ?? false,
    loading: !snapshot.ready, error: snapshot.error, retry: refreshWebAppRuntime,
  };
}
