import { afterEach, describe, expect, test } from "bun:test";
import { LOG_LEVELS } from "../src/contracts";
import { createLogger, getLogLevel, setLogLevel } from "../src/web/logger";

afterEach(() => {
  setLogLevel("info");
});

describe("web logger", () => {
  test("caches scoped loggers and synchronizes their level", () => {
    const logger = createLogger("test");

    expect(createLogger("test")).toBe(logger);

    setLogLevel("debug");
    expect(getLogLevel()).toBe("debug");
    expect(logger.settings.minLevel).toBe(LOG_LEVELS.debug);

    setLogLevel("fatal");
    expect(getLogLevel()).toBe("fatal");
    expect(logger.settings.minLevel).toBe(LOG_LEVELS.fatal);
  });

  test("rejects invalid log levels", () => {
    expect(() => setLogLevel("verbose" as never)).toThrow("Invalid log level: verbose");
  });
});
