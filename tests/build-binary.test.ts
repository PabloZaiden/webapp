import { expect, test } from "bun:test";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildWebAppBinary, buildWebAppClient } from "@pablozaiden/webapp/build";
import { fetchClientArtifacts } from "./support/client-artifacts";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

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

async function runCommand(
  command: readonly string[],
  environment: Record<string, string | undefined>,
): Promise<CommandResult> {
  const child = Bun.spawn([...command], {
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("builds and manages the Kitchen Sink example as a standalone binary", async () => {
  const exampleDirectory = resolve("examples/kitchen-sink");
  const binaryPath = resolve(
    exampleDirectory,
    "dist/kitchen-sink",
  );
  const dataDirectory = resolve(".cache/tests", `compiled-kitchen-sink-${crypto.randomUUID()}`);
  const port = await freePort();
  const environment = {
    ...process.env,
    KITCHEN_SINK_HOST: "127.0.0.1",
    KITCHEN_SINK_PORT: String(port),
    KITCHEN_SINK_DATA_DIR: dataDirectory,
    KITCHEN_SINK_DISABLE_PASSKEY: "true",
  };
  let built = false;

  rmSync(dataDirectory, { recursive: true, force: true });
  try {
    const build = Bun.spawn([process.execPath, "src/build.ts"], {
      cwd: exampleDirectory,
      stdout: "ignore",
      stderr: "ignore",
    });
    const buildExitCode = await build.exited;
    expect(buildExitCode).toBe(0);
    built = true;

    const started = await runCommand([binaryPath, "serve", "up"], environment);
    expect(started).toMatchObject({ exitCode: 0, stderr: "" });
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    await waitForHealth(baseUrl);

    const status = await runCommand([binaryPath, "serve", "status"], environment);
    expect(status).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(status.stdout)).toMatchObject({
      managed: true,
      running: true,
      config: { port },
    });

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
      publicRoute: true,
    });

    const projectSchemas = await runCommand([binaryPath, "schema", "projects"], environment);
    expect(projectSchemas).toMatchObject({ exitCode: 0, stderr: "" });
    const catalog = JSON.parse(projectSchemas.stdout);
    expect(catalog).toMatchObject({
      methods: ["GET", "POST"],
      requestSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      operations: {
        GET: { responseSchema: { type: "array" }, automation: { policy: "read" } },
        POST: { requestSchema: { required: ["name"] }, automation: { policy: "write", completion: "completed" } },
      },
    });
    const createSchema = await runCommand([binaryPath, "schema", "projects", "--method", "POST"], environment);
    expect(createSchema).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(createSchema.stdout)).toMatchObject({
      method: "POST",
      requestSchema: { required: ["name"] },
      responseSchema: { type: "object", required: ["id", "userId", "name", "status", "updatedAt"] },
    });
    const missingSchemaMethod = await runCommand([binaryPath, "schema", "projects", "--method"], environment);
    expect(missingSchemaMethod.exitCode).toBe(1);
    expect(missingSchemaMethod.stderr).toContain("requires a value");
    const missingApiMethod = await runCommand([binaryPath, "api", "projects", "-X"], environment);
    expect(missingApiMethod.exitCode).toBe(1);
    expect(missingApiMethod.stderr).toContain("requires a value");

    const stopped = await runCommand([binaryPath, "serve", "down"], environment);
    expect(stopped).toMatchObject({ exitCode: 0, stderr: "" });

    const stoppedStatus = await runCommand([binaryPath, "serve", "status"], environment);
    expect(stoppedStatus).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(stoppedStatus.stdout)).toMatchObject({
      managed: false,
      running: false,
      config: { port },
    });
  } finally {
    if (built) {
      const stopped = await runCommand([binaryPath, "serve", "down"], environment);
      expect(stopped.exitCode).toBe(0);
    }
    rmSync(dataDirectory, { recursive: true, force: true });
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
    await Bun.write(entrypoint, `import { createWebAppServer, memoryWebAppStore } from "@pablozaiden/webapp/server";
const app = createWebAppServer({
  appName: "Asset Host",
  envPrefix: "ASSET_HOST",
  store: memoryWebAppStore(),
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
          ASSET_HOST_DISABLE_PASSKEY: "true",
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
