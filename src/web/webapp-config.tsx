import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { VALID_LOG_LEVELS, type WebAppConfigResponse } from "../contracts";
import { appJson } from "./api-client";

export interface WebAppConfigState {
  config?: WebAppConfigResponse;
  loading: boolean;
  error?: Error;
  refresh: () => Promise<void>;
}

const WebAppConfigContext = createContext<WebAppConfigState | null>(null);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLogLevelName(value: unknown): boolean {
  return typeof value === "string" && VALID_LOG_LEVELS.includes(value as WebAppConfigResponse["logLevel"]["level"]);
}

function isCurrentUser(value: unknown): boolean {
  return isRecord(value)
    && typeof value["id"] === "string"
    && typeof value["username"] === "string"
    && (value["role"] === "owner" || value["role"] === "admin" || value["role"] === "user")
    && typeof value["isOwner"] === "boolean"
    && typeof value["isAdmin"] === "boolean";
}

function hasBooleanFields(value: unknown, fields: readonly string[]): boolean {
  return isRecord(value) && fields.every((field) => typeof value[field] === "boolean");
}

function isWebAppConfigResponse(value: unknown): value is WebAppConfigResponse {
  return isRecord(value)
    && typeof value["appName"] === "string"
    && typeof value["version"] === "string"
    && (value["currentUser"] === undefined || isCurrentUser(value["currentUser"]))
    && hasBooleanFields(value["passkeyAuth"], [
      "enabled",
      "passkeyConfigured",
      "passkeyDisabled",
      "passkeyRequired",
      "authenticated",
      "bootstrapRequired",
      "ownerPasskeySetupRequired",
    ])
    && hasBooleanFields(value["userManagement"], ["enabled", "canManageUsers"])
    && isRecord(value["logLevel"])
    && isLogLevelName(value["logLevel"]["level"])
    && typeof value["logLevel"]["fromEnv"] === "boolean"
    && hasBooleanFields(value["inMemoryLogs"], ["enabled"])
    && hasBooleanFields(value["deviceAuth"], ["enabled"])
    && hasBooleanFields(value["apiKeys"], ["enabled"]);
}

export function parseWebAppConfigResponse(value: unknown): WebAppConfigResponse {
  if (!isWebAppConfigResponse(value)) {
    throw new Error("Web app configuration response was invalid.");
  }
  return value;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function useWebAppConfig(consumer = "useWebAppConfig"): WebAppConfigState {
  const context = useContext(WebAppConfigContext);
  if (!context) {
    throw new Error(`${consumer} must be used within the framework WebAppRoot.`);
  }
  return context;
}

export function WebAppConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<WebAppConfigResponse>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error>();
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setError(undefined);

    try {
      const response = parseWebAppConfigResponse(await appJson<unknown>("/api/config"));
      if (requestId !== requestIdRef.current) {
        return;
      }
      setConfig(response);
    } catch (value) {
      if (requestId === requestIdRef.current) {
        setError(toError(value));
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const state = useMemo<WebAppConfigState>(() => ({
    config,
    loading,
    error,
    refresh,
  }), [config, error, loading, refresh]);

  return <WebAppConfigContext.Provider value={state}>{children}</WebAppConfigContext.Provider>;
}
