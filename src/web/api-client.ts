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

export function onAuthRequired(listener: AuthRequiredListener): () => void {
  authRequiredListeners.add(listener);
  return () => authRequiredListeners.delete(listener);
}

function emitAuthRequired(): void {
  for (const listener of authRequiredListeners) {
    listener();
  }
}

export function appPath(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;
  const base = document.querySelector("base")?.getAttribute("href") ?? "/";
  return new URL(path.replace(/^\/+/, ""), new URL(base, window.location.href)).toString();
}

export function appWebSocketUrl(path = "/api/ws"): string {
  const url = new URL(appPath(path));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export async function appFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(typeof input === "string" ? appPath(input) : input, {
    ...init,
    credentials: init?.credentials ?? "same-origin",
    headers: {
      accept: "application/json",
      ...init?.headers,
    },
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
