export class AuthBonusError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "AuthBonusError";
  }
}

export function authenticationOrigin(value: string): URL {
  const origin = new URL(value);
  if (origin.username || origin.password || origin.search || origin.hash
    || origin.pathname !== "/" || !["http:", "https:"].includes(origin.protocol)
    || (origin.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) {
    throw new TypeError("Authentication requires an HTTPS origin (HTTP is permitted on loopback).");
  }
  return origin;
}

export function requireAuthenticationOrigin(req: Request, origin: string): void {
  if (req.headers.get("origin") !== origin) {
    throw new AuthBonusError("same_origin_required", "Request origin is not allowed", 403);
  }
}

export function validVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 0) throw new TypeError("Authentication versions must be non-negative integers.");
}
