import { describe, expect, test } from "bun:test";
import {
  cliAuthEnvironmentNames,
  resolveEnvironmentApiKeyAuth,
} from "@pablozaiden/webapp/cli";

describe("CLI environment API-key auth", () => {
  test("derives the fixed environment variable names", () => {
    expect(cliAuthEnvironmentNames("NOTES_TODO")).toEqual({
      baseUrl: "NOTES_TODO_BASE_URL",
      apiKey: "NOTES_TODO_API_KEY",
    });
  });

  test("trims and normalizes a complete environment pair", () => {
    expect(resolveEnvironmentApiKeyAuth({
      envPrefix: "NOTES_TODO",
      environment: {
        NOTES_TODO_BASE_URL: "  https://example.test///  ",
        NOTES_TODO_API_KEY: "  test-key  ",
      },
    })).toEqual({
      baseUrl: "https://example.test",
      apiKey: "test-key",
      source: "environment",
    });
  });

  test("uses an explicit base URL with the environment API key", () => {
    expect(resolveEnvironmentApiKeyAuth({
      envPrefix: "NOTES_TODO",
      explicitBaseUrl: "https://explicit.example.test///",
      environment: {
        NOTES_TODO_BASE_URL: "https://ignored.example.test",
        NOTES_TODO_API_KEY: "test-key",
      },
    })).toEqual({
      baseUrl: "https://explicit.example.test",
      apiKey: "test-key",
      source: "explicit-base-url",
    });
  });

  test("treats missing, empty, and partial pairs as absent", () => {
    const cases = [
      {},
      { NOTES_TODO_BASE_URL: "" },
      { NOTES_TODO_API_KEY: "test-key" },
      { NOTES_TODO_BASE_URL: "https://example.test" },
      { NOTES_TODO_BASE_URL: "https://example.test", NOTES_TODO_API_KEY: " " },
    ];

    for (const environment of cases) {
      expect(resolveEnvironmentApiKeyAuth({
        envPrefix: "NOTES_TODO",
        environment,
      })).toBeUndefined();
    }
  });

  test("rejects an invalid prefix and malformed complete URL", () => {
    expect(() => cliAuthEnvironmentNames("notes-todo")).toThrow("envPrefix");
    expect(() => resolveEnvironmentApiKeyAuth({
      envPrefix: "NOTES_TODO",
      environment: {
        NOTES_TODO_BASE_URL: "file:///tmp/app",
        NOTES_TODO_API_KEY: "test-key",
      },
    })).toThrow("Invalid base URL protocol");
  });
});
