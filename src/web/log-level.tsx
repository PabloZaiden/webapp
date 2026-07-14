import { useMemo } from "react";
import type { LogLevelName } from "../contracts";
import { useWebAppConfig } from "./webapp-config";

export interface WebAppLogLevelState {
  level?: LogLevelName;
  fromEnv?: boolean;
  loading: boolean;
  error?: Error;
  retry: () => Promise<void>;
}

export function useLogLevel(): WebAppLogLevelState {
  const { config, loading, error, refresh } = useWebAppConfig("useLogLevel");
  return useMemo(() => ({
    level: config?.logLevel.level,
    fromEnv: config?.logLevel.fromEnv,
    loading,
    error,
    retry: refresh,
  }), [config?.logLevel.fromEnv, config?.logLevel.level, error, loading, refresh]);
}
