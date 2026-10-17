import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DEFAULT_THEME_PREFERENCE, type ThemePreference } from "../contracts";
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
  savePreference: (preference: ThemePreference) => Promise<void>;
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
    return { preference: DEFAULT_THEME_PREFERENCE, valid: true };
  }
  return isThemePreference(value)
    ? { preference: value, valid: true }
    : { preference: DEFAULT_THEME_PREFERENCE, valid: false };
}

function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") {
    return DEFAULT_THEME_PREFERENCE;
  }

  const result = readStorage(THEME_STORAGE_KEY);
  if (!result.ok) {
    return DEFAULT_THEME_PREFERENCE;
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
  const preferenceRef = useRef(preference);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(readSystemTheme);
  const [error, setError] = useState<Error>();
  const {
    pending: loading,
    start: startLoad,
    isCurrent: isLoadCurrent,
    finish: finishLoad,
    invalidate: invalidateLoad,
  } = useAsyncOperation();
  const {
    start: startSave,
    isCurrent: isSaveCurrent,
    finish: finishSave,
    invalidate: invalidateSave,
  } = useAsyncOperation({ abortOnUnmount: false });
  const commitPreference = useCallback((nextPreference: ThemePreference) => {
    preferenceRef.current = nextPreference;
    setPreferenceState(nextPreference);
  }, []);

  useLayoutEffect(() => {
    invalidateSave();
    return invalidateSave;
  }, [invalidateSave, userId]);

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
    invalidateSave();
    commitPreference(nextPreference);
  }, [commitPreference, invalidateLoad, invalidateSave]);

  const savePreference = useCallback(async (nextPreference: ThemePreference) => {
    const previous = preferenceRef.current;
    setPreference(nextPreference);
    if (!userId) return;
    const token = startSave({ replace: true });
    if (!token) throw new Error("Theme preferences are no longer available.");
    try {
      await appJson("/api/preferences/theme", { method: "PUT", body: JSON.stringify({ theme: nextPreference }) });
    } catch (value) {
      if (isSaveCurrent(token)) commitPreference(previous);
      throw value;
    } finally {
      finishSave(token);
    }
  }, [commitPreference, finishSave, isSaveCurrent, setPreference, startSave, userId]);

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
    writeStorage(THEME_STORAGE_KEY, preference);
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
      commitPreference(parseThemeResponse(response));
    } catch (value) {
      if (isLoadCurrent(token)) {
        setError(toError(value));
      }
    } finally {
      finishLoad(token);
    }
  }, [commitPreference, finishLoad, invalidateLoad, isLoadCurrent, startLoad, userId]);

  useEffect(() => {
    void retry();
  }, [retry]);

  const state = useMemo<WebAppThemeState>(() => ({
    preference,
    resolvedTheme,
    setPreference,
    savePreference,
    loading,
    error,
    retry,
  }), [error, loading, preference, resolvedTheme, retry, savePreference, setPreference]);

  return <ThemeContext.Provider value={state}>{children}</ThemeContext.Provider>;
}
