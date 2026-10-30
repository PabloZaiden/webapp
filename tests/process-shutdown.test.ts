import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const fixtureSource = `
import { createWebAppServer, memoryWebAppStore } from "@pablozaiden/webapp/server";
import { join } from "node:path";
import { rename } from "node:fs/promises";
const directory = process.env["SHUTDOWN_FIXTURE_DIR"];
if (!directory) throw new Error("Missing shutdown fixture directory");
const urls = [];
for (const id of ["first", "second"]) {
  const app = createWebAppServer({
    appName: "Shutdown Fixture",
    envPrefix: "SHUTDOWN_FIXTURE",
    runtimeConfig: {
      appName: "Shutdown Fixture",
      envPrefix: "SHUTDOWN_FIXTURE",
      host: "127.0.0.1",
      port: 0,
      dataDir: join(directory, id),
      logLevel: "error",
      logLevelFromEnv: false,
      passkeyDisabled: true,
      sameOriginDisabled: false,
      trustProxy: { enabled: false, headers: [], chain: "first" },
      development: false,
    },
    web: false,
    store: memoryWebAppStore(),
    lifecycle: {
      beforeStop: async () => {
        await Bun.write(join(directory, id + ".closed"), "resource released");
        if (id === "first" && process.env["SHUTDOWN_FIXTURE_FAIL"] === "true") {
          throw new Error("Fixture resource cleanup failed");
        }
      },
      afterStop: async () => {
        await Bun.write(join(directory, id + ".stopped"), "server stopped");
      },
    },
  });
  const server = await app.start();
  urls.push(server.url.toString());
}
await Bun.write(join(directory, "ready.tmp"), JSON.stringify(urls));
await rename(join(directory, "ready.tmp"), join(directory, "ready.json"));
`;

async function waitForReady(path: string, child: ReturnType<typeof Bun.spawn>): Promise<string[]> {
  const deadline = Date.now() + 10_000;
  while (!await Bun.file(path).exists()) {
    if (child.exitCode !== null || child.signalCode) {
      throw new Error(`Shutdown fixture exited during startup: ${String(child.exitCode ?? child.signalCode)}`);
    }
    if (Date.now() >= deadline) throw new Error("Timed out waiting for shutdown fixture listeners");
    await Bun.sleep(25);
  }
  const value: unknown = await Bun.file(path).json();
  if (!Array.isArray(value) || !value.every((url: unknown) => typeof url === "string")) {
    throw new Error("Shutdown fixture returned invalid listener URLs");
  }
  return value;
}

async function waitForExit(child: ReturnType<typeof Bun.spawn>): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for graceful process shutdown")), 10_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

for (const scenario of [
  { trigger: "SIGTERM", failure: false },
  { trigger: "HTTP", failure: false },
  { trigger: "SIGTERM", failure: true },
] as const) {
  test(`gracefully closes all servers on ${scenario.trigger}${scenario.failure ? " with a cleanup failure" : ""}`, async () => {
    const directory = resolve(".cache/tests", `process-shutdown-${crypto.randomUUID()}`);
    await mkdir(directory, { recursive: true });
    const fixturePath = resolve(directory, "app.ts");
    await Bun.write(fixturePath, fixtureSource);
    const child = Bun.spawn([process.execPath, fixturePath], {
      env: {
        ...process.env,
        SHUTDOWN_FIXTURE_DIR: directory,
        SHUTDOWN_FIXTURE_FAIL: String(scenario.failure),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    try {
      const urls = await waitForReady(resolve(directory, "ready.json"), child);
      expect(urls).toHaveLength(2);
      for (const url of urls) {
        const response = await fetch(new URL("/api/health", url), { signal: AbortSignal.timeout(5_000) });
        expect(response.status).toBe(200);
        await response.text();
      }
      if (scenario.trigger === "SIGTERM") {
        child.kill("SIGTERM");
      } else {
        const response = await fetch(new URL("/api/server/kill", urls[0]), {
          method: "POST",
          headers: { Origin: new URL(urls[0]!).origin },
          signal: AbortSignal.timeout(5_000),
        });
        expect(response.status).toBe(200);
        await response.text();
      }
      expect(await waitForExit(child)).toBe(scenario.failure ? 1 : 0);
      for (const id of ["first", "second"]) {
        expect(await Bun.file(resolve(directory, `${id}.closed`)).text()).toBe("resource released");
        expect(await Bun.file(resolve(directory, `${id}.stopped`)).text()).toBe("server stopped");
      }
    } catch (error) {
      child.kill("SIGKILL");
      const logs = await output;
      throw new Error(`Process shutdown journey failed:\n${logs.join("\n")}`, { cause: error });
    } finally {
      if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
      await child.exited;
      await output;
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
}
