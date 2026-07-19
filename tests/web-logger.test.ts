import { afterEach, describe, expect, test } from "bun:test";
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
    expect(logger.settings.minLevel).toBe(2);

    setLogLevel("fatal");
    expect(getLogLevel()).toBe("fatal");
    expect(logger.settings.minLevel).toBe(6);
  });

  test("rejects invalid log levels", () => {
    expect(() => setLogLevel("verbose" as never)).toThrow("Invalid log level: verbose");
  });
});
