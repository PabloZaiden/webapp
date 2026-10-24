import { errorResponse } from "./responses";

export function clientPreflight(req: Request): Response | undefined {
  if (req.method !== "OPTIONS" || !req.headers.has("access-control-request-method")) return undefined;
  const method = req.headers.get("access-control-request-method") ?? "";
  const headers = req.headers.get("access-control-request-headers") ?? "";
  const names = headers ? headers.split(",").map((name) => name.trim().toLowerCase()) : [];
  if (
    !req.headers.get("origin")
    || !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method)
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

export function withClientCors(req: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  const vary = headers.get("vary");
  if (vary !== "*" && !vary?.split(",").some((value) => value.trim().toLowerCase() === "origin")) {
    headers.set("vary", vary ? `${vary}, Origin` : "Origin");
  }
  if (req.headers.has("origin")) {
    headers.set("access-control-allow-origin", "*");
    headers.delete("access-control-allow-credentials");
    // Explicit names expose application metadata too, without credential wildcards.
    headers.set("access-control-expose-headers", [...headers.keys()]
      .filter((name) => name !== "set-cookie" && name !== "set-cookie2")
      .join(", "));
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
