import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ThemePreference } from "../contracts";
import { appJson } from "./api-client";
import { useAsyncOperation } from "./async-operation";
import { readStorage, warnStorageIssue, writeStorage } from "./storage";

const THEME_STORAGE_KEY = "webapp.theme";
const THEME_MEDIA_QUERY = "(prefers-color-scheme: dark)";

export type ResolvedTheme = "light" | "dark";

export interface WebAppThemeState {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
  loading: boolean;
  error?: Error;
  retry: () => Promise<void>;
}

const ThemeContext = createContext<WebAppThemeState | null>(null);

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ThemeStorageDecode = {
  preference: ThemePreference;
  valid: boolean;
};

function decodeStoredPreference(value: string | null): ThemeStorageDecode {
  if (value === null) {
    return { preference: "system", valid: true };
  }
  return isThemePreference(value)
    ? { preference: value, valid: true }
    : { preference: "system", valid: false };
}

function encodeStoredPreference(value: unknown): string | undefined {
  return isThemePreference(value) ? value : undefined;
}

function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") {
    return "system";
  }

  const result = readStorage(THEME_STORAGE_KEY);
  if (!result.ok) {
    return "system";
  }
  const decoded = decodeStoredPreference(result.value);
  if (!decoded.valid) {
    warnStorageIssue(THEME_STORAGE_KEY, "invalid-value");
  }
  return decoded.preference;
}

function readSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  return window.matchMedia(THEME_MEDIA_QUERY).matches ? "dark" : "light";
}

function parseThemeResponse(value: unknown): ThemePreference {
  if (!isRecord(value) || !isThemePreference(value["theme"])) {
    throw new Error("Theme preference response was invalid.");
  }
  return value["theme"];
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function useTheme(): WebAppThemeState {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within the framework WebAppRoot.");
  }
  return context;
}

export function ThemeProvider({ userId, children }: { userId?: string; children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(readSystemTheme);
  const [error, setError] = useState<Error>();
  const {
    pending: loading,
    start: startLoad,
    isCurrent: isLoadCurrent,
    finish: finishLoad,
    invalidate: invalidateLoad,
  } = useAsyncOperation();

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const query = window.matchMedia(THEME_MEDIA_QUERY);
    const sync = () => setSystemTheme(query.matches ? "dark" : "light");
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  const setPreference = useCallback((nextPreference: ThemePreference) => {
    if (!isThemePreference(nextPreference)) {
      throw new TypeError(`Unknown theme preference: ${String(nextPreference)}.`);
    }
    invalidateLoad();
    setPreferenceState(nextPreference);
  }, [invalidateLoad]);

  const resolvedTheme = preference === "system" ? systemTheme : preference;

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const root = document.documentElement;
    root.classList.toggle("dark", resolvedTheme === "dark");
    root.style.colorScheme = resolvedTheme;
    root.dataset["theme"] = preference;
    root.dataset["resolvedTheme"] = resolvedTheme;
    const encoded = encodeStoredPreference(preference);
    if (encoded === undefined) {
      warnStorageIssue(THEME_STORAGE_KEY, "write-failed");
      return;
    }
    writeStorage(THEME_STORAGE_KEY, encoded);
  }, [preference, resolvedTheme]);

  const retry = useCallback(async () => {
    if (!userId) {
      invalidateLoad();
      setError(undefined);
      return;
    }

    const token = startLoad({ replace: true });
    if (!token) {
      return;
    }
    setError(undefined);
    try {
      const response = await appJson<unknown>("/api/preferences/theme", { signal: token.signal });
      if (!isLoadCurrent(token)) {
        return;
      }
      setPreferenceState(parseThemeResponse(response));
    } catch (value) {
      if (isLoadCurrent(token)) {
        setError(toError(value));
      }
    } finally {
      finishLoad(token);
    }
  }, [finishLoad, invalidateLoad, isLoadCurrent, startLoad, userId]);

  useEffect(() => {
    void retry();
  }, [retry]);

  const state = useMemo<WebAppThemeState>(() => ({
    preference,
    resolvedTheme,
    setPreference,
    loading,
    error,
    retry,
  }), [error, loading, preference, resolvedTheme, retry, setPreference]);

  return <ThemeContext.Provider value={state}>{children}</ThemeContext.Provider>;
}
