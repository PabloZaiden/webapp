import { afterEach, describe, expect, test } from "bun:test";
import { createLogger, setLogLevel } from "../src/web/logger";

afterEach(() => {
  setLogLevel("info");
});

describe("web logger", () => {
  test("applies the effective level to attached sinks", () => {
    const logger = createLogger("test");
    const lines: string[] = [];
    const detach = logger.attachTransport({
      format: "json",
      write: (_record, line) => {
        lines.push(line);
      },
    });

    try {
      setLogLevel("warn");
      logger.info("filtered message");
      logger.warn("warning message");
      logger.error("error message");
      expect(lines).toHaveLength(2);
      expect(lines.some((line) => line.includes("warning message"))).toBe(true);
      expect(lines.some((line) => line.includes("error message"))).toBe(true);

      setLogLevel("debug");
      logger.debug("debug message");
      expect(lines).toHaveLength(3);
      expect(lines.some((line) => line.includes("debug message"))).toBe(true);
    } finally {
      detach();
    }
  });

  test("rejects invalid log levels", () => {
    expect(() => setLogLevel("verbose" as never)).toThrow("Invalid log level: verbose");
  });
});
