import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_LOG_LEVEL, VALID_LOG_LEVELS, type LogLevelName } from "../contracts";

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
  appDirectoryName?: string;
  host: string;
  port: number;
  dataDir: string;
  configPath?: string;
  developmentSourcePath?: string;
  logLevel: LogLevelName;
  logLevelFromEnv: boolean;
  inMemoryLogsEnabled: boolean;
  passkeyDisabled: boolean;
  sameOriginDisabled: boolean;
  publicBaseUrl?: string;
  authIssuer?: string;
  trustProxy: TrustProxyConfig;
  development: false | { hmr: true; console: true };
}

export const WEB_APP_CONFIG_VERSION = 1;
export const WEB_APP_CONFIG_FILE_NAME = "config.json";

export interface WebAppPersistedServerConfig {
  host?: string;
  port?: number;
}

export interface WebAppPersistedDevelopmentConfig {
  sourcePath?: string;
}

export interface WebAppPersistedConfig {
  version: typeof WEB_APP_CONFIG_VERSION;
  server?: WebAppPersistedServerConfig;
  development?: WebAppPersistedDevelopmentConfig;
  [key: string]: unknown;
}

export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

function isSupportedLogLevel(value: unknown): value is LogLevelName {
  return typeof value === "string" && VALID_LOG_LEVELS.includes(value as LogLevelName);
}

export function resolveEffectiveLogLevel(
  config: Pick<RuntimeConfig, "logLevel" | "logLevelFromEnv">,
  savedLogLevel?: unknown,
): LogLevelName {
  return config.logLevelFromEnv
    ? config.logLevel
    : isSupportedLogLevel(savedLogLevel)
      ? savedLogLevel
      : config.logLevel;
}

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

export function defaultAppDirectoryName(envPrefix: string): string {
  return `.${assertEnvPrefix(envPrefix).toLowerCase().replaceAll("_", "-")}`;
}

function assertAppDirectoryName(name: string): string {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error(`appDirectoryName must be a single directory name; received "${name}"`);
  }
  return name;
}

export function resolveAppDirectoryName(envPrefix: string, appDirectoryName?: string): string {
  return assertAppDirectoryName(appDirectoryName ?? defaultAppDirectoryName(envPrefix));
}

function envName(prefix: string, name: string): string {
  return `${prefix}_${name}`;
}

function readEnv(environment: RuntimeEnvironment, prefix: string, name: string): string | undefined {
  return environment[envName(prefix, name)]?.trim();
}

export function resolveAppDataDir(input: {
  envPrefix: string;
  appDirectoryName?: string;
  environment?: RuntimeEnvironment;
}): string {
  const envPrefix = assertEnvPrefix(input.envPrefix);
  const environment = input.environment ?? process.env;
  const explicit = readEnv(environment, envPrefix, "DATA_DIR");
  if (explicit) {
    return resolve(explicit);
  }
  const home = environment["HOME"]?.trim()
    || environment["USERPROFILE"]?.trim()
    || homedir();
  if (!home) {
    throw new Error("HOME is not set");
  }
  return join(home, resolveAppDirectoryName(envPrefix, input.appDirectoryName));
}

export function webAppConfigPath(dataDir: string): string {
  return join(dataDir, WEB_APP_CONFIG_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function configError(message: string, cause?: unknown): Error {
  return new Error(`Invalid web app config: ${message}`, cause === undefined ? undefined : { cause });
}

function parsePersistedServerConfig(value: unknown): WebAppPersistedServerConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw configError("server must be an object");
  }
  const host = value["host"];
  if (host !== undefined && (typeof host !== "string" || !host.trim() || /[\s/?#]/.test(host))) {
    throw configError("server.host must be a non-empty hostname or address");
  }
  const port = value["port"];
  if (
    port !== undefined
    && (!Number.isSafeInteger(port) || Number(port) < 0 || Number(port) > 65535)
  ) {
    throw configError("server.port must be an integer between 0 and 65535");
  }
  return {
    ...(host === undefined ? {} : { host: host.trim() }),
    ...(port === undefined ? {} : { port: Number(port) }),
  };
}

function parsePersistedDevelopmentConfig(value: unknown): WebAppPersistedDevelopmentConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw configError("development must be an object");
  }
  const sourcePath = value["sourcePath"];
  if (sourcePath !== undefined && (typeof sourcePath !== "string" || !sourcePath.trim())) {
    throw configError("development.sourcePath must be a non-empty path");
  }
  return sourcePath === undefined ? {} : { sourcePath: resolve(sourcePath.trim()) };
}

export function parseWebAppPersistedConfig(value: unknown): WebAppPersistedConfig {
  if (!isRecord(value)) {
    throw configError("the root value must be an object");
  }
  const version = value["version"];
  if (version !== WEB_APP_CONFIG_VERSION) {
    throw configError(`version must be ${String(WEB_APP_CONFIG_VERSION)}`);
  }
  const config: WebAppPersistedConfig = {
    ...value,
    version: WEB_APP_CONFIG_VERSION,
  };
  const server = parsePersistedServerConfig(value["server"]);
  const development = parsePersistedDevelopmentConfig(value["development"]);
  if (server === undefined) {
    delete config["server"];
  } else {
    config.server = server;
  }
  if (development === undefined) {
    delete config["development"];
  } else {
    config.development = development;
  }
  return config;
}

export function readWebAppConfig(dataDir: string): WebAppPersistedConfig {
  const path = webAppConfigPath(dataDir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { version: WEB_APP_CONFIG_VERSION };
    }
    throw new Error(`Unable to read web app config at ${path}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw configError(`JSON could not be parsed at ${path}`, error);
  }
  try {
    return parseWebAppPersistedConfig(parsed);
  } catch (error) {
    throw new Error(`Unable to validate web app config at ${path}`, { cause: error });
  }
}

export function parsePort(raw: string | undefined, name: string): number {
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
  if (!isSupportedLogLevel(raw)) {
    throw new Error(`${name} must be one of ${VALID_LOG_LEVELS.join(", ")}; received "${raw}"`);
  }
  return raw;
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
    throw new Error(`${name} must be a valid absolute http(s) origin; received "${raw}"`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.origin === "null" ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${name} must be a valid absolute http(s) origin; received "${raw}"`);
  }
  return parsed.origin;
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
  appDirectoryName?: string;
  environment?: RuntimeEnvironment;
}): RuntimeConfig {
  const envPrefix = assertEnvPrefix(input.envPrefix);
  const environment = input.environment ?? process.env;
  const appDirectoryName = resolveAppDirectoryName(envPrefix, input.appDirectoryName);
  const dataDir = resolveAppDataDir({
    envPrefix,
    appDirectoryName,
    environment,
  });
  const persisted = readWebAppConfig(dataDir);
  const logLevelRaw = readEnv(environment, envPrefix, "LOG_LEVEL");
  const logLevel = parseLogLevel(logLevelRaw, input.defaultLogLevel ?? DEFAULT_LOG_LEVEL, envName(envPrefix, "LOG_LEVEL"));
  const inMemoryLogsEnabled = parseBoolean(readEnv(environment, envPrefix, "IN_MEMORY_LOGS"), false, envName(envPrefix, "IN_MEMORY_LOGS"));
  const publicBaseUrl = parsePublicBaseUrl(readEnv(environment, envPrefix, "PUBLIC_BASE_URL"), envName(envPrefix, "PUBLIC_BASE_URL"));
  const trustProxyEnabled = parseBoolean(readEnv(environment, envPrefix, "TRUST_PROXY"), false, envName(envPrefix, "TRUST_PROXY"));
  const trustProxy = {
    enabled: trustProxyEnabled,
    headers: parseTrustProxyHeaders(readEnv(environment, envPrefix, "TRUST_PROXY_HEADERS"), trustProxyEnabled, envName(envPrefix, "TRUST_PROXY_HEADERS")),
    chain: parseTrustProxyChain(readEnv(environment, envPrefix, "TRUST_PROXY_CHAIN"), envName(envPrefix, "TRUST_PROXY_CHAIN")),
  } satisfies TrustProxyConfig;
  const host = readEnv(environment, envPrefix, "HOST")
    || persisted.server?.host
    || "localhost";
  const portFromConfig = persisted.server?.port === undefined
    ? undefined
    : String(persisted.server.port);
  return {
    appName: input.appName,
    envPrefix,
    appDirectoryName,
    host,
    port: parsePort(readEnv(environment, envPrefix, "PORT") ?? portFromConfig, envName(envPrefix, "PORT")),
    dataDir,
    configPath: webAppConfigPath(dataDir),
    developmentSourcePath: persisted.development?.sourcePath,
    logLevel,
    logLevelFromEnv: Boolean(logLevelRaw),
    inMemoryLogsEnabled,
    passkeyDisabled: isTruthyEnv(readEnv(environment, envPrefix, "DISABLE_PASSKEY")),
    sameOriginDisabled: isTruthyEnv(readEnv(environment, envPrefix, "DISABLE_SAME_ORIGIN_CHECK")),
    publicBaseUrl,
    authIssuer: readEnv(environment, envPrefix, "AUTH_ISSUER"),
    trustProxy,
    development: environment["NODE_ENV"] === "production" ? false : { hmr: true, console: true },
  };
}

export function safeRuntimeConfig(config: RuntimeConfig): Record<string, unknown> {
  return {
    appName: config.appName,
    envPrefix: config.envPrefix,
    appDirectoryName: config.appDirectoryName,
    host: config.host,
    port: config.port,
    dataDir: config.dataDir,
    configPath: config.configPath,
    developmentSourcePath: config.developmentSourcePath,
    logLevel: config.logLevel,
    logLevelFromEnv: config.logLevelFromEnv,
    inMemoryLogsEnabled: config.inMemoryLogsEnabled,
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
