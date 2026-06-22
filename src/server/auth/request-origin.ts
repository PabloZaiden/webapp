export interface RequestOriginInfo {
  origin: string;
  hostname: string;
  secure: boolean;
}

export function getRequestOriginInfo(req: Request, publicBaseUrl?: string): RequestOriginInfo {
  if (publicBaseUrl) {
    const parsed = new URL(publicBaseUrl);
    return {
      origin: parsed.origin,
      hostname: parsed.hostname,
      secure: parsed.protocol === "https:",
    };
  }
  const url = new URL(req.url);
  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const proto = forwardedProto || url.protocol.replace(":", "");
  const host = forwardedHost || req.headers.get("host") || url.host;
  const origin = `${proto}://${host}`;
  const parsed = new URL(origin);
  return {
    origin: parsed.origin,
    hostname: parsed.hostname,
    secure: parsed.protocol === "https:",
  };
}

export function getCookiePath(req: Request): string {
  const prefix = req.headers.get("x-forwarded-prefix")?.trim().replace(/\/+$/, "");
  return prefix || "/";
}
