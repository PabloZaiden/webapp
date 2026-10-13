import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger, type ILogObj, type ILogObjMeta, type IMeta, type Transport } from "tslog";
import {
  DEFAULT_LOG_LEVEL,
  LOG_LEVEL_NAMES,
  LOG_LEVELS,
  VALID_LOG_LEVELS,
  type LogLevelName,
  type ServerLogEntry,
} from "../contracts";

let serverLogStorageEnabled = false;
let serverLogDirectory: string | undefined;
let serverLogFilePath: string | undefined;
const subLoggers = new Map<string, Logger<ILogObj>>();

export interface ServerLogStorage {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  getEntries(): ServerLogEntry[];
  reset(): void;
}

function isLogLevelName(value: unknown): value is LogLevelName {
  return typeof value === "string" && VALID_LOG_LEVELS.includes(value as LogLevelName);
}

function removeServerLogDirectory(): void {
  const directory = serverLogDirectory;
  if (!directory) {
    serverLogFilePath = undefined;
    return;
  }
  rmSync(directory, { recursive: true, force: true });
  serverLogDirectory = undefined;
  serverLogFilePath = undefined;
}

function createServerLogFile(): { directory: string; filePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "webapp-server-logs-"));
  const filePath = join(directory, "server-logs.jsonl");
  serverLogDirectory = directory;
  serverLogFilePath = filePath;
  try {
    writeFileSync(filePath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    try {
      removeServerLogDirectory();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Unable to create server log storage and clean up its temporary directory",
      );
    }
    throw error;
  }
  return { directory, filePath };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseServerLogEntry(line: string): ServerLogEntry {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value)) {
    throw new TypeError("The server log file contains an invalid entry");
  }
  const timestamp = value["timestamp"];
  const level = value["level"];
  const scope = value["scope"];
  const message = value["message"];
  const renderedLine = value["line"];
  if (
    typeof timestamp !== "string"
    || !isLogLevelName(level)
    || typeof scope !== "string"
    || typeof message !== "string"
    || typeof renderedLine !== "string"
  ) {
    throw new TypeError("The server log file contains an invalid entry");
  }
  return { timestamp, level, scope, message, line: renderedLine };
}

function removeStorageAfterWriteFailure(error: unknown): void {
  serverLogStorageEnabled = false;
  console.error("[webapp] Server log capture failed; disabling capture.", error);
  try {
    removeServerLogDirectory();
  } catch (cleanupError) {
    console.error("[webapp] Unable to remove failed server log capture.", cleanupError);
  }
}

function appendServerLogEntry(entry: ServerLogEntry): void {
  if (!serverLogStorageEnabled) {
    return;
  }
  const filePath = serverLogFilePath;
  if (!filePath) {
    removeStorageAfterWriteFailure(new Error("Server log capture is enabled without a temporary file"));
    return;
  }
  const serialized = JSON.stringify(entry);
  if (serialized === undefined) {
    removeStorageAfterWriteFailure(new TypeError("Server log entries must be JSON serializable"));
    return;
  }
  try {
    appendFileSync(filePath, `${serialized}\n`, "utf8");
  } catch (error) {
    removeStorageAfterWriteFailure(error);
  }
}

function getServerLogEntries(): ServerLogEntry[] {
  if (!serverLogStorageEnabled) {
    return [];
  }
  const filePath = serverLogFilePath;
  if (!filePath) {
    throw new Error("Server log capture is enabled without a temporary file");
  }
  const contents = readFileSync(filePath, "utf8");
  if (contents === "") {
    return [];
  }
  const lines = contents.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.map(parseServerLogEntry);
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

function logRecordMessage(record: ILogObj & ILogObjMeta): string {
  if (Object.hasOwn(record, "0")) {
    return formatValue(record["0"]);
  }
  if (Object.hasOwn(record, "nativeError") && typeof record["message"] === "string") {
    return formatValue({
      name: record["name"],
      message: record["message"],
    });
  }
  const payload: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key !== "_logMeta") {
      payload[key] = record[key];
    }
  }
  return formatValue(payload);
}

function getTslogMetadata(record: ILogObj & ILogObjMeta): IMeta | undefined {
  const metadata = record["_logMeta"];
  if (
    !metadata ||
    typeof metadata.logLevelId !== "number" ||
    typeof metadata.logLevelName !== "string" ||
    !(metadata.date instanceof Date)
  ) {
    return undefined;
  }
  return metadata;
}

function appendTslogEntry(record: ILogObj & ILogObjMeta, line: string): void {
  const metadata = getTslogMetadata(record);
  if (!metadata) {
    return;
  }
  const level = LOG_LEVEL_NAMES[metadata.logLevelId] ?? (metadata.logLevelName.toLowerCase() as LogLevelName);
  if (!isLogLevelName(level)) {
    return;
  }
  const timestamp = metadata.date.toISOString();
  const scope = typeof metadata.name === "string" && metadata.name ? metadata.name : "webapp";
  const message = logRecordMessage(record);
  appendServerLogEntry({
    timestamp,
    level,
    scope,
    message,
    line,
  });
}

const consoleTransport: Transport<ILogObj> = {
  name: "webapp-console",
  format: "pretty",
  write(record, line) {
    const metadata = getTslogMetadata(record);
    const level = LOG_LEVEL_NAMES[metadata?.logLevelId ?? LOG_LEVELS.info] ?? DEFAULT_LOG_LEVEL;
    if (level === "fatal" || level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
    appendTslogEntry(record, line);
  },
};

export const log = new Logger<ILogObj>({
  type: "hidden",
  name: "webapp",
  minLevel: LOG_LEVELS[DEFAULT_LOG_LEVEL],
  pretty: {
    timeZone: "UTC",
    style: false,
    inspectOptions: { colors: false, compact: true, depth: Infinity },
  },
  attachedTransports: [consoleTransport],
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

export function setServerLogStorageEnabled(enabled: boolean): void {
  if (enabled) {
    if (serverLogStorageEnabled && serverLogFilePath) {
      return;
    }
    removeServerLogDirectory();
    const storage = createServerLogFile();
    serverLogDirectory = storage.directory;
    serverLogFilePath = storage.filePath;
    serverLogStorageEnabled = true;
    return;
  }
  serverLogStorageEnabled = false;
  removeServerLogDirectory();
}

export function isServerLogStorageEnabled(): boolean {
  return serverLogStorageEnabled;
}

export function resetServerLogStorage(): void {
  serverLogStorageEnabled = false;
  removeServerLogDirectory();
}

export const serverLogStorage: ServerLogStorage = {
  isEnabled: isServerLogStorageEnabled,
  setEnabled: setServerLogStorageEnabled,
  getEntries: getServerLogEntries,
  reset: resetServerLogStorage,
};

process.once("exit", () => {
  try {
    resetServerLogStorage();
  } catch (error) {
    console.error("[webapp] Unable to remove temporary server log storage on exit.", error);
  }
});
