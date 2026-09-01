import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createWebAppCli,
  type CliProfileStore,
  type StoredDeviceCredentials,
} from "@pablozaiden/webapp/cli";

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

function cliInput() {
  return {
    async *[Symbol.asyncIterator]() {
      return;
    },
  };
}

describe("composable web app CLI", () => {
  test("exposes built-ins, composes additions, and requires explicit overrides", async () => {
    const cli = createWebAppCli({
      appName: "Test",
      commandName: "test-app",
      envPrefix: "TEST_APP",
      version: "1.2.3",
      profileStore: profileStore(),
      stdin: cliInput(),
      commands: {
        greet: {
          description: "Greet the selected profile.",
          usage: "greet",
          handler: ({ profile }) => ({
            exitCode: 0,
            output: `hello ${profile}`,
          }),
        },
      },
    });

    expect(Object.keys(cli.commands).sort()).toEqual([
      "api",
      "auth",
      "config",
      "greet",
      "help",
      "logs",
      "profile",
      "schema",
      "serve",
      "status",
      "update",
      "version",
      "ws",
    ]);
    expect(await cli.execute(["--profile", "work", "greet"])).toEqual({
      exitCode: 0,
      output: "hello work",
    });
    expect(() => createWebAppCli({
      appName: "Test",
      commandName: "test-app",
      envPrefix: "TEST_APP",
      version: "1.2.3",
      profileStore: profileStore(),
      stdin: cliInput(),
      commands: {
        version: {
          description: "Implicit collision.",
          handler: () => ({ exitCode: 0 }),
        },
      },
    })).toThrow("set override: true");

    const overridden = createWebAppCli({
      appName: "Test",
      commandName: "test-app",
      envPrefix: "TEST_APP",
      version: "1.2.3",
      profileStore: profileStore(),
      stdin: cliInput(),
      commands: {
        version: {
          description: "Application version output.",
          override: true,
          handler: () => ({ exitCode: 0, output: "custom" }),
        },
      },
    });
    expect(await overridden.execute(["version"])).toEqual({
      exitCode: 0,
      output: "custom",
    });
  });

  test("generates top-level and command help and invokes the serve callback", async () => {
    let starts = 0;
    const cli = createWebAppCli({
      appName: "Test",
      commandName: "test-app",
      envPrefix: "TEST_APP",
      version: "1.2.3",
      profileStore: profileStore(),
      stdin: cliInput(),
      start: async () => {
        starts += 1;
      },
    });

    const topLevel = await cli.execute(["help"]);
    const command = await cli.execute(["serve", "--help"]);
    const served = await cli.execute(["serve"]);

    expect(topLevel.output).toContain("Usage: test-app [--profile NAME] <command>");
    expect(topLevel.output).toContain("profile");
    expect(command.output).toContain("Usage: test-app [--profile NAME] serve");
    expect(command.output).toContain("serve up --dev");
    expect(served.exitCode).toBe(0);
    expect(starts).toBe(1);
  });

  test("stores default CLI profiles inside the configured application state directory", async () => {
    const root = resolve(".cache/tests/cli-state", crypto.randomUUID());
    const dataDir = join(root, "state");
    const home = join(root, "home");
    try {
      const cli = createWebAppCli({
        appName: "Test",
        commandName: "test-app",
        envPrefix: "TEST_APP",
        version: "1.2.3",
        environment: {
          HOME: home,
          TEST_APP_DATA_DIR: dataDir,
        },
        stdin: cliInput(),
        commands: {
          save: {
            description: "Save test credentials.",
            handler: async ({ profiles }) => {
              await profiles.credentials("saved").write({
                baseUrl: "https://example.test",
                clientId: "test",
                accessToken: "access",
                refreshToken: "refresh",
                tokenType: "Bearer",
                scope: "test",
                accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              });
              return { exitCode: 0 };
            },
          },
        },
      });

      expect((await cli.execute(["save"])).exitCode).toBe(0);
      expect(await Bun.file(join(dataDir, "profiles.json")).exists()).toBe(true);
      expect(await Bun.file(join(dataDir, "profiles", "saved", "device-auth.json")).exists()).toBe(true);
      expect(await Bun.file(join(home, ".test-app", "profiles.json")).exists()).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
