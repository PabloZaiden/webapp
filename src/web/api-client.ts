import { fetchAppRequest } from "./network-failures";
import { readResponseMetadata, type PartialResultMetadata, type WebAppResponseMetadata } from "../contracts/response-metadata";
import type { WebAppDuplex, WebAppExternalClient, WebAppResourceUrl, WebAppSaveResourceOptions } from "./external-client";
import { validateExternalSession } from "./external-client";
import { nativeWebAppDuplex } from "./native-duplex";
import {
  configureWebAppRuntime, getWebAppRuntimeSnapshot, subscribeWebAppRuntime,
  type WebAppClientRuntime,
} from "./runtime";
import { setExternalRealtimeSource, setRealtimeIdentity } from "./realtime/shared";
import type { RealtimeSource } from "./realtime/source";
import { createLogger } from "./logger";

export class WebAppApiError extends Error {
  status: number;
  error?: string;
  details?: unknown;

  constructor(message: string, status: number, error?: string, details?: unknown) {
    super(message);
    this.name = "WebAppApiError";
    this.status = status;
    this.error = error;
    this.details = details;
  }
}

export type AuthRequiredListener = () => void;

export interface WebAppNativeResourceSaver {
  saveResource(resource: { url: string; suggestedName: string }): Promise<void>;
}

declare global {
  interface Window {
    webappNativeResourceSaver?: WebAppNativeResourceSaver;
  }
}

const authRequiredListeners = new Set<AuthRequiredListener>();
authRequiredListeners.add(() => setRealtimeIdentity(undefined));
let configuredPublicBasePath: string | undefined;
let configuredApiBaseUrl: string | undefined;
let configuredWebSocketBaseUrl: string | undefined;
let configuredPartialResults: PartialResultMetadata | undefined;
let configuredMode: "integrated" | "remote" | "external" = "integrated";
let configuredClientVersion: string | undefined;
let configuredConnectionPickerUrl: string | undefined;
let externalClient: WebAppExternalClient | undefined;
let transport: WebAppClientOptions = {};
let realtimePath: string | false = "/api/ws";
let sessionAbort = new AbortController();
let activeSessionKey = "";
const ABSOLUTE_URL_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;

export interface WebAppClientOptions {
  publicBasePath?: string | null;
  apiBaseUrl?: string | null;
  wsBaseUrl?: string | null;
  partialResults?: PartialResultMetadata;
  mode?: "integrated" | "remote" | "external";
  external?: WebAppExternalClient;
  version?: string;
  connectionPickerUrl?: string;
  request?(request: Request): Promise<Response>;
  connect?(path: string, options: { signal?: AbortSignal }): Promise<WebAppDuplex>;
  resourceUrl?(path: string, options: { signal?: AbortSignal; kind?: "resource" | "websocket" }): Promise<WebAppResourceUrl>;
  saveResource?(path: string, options: WebAppSaveResourceOptions): Promise<void>;
  createRealtimeSource?(): RealtimeSource;
  runtime?: WebAppClientRuntime;
  realtimePath?: string | false;
}

function synchronizeRuntime(): void {
  const state = getWebAppRuntimeSnapshot();
  const key = `${state.scope}\0${state.generation}\0${String(state.ready)}\0${String(Boolean(state.error))}`;
  if (key !== activeSessionKey) {
    sessionAbort.abort(new Error("The client session changed."));
    sessionAbort = new AbortController();
    activeSessionKey = key;
  }
  const create = transport.createRealtimeSource ?? (externalClient ? () => externalClient!.createRealtimeSource() : undefined);
  if (create) {
    setExternalRealtimeSource(state.ready && !state.error ? { identity: state.scope, generation: state.generation, create } : undefined);
  } else {
    setRealtimeIdentity(state.ready && !state.error && realtimePath !== false ? `${state.scope}:${state.generation}` : undefined,
      realtimePath === false ? undefined : realtimePath);
  }
}
subscribeWebAppRuntime(synchronizeRuntime);

export function onAuthRequired(listener: AuthRequiredListener): () => void {
  authRequiredListeners.add(listener);
  return () => authRequiredListeners.delete(listener);
}

function emitAuthRequired(): void {
  for (const listener of authRequiredListeners) {
    listener();
  }
}

export function configureWebAppClient(options: WebAppClientOptions = {}): void {
  if (options.connectionPickerUrl !== undefined) {
    const url = new URL(options.connectionPickerUrl, document.baseURI);
    if (!options.connectionPickerUrl.trim() || url.origin !== window.location.origin || url.username || url.password) {
      throw new TypeError("The connection picker must use a same-origin URL without credentials.");
    }
    configuredConnectionPickerUrl = url.href;
  }
  const mode = options.mode ?? (options.external ? "external" : configuredMode);
  if (mode === "external" && (options.apiBaseUrl || options.wsBaseUrl)) {
    throw new TypeError("An external client cannot also use an API server.");
  }
  if (options.external && mode !== "external") {
    throw new TypeError("An external transport requires external client mode.");
  }
  if (configuredMode === "external" && mode !== "external") {
    throw new TypeError("Reload the application before changing client modes.");
  }
  configuredMode = mode;
  if (options.version !== undefined) {
    if (!options.version.trim()) throw new TypeError("Client version must not be empty.");
    configuredClientVersion = options.version;
  }
  if (mode === "external") {
    configuredApiBaseUrl = undefined;
    configuredWebSocketBaseUrl = undefined;
  }
  if (options.external) {
    const client = options.external;
    validateExternalSession(client.session.getSnapshot());
    externalClient = client;
  }
  transport = { ...transport, ...options };
  if ("publicBasePath" in options) setWebAppPublicBasePath(options.publicBasePath);
  if ("apiBaseUrl" in options) configuredApiBaseUrl = normalizeOptionalBaseUrl(options.apiBaseUrl);
  if ("wsBaseUrl" in options) configuredWebSocketBaseUrl = normalizeOptionalBaseUrl(options.wsBaseUrl);
  if ("partialResults" in options) configuredPartialResults = options.partialResults;
  if (options.realtimePath !== undefined) realtimePath = options.realtimePath;
  if (options.runtime) configureWebAppRuntime(options.runtime);
  else if (options.external) configureWebAppRuntime(options.external.session);
  synchronizeRuntime();
}

export function getWebAppClientMode(): "integrated" | "remote" | "external" {
  return configuredMode;
}

export function getWebAppClientVersion(): string | undefined {
  return configuredClientVersion;
}

export function getClientConnectionPickerUrl(): string | undefined {
  return configuredConnectionPickerUrl;
}

export function getWebAppExternalClient(): WebAppExternalClient | undefined {
  if (configuredMode !== "external") return undefined;
  if (!externalClient) throw new Error("Configure the external client runtime before rendering or making requests.");
  return externalClient;
}

export function setWebAppPublicBasePath(basePath?: string | null): void {
  if (basePath == null) {
    configuredPublicBasePath = undefined;
    return;
  }

  const normalizedBasePath = normalizePublicBasePath(basePath);
  if (!isWebAppPublicBasePath(normalizedBasePath || "/")) {
    throw new TypeError("Web app public base path must be a normalized path without query or fragment.");
  }
  configuredPublicBasePath = normalizedBasePath || undefined;
}

export function getWebAppPublicBasePath(): string {
  return configuredPublicBasePath ?? "";
}

export function isWebAppPublicBasePath(value: unknown): value is string {
  return typeof value === "string"
    && (value === "/" || (
      value.startsWith("/")
      && !value.startsWith("//")
      && !value.endsWith("/")
      && !/[\u0000-\u0020\u007f?#\\]/.test(value)
      && !value.split("/").some((segment) => {
        if (segment === "." || segment === "..") {
          return true;
        }
        try {
          const decoded = decodeURIComponent(segment);
          return decoded === "." || decoded === "..";
        } catch {
          return false;
        }
      })
    ));
}

export function appPath(path: string): string {
  if (isAbsolutePath(path)) return path;
  const baseUrl = apiBaseUrl();
  if (baseUrl) {
    return buildAbsoluteUrl(baseUrl, path);
  }

  const normalizedPath = path.replace(/^\/+/, "");
  return new URL(normalizedPath, getPublicBaseUrl()).toString();
}

export function appAbsoluteUrl(path: string): string {
  if (isAbsolutePath(path)) return path;

  const normalizedPath = path.replace(/^\/+/, "");
  return new URL(normalizedPath, getPublicBaseUrl()).toString();
}

export function appPagePath(path: string): string {
  const url = new URL(appAbsoluteUrl(path), getDocumentBaseUrl());
  return `${url.pathname}${url.search}${url.hash}`;
}

export function appWebSocketUrl(path = "/api/ws"): string {
  if (configuredMode === "external") {
    throw new Error("An external client does not have native API WebSocket URLs. Use appDuplexConnection.");
  }
  const configuredWsBaseUrl = configuredWebSocketBaseUrl ?? configuredApiBaseUrl;
  const url = new URL(configuredWsBaseUrl ? buildAbsoluteUrl(configuredWsBaseUrl, path) : appAbsoluteUrl(path));
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  return url.toString();
}

export async function appRequest(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const source = new Request(typeof input === "string" ? appPath(input) : input, init);
  const request = new Request(source, { signal: AbortSignal.any([source.signal, sessionAbort.signal]) });
  const signal = sessionAbort.signal;
  if (transport.request) {
    const response = await transport.request(request);
    signal.throwIfAborted();
    return response;
  }
  const external = getWebAppExternalClient();
  if (external) {
    const base = getPublicBaseUrl();
    const url = new URL(request.url);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
      throw new Error("An external client request must address the application's logical API.");
    }
    url.pathname = `/${url.pathname.slice(base.pathname.length)}`;
    // A keepalive body must retain a non-stream source when its URL changes.
    const delegated = request.keepalive && request.body ? new Request(url, {
      ...init,
      method: request.method,
      headers: request.headers,
      body: await request.blob(),
      keepalive: request.keepalive,
      mode: request.mode,
      credentials: request.credentials,
      cache: request.cache,
      redirect: request.redirect,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
      integrity: request.integrity,
      signal: request.signal,
    }) : new Request(url, request);
    const response = await external.request(delegated);
    signal.throwIfAborted();
    return response;
  }
  return await fetchAppRequest(request);
}

export type { WebAppResourceUrl } from "./external-client";

export async function appResourceUrl(
  path: string,
  kind: "resource" | "websocket" = "resource",
  options: { signal?: AbortSignal } = {},
): Promise<WebAppResourceUrl> {
  const signal = sessionAbort.signal;
  const combined = { signal: options.signal ? AbortSignal.any([options.signal, signal]) : signal };
  if (transport.resourceUrl) {
    const resource = await transport.resourceUrl(path, { ...combined, kind });
    if (combined.signal.aborted) { resource.dispose?.(); combined.signal.throwIfAborted(); }
    return resource;
  }
  const external = getWebAppExternalClient();
  if (external) {
    if (kind !== "resource" || !external.resourceUrl) {
      throw new Error("This client does not provide a browser URL for this resource.");
    }
    const resource = await external.resourceUrl(path, combined);
    if (combined.signal.aborted) { resource.dispose?.(); combined.signal.throwIfAborted(); }
    return resource;
  }
  const url = new URL(kind === "websocket" ? appWebSocketUrl(path) : appPath(path));
  return { url: url.toString(), expiresAt: null };
}

export async function appWebSocketConnection(path = "/api/ws", options: { signal?: AbortSignal } = {}): Promise<WebSocket> {
  if (getWebAppExternalClient()) {
    throw new Error("An external client provides message channels, not native WebSockets. Use appDuplexConnection.");
  }
  const signal = options.signal ? AbortSignal.any([options.signal, sessionAbort.signal]) : sessionAbort.signal;
  const resource = await appResourceUrl(path, "websocket", { signal });
  let socket: WebSocket;
  try { signal.throwIfAborted(); socket = new WebSocket(resource.url); }
  catch (error) { resource.dispose?.(); throw error; }
  const close = () => { socket.close(1000, "session_changed"); };
  signal.addEventListener("abort", close, { once: true });
  socket.addEventListener("close", () => { signal.removeEventListener("abort", close); resource.dispose?.(); }, { once: true });
  return socket;
}

export function hasWebAppResourceTransport(): boolean {
  return Boolean(transport.resourceUrl || externalClient?.resourceUrl);
}

export async function appDuplexConnection(path: string, options: { signal?: AbortSignal } = {}): Promise<WebAppDuplex> {
  const signal = sessionAbort.signal;
  const combined = { signal: options.signal ? AbortSignal.any([options.signal, signal]) : signal };
  if (transport.connect) {
    const connection = await transport.connect(path, combined);
    return await bindDuplexLifetime(connection, combined.signal);
  }
  const external = getWebAppExternalClient();
  if (external) {
    const connection = await external.connect(path, combined);
    return await bindDuplexLifetime(connection, combined.signal);
  }
  return nativeWebAppDuplex(await appWebSocketConnection(path, combined), combined.signal);
}

async function bindDuplexLifetime(connection: WebAppDuplex, signal: AbortSignal): Promise<WebAppDuplex> {
  if (signal.aborted) {
    await connection.close(1000, "session_changed");
    signal.throwIfAborted();
  }
  const cleanup = () => { signal.removeEventListener("abort", close); unsubscribe?.(); };
  const close = () => {
    cleanup();
    void connection.close(1000, "session_changed").catch(error =>
      createLogger("webapp:transport").error("Could not close the retired transport", { error }));
  };
  let unsubscribe: (() => void) | undefined;
  unsubscribe = connection.subscribe({ onMessage() {}, onError() {}, onClose: cleanup });
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) close();
  return connection;
}

export async function appSaveResource(path: string, options: WebAppSaveResourceOptions): Promise<void> {
  if (transport.saveResource) { await transport.saveResource(path, options); return; }
  const external = getWebAppExternalClient();
  if (external) {
    if (!external.saveResource) throw new Error("This client does not support saving resources.");
    await external.saveResource(path, options);
    return;
  }
  const resource = await appResourceUrl(path, "resource", options);
  try {
    options.signal?.throwIfAborted();
    if (window.webappNativeResourceSaver) {
      await window.webappNativeResourceSaver.saveResource({
        url: resource.url,
        suggestedName: options.suggestedName,
      });
      return;
    }
    const link = document.createElement("a");
    link.href = resource.url;
    link.download = options.suggestedName;
    link.click();
  } finally {
    resource.dispose?.();
  }
}
function apiBaseUrl(): string | undefined {
  return configuredApiBaseUrl;
}

export async function appFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }
  const response = await appRequest(input, {
    ...init,
    credentials: init?.credentials ?? "same-origin",
    headers,
  });
  if (response.status === 401) {
    emitAuthRequired();
  }
  if (!response.ok) {
    let body: { error?: string; message?: string; details?: unknown } | undefined;
    try {
      body = await response.clone().json() as typeof body;
    } catch {
      body = undefined;
    }
    throw new WebAppApiError(body?.message ?? `Request failed with status ${response.status}`, response.status, body?.error, body?.details);
  }
  return response;
}

export async function appJson<T>(input: RequestInfo | URL, init: RequestInit = {}): Promise<T> {
  return (await appJsonWithMetadata<T>(input, init)).data;
}

/** Preserve collection bodies while allowing callers to display incomplete state. */
export async function appJsonWithMetadata<T>(
  input: RequestInfo | URL,
  init: RequestInit = {},
  partialResults: PartialResultMetadata | undefined = configuredPartialResults,
): Promise<{ data: T; metadata: WebAppResponseMetadata }> {
  const headers = new Headers(init.headers);
  if (init.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await appFetch(input, { ...init, headers });
  return { data: await response.json() as T, metadata: readResponseMetadata(response, partialResults) };
}

function normalizeOptionalBaseUrl(rawValue?: string | null): string | undefined {
  const trimmedValue = rawValue?.trim();
  if (!trimmedValue) {
    return undefined;
  }

  return trimmedValue.replace(/\/+$/, "");
}

function normalizePublicBasePath(rawBasePath?: string | null): string {
  const trimmedBasePath = rawBasePath?.trim();
  if (!trimmedBasePath || trimmedBasePath === "/") {
    return "";
  }

  const withLeadingSlash = trimmedBasePath.startsWith("/") ? trimmedBasePath : `/${trimmedBasePath}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, "");

  return withoutTrailingSlash === "/" ? "" : withoutTrailingSlash;
}

function buildAbsoluteUrl(baseUrl: string, path: string): string {
  return new URL(path.replace(/^\/+/, ""), `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

function getDocumentBaseUrl(): URL {
  const baseHref = document.querySelector("base")?.getAttribute("href");
  return baseHref ? new URL(baseHref, window.location.href) : new URL(".", window.location.href);
}

function getPublicBaseUrl(): URL {
  const configuredBasePath = getWebAppPublicBasePath();
  return configuredBasePath ? getConfiguredBaseUrl(configuredBasePath) : getDocumentBaseUrl();
}

function getConfiguredBaseUrl(basePath: string): URL {
  return new URL(`${basePath}/`, new URL(window.location.href).origin);
}

function isAbsolutePath(path: string): boolean {
  return ABSOLUTE_URL_PATTERN.test(path) || path.startsWith("//");
}
