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
} = {}): void {
  setWebAppPublicBasePath(options.publicBasePath);
  configuredApiBaseUrl = normalizeOptionalBaseUrl(options.apiBaseUrl);
  configuredWebSocketBaseUrl = normalizeOptionalBaseUrl(options.wsBaseUrl);
}

export function setWebAppPublicBasePath(basePath?: string | null): void {
  if (basePath == null) {
    configuredPublicBasePath = undefined;
    return;
  }

  const normalizedBasePath = normalizePublicBasePath(basePath);
  configuredPublicBasePath = normalizedBasePath || undefined;
}

export function getWebAppPublicBasePath(): string {
  return configuredPublicBasePath ?? "";
}

export function appPath(path: string): string {
  if (isAbsolutePath(path)) return path;
  if (configuredApiBaseUrl) {
    return buildAbsoluteUrl(configuredApiBaseUrl, path);
  }

  const normalizedPath = path.replace(/^\/+/, "");
  const configuredBasePath = getWebAppPublicBasePath();
  if (configuredBasePath) {
    return new URL(normalizedPath, getConfiguredBaseUrl(configuredBasePath)).toString();
  }

  return new URL(normalizedPath, getDocumentBaseUrl()).toString();
}

export function appAbsoluteUrl(path: string): string {
  if (isAbsolutePath(path)) return path;

  const normalizedPath = path.replace(/^\/+/, "");
  const configuredBasePath = getWebAppPublicBasePath();
  if (configuredBasePath) {
    return new URL(normalizedPath, getConfiguredBaseUrl(configuredBasePath)).toString();
  }

  return new URL(normalizedPath, getDocumentBaseUrl()).toString();
}

export function appWebSocketUrl(path = "/api/ws"): string {
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
  return await fetch(typeof input === "string" ? appPath(input) : input, init);
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
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await appFetch(input, { ...init, headers });
  return await response.json() as T;
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
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return new URL(normalizedPath, `${baseUrl}/`).toString();
}

function getDocumentBaseUrl(): URL {
  const baseHref = document.querySelector("base")?.getAttribute("href");
  return baseHref ? new URL(baseHref, window.location.href) : new URL(".", window.location.href);
}

function getConfiguredBaseUrl(basePath: string): URL {
  return new URL(`${basePath}/`, new URL(window.location.href).origin);
}

function isAbsolutePath(path: string): boolean {
  return ABSOLUTE_URL_PATTERN.test(path) || path.startsWith("//");
}
