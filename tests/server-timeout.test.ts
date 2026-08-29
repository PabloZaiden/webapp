import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS,
  MAX_SERVER_IDLE_TIMEOUT_SECONDS,
  createWebAppServer,
  defineRoutes,
  resolveServerIdleTimeout,
  sqliteWebAppStore,
} from "../src/server";

const dataDirs: string[] = [];
const originalServe = Bun.serve;

afterEach(() => {
  if (Bun.serve !== originalServe) {
    Bun.serve = originalServe;
  }
  for (const dataDir of dataDirs.splice(0)) {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

function createApp(idleTimeout: number | undefined) {
  const dataDir = join(".cache/tests", `server-timeout-${crypto.randomUUID()}`);
  dataDirs.push(dataDir);
  const envPrefix = `TEST_SERVER_TIMEOUT_${crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  return createWebAppServer({
    appName: "Server Timeout Test",
    envPrefix,
    runtimeConfig: {
      appName: "Server Timeout Test",
      envPrefix,
      host: "127.0.0.1",
      port: 0,
      dataDir,
      logLevel: "info",
      logLevelFromEnv: false,
      inMemoryLogsEnabled: false,
      passkeyDisabled: true,
      sameOriginDisabled: true,
      trustProxy: { enabled: false, headers: [], chain: "first" },
      development: false,
    },
    web: { entry: new URL("./fixtures/web/main.tsx", import.meta.url) },
    server: { idleTimeout },
    store: sqliteWebAppStore({ dataDir }),
    auth: { passkeys: false },
    routes: defineRoutes({}),
  });
}

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
    expect(() => resolveServerIdleTimeout(value)).toThrow();
  }
});

test("passes the resolved idle timeout to Bun.serve when the server starts", async () => {
  const observed: number[] = [];
  Bun.serve = ((options: Parameters<typeof Bun.serve>[0]) => {
    observed.push(options.idleTimeout ?? -1);
    return originalServe(options);
  }) as typeof Bun.serve;

  const defaultApp = createApp(undefined);
  const configuredApp = createApp(120);
  let defaultServer: Awaited<ReturnType<typeof defaultApp.start>> | undefined;
  let configuredServer: Awaited<ReturnType<typeof configuredApp.start>> | undefined;
  try {
    defaultServer = await defaultApp.start();
    configuredServer = await configuredApp.start();

    expect(observed).toEqual([
      DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS,
      120,
    ]);
  } finally {
    Bun.serve = originalServe;
    await defaultServer?.stop(true);
    await configuredServer?.stop(true);
  }
});
