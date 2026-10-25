import { fetchAppRequest } from "./network-failures";
import { readResponseMetadata, type PartialResultMetadata, type WebAppResponseMetadata } from "../contracts/response-metadata";
import type { WebAppDuplex, WebAppExternalClient, WebAppResourceUrl, WebAppSaveResourceOptions } from "./external-client";
import { validateExternalSession } from "./external-client";
import { nativeWebAppDuplex } from "./native-duplex";
import {
  clientAccessToken, configureExternalClientStorageScope, configureRemoteClient, getClientSession,
  type WebAppRemoteClientOptions,
} from "./client-session";

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

const authRequiredListeners = new Set<AuthRequiredListener>();
let configuredPublicBasePath: string | undefined;
let configuredApiBaseUrl: string | undefined;
let configuredWebSocketBaseUrl: string | undefined;
let configuredPartialResults: PartialResultMetadata | undefined;
let configuredMode: "integrated" | "remote" | "external" = "integrated";
let externalClient: WebAppExternalClient | undefined;
const ABSOLUTE_URL_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;

export function onAuthRequired(listener: AuthRequiredListener): () => void {
  authRequiredListeners.add(listener);
  return () => authRequiredListeners.delete(listener);
}

function emitAuthRequired(): void {
  for (const listener of authRequiredListeners) {
    listener();
  }
}

export function configureWebAppClient(options: {
  publicBasePath?: string | null;
  apiBaseUrl?: string | null;
  wsBaseUrl?: string | null;
  partialResults?: PartialResultMetadata;
  mode?: "integrated" | "remote" | "external";
  remote?: WebAppRemoteClientOptions;
  external?: WebAppExternalClient;
} = {}): void {
  const mode = options.mode ?? (options.external ? "external" : options.remote ? "remote" : configuredMode);
  if (mode === "external" && (getClientSession().enabled || options.remote
    || options.apiBaseUrl || options.wsBaseUrl)) {
    throw new TypeError("An external client cannot also use an API server or remote server credentials.");
  }
  if (options.external && mode !== "external") {
    throw new TypeError("An external transport requires external client mode.");
  }
  if (configuredMode === "external" && mode !== "external") {
    throw new TypeError("Reload the application before changing client modes.");
  }
  configuredMode = mode;
  if (mode === "external") {
    configuredApiBaseUrl = undefined;
    configuredWebSocketBaseUrl = undefined;
  }
  if (options.external) {
    const client = options.external;
    validateExternalSession(client.session.getSnapshot());
    externalClient = client;
    configureExternalClientStorageScope(() => `external:${validateExternalSession(client.session.getSnapshot()).scope}`);
  }
  if ("publicBasePath" in options) setWebAppPublicBasePath(options.publicBasePath);
  if ("apiBaseUrl" in options) configuredApiBaseUrl = normalizeOptionalBaseUrl(options.apiBaseUrl);
  if ("wsBaseUrl" in options) configuredWebSocketBaseUrl = normalizeOptionalBaseUrl(options.wsBaseUrl);
  if ("partialResults" in options) configuredPartialResults = options.partialResults;
  if (options.mode === "remote" || options.remote) configureRemoteClient(configuredApiBaseUrl, options.remote);
}

export function getWebAppClientMode(): "integrated" | "remote" | "external" {
  return configuredMode;
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
  const configuredWsBaseUrl = getClientSession().enabled ? apiBaseUrl() : configuredWebSocketBaseUrl ?? configuredApiBaseUrl;
  const url = new URL(configuredWsBaseUrl ? buildAbsoluteUrl(configuredWsBaseUrl, path) : appAbsoluteUrl(path));
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  return url.toString();
}

export async function appRequest(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(typeof input === "string" ? appPath(input) : input, init);
  const external = getWebAppExternalClient();
  if (external) {
    const base = getPublicBaseUrl();
    const url = new URL(request.url);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
      throw new Error("An external client request must address the application's logical API.");
    }
    url.pathname = `/${url.pathname.slice(base.pathname.length)}`;
    return await external.request(new Request(url, request));
  }
  if (!getClientSession().enabled) return await fetchAppRequest(request);
  assertSelectedApiUrl(new URL(request.url));
  const retry = request.clone();
  const accessToken = await clientAccessToken();
  const send = async (source: Request, token: string) => {
    const headers = new Headers(source.headers);
    headers.set("authorization", `Bearer ${token}`);
    return await fetchAppRequest(new Request(source, { headers, credentials: "omit", redirect: "error" }));
  };
  const response = await send(request, accessToken);
  if (response.status !== 401) return response;
  let failure: unknown;
  try {
    failure = await response.clone().json();
  } catch {
    // Non-authentication 401 responses belong to the caller and must not replay a mutation.
    return response;
  }
  if (typeof failure !== "object" || failure === null || !("error" in failure)
    || !["invalid_token", "authentication_required"].includes(String(failure.error))) return response;
  const token = await clientAccessToken(accessToken);
  await response.body?.cancel();
  return await send(retry, token);
}

export type { WebAppResourceUrl } from "./external-client";

export async function appResourceUrl(
  path: string,
  kind: "resource" | "websocket" = "resource",
  options: { signal?: AbortSignal } = {},
): Promise<WebAppResourceUrl> {
  const external = getWebAppExternalClient();
  if (external) {
    if (kind !== "resource" || !external.resourceUrl) {
      throw new Error("This client does not provide a browser URL for this resource.");
    }
    return await external.resourceUrl(path, options);
  }
  const url = new URL(kind === "websocket" ? appWebSocketUrl(path) : appPath(path));
  if (!getClientSession().enabled) return { url: url.toString(), expiresAt: null };
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  const base = assertSelectedApiUrl(url);
  const target = `/${url.pathname.slice(base.pathname.replace(/\/$/, "").length).replace(/^\/+/, "")}${url.search}`;
  const response = await appJson<unknown>("/api/auth/client-ticket", {
    method: "POST", body: JSON.stringify({ url: target, kind }), signal: options.signal,
  });
  if (!response || typeof response !== "object" || !("url" in response) || !("expiresAt" in response)
    || typeof response.url !== "string" || typeof response.expiresAt !== "number"
    || !Number.isFinite(response.expiresAt) || response.expiresAt <= Date.now()) {
    throw new Error("The server returned an invalid client resource ticket.");
  }
  const resource = new URL(buildAbsoluteUrl(base.toString(), response.url));
  assertSelectedApiUrl(resource);
  if (kind === "websocket") resource.protocol = resource.protocol === "https:" ? "wss:" : "ws:";
  return { url: resource.toString(), expiresAt: response.expiresAt };
}

export async function appWebSocketConnection(path = "/api/ws", options: { signal?: AbortSignal } = {}): Promise<WebSocket> {
  if (getWebAppExternalClient()) {
    throw new Error("An external client provides message channels, not native WebSockets. Use appDuplexConnection.");
  }
  const resource = await appResourceUrl(path, "websocket", options);
  options.signal?.throwIfAborted();
  return new WebSocket(resource.url);
}

export async function appDuplexConnection(path: string, options: { signal?: AbortSignal } = {}): Promise<WebAppDuplex> {
  const external = getWebAppExternalClient();
  if (external) return await external.connect(path, options);
  return nativeWebAppDuplex(await appWebSocketConnection(path, options), options.signal);
}

export async function appSaveResource(path: string, options: WebAppSaveResourceOptions): Promise<void> {
  const external = getWebAppExternalClient();
  if (external) {
    if (!external.saveResource) throw new Error("This client does not support saving resources.");
    await external.saveResource(path, options);
    return;
  }
  const resource = await appResourceUrl(path, "resource", options);
  try {
    options.signal?.throwIfAborted();
    const link = document.createElement("a");
    link.href = resource.url;
    link.download = options.suggestedName;
    link.click();
  } finally {
    resource.dispose?.();
  }
}
function apiBaseUrl(): string | undefined {
  const session = getClientSession();
  if (!session.enabled) return configuredApiBaseUrl;
  if (!session.endpoint) throw new Error("Choose an API server first.");
  return session.endpoint;
}

function assertSelectedApiUrl(url: URL): URL {
  const base = new URL(`${apiBaseUrl()}/`);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
    throw new Error("Refusing to send server credentials to a different API endpoint.");
  }
  return base;
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
  if (response.headers.get("x-webapp-passkey-required") === "true" || response.headers.get("x-passkey-auth-required") === "true") {
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
