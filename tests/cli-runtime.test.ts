import { describe, expect, test } from "bun:test";
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
    expect(served.exitCode).toBe(0);
    expect(starts).toBe(1);
  });
});
