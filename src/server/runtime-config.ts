import type { LogLevelName } from "../contracts";

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

export function readRuntimeConfig(input: {
  appName: string;
  envPrefix: string;
  defaultLogLevel?: LogLevelName;
}): RuntimeConfig {
  const envPrefix = assertEnvPrefix(input.envPrefix);
  const logLevelRaw = readEnv(envPrefix, "LOG_LEVEL");
  const logLevel = parseLogLevel(logLevelRaw, input.defaultLogLevel ?? "info", envName(envPrefix, "LOG_LEVEL"));
  return {
    appName: input.appName,
    envPrefix,
    host: readEnv(envPrefix, "HOST") || "127.0.0.1",
    port: parsePort(readEnv(envPrefix, "PORT"), envName(envPrefix, "PORT")),
    dataDir: readEnv(envPrefix, "DATA_DIR") || "./data",
    logLevel,
    logLevelFromEnv: Boolean(logLevelRaw),
    passkeyDisabled: isTruthyEnv(readEnv(envPrefix, "DISABLE_PASSKEY")),
    sameOriginDisabled: isTruthyEnv(readEnv(envPrefix, "DISABLE_SAME_ORIGIN_CHECK")),
    publicBaseUrl: readEnv(envPrefix, "PUBLIC_BASE_URL"),
    authIssuer: readEnv(envPrefix, "AUTH_ISSUER"),
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
    production: config.development === false,
  };
}
