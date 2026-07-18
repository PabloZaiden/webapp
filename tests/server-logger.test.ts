import { afterEach, describe, expect, test } from "bun:test";
import {
  createLogger,
  getInMemoryLogEntries,
  MAX_IN_MEMORY_LOG_BYTES,
  MAX_IN_MEMORY_LOG_ENTRIES,
  resetInMemoryLogStorage,
  setInMemoryLogStorageEnabled,
  setLogLevel,
} from "../src/server/logger";

function silenceConsole(): () => void {
  const previousLog = console.log;
  const previousWarn = console.warn;
  const previousError = console.error;
  console.log = (() => undefined) as typeof console.log;
  console.warn = (() => undefined) as typeof console.warn;
  console.error = (() => undefined) as typeof console.error;
  return () => {
    console.log = previousLog;
    console.warn = previousWarn;
    console.error = previousError;
  };
}

afterEach(() => {
  resetInMemoryLogStorage();
  setLogLevel("info");
});

describe("in-memory server logs", () => {
  test("starts disabled and does not retain entries", () => {
    const restoreConsole = silenceConsole();
    try {
      const logger = createLogger("test");
      logger.info("not retained");

      expect(getInMemoryLogEntries()).toEqual([]);
    } finally {
      restoreConsole();
    }
  });

  test("captures eligible entries and clears them when disabled", () => {
    const restoreConsole = silenceConsole();
    try {
      setInMemoryLogStorageEnabled(true);
      const logger = createLogger("test");
      logger.debug("filtered");
      logger.info("retained", { requestId: "request-1" });

      const entries = getInMemoryLogEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        level: "info",
        scope: "test",
        message: "retained",
      });
      expect(entries[0]?.line).toContain("request-1");

      entries[0]!.message = "mutated copy";
      expect(getInMemoryLogEntries()[0]?.message).toBe("retained");

      setInMemoryLogStorageEnabled(false);
      expect(getInMemoryLogEntries()).toEqual([]);
    } finally {
      restoreConsole();
    }
  });

  test("keeps the newest entries within the entry and byte bounds", () => {
    const restoreConsole = silenceConsole();
    try {
      setInMemoryLogStorageEnabled(true);
      const logger = createLogger("test");
      for (let index = 0; index < MAX_IN_MEMORY_LOG_ENTRIES + 5; index += 1) {
        logger.info(`entry-${index}`);
      }

      const entries = getInMemoryLogEntries();
      expect(entries).toHaveLength(MAX_IN_MEMORY_LOG_ENTRIES);
      expect(entries[0]?.message).toBe("entry-5");
      expect(entries.at(-1)?.message).toBe(`entry-${MAX_IN_MEMORY_LOG_ENTRIES + 4}`);

      logger.info("x".repeat(MAX_IN_MEMORY_LOG_BYTES));
      expect(getInMemoryLogEntries()).toEqual(entries);
    } finally {
      restoreConsole();
    }
  });

  test("reset returns the process-local state to disabled and empty", () => {
    const restoreConsole = silenceConsole();
    try {
      setInMemoryLogStorageEnabled(true);
      createLogger("test").info("retained before reset");

      resetInMemoryLogStorage();

      expect(getInMemoryLogEntries()).toEqual([]);
    } finally {
      restoreConsole();
    }
  });
});
