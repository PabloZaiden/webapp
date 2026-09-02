import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  createWebAppServer,
  defineRoutes,
  sqliteWebAppStore,
  type WebAppServerLifecycleHooks,
} from "@pablozaiden/webapp/server";

const testWeb = { entry: new URL("./fixtures/web/main.tsx", import.meta.url) };

function createLifecycleApp(
  envPrefix: string,
  lifecycle: WebAppServerLifecycleHooks,
): { app: ReturnType<typeof createWebAppServer>; dataDir: string } {
  const dataDir = resolve(".cache/tests", `server-lifecycle-${crypto.randomUUID()}`);
  const app = createWebAppServer({
    appName: "Lifecycle Test",
    envPrefix,
    runtimeConfig: {
      appName: "Lifecycle Test",
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
    web: testWeb,
    store: sqliteWebAppStore({ dataDir }),
    auth: { passkeys: false },
    routes: defineRoutes({}),
    lifecycle,
  });
  return { app, dataDir };
}

test("runs lifecycle hooks around a real server start and stop", async () => {
  const events: string[] = [];
  const { app, dataDir } = createLifecycleApp("TEST_SERVER_LIFECYCLE", {
    beforeStart: () => {
      events.push("beforeStart");
    },
    afterStart: (server) => {
      expect(server.url.protocol).toBe("http:");
      events.push("afterStart");
    },
    beforeStop: () => {
      events.push("beforeStop");
    },
    afterStop: () => {
      events.push("afterStop");
    },
  });

  try {
    await app.start();
    await app.stop(true);
    expect(events).toEqual(["beforeStart", "afterStart", "beforeStop", "afterStop"]);
  } finally {
    await app.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cleans up the server when an afterStart hook fails", async () => {
  const events: string[] = [];
  const { app, dataDir } = createLifecycleApp("TEST_SERVER_LIFECYCLE_FAILURE", {
    beforeStart: () => {
      events.push("beforeStart");
    },
    afterStart: () => {
      events.push("afterStart");
      throw new Error("worker startup failed");
    },
    beforeStop: () => {
      events.push("beforeStop");
    },
    afterStop: () => {
      events.push("afterStop");
    },
  });

  try {
    await expect(app.start()).rejects.toThrow("worker startup failed");
    expect(events).toEqual(["beforeStart", "afterStart", "beforeStop", "afterStop"]);
    await app.stop(true);
  } finally {
    await app.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
  }
});
