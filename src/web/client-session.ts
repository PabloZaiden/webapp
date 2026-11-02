import { ClientAuthorizationError, authorizeClient, refreshClientCredentials, revokeClientCredentials } from "./client-auth";
import {
  browserClientCredentialStore, clientStorageKey, credentialsKey, readClientCredentials, withClientCredentialLock,
  type WebAppClientCredentials, type WebAppClientCredentialStore,
} from "./client-credentials";
import { readStorage, writeStorage } from "./storage";

export interface WebAppRemoteClientOptions {
  credentialStore?: WebAppClientCredentialStore;
  openAuthorizationUrl?: (url: string) => void | Promise<void>;
  resolveConnection?: (endpoint: string) => Promise<WebAppRemoteConnection>;
}

/** Separate initial account authorization from the authenticated API transport. */
export interface WebAppRemoteConnection {
  authorizationBaseUrl: string;
  apiBaseUrl: string;
  /** Stable authenticated destination binding, checked before reusing credentials. */
  identity?: string;
}

export interface WebAppClientSession {
  enabled: boolean;
  ready: boolean;
  endpoint?: string;
  authorizationEndpoint?: string;
  apiEndpoint?: string;
  authenticated: boolean;
  generation: number;
  error?: Error;
}

let state: WebAppClientSession = { enabled: false, ready: true, authenticated: false, generation: 0 };
let credentials: WebAppClientCredentials | undefined;
let store = browserClientCredentialStore;
let nativeOpen: WebAppRemoteClientOptions["openAuthorizationUrl"];
let resolveConnection: WebAppRemoteClientOptions["resolveConnection"];
let connection: WebAppRemoteConnection | undefined;
let hydration: Promise<void> | undefined;
let refresh: Promise<string> | undefined;
let login: AbortController | undefined;
let externalStorageScope: (() => string) | undefined;
const listeners = new Set<() => void>();

function update(change: Partial<WebAppClientSession>): void {
  state = { ...state, ...change };
  for (const listener of listeners) listener();
}

export function normalizeClientEndpoint(value: string): string {
  const url = new URL(value.trim());
  if (url.username || url.password || url.search || url.hash
    || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("Enter an HTTP(S) API URL without credentials, query or fragment.");
  }
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Remote API servers require HTTPS.");
  }
  return url.toString().replace(/\/+$/, "");
}

export function configureRemoteClient(defaultEndpoint?: string, options: WebAppRemoteClientOptions = {}): void {
  if (options.credentialStore) {
    if (hydration) throw new Error("Configure native credential storage before rendering the application.");
    store = options.credentialStore;
  }
  if (options.openAuthorizationUrl) nativeOpen = options.openAuthorizationUrl;
  if (options.resolveConnection) {
    if (hydration) throw new Error("Configure connection resolution before rendering the application.");
    resolveConnection = options.resolveConnection;
  }
  if (state.enabled) return;
  try {
    const saved = readStorage(clientStorageKey("endpoint"));
    if (!saved.ok) throw saved.error;
    const endpoint = saved.value ?? defaultEndpoint;
    update({ enabled: true, ready: false, endpoint: endpoint ? normalizeClientEndpoint(endpoint) : undefined });
  } catch (error) {
    update({ enabled: true, ready: true, error: error instanceof Error ? error : new Error(String(error)) });
  }
}

export function getClientSession(): WebAppClientSession { return state; }
function storageChanged(event: StorageEvent): void {
  if (event.storageArea !== window.localStorage) return;
  if (event.key === null || event.key === clientStorageKey("endpoint")) {
    window.location.reload();
    return;
  }
  const endpoint = state.endpoint;
  if (!endpoint || store !== browserClientCredentialStore || event.key !== credentialsKey(endpoint)) return;
  void readClientCredentials(store, endpoint).then(saved => {
    if (saved?.clientId !== credentials?.clientId) window.location.reload();
  }).catch(error => {
    credentials = undefined;
    update({ authenticated: false, generation: state.generation + 1, error: error instanceof Error ? error : new Error(String(error)) });
  });
}

export function subscribeClientSession(listener: () => void): () => void {
  if (!listeners.size && state.enabled) window.addEventListener("storage", storageChanged);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && state.enabled) window.removeEventListener("storage", storageChanged);
  };
}

export function getClientStorageScope(): string {
  if (externalStorageScope) return externalStorageScope();
  return state.enabled ? `${state.endpoint ?? ""}:${credentials?.clientId ?? ""}` : "";
}

export function configureExternalClientStorageScope(scope: () => string): void {
  if (state.enabled) throw new Error("A remote API session cannot also use an external client profile.");
  externalStorageScope = scope;
}

export function clientScopedStorageKey(key: string): string {
  const scope = getClientStorageScope();
  return scope ? `${key}:client:${encodeURIComponent(scope)}` : key;
}

export async function initializeClientSession(): Promise<void> {
  if (!state.enabled || state.ready) return;
  hydration ??= (async () => {
    const endpoint = state.endpoint;
    const generation = state.generation;
    try {
      const resolved = endpoint ? await resolveClientConnection(endpoint) : undefined;
      const saved = endpoint ? await readClientCredentials(store, endpoint) : undefined;
      if (state.generation !== generation) return;
      if (saved && saved.connectionIdentity !== resolved?.identity) {
        throw new Error("The selected connection belongs to a different server. Sign out or choose the server again.");
      }
      connection = resolved;
      credentials = saved;
      update({
        ready: true, authorizationEndpoint: resolved?.authorizationBaseUrl,
        apiEndpoint: resolved?.apiBaseUrl, authenticated: saved !== undefined, error: undefined,
      });
    } catch (error) {
      if (state.generation === generation) update({
        ready: true, error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  })();
  await hydration;
}

async function resolveClientConnection(endpoint: string): Promise<WebAppRemoteConnection> {
  const resolved = resolveConnection ? await resolveConnection(endpoint)
    : { authorizationBaseUrl: endpoint, apiBaseUrl: endpoint };
  if (resolved.identity !== undefined && (typeof resolved.identity !== "string" || !resolved.identity.trim())) {
    throw new Error("The connection returned an invalid server identity.");
  }
  return {
    authorizationBaseUrl: normalizeClientEndpoint(resolved.authorizationBaseUrl),
    apiBaseUrl: normalizeClientEndpoint(resolved.apiBaseUrl),
    ...(resolved.identity ? { identity: resolved.identity } : {}),
  };
}

export async function selectClientEndpoint(endpoint: string): Promise<void> {
  const normalized = normalizeClientEndpoint(endpoint);
  await resolveClientConnection(normalized);
  const previous = state.endpoint;
  if (previous) await withClientCredentialLock(previous, async () => { await store.remove(previous); });
  const result = writeStorage(clientStorageKey("endpoint"), normalized);
  if (!result.ok) throw result.error;
  login?.abort();
  // A fresh JavaScript context also retires application-owned caches and pending work.
  window.location.reload();
}

export function hasNativeAuthorizationBrowser(): boolean { return nativeOpen !== undefined; }

export async function loginClient(onVerification: (info: { url: string; code: string }) => void): Promise<void> {
  const endpoint = state.endpoint;
  if (!endpoint || !connection || !state.ready || state.error) throw new Error("Choose an available API server first.");
  login?.abort();
  const controller = new AbortController();
  login = controller;
  const generation = state.generation;
  try {
    const next = await authorizeClient({
      baseUrl: connection.authorizationBaseUrl,
      credentialBaseUrl: endpoint,
      connectionIdentity: connection.identity,
      signal: controller.signal,
      onVerification(info) {
        onVerification(info);
        if (nativeOpen) void Promise.resolve(nativeOpen(info.url)).catch(error => {
          controller.abort(new Error("Unable to open the authorization browser.", { cause: error }));
        });
      },
    });
    controller.signal.throwIfAborted();
    if (state.generation !== generation) throw new Error("The selected server changed during authorization.");
    await withClientCredentialLock(endpoint, async () => {
      controller.signal.throwIfAborted();
      if (state.generation !== generation) throw new Error("The selected server changed during authorization.");
      await store.write(next);
      if (controller.signal.aborted || state.generation !== generation) {
        await store.remove(endpoint);
        controller.signal.throwIfAborted();
        throw new Error("The selected server changed during authorization.");
      }
      credentials = next;
      update({ authenticated: true, generation: generation + 1, error: undefined });
    }, controller.signal);
  } finally {
    if (login === controller) login = undefined;
  }
}

export function cancelClientLogin(): void { login?.abort(); }

export async function logoutClient(): Promise<void> {
  const endpoint = state.endpoint;
  let previous = credentials;
  login?.abort();
  try {
    if (endpoint) await withClientCredentialLock(endpoint, async () => {
      previous = await readClientCredentials(store, endpoint) ?? previous;
      await store.remove(endpoint);
    });
    if (previous) {
      if (!connection) throw new Error("The selected connection is unavailable.");
      await revokeClientCredentials(previous, connection.apiBaseUrl);
    }
    window.location.reload();
  } catch (error) {
    credentials = undefined;
    update({ authenticated: false, generation: state.generation + 1, error: error instanceof Error ? error : new Error(String(error)) });
    throw error;
  }
}

export function invalidateClientSession(): void {
  credentials = undefined;
  update({ authenticated: false, generation: state.generation + 1 });
}

export async function clientAccessToken(rejectedToken?: string): Promise<string> {
  const current = credentials;
  if (!current || current.baseUrl !== state.endpoint) throw new Error("Sign in to the selected API server.");
  if (rejectedToken && current.accessToken !== rejectedToken) return current.accessToken;
  if (!rejectedToken && current.expiresAt > Date.now() + 15_000) return current.accessToken;
  refresh ??= refreshSession(current).finally(() => { refresh = undefined; });
  return await refresh;
}

async function refreshSession(previous: WebAppClientCredentials): Promise<string> {
  const generation = state.generation;
  const renew = async () => {
    if (!connection) throw new Error("The selected connection is unavailable.");
    const saved = await readClientCredentials(store, previous.baseUrl);
    if (!saved || saved.clientId !== previous.clientId) {
      throw new ClientAuthorizationError("The browser session changed. Sign in again.", "session_changed", 400);
    }
    const next = saved.accessToken !== previous.accessToken && saved.expiresAt > Date.now() + 15_000
      ? saved : await refreshClientCredentials(saved, connection.apiBaseUrl);
    if (state.generation !== generation || state.endpoint !== next.baseUrl) {
      throw new Error("The selected server changed while renewing authorization.");
    }
    await store.write(next);
    if (state.generation !== generation) {
      await store.remove(previous.baseUrl);
      throw new Error("The selected server changed while saving authorization.");
    }
    credentials = next;
    return next.accessToken;
  };
  try {
    return await withClientCredentialLock(previous.baseUrl, renew);
  } catch (error) {
    if (state.generation === generation && error instanceof ClientAuthorizationError
      && [400, 401].includes(error.status)) {
      await withClientCredentialLock(previous.baseUrl, async () => {
        const saved = await readClientCredentials(store, previous.baseUrl);
        if (saved?.clientId === previous.clientId) await store.remove(previous.baseUrl);
      });
      invalidateClientSession();
    }
    throw error;
  }
}
