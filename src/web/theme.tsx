import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ThemePreference } from "../contracts";
import { appJson } from "./api-client";

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

function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") {
    return "system";
  }

  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return isThemePreference(stored) ? stored : "system";
}

function readSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  return window.matchMedia(THEME_MEDIA_QUERY).matches ? "dark" : "light";
}

function parseThemeResponse(value: unknown): ThemePreference {
  if (!isRecord(value) || !isThemePreference(value.theme)) {
    throw new Error("Theme preference response was invalid.");
  }
  return value.theme;
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error>();
  const requestIdRef = useRef(0);

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
    setPreferenceState(nextPreference);
  }, []);

  const resolvedTheme = preference === "system" ? systemTheme : preference;

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const root = document.documentElement;
    root.classList.toggle("dark", resolvedTheme === "dark");
    root.style.colorScheme = resolvedTheme;
    root.dataset.theme = preference;
    root.dataset.resolvedTheme = resolvedTheme;
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  }, [preference, resolvedTheme]);

  const retry = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    if (!userId) {
      setLoading(false);
      setError(undefined);
      return;
    }

    setLoading(true);
    setError(undefined);
    try {
      const response = await appJson<unknown>("/api/preferences/theme");
      if (requestId !== requestIdRef.current) {
        return;
      }
      setPreference(parseThemeResponse(response));
    } catch (value) {
      if (requestId === requestIdRef.current) {
        setError(toError(value));
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [setPreference, userId]);

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
