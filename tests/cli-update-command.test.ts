import { describe, expect, test } from "bun:test";
import {
  buildReleaseAssetName,
  resolveReleasePlatform,
} from "@pablozaiden/installer";
import { createWebAppCli } from "@pablozaiden/webapp/cli";

function outputCapture(): {
  stdout: string[];
  stderr: string[];
  stdoutWriter: { write(chunk: string): void };
  stderrWriter: { write(chunk: string): void };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    stdoutWriter: { write: (chunk) => stdout.push(chunk) },
    stderrWriter: { write: (chunk) => stderr.push(chunk) },
  };
}

function releaseFetch(version: string, requests: string[]): typeof fetch {
  const platform = resolveReleasePlatform(process.platform, process.arch);
  const assetName = buildReleaseAssetName("demo", version, platform);
  return (async (input: string | URL | Request) => {
    requests.push(String(input));
    return Response.json({
      tag_name: version,
      assets: [{
        name: assetName,
        browser_download_url: `https://downloads.example.test/${assetName}`,
      }],
    });
  }) as typeof fetch;
}

function createUpdateCli(
  version = "1.0.0",
  update?: {
    repository: string;
    binaryName: string;
    currentVersion: string;
  },
) {
  const output = outputCapture();
  const requests: string[] = [];
  const cli = createWebAppCli({
    appName: "Demo",
    commandName: "demo",
    envPrefix: "DEMO",
    version,
    update: update ?? {
      repository: "example/demo",
      binaryName: "demo",
      currentVersion: version,
    },
    fetchFn: releaseFetch("v1.1.0", requests),
    stdout: output.stdoutWriter,
    stderr: output.stderrWriter,
  });
  return { cli, output, requests };
}

describe("generic update CLI command", () => {
  test("delegates update checks to the installer and streams progress", async () => {
    const { cli, output, requests } = createUpdateCli();

    const result = await cli.execute(["update", "--check"]);

    expect(result).toEqual({ exitCode: 0 });
    expect(output.stdout.join("")).toContain("Update available: 1.0.0 -> 1.1.0");
    expect(output.stderr).toEqual([]);
    expect(requests).toEqual([
      "https://api.github.com/repos/example/demo/releases/latest",
    ]);
  });

  test("passes an explicit version to the installer", async () => {
    const { cli, requests } = createUpdateCli("1.1.0");

    const result = await cli.execute(["update", "--version=1.1.0"]);

    expect(result).toEqual({ exitCode: 0 });
    expect(requests).toEqual([
      "https://api.github.com/repos/example/demo/releases/tags/v1.1.0",
    ]);
  });

  test("rejects incompatible or unknown update options", async () => {
    const { cli } = createUpdateCli();

    await expect(cli.execute(["update", "--check", "--version", "1.1.0"])).resolves.toEqual({
      exitCode: 1,
      error: "Cannot combine --check with --version",
    });
    await expect(cli.execute(["update", "--unknown"])).resolves.toEqual({
      exitCode: 1,
      error: "Unknown update option: --unknown",
    });
  });

  test("reports when an application has no update configuration", async () => {
    const { cli } = createUpdateCli("1.0.0", undefined);
    const unconfigured = createWebAppCli({
      appName: "Demo",
      commandName: "demo",
      envPrefix: "DEMO",
      version: "1.0.0",
    });

    expect(await unconfigured.execute(["update"])).toEqual({
      exitCode: 1,
      error: "No application update configuration is configured",
    });
    expect(cli.commands["update"]).toBeDefined();
  });
});
