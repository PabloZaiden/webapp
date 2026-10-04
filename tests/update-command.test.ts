import { describe, expect, test } from "bun:test";
import { buildReleaseAssetName, resolveReleasePlatform } from "@pablozaiden/installer";
import {
  createWebAppCli,
  type CliProfileStore,
  type StoredDeviceCredentials,
} from "@pablozaiden/webapp/cli";

function createProfileStore(): CliProfileStore {
  const credentials = new Map<string, StoredDeviceCredentials>();
  return {
    selectedName: async name => name ?? "default",
    list: async () => [],
    use: async () => undefined,
    remove: async () => false,
    credentials: name => ({
      path: () => name,
      read: async () => credentials.get(name),
      write: async value => {
        credentials.set(name, value);
      },
      clear: async () => {
        credentials.delete(name);
      },
    }),
  };
}

function updaterAssetName(tagName: string): string {
  const target = resolveReleasePlatform(process.platform, process.arch);
  return buildReleaseAssetName("link-cli", tagName, target);
}

function stableReleaseResponse(tagName: string): Response {
  const assetName = updaterAssetName(tagName);
  return Response.json({
    tag_name: tagName,
    draft: false,
    prerelease: false,
    assets: [{
      name: assetName,
      browser_download_url: `https://downloads.example/${assetName}`,
    }],
  });
}

function prereleaseListResponse(tagName: string): Response {
  const assetName = updaterAssetName(tagName);
  return Response.json([{
    tag_name: tagName,
    draft: false,
    prerelease: true,
    assets: [{
      name: assetName,
      browser_download_url: `https://downloads.example/${assetName}`,
    }],
  }]);
}

function createUpdaterCli(responses: Response[]): {
  cli: ReturnType<typeof createWebAppCli>;
  output: string[];
  urls: string[];
} {
  const queuedResponses = [...responses];
  const output: string[] = [];
  const urls: string[] = [];
  const cli = createWebAppCli({
    appName: "Updater CLI Test",
    commandName: "updater-test",
    envPrefix: "UPDATER_TEST",
    version: "1.2.2",
    update: {
      repository: "pablozaiden/link",
      binaryName: "link-cli",
      currentVersion: "1.2.2",
    },
    profileStore: createProfileStore(),
    fetchFn: (async (input: string | URL | Request) => {
      urls.push(String(input));
      const response = queuedResponses.shift();
      if (!response) {
        throw new Error(`Unexpected fetch: ${String(input)}`);
      }
      return response;
    }) as typeof fetch,
    stdout: { write: chunk => output.push(chunk) },
    stderr: { write: () => undefined },
  });
  return { cli, output, urls };
}

describe("update CLI", () => {
  test("checks a newer prerelease when requested", async () => {
    const { cli, output } = createUpdaterCli([
      stableReleaseResponse("v1.2.3"),
      prereleaseListResponse("v1.3.0-rc.1"),
    ]);

    const result = await cli.execute(["update", "--check", "--pre-release"]);

    expect(result.exitCode).toBe(0);
    expect(output.join("")).toContain("1.3.0-rc.1");
  });

  test("keeps the default check on the stable release", async () => {
    const { cli, output, urls } = createUpdaterCli([
      stableReleaseResponse("v1.2.3"),
    ]);

    const result = await cli.execute(["update", "--check"]);

    expect(result.exitCode).toBe(0);
    expect(output.join("")).toContain("1.2.3");
    expect(urls).toHaveLength(1);
  });
});
