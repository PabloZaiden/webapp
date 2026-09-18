import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

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

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
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
    `dist/kitchen-sink${process.platform === "win32" ? ".exe" : ""}`,
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

    const ping = await fetch(`${baseUrl}/api/public/ping`);
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ pong: true });

    const diagnostics = await fetch(`${baseUrl}/public/diagnostics.json`);
    expect(diagnostics.status).toBe(200);
    expect(await diagnostics.json()).toMatchObject({
      app: "kitchen-sink",
      publicRoute: true,
    });
  } finally {
    if (built) {
      const stopped = await runCommand([binaryPath, "serve", "down"], environment);
      expect(stopped.exitCode).toBe(0);
    }
    rmSync(dataDirectory, { recursive: true, force: true });
  }
}, 120_000);
