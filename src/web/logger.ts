import { Logger, type ILogObj } from "tslog";
import {
  DEFAULT_LOG_LEVEL,
  LOG_LEVEL_NAMES,
  LOG_LEVELS,
  VALID_LOG_LEVELS,
  type LogLevelName,
} from "../contracts";

const subLoggers = new Map<string, Logger<ILogObj>>();

function isLogLevelName(value: unknown): value is LogLevelName {
  return typeof value === "string" && VALID_LOG_LEVELS.includes(value as LogLevelName);
}

export const log = new Logger<ILogObj>({
  name: "webapp",
  minLevel: LOG_LEVELS[DEFAULT_LOG_LEVEL],
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
