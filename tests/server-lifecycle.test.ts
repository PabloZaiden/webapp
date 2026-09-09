import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  createWebAppServer,
  defineRoutes,
  sqliteWebAppStore,
  type WebAppServerOptions,
  type WebAppServerLifecycleHooks,
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
    server,
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
