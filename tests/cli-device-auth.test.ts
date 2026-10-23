import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createCliProfileStore } from "../src/cli";
import { createWebAppServer } from "../src/server";

const clientSource = `
import { mock } from "bun:test";
import * as os from "node:os";
const machine = process.env["CLI_AUTH_TEST_HOSTNAME"];
if (!machine) throw new Error("Missing test hostname");
mock.module("node:os", () => ({ ...os, hostname: () => machine }));
const { createWebAppCli } = await import("@pablozaiden/webapp/cli");
const cli = createWebAppCli({
  appName: "CLI Auth Test",
  commandName: "cli-auth-test",
  envPrefix: "CLI_AUTH_TEST",
  version: "0.0.0",
  clientId: process.env["CLI_AUTH_TEST_CLIENT_ID"],
});
process.exitCode = await cli.run();
`;

test("keeps CLI sessions on different hostnames independent and preserves explicit client IDs", async () => {
  const directory = resolve(".cache/tests", `cli-device-auth-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const fixture = resolve(directory, "client.ts");
  await Bun.write(fixture, clientSource);
  const app = createWebAppServer({
    appName: "CLI Auth Test",
    envPrefix: "CLI_AUTH_TEST",
    runtimeConfig: {
      appName: "CLI Auth Test",
      envPrefix: "CLI_AUTH_TEST",
      host: "127.0.0.1",
      port: 0,
      dataDir: resolve(directory, "server"),
      logLevel: "error",
      logLevelFromEnv: false,
      passkeyDisabled: true,
      sameOriginDisabled: false,
      trustProxy: { enabled: false, headers: [], chain: "first" },
      development: false,
    },
    auth: { passkeys: true, deviceAuth: true },
    web: false,
  });
  const server = await app.start();
  const baseUrl = server.url.origin;

  async function run(machine: string, args: string[], configuredClientId?: string): Promise<string> {
    const child = Bun.spawn([process.execPath, fixture, ...args], {
      env: {
        ...process.env,
        CLI_AUTH_TEST_HOSTNAME: machine,
        CLI_AUTH_TEST_CLIENT_ID: configuredClientId,
        CLI_AUTH_TEST_CLI_HOME: resolve(directory, machine),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    let output = "";
    let pending = "";
    const decoder = new TextDecoder();
    try {
      for await (const chunk of child.stdout) {
        const text = decoder.decode(chunk, { stream: true });
        output += text;
        pending += text;
        let newline: number;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line.startsWith("Open: ")) {
            const verification = new URL(line.slice(6));
            const approved = await fetch(`${baseUrl}/api/auth/device/approve`, {
              method: "POST",
              headers: { "content-type": "application/json", origin: baseUrl },
              body: JSON.stringify({ user_code: verification.searchParams.get("user_code") }),
            });
            expect(approved.status).toBe(200);
          }
        }
      }
      const error = await stderr;
      expect(await child.exited, error).toBe(0);
      return output;
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      await child.exited;
    }
  }

  async function refreshAndCheckStatus(machine: string, clientId: string): Promise<void> {
    const store = createCliProfileStore({
      appDirectoryName: ".cli-auth-test",
      stateDirectory: () => resolve(directory, machine),
    }).credentials("default");
    const credentials = await store.read();
    if (!credentials) throw new Error("CLI auth did not persist credentials");
    await store.write({ ...credentials, accessTokenExpiresAt: new Date(0).toISOString() });
    const status: unknown = JSON.parse(await run(machine, ["status"]));
    expect(status).toMatchObject({ authenticated: true, clientId });
  }

  try {
    await run("laptop", ["auth", "--base-url", baseUrl]);
    await run("desktop", ["auth", "--base-url", baseUrl]);
    await refreshAndCheckStatus("laptop", "cli-auth-test-cli-laptop");
    await refreshAndCheckStatus("desktop", "cli-auth-test-cli-desktop");
    await run("laptop", ["auth"]);
    await refreshAndCheckStatus("laptop", "cli-auth-test-cli-laptop");
    await refreshAndCheckStatus("desktop", "cli-auth-test-cli-desktop");

    await run("configured", ["auth", "--base-url", baseUrl], "configured-client");
    await refreshAndCheckStatus("configured", "configured-client");
    await run("configured", ["auth", "--client-id", "explicit-client"], "configured-client");
    await refreshAndCheckStatus("configured", "explicit-client");
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 40_000);
