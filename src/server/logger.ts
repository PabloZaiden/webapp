import type { LogLevelName, ServerLogEntry } from "../contracts";

const ORDER: Record<LogLevelName, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

export const MAX_IN_MEMORY_LOG_ENTRIES = 1_000;
export const MAX_IN_MEMORY_LOG_BYTES = 512 * 1024;

let currentLevel: LogLevelName = "info";
let inMemoryLogStorageEnabled = false;
let inMemoryLogEntries: ServerLogEntry[] = [];
let inMemoryLogBytes = 0;
const textEncoder = new TextEncoder();

export interface InMemoryLogStorage {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  getEntries(): ServerLogEntry[];
  reset(): void;
}

export function setLogLevel(level: LogLevelName): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevelName {
  return currentLevel;
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

export function createLogger(scope: string) {
  function log(level: LogLevelName, message: string, fields?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[currentLevel]) {
      return;
    }
    const timestamp = new Date().toISOString();
    const suffix = fields ? ` ${JSON.stringify(fields)}` : "";
    const line = `${timestamp}\t${level.toUpperCase()}\t${scope}\t${message}${suffix}`;
    appendInMemoryLogEntry({ timestamp, level, scope, message, line });
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }
  return {
    trace: (message: string, fields?: Record<string, unknown>) => log("trace", message, fields),
    debug: (message: string, fields?: Record<string, unknown>) => log("debug", message, fields),
    info: (message: string, fields?: Record<string, unknown>) => log("info", message, fields),
    warn: (message: string, fields?: Record<string, unknown>) => log("warn", message, fields),
    error: (message: string, fields?: Record<string, unknown>) => log("error", message, fields),
  };
}
