import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createWebAppServer, defineRoutes, sqliteWebAppStore } from "../src/server";

type AppFixture = {
  root: string;
  entrypoint: string;
};

function createAppFixture(withReactDom: boolean): AppFixture {
  const root = join(tmpdir(), `webapp-server-package-resolution-${crypto.randomUUID()}`);
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
  }

  return { root, entrypoint };
}

function createStore(root: string, name: string) {
  return sqliteWebAppStore({ dataDir: join(root, "data", name) });
}

test("native server documents load an application-local react-dom export", async () => {
  const fixture = createAppFixture(true);

  try {
    const app = createWebAppServer({
      appName: "Native Resolution Fixture",
      envPrefix: "PACKAGE_RESOLUTION_NATIVE",
      web: { entry: pathToFileURL(fixture.entrypoint) },
      store: createStore(fixture.root, "native"),
      auth: { passkeys: false },
      routes: defineRoutes({}),
    });

    const response = await app.handleRequest(new Request("http://localhost/"));
    expect(response?.status).toBe(200);
    expect(await response?.text()).toContain('<div id="root"></div>');
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
      store: createStore(fixture.root, "missing"),
      auth: { passkeys: false },
      routes: defineRoutes({}),
    })).toThrow(/Unable to resolve "react-dom\/client".*Install "react-dom"/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("compiled server documents do not require runtime application node_modules", async () => {
  const fixture = createAppFixture(false);
  const compiledClientSymbol = Symbol.for("webapp.compiledClient");
  const globalWithCompiledClient = globalThis as Record<symbol, unknown>;
  globalWithCompiledClient[compiledClientSymbol] = {
    packageRoot: fixture.root,
    assets: [{
      path: "/webapp-compiled/fixture-client.js",
      contentType: "text/javascript; charset=utf-8",
      role: "script",
      scriptOrder: 1,
      body: Buffer.from("globalThis.__compiledFixtureLoaded = true;\n").toString("base64"),
    }],
  };

  try {
    const app = createWebAppServer({
      appName: "Compiled Resolution Fixture",
      envPrefix: "PACKAGE_RESOLUTION_COMPILED",
      web: { entry: pathToFileURL(fixture.entrypoint) },
      store: createStore(fixture.root, "compiled"),
      auth: { passkeys: false },
      routes: defineRoutes({}),
    });

    const response = await app.handleRequest(new Request("http://localhost/"));
    expect(response?.status).toBe(200);
    expect(await response?.text()).toContain("/webapp-compiled/fixture-client.js");
  } finally {
    delete globalWithCompiledClient[compiledClientSymbol];
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
