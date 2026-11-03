import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildWebAppBinary, buildWebAppClient } from "@pablozaiden/webapp/build";
import { fetchClientArtifacts } from "./support/client-artifacts";

async function freePort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) {
    throw new Error("Test server did not expose an allocated port");
  }
  return port;
}

async function waitForHealth(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        await response.text();
        return;
      }
      await response.text();
    } catch {
      // The compiled process is still starting.
    }
    await Bun.sleep(50);
  }
  throw new Error(`Compiled example at ${baseUrl} did not become healthy`);
}

test("compiled core-only example serves the shell and live data without account storage", async () => {
  const exampleDirectory = resolve("examples/kitchen-sink");
  const binaryPath = resolve(
    exampleDirectory,
    "dist/kitchen-sink",
  );
  const dataDirectory = resolve(".cache/tests", `compiled-kitchen-sink-${crypto.randomUUID()}`);
  const runtimeDirectory = `${dataDirectory}-runtime`;
  const port = await freePort();
  const environment = {
    ...process.env,
    KITCHEN_SINK_HOST: "127.0.0.1",
    KITCHEN_SINK_PORT: String(port),
    KITCHEN_SINK_DATA_DIR: dataDirectory,
    HOME: runtimeDirectory,
  };
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let output: Promise<unknown> | undefined;

  rmSync(dataDirectory, { recursive: true, force: true });
  mkdirSync(runtimeDirectory, { recursive: true });
  try {
    const build = Bun.spawn([process.execPath, "src/build.ts"], {
      cwd: exampleDirectory,
      stdout: "ignore",
      stderr: "ignore",
    });
    const buildExitCode = await build.exited;
    expect(buildExitCode).toBe(0);
    const launched = Bun.spawn([binaryPath], { cwd: runtimeDirectory, env: environment, stdout: "pipe", stderr: "pipe" });
    child = launched;
    output = Promise.all([new Response(launched.stdout).text(), new Response(launched.stderr).text()]);
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    await waitForHealth(baseUrl);

    const document = await fetch(`${baseUrl}/`);
    expect(document.status).toBe(200);
    expect(document.headers.get("content-type")).toContain("text/html");
    await document.text();
    const browserArtifacts = await fetchClientArtifacts(`${baseUrl}/`);
    expect([...browserArtifacts.keys()].some((url) => url.endsWith(".js"))).toBe(true);
    expect([...browserArtifacts.keys()].some((url) => url.endsWith(".css"))).toBe(true);

    const ping = await fetch(`${baseUrl}/api/public/ping`);
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ pong: true });

    const diagnostics = await fetch(`${baseUrl}/public/diagnostics.json`);
    expect(diagnostics.status).toBe(200);
    expect(await diagnostics.json()).toMatchObject({
      app: "kitchen-sink",
      persistence: "memory",
    });

    const project = await fetch(`${baseUrl}/api/projects`, {
      method: "POST", headers: { origin: baseUrl, "content-type": "application/json" }, body: JSON.stringify({ name: "Memory project" }),
    });
    expect(project.status).toBe(200);
    expect(await project.json()).toMatchObject({ name: "Memory project" });
    expect(existsSync(dataDirectory)).toBe(false);
    expect(readdirSync(runtimeDirectory)).toEqual([]);
    for (const path of ["/api/accounts", "/api/preferences/theme", "/api/auth/status"]) {
      expect((await fetch(`${baseUrl}${path}`)).status).toBe(404);
    }
  } finally {
    child?.kill("SIGTERM");
    if (child) expect(await child.exited).toBe(0);
    await output;
    rmSync(dataDirectory, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
}, 120_000);

test("serves development assets and embeds the published frontend unchanged in a standalone binary", async () => {
  const directory = resolve(".cache/tests", `configured-assets-${crypto.randomUUID()}`);
  const entrypoint = join(directory, "server.ts");
  const assetDirectory = join(directory, "assets");
  const binary = join(directory, "asset-host");
  const worker = `self.onmessage = () => self.postMessage("ready");`;
  const sourcemap = JSON.stringify({ version: 3, sources: [], names: [], mappings: "" });
  const runtimeDirectory = join(directory, "runtime");
  try {
    mkdirSync(runtimeDirectory, { recursive: true });
    await Bun.write(join(directory, "main.ts"), `import "./main.css"; document.title = "Asset Host";`);
    await Bun.write(join(directory, "main.css"), `body { margin: 0; }`);
    await Bun.write(join(assetDirectory, "workers", "editor.js"), worker);
    await Bun.write(join(assetDirectory, "workers", "editor.js.map"), sourcemap);
    await Bun.write(entrypoint, `import { createWebAppServer } from "@pablozaiden/webapp/server";
const app = createWebAppServer({
  appName: "Asset Host",
  envPrefix: "ASSET_HOST",
  web: {
    entry: new URL("./main.ts", import.meta.url),
    assets: [{ src: new URL("./assets", import.meta.url), path: "/webapp-assets/editor" }],
  },
});
await app.start();
process.on("SIGTERM", async () => { await app.stop(true); process.exit(0); });
`);
    const clientDirectory = join(directory, "client");
    const client = await buildWebAppClient({
      entry: join(directory, "main.ts"),
      outdir: clientDirectory,
      appName: "Asset Host",
      assets: [{ src: assetDirectory, path: "/webapp-assets/editor" }],
    });
    for (const mode of ["hot", "binary"]) {
      if (mode === "binary") {
        renameSync(assetDirectory, join(directory, "retired-assets"));
        renameSync(join(directory, "main.ts"), join(directory, "retired-main.ts"));
        renameSync(join(directory, "main.css"), join(directory, "retired-main.css"));
        await buildWebAppBinary({ entrypoint, outfile: binary, web: { client } });
      }
      const port = await freePort();
      const child = Bun.spawn(mode === "hot" ? [process.execPath, "--hot", entrypoint] : [binary], {
        env: {
          ...process.env,
          ASSET_HOST_HOST: "127.0.0.1",
          ASSET_HOST_PORT: String(port),
          ASSET_HOST_DATA_DIR: join(directory, `data-${mode}`),
          TMPDIR: runtimeDirectory,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = new Response(child.stdout).text();
      const stderr = new Response(child.stderr).text();
      try {
        const baseUrl = `http://127.0.0.1:${port}`;
        await waitForHealth(baseUrl, 10_000);
        await fetchClientArtifacts(`${baseUrl}/`);
        const bootstrap = await fetch(`${baseUrl}/webapp-client.json`, { signal: AbortSignal.timeout(5_000) });
        expect(await bootstrap.json()).toEqual({ mode: "integrated", publicBasePath: "/" });
        if (mode === "binary") {
          const document = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(5_000) });
          expect(await document.text()).toBe(await Bun.file(join(clientDirectory, "index.html")).text());
          for await (const path of new Bun.Glob("**/*").scan({ cwd: clientDirectory, onlyFiles: true })) {
            if (path === "webapp-client.json") continue;
            const response = await fetch(new URL(path, `${baseUrl}/`), { signal: AbortSignal.timeout(5_000) });
            expect(response.status, path).toBe(200);
            expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(await Bun.file(join(clientDirectory, path)).arrayBuffer()));
          }
        }
        for (const [path, content] of [["editor.js", worker], ["editor.js.map", sourcemap]]) {
          const response = await fetch(`${baseUrl}/webapp-assets/editor/workers/${path}`, { signal: AbortSignal.timeout(5_000) });
          expect(response.status).toBe(200);
          expect(await response.text()).toBe(content!);
        }
      } catch (error) {
        child.kill();
        await child.exited;
        throw new Error(`${mode} asset host failed: ${String(error)}\n${await stdout}\n${await stderr}`, { cause: error });
      } finally {
        child.kill();
        await child.exited;
        await Promise.all([stdout, stderr]);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
