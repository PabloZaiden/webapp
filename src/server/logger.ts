import type { LogLevelName } from "../contracts";

const ORDER: Record<LogLevelName, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

let currentLevel: LogLevelName = "info";

export function setLogLevel(level: LogLevelName): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevelName {
  return currentLevel;
}

export function createLogger(scope: string) {
  function log(level: LogLevelName, message: string, fields?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[currentLevel]) {
      return;
    }
    const timestamp = new Date().toISOString();
    const suffix = fields ? ` ${JSON.stringify(fields)}` : "";
    const line = `${timestamp}\t${level.toUpperCase()}\t${scope}\t${message}${suffix}`;
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
