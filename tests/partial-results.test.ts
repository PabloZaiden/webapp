import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createRouteCatalog, createWebAppServer, defineRoutes, jsonResponse, memoryWebAppStore,
} from "@pablozaiden/webapp/server";
import { appJsonWithMetadata } from "../src/web/api-client";

// Product contract: an unavailable source must not turn an incomplete collection
// into a successful CLI result or require changing the existing array body.
test("partial collections retain JSON bodies and surface metadata to web and CLI clients", async () => {
  const directory = resolve(".cache/tests", `partial-results-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  let partial = true;
  const routes = defineRoutes({
    "/api/documents": {
      auth: "user", sameOrigin: "mutations",
      partialResults: { header: "X-Clanky-Partial" },
      GET: () => jsonResponse([{ id: "local" }], { headers: partial ? { "X-Clanky-Partial": "true" } : {} }),
      POST() { partial = false; return jsonResponse({ available: true }); },
    },
  });
  const app = createWebAppServer({
    appName: "Partial", envPrefix: "TEST_PARTIAL", web: false, store: memoryWebAppStore(), routes,
    auth: { apiKeys: true },
    runtimeConfig: {
      appName: "Partial", envPrefix: "TEST_PARTIAL", host: "127.0.0.1", port: 0,
      dataDir: resolve(directory, "server"), logLevel: "error", logLevelFromEnv: false,
      passkeyDisabled: true, sameOriginDisabled: false,
      trustProxy: { enabled: false, headers: [], chain: "first" }, development: false,
    },
  });
  const server = await app.start();
  const keyResponse = await fetch(`${server.url.origin}/api/api-keys`, {
    method: "POST", headers: { origin: server.url.origin, "content-type": "application/json" },
    body: JSON.stringify({ name: "Collection CLI" }), signal: AbortSignal.timeout(5_000),
  });
  expect(keyResponse.status).toBe(200);
  const key = await keyResponse.json() as { token: string };
  const fixture = resolve(directory, "cli.ts");
  await Bun.write(resolve(directory, "catalog.json"), JSON.stringify(createRouteCatalog(routes)));
  await Bun.write(fixture, `
    import { createWebAppCli } from "@pablozaiden/webapp/cli";
    const cli = createWebAppCli({
      appName: "Partial", commandName: "partial", envPrefix: "TEST_PARTIAL", version: "0.0.0",
      routeCatalog: await Bun.file(process.env["CATALOG"]!).json(),
    });
    process.exitCode = await cli.run();
  `);
  const run = async () => {
    const child = Bun.spawn([process.execPath, fixture, "api", "documents"], {
      env: {
        ...process.env, TEST_PARTIAL_BASE_URL: server.url.origin,
        TEST_PARTIAL_API_KEY: key.token,
        TEST_PARTIAL_CLI_HOME: resolve(directory, "home"), CATALOG: resolve(directory, "catalog.json"),
      }, stdout: "pipe", stderr: "pipe", timeout: 5_000,
    });
    const output = new Response(child.stdout).text();
    const error = new Response(child.stderr).text();
    try {
      const code = await child.exited;
      const text = await output;
      const stderr = await error;
      if (!text) throw new Error(`CLI exited ${code} without JSON: ${stderr}`);
      return { code, json: JSON.parse(text) as unknown, error: stderr };
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      await child.exited;
    }
  };
  try {
    const web = await appJsonWithMetadata<{ id: string }[]>(`${server.url.origin}/api/documents`,
      { signal: AbortSignal.timeout(5_000) }, { header: "X-Clanky-Partial" });
    expect(web).toEqual({ data: [{ id: "local" }], metadata: { partial: true } });
    expect(await run()).toMatchObject({
      code: 1, json: { status: { code: 200, ok: true }, partial: true, response: [{ id: "local" }] }, error: "",
    });
    const available = await fetch(`${server.url.origin}/api/documents`, {
      method: "POST", headers: { origin: server.url.origin }, signal: AbortSignal.timeout(5_000),
    });
    expect(available.status).toBe(200);
    expect(await run()).toMatchObject({
      code: 0, json: { status: { code: 200, ok: true }, response: [{ id: "local" }] }, error: "",
    });
  } finally {
    await app.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
