import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  createWebAppServer,
  defineRoutes,
  readRuntimeConfig,
  type WebAppServerOptions,
  type WebAppServerLifecycleHooks,
  type WebAppWebSocketData,
} from "@pablozaiden/webapp/server";

const testWeb = { entry: new URL("./fixtures/web/main.tsx", import.meta.url) };

interface TestTls {
  directory: string;
  options: NonNullable<WebAppServerOptions["tls"]>;
}

function formatOpenSslDate(value: Date): string {
  const pad = (part: number): string => String(part).padStart(2, "0");
  return [
    String(value.getUTCFullYear()).slice(-2),
    pad(value.getUTCMonth() + 1),
    pad(value.getUTCDate()),
    pad(value.getUTCHours()),
    pad(value.getUTCMinutes()),
    pad(value.getUTCSeconds()),
  ].join("") + "Z";
}

async function runOpenSsl(
  executable: string,
  arguments_: readonly string[],
  cwd: string,
): Promise<void> {
  const process = Bun.spawn([executable, ...arguments_], {
    cwd,
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderrPromise = process.stderr
    ? new Response(process.stderr).text()
    : Promise.resolve("");
  const exitCode = await process.exited;
  const stderr = await stderrPromise;
  if (exitCode === 0) {
    return;
  }
  throw new Error(`OpenSSL failed with exit code ${String(exitCode)}: ${stderr.trim()}`);
}

async function createTestTls(): Promise<TestTls> {
  const executable = Bun.which("openssl");
  if (!executable) {
    throw new Error("The HTTPS lifecycle test requires OpenSSL to be available on PATH.");
  }

  const directory = resolve(".cache/tests", `server-lifecycle-tls-${crypto.randomUUID()}`);
  const newCertificatesDirectory = resolve(directory, "newcerts");
  mkdirSync(newCertificatesDirectory, { recursive: true });
  try {
    await Bun.write(resolve(directory, "index.txt"), "");
    await Bun.write(resolve(directory, "serial"), "1000\n");
    await Bun.write(resolve(directory, "openssl.cnf"), [
      "[ ca ]",
      "default_ca = test_ca",
      "[ test_ca ]",
      "database = index.txt",
      "serial = serial",
      "new_certs_dir = newcerts",
      "default_md = sha256",
      "policy = policy_any",
      "x509_extensions = server_extensions",
      "[ policy_any ]",
      "commonName = supplied",
      "[ server_extensions ]",
      "basicConstraints = critical,CA:FALSE",
      "keyUsage = critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage = serverAuth",
      "subjectAltName = DNS:localhost,IP:127.0.0.1",
    ].join("\n"));

    await runOpenSsl(executable, [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "localhost-key.pem",
      "-out",
      "localhost.csr",
      "-subj",
      "/CN=localhost",
    ], directory);
    const notBefore = formatOpenSslDate(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    const notAfter = formatOpenSslDate(new Date(Date.now() + 365 * 24 * 60 * 60 * 1000));
    await runOpenSsl(executable, [
      "ca",
      "-selfsign",
      "-batch",
      "-config",
      "openssl.cnf",
      "-keyfile",
      "localhost-key.pem",
      "-in",
      "localhost.csr",
      "-out",
      "localhost-cert.pem",
      "-startdate",
      notBefore,
      "-enddate",
      notAfter,
      "-extensions",
      "server_extensions",
      "-notext",
    ], directory);
    return {
      directory,
      options: {
        cert: Bun.file(resolve(directory, "localhost-cert.pem")),
        key: Bun.file(resolve(directory, "localhost-key.pem")),
      },
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function createLifecycleApp(
  envPrefix: string,
  lifecycle: WebAppServerLifecycleHooks,
  server?: WebAppServerOptions,
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
      sameOriginDisabled: true,
      trustProxy: { enabled: false, headers: [], chain: "first" },
      development: false,
    },
    web: testWeb,
    routes: defineRoutes({}),
    server,
    lifecycle,
  });
  return { app, dataDir };
}

async function bounded<T>(promise: Promise<T>, condition: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${condition}`)), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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

test("custom WebSocket delivery follows the listener buffering and close policy", async () => {
  type ClientSocket = WebSocket & Pick<Bun.WebSocket, "pause" | "resume" | "terminate">;
  const chunkBytes = 64 * 1_024;
  const scenarios: {
    name: string;
    websocket?: WebAppServerOptions["websocket"];
    frames: number;
    limited: boolean;
    closes: boolean;
  }[] = [
    { name: "unlimited", websocket: { backpressureLimit: 0, closeOnBackpressureLimit: false }, frames: 384, limited: false, closes: false },
    { name: "Bun defaults", frames: 384, limited: true, closes: false },
    { name: "keep connection on limit", websocket: { backpressureLimit: chunkBytes, closeOnBackpressureLimit: false }, frames: 128, limited: true, closes: false },
    { name: "close connection on limit", websocket: { backpressureLimit: chunkBytes, closeOnBackpressureLimit: true }, frames: 128, limited: true, closes: true },
  ];
  for (const scenario of scenarios) {
    let peer: Bun.ServerWebSocket<WebAppWebSocketData> | undefined;
    const config = readRuntimeConfig({
      appName: "WebSocket contract",
      envPrefix: "WEBSOCKET_CONTRACT",
      environment: {
        WEBSOCKET_CONTRACT_HOST: "127.0.0.1",
        WEBSOCKET_CONTRACT_PORT: "0",
        WEBSOCKET_CONTRACT_LOG_LEVEL: "error",
        NODE_ENV: "production",
      },
    });
    const app = createWebAppServer({
      appName: config.appName,
      envPrefix: config.envPrefix,
      runtimeConfig: config,
      web: false,
      server: scenario.websocket ? { websocket: scenario.websocket } : undefined,
      request(request, server) {
        const path = new URL(request.url).pathname;
        if (path === "/stream") {
          return server?.upgrade(request, { data: { webappSocketHandler: "delivery" } })
            ? undefined : new Response("Upgrade required", { status: 426 });
        }
        if (path !== "/send") return undefined;
        if (!peer) return new Response("Stream unavailable", { status: 409 });
        const payload = new Uint8Array(chunkBytes);
        const view = new DataView(payload.buffer);
        for (let accepted = 0; accepted < scenario.frames; accepted++) {
          view.setUint32(0, accepted);
          if (peer.send(payload) === 0) return Response.json({ accepted, limited: true });
        }
        return Response.json({ accepted: scenario.frames, limited: false });
      },
      websockets: {
        delivery: {
          open(socket) { peer = socket; },
          message(socket) { socket.send("pong"); },
        },
      },
    });
    const opened = Promise.withResolvers<void>();
    const delivered = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const pong = Promise.withResolvers<void>();
    let socket: ClientSocket | undefined;
    let receivedFrames = 0;
    let expectedFrames = scenario.frames;
    const expectedPayload = new Uint8Array(chunkBytes);
    const expectedView = new DataView(expectedPayload.buffer);
    try {
      const server = await app.start();
      // DOM types omit Bun's native consumer flow-control methods.
      socket = new WebSocket(new URL("/stream", server.url).toString().replace("http:", "ws:")) as ClientSocket;
      socket.binaryType = "arraybuffer";
      socket.onopen = () => { socket!.pause(); opened.resolve(); };
      socket.onerror = () => opened.reject(new Error(`${scenario.name}: WebSocket open failed`));
      socket.onclose = () => { closed.resolve(); delivered.resolve(); };
      socket.onmessage = event => {
        if (event.data === "pong") { pong.resolve(); return; }
        try {
          expectedView.setUint32(0, receivedFrames);
          expect(new Uint8Array(event.data)).toEqual(expectedPayload);
          if (++receivedFrames === expectedFrames) delivered.resolve();
        } catch (error) {
          delivered.reject(error);
        }
      };
      await bounded(opened.promise, `${scenario.name}: WebSocket open`);
      // Pause the real consumer so the listener must buffer the burst.
      const response = await fetch(new URL("/send", server.url), { signal: AbortSignal.timeout(5_000) });
      expect(response.status).toBe(200);
      const outcome = await response.json() as { accepted: number; limited: boolean };
      expect(outcome.limited).toBe(scenario.limited);
      expectedFrames = outcome.accepted;
      socket.resume();
      await bounded(delivered.promise, `${scenario.name}: delivery or selected close`);
      if (scenario.closes) {
        await bounded(closed.promise, `${scenario.name}: close on limit`);
      } else {
        expect(receivedFrames).toBe(expectedFrames);
        if (!scenario.limited) expect(receivedFrames * chunkBytes).toBe(24 * 1_024 * 1_024);
        socket.send("ping");
        await bounded(pong.promise, `${scenario.name}: connection continues`);
      }
      await app.stop(true);
      await bounded(closed.promise, `${scenario.name}: shutdown closes WebSocket`);
    } finally {
      socket?.terminate();
      await app.stop(true);
      if (socket) await bounded(closed.promise, `${scenario.name}: socket cleanup`);
    }
  }
}, 20_000);

test("serves HTTPS when TLS options are configured", async () => {
  const testTls = await createTestTls();
  const { app, dataDir } = createLifecycleApp(
    "TEST_SERVER_LIFECYCLE_TLS",
    {},
    { tls: testTls.options },
  );

  try {
    const server = await app.start();
    expect(server.url.protocol).toBe("https:");
    const response = await fetch(new URL("/api/health", server.url), {
      tls: { rejectUnauthorized: false },
    });
    expect(response.status).toBe(200);
    await response.text();
    await app.stop(true);
  } finally {
    await app.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(testTls.directory, { recursive: true, force: true });
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
