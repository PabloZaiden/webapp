import { expect, test } from "bun:test";
import {
  DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS,
  MAX_SERVER_IDLE_TIMEOUT_SECONDS,
  resolveServerIdleTimeout,
} from "../src/server";

test("defaults the server idle timeout to Bun's maximum", () => {
  expect(resolveServerIdleTimeout(undefined)).toBe(DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS);
  expect(DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS).toBe(MAX_SERVER_IDLE_TIMEOUT_SECONDS);
});

test("accepts configurable server idle timeout values", () => {
  expect(resolveServerIdleTimeout(0)).toBe(0);
  expect(resolveServerIdleTimeout(120)).toBe(120);
  expect(resolveServerIdleTimeout(MAX_SERVER_IDLE_TIMEOUT_SECONDS)).toBe(MAX_SERVER_IDLE_TIMEOUT_SECONDS);
});

test("rejects unsupported server idle timeout values", () => {
  for (const value of [-1, 1.5, MAX_SERVER_IDLE_TIMEOUT_SECONDS + 1]) {
    expect(() => resolveServerIdleTimeout(value)).toThrow(
      "server.idleTimeout must be an integer",
    );
  }
});
