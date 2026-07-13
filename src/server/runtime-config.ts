import type { LogLevelName } from "../contracts";

export const TRUST_PROXY_HEADERS = ["proto", "host", "prefix"] as const;
export type TrustProxyHeader = typeof TRUST_PROXY_HEADERS[number];
export type TrustProxyChain = "first" | "last";

export interface TrustProxyConfig {
  enabled: boolean;
  headers: readonly TrustProxyHeader[];
  chain: TrustProxyChain;
}

export interface RuntimeConfig {
  appName: string;
  envPrefix: string;
  host: string;
  port: number;
  dataDir: string;
  logLevel: LogLevelName;
  logLevelFromEnv: boolean;
  passkeyDisabled: boolean;
  sameOriginDisabled: boolean;
  publicBaseUrl?: string;
  authIssuer?: string;
  trustProxy: TrustProxyConfig;
  development: false | { hmr: true; console: true };
}

const LOG_LEVELS = new Set(["trace", "debug", "info", "warn", "error"]);

export function isTruthyEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

export function assertEnvPrefix(prefix: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(prefix)) {
    throw new Error(`envPrefix must match /^[A-Z][A-Z0-9_]*$/; received "${prefix}"`);
  }
  return prefix;
}

function envName(prefix: string, name: string): string {
  return `${prefix}_${name}`;
}

function readEnv(prefix: string, name: string): string | undefined {
  return process.env[envName(prefix, name)]?.trim();
}

function parsePort(raw: string | undefined, name: string): number {
  const value = raw || "3000";
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an integer between 0 and 65535; received "${value}"`);
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${name} must be an integer between 0 and 65535; received "${value}"`);
  }
  return port;
}

function parseLogLevel(raw: string | undefined, fallback: LogLevelName, name: string): LogLevelName {
  if (!raw) {
    return fallback;
  }
  if (!LOG_LEVELS.has(raw)) {
    throw new Error(`${name} must be one of trace, debug, info, warn, error; received "${raw}"`);
  }
  return raw as LogLevelName;
}

function parseBoolean(raw: string | undefined, fallback: boolean, name: string): boolean {
  if (raw === undefined) {
    return fallback;
  }
  const normalized = raw.toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  throw new Error(`${name} must be true or false; received "${raw}"`);
}

function parsePublicBaseUrl(raw: string | undefined, name: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid absolute http(s) URL; received "${raw}"`);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.origin === "null") {
    throw new Error(`${name} must be a valid absolute http(s) URL; received "${raw}"`);
  }
  return raw;
}

function parseTrustProxyHeaders(raw: string | undefined, enabled: boolean, name: string): TrustProxyHeader[] {
  if (raw === undefined) {
    return enabled ? [...TRUST_PROXY_HEADERS] : [];
  }
  const values = raw.split(",").map((value) => value.trim().toLowerCase());
  if (values.length === 0 || values.some((value) => !value)) {
    throw new Error(`${name} must be a comma-separated list of proto, host, and prefix; received "${raw}"`);
  }
  const headers: TrustProxyHeader[] = [];
  for (const value of values) {
    const header = TRUST_PROXY_HEADERS.find((candidate) => candidate === value);
    if (!header) {
      throw new Error(`${name} must contain only proto, host, and prefix; received "${raw}"`);
    }
    if (headers.includes(header)) {
      throw new Error(`${name} must not contain duplicate values; received "${raw}"`);
    }
    headers.push(header);
  }
  return headers;
}

function parseTrustProxyChain(raw: string | undefined, name: string): TrustProxyChain {
  const value = raw?.toLowerCase() ?? "first";
  if (value === "first" || value === "last") {
    return value;
  }
  throw new Error(`${name} must be first or last; received "${raw}"`);
}

export function readRuntimeConfig(input: {
  appName: string;
  envPrefix: string;
  defaultLogLevel?: LogLevelName;
}): RuntimeConfig {
  const envPrefix = assertEnvPrefix(input.envPrefix);
  const logLevelRaw = readEnv(envPrefix, "LOG_LEVEL");
  const logLevel = parseLogLevel(logLevelRaw, input.defaultLogLevel ?? "info", envName(envPrefix, "LOG_LEVEL"));
  const publicBaseUrl = parsePublicBaseUrl(readEnv(envPrefix, "PUBLIC_BASE_URL"), envName(envPrefix, "PUBLIC_BASE_URL"));
  const trustProxyEnabled = parseBoolean(readEnv(envPrefix, "TRUST_PROXY"), false, envName(envPrefix, "TRUST_PROXY"));
  const trustProxy = {
    enabled: trustProxyEnabled,
    headers: parseTrustProxyHeaders(readEnv(envPrefix, "TRUST_PROXY_HEADERS"), trustProxyEnabled, envName(envPrefix, "TRUST_PROXY_HEADERS")),
    chain: parseTrustProxyChain(readEnv(envPrefix, "TRUST_PROXY_CHAIN"), envName(envPrefix, "TRUST_PROXY_CHAIN")),
  } satisfies TrustProxyConfig;
  return {
    appName: input.appName,
    envPrefix,
    host: readEnv(envPrefix, "HOST") || "localhost",
    port: parsePort(readEnv(envPrefix, "PORT"), envName(envPrefix, "PORT")),
    dataDir: readEnv(envPrefix, "DATA_DIR") || "./data",
    logLevel,
    logLevelFromEnv: Boolean(logLevelRaw),
    passkeyDisabled: isTruthyEnv(readEnv(envPrefix, "DISABLE_PASSKEY")),
    sameOriginDisabled: isTruthyEnv(readEnv(envPrefix, "DISABLE_SAME_ORIGIN_CHECK")),
    publicBaseUrl,
    authIssuer: readEnv(envPrefix, "AUTH_ISSUER"),
    trustProxy,
    development: process.env["NODE_ENV"] === "production" ? false : { hmr: true, console: true },
  };
}

export function safeRuntimeConfig(config: RuntimeConfig): Record<string, unknown> {
  return {
    appName: config.appName,
    envPrefix: config.envPrefix,
    host: config.host,
    port: config.port,
    dataDir: config.dataDir,
    logLevel: config.logLevel,
    logLevelFromEnv: config.logLevelFromEnv,
    passkeyDisabled: config.passkeyDisabled,
    sameOriginDisabled: config.sameOriginDisabled,
    publicBaseUrl: config.publicBaseUrl,
    authIssuer: config.authIssuer,
    trustProxy: {
      enabled: config.trustProxy.enabled,
      headers: [...config.trustProxy.headers],
      chain: config.trustProxy.chain,
    },
    production: config.development === false,
  };
}
