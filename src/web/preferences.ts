import { getWebAppRuntimeSnapshot } from "./runtime";

export interface WebAppPreferenceAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface WebAppPreferenceOptions {
  adapter?: WebAppPreferenceAdapter;
  scope?: () => string;
  themeStorageKey?: string | (() => string);
}

function memoryAdapter(): WebAppPreferenceAdapter {
  const values = new Map<string, string>();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
  };
}

let options: WebAppPreferenceOptions = {};
let adapter = memoryAdapter();

export function configureWebAppPreferences(next: WebAppPreferenceOptions = {}): void {
  options = next;
  adapter = next.adapter ?? memoryAdapter();
}

/** Storage is accessed only when the application explicitly selects this adapter. */
export function createBrowserPreferenceAdapter(storage?: Storage): WebAppPreferenceAdapter {
  let selected: Storage;
  try {
    selected = storage ?? window.localStorage;
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "SecurityError") throw error;
    console.warn("[webapp] Browser preference storage is unavailable; using memory-only preferences.", error);
    return memoryAdapter();
  }
  return {
    getItem: key => selected.getItem(key),
    setItem: (key, value) => { selected.setItem(key, value); },
    removeItem: key => { selected.removeItem(key); },
  };
}

export function getWebAppPreferenceAdapter(): WebAppPreferenceAdapter { return adapter; }
export function getThemeStorageKey(): string {
  return typeof options.themeStorageKey === "function" ? options.themeStorageKey() : options.themeStorageKey ?? "webapp.theme";
}
export function getClientStorageScope(): string { return options.scope?.() ?? getWebAppRuntimeSnapshot().scope; }
export function clientScopedStorageKey(key: string): string {
  const scope = getClientStorageScope();
  return scope ? `${key}:client:${encodeURIComponent(scope)}` : key;
}
