export * from "./client-bootstrap";
export * from "./realtime";
export * from "./response-metadata";
export * from "./sidebar-pins";

export const VALID_LOG_LEVELS = ["silly", "trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevelName = typeof VALID_LOG_LEVELS[number];
export const LOG_LEVELS: Record<LogLevelName, number> = {
  silly: 0, trace: 1, debug: 2, info: 3, warn: 4, error: 5, fatal: 6,
};
export const LOG_LEVEL_NAMES: Record<number, LogLevelName> = {
  0: "silly", 1: "trace", 2: "debug", 3: "info", 4: "warn", 5: "error", 6: "fatal",
};
export const DEFAULT_LOG_LEVEL: LogLevelName = "info";
export type ThemePreference = "system" | "light" | "dark";
export const DEFAULT_THEME_PREFERENCE: ThemePreference = "dark";

export interface ServerLogEntry {
  timestamp: string;
  level: LogLevelName;
  scope: string;
  message: string;
  line: string;
}

export interface WebAppConfigResponse {
  appName: string;
  version: string;
  publicBasePath: string;
  realtime: { path: string };
  logLevel: { level: LogLevelName; fromEnv: boolean };
}

export interface WebAppErrorResponse {
  error: string;
  message: string;
  details?: unknown;
}
