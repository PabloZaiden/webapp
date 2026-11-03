import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createWebAppServer, defineRoutes } from "../src/server";

type AppFixture = {
  root: string;
  entrypoint: string;
};

function createAppFixture(withReactDom: boolean): AppFixture {
  const root = resolve(".cache/tests", `webapp-server-package-resolution-${crypto.randomUUID()}`);
  const sourceDir = join(root, "src");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: withReactDom ? "fixture-native-react-dom" : "fixture-native-missing-react-dom",
    private: true,
  }));
  const entrypoint = join(sourceDir, "main.tsx");
  writeFileSync(entrypoint, "console.log('fixture web entry');\n");

  if (withReactDom) {
    const reactDomRoot = join(root, "node_modules", "react-dom");
    mkdirSync(reactDomRoot, { recursive: true });
    writeFileSync(join(reactDomRoot, "package.json"), JSON.stringify({
      name: "react-dom",
      version: "fixture-native",
      exports: { "./client": "./client.js" },
    }));
    writeFileSync(join(reactDomRoot, "client.js"), `export function createRoot() {
  globalThis.__fixtureNativeReactDomMarker = "native-app-react-dom";
  return { render() {} };
}
`);
  } else {
    const rootPackage = join(root, "node_modules", "react-dom");
    mkdirSync(rootPackage, { recursive: true });
    writeFileSync(join(rootPackage, "package.json"), JSON.stringify({ name: "react-dom", exports: {} }));
  }

  return { root, entrypoint };
}

test("native server documents load an application-local react-dom export", async () => {
  const fixture = createAppFixture(true);
  const envPrefix = "PACKAGE_RESOLUTION_NATIVE";

  try {
    const app = createWebAppServer({
      appName: "Native Resolution Fixture",
      envPrefix,
      runtimeConfig: {
        appName: "Native Resolution Fixture",
        envPrefix,
        host: "127.0.0.1",
        port: 0,
        dataDir: join(fixture.root, "data", "native"),
        logLevel: "info",
        logLevelFromEnv: false,
        sameOriginDisabled: true,
        trustProxy: { enabled: false, headers: [], chain: "first" },
        development: false,
      },
      web: { entry: pathToFileURL(fixture.entrypoint) },
      routes: defineRoutes({}),
    });

    const server = await app.start();
    try {
      const response = await fetch(new URL("/", server.url));
      expect(response.status).toBe(200);
      const html = await response.text();
      const scriptPaths = Array.from(
        html.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+)"/g),
        (match) => match[1],
      ).filter((path): path is string => path !== undefined);
      expect(scriptPaths.length).toBeGreaterThan(0);

      const scriptResponses = await Promise.all(
        scriptPaths.map(async (path) => await fetch(new URL(path, server.url), {
          headers: { accept: "text/javascript" },
        })),
      );
      expect(scriptResponses.every((response) => response.status === 200)).toBe(true);
      const scriptBodies = await Promise.all(scriptResponses.map((response) => response.text()));
      expect(scriptBodies.some((body) => body.includes("native-app-react-dom"))).toBe(true);
    } finally {
      await server.stop(true);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("native server reports a missing application react-dom before serving a document", () => {
  const fixture = createAppFixture(false);

  try {
    expect(() => createWebAppServer({
      appName: "Missing React DOM Fixture",
      envPrefix: "PACKAGE_RESOLUTION_MISSING",
      web: { entry: pathToFileURL(fixture.entrypoint) },
      routes: defineRoutes({}),
    })).toThrow(/Unable to resolve "react-dom\/client".*Install "react-dom"/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
