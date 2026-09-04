import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createWebAppCli,
  type WebAppCli,
  type CliProfileStore,
  type StoredDeviceCredentials,
  type WebAppServeOptionValues,
} from "@pablozaiden/webapp/cli";

const testRoot = resolve(".cache/tests/serve-lifecycle");
const resources: string[] = [];
const lifecycleClis: WebAppCli[] = [];
const fixtureSource = `
const port = Number(process.env["TEST_SERVE_PORT"]);
const host = process.env["TEST_SERVE_HOST"] === "0.0.0.0"
  ? "127.0.0.1"
  : (process.env["TEST_SERVE_HOST"] || "127.0.0.1");
Bun.serve({
  hostname: host,
  port,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/health") {
      return Response.json({ ok: true });
    }
    if (path === "/api/options") {
      return Response.json({
        featureMode: process.env["TEST_SERVE_FEATURE_MODE"],
        workerName: process.env["TEST_SERVE_WORKER_NAME"],
        capacity: process.env["TEST_SERVE_CAPACITY"],
      });
    }
    return new Response("not found", { status: 404 });
  },
});
await new Promise(() => {});
`;

function profileStore(): CliProfileStore {
  const credentials = new Map<string, StoredDeviceCredentials>();
  return {
    selectedName: async (name) => name ?? "default",
    list: async () => [],
    use: async () => undefined,
    remove: async () => false,
    credentials: (name) => ({
      path: () => name,
      read: async () => credentials.get(name),
      write: async (value) => {
        credentials.set(name, value);
      },
      clear: async () => {
        credentials.delete(name);
      },
    }),
  };
}

async function freePort(): Promise<number> {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("ok"),
  });
  const port = server.port;
  if (port === undefined) {
    throw new Error("Ephemeral fixture server did not expose a port");
  }
  await server.stop(true);
  return port;
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastStatus = "no response";
  while (Date.now() <= deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/api/health`);
      if (response.ok) {
        await response.text();
        return;
      }
      lastStatus = `HTTP ${String(response.status)}`;
      await response.text();
    } catch (error) {
      lastStatus = String(error);
    }
    await Bun.sleep(50);
  }
  throw new Error(`Fixture did not become healthy: ${lastStatus}`);
}

function createFixtureCli(input: {
  dataDir: string;
  port: number;
  onBuild?: () => void;
  environment?: Record<string, string>;
  onStart?: (
    options: WebAppServeOptionValues,
    environment: Readonly<Record<string, string | undefined>>,
  ) => void;
}) {
  const fixturePath = join(input.dataDir, "fixture.ts");
  const environment = {
    HOME: input.dataDir,
    TEST_SERVE_DATA_DIR: input.dataDir,
    TEST_SERVE_HOST: "127.0.0.1",
    TEST_SERVE_PORT: String(input.port),
    ...input.environment,
  };
  const cli = createWebAppCli({
    appName: "Serve Lifecycle Test",
    commandName: "serve-lifecycle-test",
    envPrefix: "TEST_SERVE",
    appDirectoryName: ".serve-lifecycle-test",
    version: "1.0.0",
    environment,
    profileStore: profileStore(),
    start: input.onStart
      ? ({ options, environment: resolvedEnvironment }) => {
          input.onStart?.(options, resolvedEnvironment);
        }
      : undefined,
    serve: {
      options: [
        {
          name: "feature-mode",
          type: "boolean",
          description: "Enable fixture feature mode.",
          defaultValue: false,
        },
        {
          name: "worker-name",
          type: "string",
          description: "Set the fixture worker name.",
          defaultValue: "default-worker",
        },
        {
          name: "capacity",
          type: "number",
          description: "Set fixture worker capacity.",
          defaultValue: 1,
        },
      ],
      command: () => [process.execPath, fixturePath, "serve"],
      development: {
        build: () => {
          input.onBuild?.();
        },
        command: () => [process.execPath, fixturePath, "serve"],
      },
      readinessTimeoutMs: 5_000,
    },
  });
  lifecycleClis.push(cli);
  return {
    cli,
    fixturePath,
    environment,
  };
}

afterEach(async () => {
  for (const cli of lifecycleClis.splice(0)) {
    await cli.execute(["serve", "down"]);
  }
  for (const path of resources.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("detached serve lifecycle", () => {
  test("resolves application serve options across config, environment, and flags", async () => {
    const root = join(testRoot, crypto.randomUUID());
    const dataDir = join(root, "state");
    mkdirSync(dataDir, { recursive: true });
    resources.push(root);
    const port = await freePort();
    const fixture = createFixtureCli({
      dataDir,
      port,
      environment: {
        TEST_SERVE_FEATURE_MODE: "false",
        TEST_SERVE_WORKER_NAME: "environment-worker",
      },
    });
    await Bun.write(fixture.fixturePath, fixtureSource);

    expect((await fixture.cli.execute([
      "serve",
      "config",
      "set",
      "feature-mode",
      "true",
    ])).exitCode).toBe(0);
    expect((await fixture.cli.execute([
      "serve",
      "config",
      "set",
      "worker-name",
      "configured-worker",
    ])).exitCode).toBe(0);
    expect((await fixture.cli.execute([
      "serve",
      "config",
      "set",
      "capacity",
      "3",
    ])).exitCode).toBe(0);

    const shown = await fixture.cli.execute(["serve", "config", "show"]);
    expect(shown.exitCode).toBe(0);
    expect(JSON.parse(shown.output ?? "")).toMatchObject({
      config: {
        serve: {
          options: {
            "feature-mode": true,
            "worker-name": "configured-worker",
            capacity: 3,
          },
        },
      },
      effective: {
        application: {
          "feature-mode": false,
          "worker-name": "environment-worker",
          capacity: 3,
        },
      },
    });

    const started = await fixture.cli.execute([
      "serve",
      "up",
      "--feature-mode",
      "true",
      "--worker-name=flag=worker",
      "--capacity",
      "7",
    ]);
    expect(started.exitCode).toBe(0);
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/options`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      featureMode: "true",
      workerName: "flag=worker",
      capacity: "7",
    });
  });

  test("provides resolved application options to foreground servers", async () => {
    const root = join(testRoot, crypto.randomUUID());
    const dataDir = join(root, "state");
    mkdirSync(dataDir, { recursive: true });
    resources.push(root);
    const port = await freePort();
    let observed:
      | {
          options: WebAppServeOptionValues;
          environment: Readonly<Record<string, string | undefined>>;
        }
      | undefined;
    const fixture = createFixtureCli({
      dataDir,
      port,
      onStart: (options, environment) => {
        observed = { options, environment };
      },
    });
    const result = await fixture.cli.execute([
      "serve",
      "--feature-mode",
      "true",
      "--worker-name",
      "foreground-worker",
      "--capacity=5",
    ]);
    expect(result.exitCode).toBe(0);
    expect(observed?.options).toEqual({
      "feature-mode": true,
      "worker-name": "foreground-worker",
      capacity: 5,
    });
    expect(observed?.environment).toMatchObject({
      TEST_SERVE_FEATURE_MODE: "true",
      TEST_SERVE_WORKER_NAME: "foreground-worker",
      TEST_SERVE_CAPACITY: "5",
    });
    expect(fixture.cli.help("serve")).toContain(
      "--feature-mode BOOLEAN  Enable fixture feature mode.",
    );
    const invalid = await fixture.cli.execute(["serve", "--capacity", "many"]);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.error).toContain("--capacity must be a finite number");
  });

  test("persists configuration, starts detached, reports status, and stops safely", async () => {
    const root = join(testRoot, crypto.randomUUID());
    const dataDir = join(root, "state");
    mkdirSync(dataDir, { recursive: true });
    resources.push(root);
    const port = await freePort();
    const fixture = createFixtureCli({ dataDir, port });
    await Bun.write(fixture.fixturePath, fixtureSource);

    const configured = await fixture.cli.execute([
      "serve",
      "config",
      "set",
      "development.source-path",
      root,
    ]);
    expect(configured.exitCode).toBe(0);
    const shown = await fixture.cli.execute(["serve", "config", "show"]);
    expect(shown.exitCode).toBe(0);
    const shownValue = JSON.parse(shown.output ?? "") as {
      config: { development?: { sourcePath?: string } };
      effective: { port: number; dataDir: string };
    };
    expect(shownValue.config.development?.sourcePath).toBe(root);
    expect(shownValue.effective.port).toBe(port);
    expect(shownValue.effective.dataDir).toBe(dataDir);

    const started = await fixture.cli.execute(["serve", "up"]);
    expect(started.exitCode).toBe(0);
    expect(started.output).toContain("Server started with PID");
    const status = await fixture.cli.execute(["serve", "status"]);
    expect(status.exitCode).toBe(0);
    const statusValue = JSON.parse(status.output ?? "") as {
      running: boolean;
      managed: boolean;
      pids: number[];
      recognizedPids: number[];
    };
    expect(statusValue.running).toBe(true);
    expect(statusValue.managed).toBe(true);
    expect(statusValue.pids).toEqual(statusValue.recognizedPids);

    const stopped = await fixture.cli.execute(["serve", "down"]);
    expect(stopped.exitCode).toBe(0);
    const afterStop = await fixture.cli.execute(["serve", "status"]);
    expect(afterStop.exitCode).toBe(0);
    expect(JSON.parse(afterStop.output ?? "")).toMatchObject({
      running: false,
      managed: false,
      pids: [],
    });
    expect((await fixture.cli.execute(["serve", "down"])).exitCode).toBe(0);
  });

  test("builds from the configured source path before starting development mode", async () => {
    const root = join(testRoot, crypto.randomUUID());
    const dataDir = join(root, "state");
    mkdirSync(dataDir, { recursive: true });
    resources.push(root);
    const port = await freePort();
    let builds = 0;
    const fixture = createFixtureCli({
      dataDir,
      port,
      onBuild: () => {
        builds += 1;
      },
    });
    await Bun.write(fixture.fixturePath, fixtureSource);
    const missingSource = await fixture.cli.execute(["serve", "up", "--dev"]);
    expect(missingSource.exitCode).toBe(1);
    expect(missingSource.error).toContain("development.source-path");
    const configured = await fixture.cli.execute([
      "serve",
      "config",
      "set",
      "development.source-path",
      root,
    ]);
    expect(configured.exitCode).toBe(0);

    const started = await fixture.cli.execute(["serve", "up", "--dev"]);
    expect(started.exitCode).toBe(0);
    expect(builds).toBe(1);

    await fixture.cli.execute(["serve", "down"]);
  });

  test("keeps the current server running when the development build fails", async () => {
    const root = join(testRoot, crypto.randomUUID());
    const dataDir = join(root, "state");
    mkdirSync(dataDir, { recursive: true });
    resources.push(root);
    const port = await freePort();
    const fixture = createFixtureCli({
      dataDir,
      port,
      onBuild: () => {
        throw new Error("build failed");
      },
    });
    await Bun.write(fixture.fixturePath, fixtureSource);
    const configured = await fixture.cli.execute([
      "serve",
      "config",
      "set",
      "development.source-path",
      root,
    ]);
    expect(configured.exitCode).toBe(0);
    const started = await fixture.cli.execute(["serve", "up"]);
    expect(started.exitCode).toBe(0);

    const development = await fixture.cli.execute(["serve", "up", "--dev"]);
    expect(development.exitCode).toBe(1);
    expect(development.error).toContain("build failed");
    await waitForHealth(port);

    await fixture.cli.execute(["serve", "down"]);
  });

  test("refuses to stop an unrelated process that owns the configured port", async () => {
    const root = join(testRoot, crypto.randomUUID());
    const dataDir = join(root, "state");
    mkdirSync(dataDir, { recursive: true });
    resources.push(root);
    const port = await freePort();
    const fixture = createFixtureCli({ dataDir, port });
    await Bun.write(fixture.fixturePath, fixtureSource);
    const foreign = Bun.spawn([process.execPath, fixture.fixturePath, "foreign"], {
      env: {
        ...process.env,
        ...fixture.environment,
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      await waitForHealth(port);
      const result = await fixture.cli.execute(["serve", "up"]);
      expect(result.exitCode).toBe(1);
      expect(result.error).toContain("refusing to stop it");
      expect(foreign.exitCode).toBeNull();
    } finally {
      foreign.kill("SIGTERM");
      await foreign.exited;
    }
  });
});
