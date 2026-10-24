import { errorResponse } from "./responses";
import type { RuntimeConfig } from "./runtime-config";

export function normalizeClientOrigins(origins: readonly string[] = []): string[] {
  return [...new Set(origins.map((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("clientOrigins must contain absolute HTTPS origins (HTTP is allowed for localhost development)");
    }
    const loopback = url.hostname === "localhost"
      || url.hostname.endsWith(".localhost")
      || url.hostname === "[::1]"
      || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
      || url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || (value !== url.origin && value !== `${url.origin}/`)
    ) {
      throw new Error("clientOrigins must contain absolute HTTPS origins without credentials, paths, queries, or fragments (HTTP is allowed for localhost development)");
    }
    return url.origin;
  }))];
}

export function isClientOrigin(origin: string, config: RuntimeConfig): boolean {
  return config.clientOrigins?.includes(origin) ?? false;
}

export function clientPreflight(req: Request, config: RuntimeConfig): Response | undefined {
  if (req.method !== "OPTIONS" || !req.headers.has("access-control-request-method")) return undefined;
  const origin = req.headers.get("origin");
  if (!origin || !isClientOrigin(origin, config)) {
    return errorResponse(403, "client_origin_forbidden", "Client origin is not allowed");
  }
  const method = req.headers.get("access-control-request-method") ?? "";
  const headers = req.headers.get("access-control-request-headers") ?? "";
  const names = headers ? headers.split(",").map((name) => name.trim().toLowerCase()) : [];
  if (
    !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method)
    || headers.length > 8192 || names.length > 64
    || names.some((name) => !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name))
  ) {
    return errorResponse(400, "invalid_preflight", "Invalid client preflight");
  }
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
      ...(names.length ? { "access-control-allow-headers": names.join(", ") } : {}),
      "access-control-max-age": "600",
      vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    },
  });
}

export function withClientCors(req: Request, config: RuntimeConfig, response: Response): Response {
  const headers = new Headers(response.headers);
  const vary = headers.get("vary");
  if (vary !== "*" && !vary?.split(",").some((value) => value.trim().toLowerCase() === "origin")) {
    headers.set("vary", vary ? `${vary}, Origin` : "Origin");
  }
  const origin = req.headers.get("origin");
  if (origin && isClientOrigin(origin, config)) {
    headers.set("access-control-allow-origin", origin);
    // Explicit names expose application metadata too, without credential wildcards.
    headers.set("access-control-expose-headers", [...headers.keys()]
      .filter((name) => name !== "set-cookie" && name !== "set-cookie2")
      .join(", "));
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
