import type { RuntimeConfig, TrustProxyHeader } from "../runtime-config";

export interface RequestOriginInfo {
  origin: string;
  hostname: string;
  secure: boolean;
  pathPrefix: string;
}

const FORWARDED_HEADER_NAMES: Record<TrustProxyHeader, string> = {
  proto: "x-forwarded-proto",
  host: "x-forwarded-host",
  prefix: "x-forwarded-prefix",
};

function forwardedValue(req: Request, config: Pick<RuntimeConfig, "trustProxy">, header: TrustProxyHeader): string | undefined {
  if (!config.trustProxy.enabled || !config.trustProxy.headers.includes(header)) {
    return undefined;
  }
  const raw = req.headers.get(FORWARDED_HEADER_NAMES[header]);
  if (raw === null) {
    return undefined;
  }
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) {
    return undefined;
  }
  return config.trustProxy.chain === "last" ? values[values.length - 1] : values[0];
}

function parseOrigin(protocol: string, host: string): RequestOriginInfo | undefined {
  if (!protocol || !host || /[\u0000-\u0020\u007f]/.test(host) || /[/?#\\]/.test(host)) {
    return undefined;
  }
  try {
    const parsed = new URL(`${protocol}://${host}`);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return undefined;
    }
    return {
      origin: parsed.origin,
      hostname: parsed.hostname,
      secure: parsed.protocol === "https:",
      pathPrefix: "/",
    };
  } catch {
    return undefined;
  }
}

function directOrigin(req: Request): RequestOriginInfo {
  const url = new URL(req.url);
  const protocol = url.protocol.replace(/:$/, "").toLowerCase();
  const host = req.headers.get("host")?.trim() || url.host;
  return parseOrigin(protocol, host) ?? {
    origin: url.origin,
    hostname: url.hostname,
    secure: url.protocol === "https:",
    pathPrefix: "/",
  };
}

function forwardedProtocol(value: string | undefined): string | undefined {
  const normalized = value?.toLowerCase();
  return normalized === "http" || normalized === "https" ? normalized : undefined;
}

function forwardedHost(value: string | undefined): string | undefined {
  if (!value || !parseOrigin("http", value)) {
    return undefined;
  }
  return value;
}

function forwardedPrefix(value: string | undefined): string | undefined {
  if (!value || !value.startsWith("/") || /[\u0000-\u0020\u007f?#\\]/.test(value)) {
    return undefined;
  }
  const normalized = value.replace(/\/+$/, "");
  if (!normalized || normalized === "/") {
    return "/";
  }
  if (normalized.startsWith("//")) {
    return undefined;
  }
  return normalized;
}

export function getRequestOriginInfo(req: Request, config: Pick<RuntimeConfig, "publicBaseUrl" | "trustProxy">): RequestOriginInfo {
  const direct = directOrigin(req);
  const prefix = forwardedPrefix(forwardedValue(req, config, "prefix")) ?? "/";
  if (config.publicBaseUrl) {
    const parsed = new URL(config.publicBaseUrl);
    return {
      origin: parsed.origin,
      hostname: parsed.hostname,
      secure: parsed.protocol === "https:",
      pathPrefix: prefix,
    };
  }
  const protocol = forwardedProtocol(forwardedValue(req, config, "proto")) ?? new URL(direct.origin).protocol.replace(/:$/, "");
  const host = forwardedHost(forwardedValue(req, config, "host")) ?? new URL(direct.origin).host;
  const resolved = parseOrigin(protocol, host);
  return resolved ? { ...resolved, pathPrefix: prefix } : { ...direct, pathPrefix: prefix };
}

export function getCookiePath(req: Request, config: Pick<RuntimeConfig, "publicBaseUrl" | "trustProxy">): string {
  return getRequestOriginInfo(req, config).pathPrefix;
}

export function getRequestBaseUrl(req: Request, config: Pick<RuntimeConfig, "publicBaseUrl" | "trustProxy">): string {
  const { origin, pathPrefix } = getRequestOriginInfo(req, config);
  return `${origin}${pathPrefix === "/" ? "" : pathPrefix}`;
}
