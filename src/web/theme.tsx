import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_THEME_PREFERENCE, type ThemePreference } from "../contracts";
import { clientScopedStorageKey, getThemeStorageKey } from "./preferences";
import { readStorage, warnStorageIssue, writeStorage } from "./storage";
import { Select } from "./components";
import { useAsyncOperation } from "./async-operation";

const THEME_MEDIA_QUERY = "(prefers-color-scheme: dark)";
export type ResolvedTheme = "light" | "dark";
export interface WebAppThemeState {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference(preference: ThemePreference): void;
  savePreference(preference: ThemePreference): Promise<void>;
  loading: boolean;
  error?: Error;
  retry(): Promise<void>;
}

/** Optional app-owned server preference synchronization; no account or endpoint assumptions. */
export interface WebAppThemeAdapter {
  storageKey?: string;
  load(): Promise<ThemePreference>;
  save(preference: ThemePreference): Promise<void>;
}
const ThemeContext = createContext<WebAppThemeState | null>(null);
export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}
function readStoredPreference(key = clientScopedStorageKey(getThemeStorageKey())): ThemePreference {
  const result = readStorage(key);
  if (!result.ok || result.value === null) return DEFAULT_THEME_PREFERENCE;
  if (isThemePreference(result.value)) return result.value;
  warnStorageIssue(key, "invalid-value");
  return DEFAULT_THEME_PREFERENCE;
}
function readSystemTheme(): ResolvedTheme {
  return typeof window !== "undefined" && window.matchMedia?.(THEME_MEDIA_QUERY).matches ? "dark" : "light";
}
function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = preference === "system" ? readSystemTheme() : preference;
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.classList.toggle("dark", resolved === "dark");
    root.style.colorScheme = resolved;
    root.dataset["theme"] = preference;
    root.dataset["resolvedTheme"] = resolved;
  }
  return resolved;
}

/** Call after selecting preferences, before rendering, for the same early theme as React. */
export function initializeWebAppTheme(): void { applyTheme(readStoredPreference()); }
export function ThemeSelect({ id, disabled, onError }: { id?: string; disabled?: boolean; onError?: (error: Error) => void }) {
  const { preference, savePreference, loading } = useTheme();
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Error>();
  return <>
    <Select id={id} aria-label="Theme" value={preference} disabled={disabled || loading || saving}
      onChange={event => {
        const next = event.currentTarget.value;
        if (!isThemePreference(next)) return;
        setSaving(true);
        setFailure(undefined);
        void savePreference(next).catch(value => {
          const error = value instanceof Error ? value : new Error(String(value));
          setFailure(error);
          onError?.(error);
        }).finally(() => setSaving(false));
      }}>
      <option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option>
    </Select>
    {failure ? <small role="alert">{failure.message}</small> : null}
  </>;
}
export function useTheme(): WebAppThemeState {
  const state = useContext(ThemeContext);
  if (!state) throw new Error("useTheme requires ThemeProvider or WebAppRoot.");
  return state;
}

export function ThemeProvider({ children, adapter }: { children: ReactNode; adapter?: WebAppThemeAdapter }) {
  const key = adapter?.storageKey ?? clientScopedStorageKey(getThemeStorageKey());
  const [preference, setPreferenceState] = useState(() => readStoredPreference(key));
  const [systemTheme, setSystemTheme] = useState(readSystemTheme);
  const [error, setError] = useState<Error>();
  const { pending: loading, start, isCurrent, finish, invalidate } = useAsyncOperation();
  const resolvedTheme = preference === "system" ? systemTheme : preference;
  const commitPreference = useCallback((next: ThemePreference) => {
    if (!isThemePreference(next)) throw new TypeError("Invalid theme preference.");
    const result = writeStorage(key, next);
    if (!result.ok) throw result.error;
    setPreferenceState(next);
  }, [key]);
  const setPreference = useCallback((next: ThemePreference) => {
    invalidate();
    setError(undefined);
    commitPreference(next);
  }, [invalidate, commitPreference]);
  const retry = useCallback(async () => {
    if (!adapter) return;
    const token = start({ replace: true });
    if (!token) return;
    setError(undefined);
    try {
      const next = await adapter.load();
      if (isCurrent(token)) commitPreference(next);
    } catch (value) {
      if (isCurrent(token)) setError(value instanceof Error ? value : new Error(String(value)));
    } finally { finish(token); }
  }, [adapter, commitPreference, start, isCurrent, finish]);
  useEffect(() => {
    const query = window.matchMedia(THEME_MEDIA_QUERY);
    const update = () => setSystemTheme(query.matches ? "dark" : "light");
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    setPreferenceState(readStoredPreference(key));
    void retry();
    return invalidate;
  }, [key, retry, invalidate]);
  useLayoutEffect(() => { applyTheme(preference); }, [preference, resolvedTheme]);
  const savePreference = useCallback(async (next: ThemePreference) => {
    if (!isThemePreference(next)) throw new TypeError("Invalid theme preference.");
    const token = start({ replace: true });
    if (!token) return;
    setError(undefined);
    try {
      await adapter?.save(next);
      if (isCurrent(token)) commitPreference(next);
    } catch (value) {
      const failure = value instanceof Error ? value : new Error(String(value));
      if (isCurrent(token)) setError(failure);
      throw failure;
    } finally { finish(token); }
  }, [adapter, commitPreference, start, isCurrent, finish]);
  const state = useMemo<WebAppThemeState>(() => ({
    preference, resolvedTheme, setPreference, savePreference, loading, error, retry,
  }), [preference, resolvedTheme, setPreference, savePreference, loading, error, retry]);
  return <ThemeContext.Provider value={state}>{children}</ThemeContext.Provider>;
}
