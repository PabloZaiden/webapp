import { inspect } from "node:util";
import { Logger, type ILogObj, type IMeta } from "tslog";
import {
  DEFAULT_LOG_LEVEL,
  LOG_LEVEL_NAMES,
  LOG_LEVELS,
  VALID_LOG_LEVELS,
  type LogLevelName,
  type ServerLogEntry,
} from "../contracts";

export const MAX_IN_MEMORY_LOG_ENTRIES = 1_000;
export const MAX_IN_MEMORY_LOG_BYTES = 512 * 1024;

let inMemoryLogStorageEnabled = false;
let inMemoryLogEntries: ServerLogEntry[] = [];
let inMemoryLogBytes = 0;
const textEncoder = new TextEncoder();
const subLoggers = new Map<string, Logger<ILogObj>>();

export interface InMemoryLogStorage {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  getEntries(): ServerLogEntry[];
  reset(): void;
}

function isLogLevelName(value: unknown): value is LogLevelName {
  return typeof value === "string" && VALID_LOG_LEVELS.includes(value as LogLevelName);
}

function lineByteLength(line: string): number {
  return textEncoder.encode(line).byteLength;
}

function appendInMemoryLogEntry(entry: ServerLogEntry): void {
  if (!inMemoryLogStorageEnabled) {
    return;
  }
  const entryBytes = lineByteLength(entry.line);
  if (entryBytes > MAX_IN_MEMORY_LOG_BYTES) {
    return;
  }
  inMemoryLogEntries.push(entry);
  inMemoryLogBytes += entryBytes;
  while (inMemoryLogEntries.length > MAX_IN_MEMORY_LOG_ENTRIES || inMemoryLogBytes > MAX_IN_MEMORY_LOG_BYTES) {
    const removed = inMemoryLogEntries.shift();
    if (!removed) {
      break;
    }
    inMemoryLogBytes -= lineByteLength(removed.line);
  }
}

function formatValue(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  if (typeof value === "object" && value !== null && "message" in value) {
    const record = value as { message?: unknown; name?: unknown };
    if (typeof record.message === "string") {
      return typeof record.name === "string" ? `${record.name}: ${record.message}` : record.message;
    }
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function appendTslogEntry(metadata: IMeta, line: string, logArgs: unknown[], logErrors: string[]): void {
  const level = LOG_LEVEL_NAMES[metadata.logLevelId] ?? (metadata.logLevelName.toLowerCase() as LogLevelName);
  if (!isLogLevelName(level)) {
    return;
  }
  const timestamp = metadata.date.toISOString();
  const scope = typeof metadata.name === "string" && metadata.name ? metadata.name : "webapp";
  const message = formatValue(logArgs[0] ?? logErrors[0] ?? "");
  appendInMemoryLogEntry({
    timestamp,
    level,
    scope,
    message,
    line,
  });
}

function renderConsoleValue(value: unknown): string {
  return typeof value === "string" ? value : inspect(value, { colors: false, compact: true, depth: Infinity });
}

function transportFormatted(logMetaMarkup: string, logArgs: unknown[], logErrors: string[], logMeta?: IMeta): void {
  const errors = (logErrors.length > 0 && logArgs.length > 0 ? "\n" : "") + logErrors.join("\n");
  const line = `${logMetaMarkup}${logArgs.map(renderConsoleValue).join(" ")}${errors}`;
  const level = LOG_LEVEL_NAMES[logMeta?.logLevelId ?? LOG_LEVELS.info] ?? DEFAULT_LOG_LEVEL;
  if (level === "fatal" || level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
  if (logMeta) {
    appendTslogEntry(logMeta, line, logArgs, logErrors);
  }
}

export const log = new Logger<ILogObj>({
  name: "webapp",
  minLevel: LOG_LEVELS[DEFAULT_LOG_LEVEL],
  prettyLogTimeZone: "UTC",
  stylePrettyLogs: false,
  prettyInspectOptions: { colors: false, compact: true, depth: Infinity },
  overwrite: { transportFormatted },
});

export function createLogger(scope: string): Logger<ILogObj> {
  const existing = subLoggers.get(scope);
  if (existing) {
    return existing;
  }
  const logger = log.getSubLogger({ name: scope });
  subLoggers.set(scope, logger);
  return logger;
}

export function setLogLevel(level: LogLevelName): void {
  if (!isLogLevelName(level)) {
    throw new Error(`Invalid log level: ${String(level)}`);
  }
  const numericLevel = LOG_LEVELS[level];
  log.settings.minLevel = numericLevel;
  for (const subLogger of subLoggers.values()) {
    subLogger.settings.minLevel = numericLevel;
  }
}

export function getLogLevel(): LogLevelName {
  return LOG_LEVEL_NAMES[log.settings.minLevel] ?? DEFAULT_LOG_LEVEL;
}

export function setInMemoryLogStorageEnabled(enabled: boolean): void {
  inMemoryLogStorageEnabled = enabled;
  if (!enabled) {
    inMemoryLogEntries = [];
    inMemoryLogBytes = 0;
  }
}

export function isInMemoryLogStorageEnabled(): boolean {
  return inMemoryLogStorageEnabled;
}

export function getInMemoryLogEntries(): ServerLogEntry[] {
  return inMemoryLogEntries.map((entry) => ({ ...entry }));
}

export function resetInMemoryLogStorage(): void {
  inMemoryLogStorageEnabled = false;
  inMemoryLogEntries = [];
  inMemoryLogBytes = 0;
}

export const inMemoryLogStorage: InMemoryLogStorage = {
  isEnabled: isInMemoryLogStorageEnabled,
  setEnabled: setInMemoryLogStorageEnabled,
  getEntries: getInMemoryLogEntries,
  reset: resetInMemoryLogStorage,
};
