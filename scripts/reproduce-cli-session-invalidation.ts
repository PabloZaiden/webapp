import { strict as assert } from "node:assert";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createCliProfileStore, createWebAppCli, type StoredDeviceCredentials } from "../src/cli";
import { createWebAppServer, type RuntimeConfig } from "../src/server";

const mode = process.argv[2];
const directory = process.argv[3];

if (mode === "server") {
  assert(directory);
  const serverPort = Number(process.argv[4] ?? 0);
  assert(Number.isInteger(serverPort) && serverPort >= 0 && serverPort <= 65535);
  const runtimeConfig: RuntimeConfig = {
    appName: "Session reproduction",
    envPrefix: "SESSION_REPRO",
    host: "127.0.0.1",
    port: serverPort,
    dataDir: directory,
    logLevel: "error",
    logLevelFromEnv: false,
    passkeyDisabled: true,
    sameOriginDisabled: false,
    trustProxy: { enabled: false, headers: [], chain: "first" },
    development: false,
  };
  const app = createWebAppServer({
    appName: runtimeConfig.appName,
    envPrefix: runtimeConfig.envPrefix,
    runtimeConfig,
    auth: { passkeys: true, deviceAuth: true },
    web: false,
  });
  const server = await app.start();
  process.send?.({ baseUrl: server.url.origin });
} else if (mode === "client") {
  assert(directory);
  const cli = createWebAppCli({
    appName: "Session reproduction",
    commandName: "session-repro",
    envPrefix: "SESSION_REPRO",
    version: "0.0.0",
    profileStore: createCliProfileStore({
      appDirectoryName: "session-repro",
      stateDirectory: () => directory,
    }),
  });
  process.exitCode = await cli.run(process.argv.slice(4));
} else {
  assert.equal(mode, undefined, "Run without arguments; server/client modes are internal to this reproduction.");
  const root = resolve(".cache/tests", `session-repro-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  const script = import.meta.path;
  let serverProcess: ReturnType<typeof Bun.spawn> | undefined;
  let baseUrl = "";
  let port = 0;

  async function startServer(): Promise<void> {
    const ready = Promise.withResolvers<string>();
    serverProcess = Bun.spawn([process.execPath, script, "server", resolve(root, "server"), String(port)], {
      stdout: "inherit",
      stderr: "inherit",
      ipc(message) {
        if (message && typeof message === "object" && "baseUrl" in message && typeof message.baseUrl === "string") {
          ready.resolve(message.baseUrl);
        }
      },
    });
    void serverProcess.exited.then((code) => ready.reject(new Error(`Server exited: ${code}`)));
    baseUrl = await ready.promise;
    port = Number(new URL(baseUrl).port);
    assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
  }

  async function stopServer(): Promise<void> {
    assert(serverProcess);
    serverProcess.kill("SIGTERM");
    assert.equal(await serverProcess.exited, 0);
    serverProcess = undefined;
  }

  function credentials(machine: string) {
    return createCliProfileStore({
      appDirectoryName: "session-repro",
      stateDirectory: () => resolve(root, machine),
    }).credentials("default");
  }

  async function runCli(machine: string, args: string[], approve = false): Promise<void> {
    const child = Bun.spawn([process.execPath, script, "client", resolve(root, machine), ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    try {
      let pending = "";
      const decoder = new TextDecoder();
      for await (const chunk of child.stdout) {
        pending += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (approve && line.startsWith("Open: ")) {
            const verification = new URL(line.slice(6));
            const response = await fetch(`${baseUrl}/api/auth/device/approve`, {
              method: "POST",
              headers: { "content-type": "application/json", origin: baseUrl },
              body: JSON.stringify({ user_code: verification.searchParams.get("user_code") }),
            });
            assert.equal(response.status, 200);
          }
        }
      }
      assert.equal(await child.exited, 0, await stderr);
      console.log(`${machine}: CLI ${args[0]} succeeded`);
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      await child.exited;
    }
  }

  async function refresh(machine: string, expectedStatus: number): Promise<void> {
    const store = credentials(machine);
    const stored = await store.read();
    assert(stored);
    const response = await fetch(`${baseUrl}/api/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: stored.refreshToken,
        client_id: stored.clientId,
      }),
    });
    const body: unknown = await response.json();
    assert.equal(response.status, expectedStatus);
    if (response.ok) {
      assert(body && typeof body === "object");
      assert("access_token" in body && typeof body.access_token === "string");
      assert("refresh_token" in body && typeof body.refresh_token === "string");
      assert("expires_in" in body && typeof body.expires_in === "number");
      const next: StoredDeviceCredentials = {
        ...stored,
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        accessTokenExpiresAt: new Date(Date.now() + body.expires_in * 1000).toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await store.write(next);
      console.log(`${machine}: refresh HTTP ${response.status}`);
    } else {
      assert(body && typeof body === "object" && "error" in body);
      assert.equal(body.error, "invalid_grant");
      console.log(`${machine}: refresh HTTP ${response.status} ${JSON.stringify(body)}`);
    }
  }

  async function confirmMonthRemaining(machine: string): Promise<void> {
    const stored = await credentials(machine).read();
    assert(stored);
    const response = await fetch(`${baseUrl}/api/auth/sessions`, {
      headers: { authorization: `${stored.tokenType} ${stored.accessToken}` },
    });
    assert.equal(response.status, 200);
    const sessions: unknown = await response.json();
    assert(Array.isArray(sessions) && sessions.length === 1);
    const session: unknown = sessions[0];
    assert(session && typeof session === "object" && "expiresAt" in session && typeof session.expiresAt === "string");
    const remainingDays = (Date.parse(session.expiresAt) - Date.now()) / (24 * 60 * 60 * 1000);
    assert(remainingDays > 29 && remainingDays <= 30);
    console.log(`${machine}: refresh session has approximately ${Math.round(remainingDays)} days remaining`);
  }

  try {
    await startServer();
    await runCli("computer-A", ["auth", "--base-url", baseUrl, "--client-id", "session-repro-cli"], true);
    await runCli("computer-A", ["status"]);
    await stopServer();
    await startServer();
    await runCli("computer-A", ["status"]);
    await refresh("computer-A", 200);
    await confirmMonthRemaining("computer-A");
    console.log("CONTROL: same durable data + process restart preserves access and refresh.");

    await runCli("computer-B", ["auth", "--base-url", baseUrl, "--client-id", "session-repro-cli"], true);
    const a = await credentials("computer-A").read();
    const b = await credentials("computer-B").read();
    assert(a && b);
    assert.equal(a.clientId, b.clientId);
    console.log(`Both independent computers use client_id=${a.clientId}`);
    const replacedSession = await fetch(`${baseUrl}/api/auth/sessions`, {
      headers: { authorization: `${a.tokenType} ${a.accessToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(replacedSession.status, 401);
    await replacedSession.body?.cancel();
    await refresh("computer-A", 400);
    await refresh("computer-B", 200);
    console.log("CONTROL: a second login with the same client_id invalidates A's access and refresh.");

    await runCli("computer-C", ["auth", "--base-url", baseUrl], true);
    await refresh("computer-B", 200);
    await refresh("computer-C", 200);
    console.log("CONTROL: distinct client_id values preserve both computers' refresh sessions.");
  } finally {
    try {
      if (serverProcess) await stopServer();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
