import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  createWebAppServer,
  defineRoutes,
  sqliteWebAppStore,
} from "@pablozaiden/webapp/server";

const dataDirs: string[] = [];
const testWeb = { entry: new URL("./fixtures/web/main.tsx", import.meta.url) };

afterEach(() => {
  for (const dataDir of dataDirs.splice(0)) {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

function lifecycleApp(
  envPrefix: string,
  lifecycle: NonNullable<Parameters<typeof createWebAppServer>[0]["lifecycle"]>,
) {
  const dataDir = `.cache/tests/${envPrefix.toLowerCase()}-${crypto.randomUUID()}`;
  dataDirs.push(dataDir);
  process.env[`${envPrefix}_HOST`] = "127.0.0.1";
  process.env[`${envPrefix}_PORT`] = "0";
  return createWebAppServer({
    appName: "Lifecycle Test",
    envPrefix,
    web: testWeb,
    store: sqliteWebAppStore({ dataDir }),
    auth: { passkeys: false },
    routes: defineRoutes({}),
    lifecycle,
  });
}

describe("server lifecycle hooks", () => {
  test("orders start and deterministic stop hooks around the Bun server", async () => {
    const events: string[] = [];
    const app = lifecycleApp("TEST_LIFECYCLE_ORDER", {
      beforeStart: () => {
        events.push("beforeStart");
      },
      afterStart: (server) => {
        expect(server.url).toBeDefined();
        events.push("afterStart");
      },
      beforeStop: () => {
        events.push("beforeStop");
      },
      afterStop: () => {
        events.push("afterStop");
      },
    });

    await app.start();
    await app.stop(true);

    expect(events).toEqual([
      "beforeStart",
      "afterStart",
      "beforeStop",
      "afterStop",
    ]);
  });

  test("cleans up a started server and surfaces an afterStart failure", async () => {
    const events: string[] = [];
    const app = lifecycleApp("TEST_LIFECYCLE_AFTER_START", {
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

    await expect(app.start()).rejects.toThrow("worker startup failed");
    expect(events).toEqual([
      "beforeStart",
      "afterStart",
      "beforeStop",
      "afterStop",
    ]);
    await app.stop(true);
  });

  test("continues cleanup and surfaces stop-hook failures", async () => {
    const events: string[] = [];
    const app = lifecycleApp("TEST_LIFECYCLE_STOP_ERROR", {
      beforeStop: () => {
        events.push("beforeStop");
        throw new Error("before stop failed");
      },
      afterStop: () => {
        events.push("afterStop");
      },
    });

    await app.start();
    await expect(app.stop(true)).rejects.toThrow("before stop failed");
    expect(events).toEqual(["beforeStop", "afterStop"]);
  });
});
