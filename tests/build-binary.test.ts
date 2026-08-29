import { expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  BUN_COMPILE_TARGETS,
  buildWebAppBinary,
  getBunCompileTargetFromArgs,
} from "../src/build/build-binary";
import { createWebAppPublicAsset, createWebAppServer, defineRoutes, sqliteWebAppStore } from "../src/server";
import { normalizePublicAssetPath, publicAssetKind } from "../src/server/public-asset-manifest";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForOutput(stream: ReadableStream<Uint8Array>, marker: string): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      throw new Error(`Process output ended before marker ${marker}`);
    }
    output += decoder.decode(chunk.value, { stream: true });
    if (output.includes(marker)) {
      return output;
    }
  }
}

test("getBunCompileTargetFromArgs accepts every supported target and no target", () => {
  expect(getBunCompileTargetFromArgs(["bun", "src/build.ts"])).toBeUndefined();

  for (const target of BUN_COMPILE_TARGETS) {
    expect(getBunCompileTargetFromArgs(["bun", "src/build.ts", `--target=${target}`])).toBe(target);
  }
});

test("getBunCompileTargetFromArgs ignores missing sparse argv entries", () => {
  const args = new Array<string>(3);
  args[2] = "--target=bun-linux-x64";

  expect(getBunCompileTargetFromArgs(args)).toBe("bun-linux-x64");
});

test("getBunCompileTargetFromArgs rejects invalid target arguments with supported choices", () => {
  const invalidCases = [
    { args: ["--target="], expected: `Invalid Bun compile target ""` },
    { args: ["--target=bun-freebsd-x64"], expected: `"bun-freebsd-x64"` },
    {
      args: ["--target=bun-linux-x64", "--target=bun-linux-arm64"],
      expected: "Duplicate Bun compile target options",
    },
    { args: ["--target"], expected: "Malformed Bun compile target option" },
    { args: ["--target", "bun-linux-x64"], expected: "--target bun-linux-x64" },
    { args: ["--target-bun-linux-x64"], expected: "--target-bun-linux-x64" },
  ];

  for (const testCase of invalidCases) {
    let thrown: unknown;
    try {
      getBunCompileTargetFromArgs(testCase.args);
    } catch (error) {
      thrown = error;
    }

    const message = errorMessage(thrown);
    expect(message).toContain(testCase.expected);
    for (const target of BUN_COMPILE_TARGETS) {
      expect(message).toContain(target);
    }
  }
});

test("buildWebAppBinary rejects an invalid runtime target before creating output directories", async () => {
  const fixtureRoot = resolve(".cache/tests/build-binary-runtime-target", crypto.randomUUID());
  const outfile = join(fixtureRoot, "dist", "fixture-app");
  const invalidOptions = JSON.parse(JSON.stringify({
    entrypoint: join(fixtureRoot, "src", "index.ts"),
    outfile,
    target: "bun-freebsd-x64",
  }));

  rmSync(fixtureRoot, { recursive: true, force: true });
  try {
    await expect(buildWebAppBinary(invalidOptions)).rejects.toThrow("bun-freebsd-x64");
    expect(existsSync(dirname(outfile))).toBe(false);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("buildWebAppBinary processes Tailwind CSS and app-provided browser plugins", async () => {
  const id = crypto.randomUUID();
  const fixtureRoot = resolve(".cache/tests/build-binary", id);
  const srcDir = join(fixtureRoot, "src");
  const outfile = join(fixtureRoot, "dist", "fixture-app");
  const assetsPath = join(fixtureRoot, "compiled-assets.json");

  rmSync(fixtureRoot, { recursive: true, force: true });
  mkdirSync(srcDir, { recursive: true });

  writeFileSync(join(srcDir, "index.ts"), `const compiledClient = globalThis[Symbol.for("webapp.compiledClient")];
const outputPath = process.env["TEST_COMPILED_ASSETS_PATH"];

if (!outputPath) {
  throw new Error("TEST_COMPILED_ASSETS_PATH is required");
}

await Bun.write(outputPath, JSON.stringify(compiledClient));
`);
  writeFileSync(join(srcDir, "frontend.tsx"), `import { renderWebApp } from "@pablozaiden/webapp/web";
import "@pablozaiden/webapp/web/styles.css";
import "./app.css";

function FixtureApp() {
  return <main className="grid max-w-7xl rounded-lg p-6 text-gray-900">Fixture</main>;
}

renderWebApp(<FixtureApp />);
`);
  writeFileSync(join(srcDir, "app.css"), `@import "tailwindcss";\n`);

  let customPluginLoadCount = 0;
  const markerPlugin: BunPlugin = {
    name: "test-marker-js",
    setup(build) {
      build.onLoad({ filter: /frontend/ }, async (args) => {
        customPluginLoadCount++;
        return {
          contents: `${await Bun.file(args.path).text()}\nglobalThis.__customPluginMarker = true;\n`,
          loader: "tsx",
        };
      });
    },
  };

  try {
    await buildWebAppBinary({
      entrypoint: join(srcDir, "index.ts"),
      outfile,
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      web: {
        entry: "./frontend.tsx",
        build: {
          plugins: [markerPlugin],
        },
      },
    });
    expect(customPluginLoadCount).toBeGreaterThan(0);

    const child = Bun.spawn([outfile], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        TEST_COMPILED_ASSETS_PATH: assetsPath,
      },
      stdout: "ignore",
      stderr: "pipe",
    });

    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);

    const compiled = await Bun.file(assetsPath).json() as {
      assets: Array<{ path: string; contentType: string; role: string; body: string }>;
    };
    const cssAssets = compiled.assets
      .filter((asset) => asset.contentType.includes("text/css"));
    expect(cssAssets.length).toBeGreaterThan(0);
    expect(cssAssets.every((asset) => Buffer.from(asset.body, "base64").byteLength > 0)).toBe(true);

    const scripts = compiled.assets
      .filter((asset) => asset.contentType.includes("text/javascript"))
      .map((asset) => Buffer.from(asset.body, "base64").toString("utf8"))
      .join("\n");
    expect(scripts).toContain("customPluginMarker");
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("buildWebAppBinary embeds app-owned public assets", async () => {
  const id = crypto.randomUUID();
  const fixtureRoot = resolve(".cache/tests/build-binary-public-asset", id);
  const srcDir = join(fixtureRoot, "src");
  const outfile = join(fixtureRoot, "dist", "fixture-app");
  const assetsPath = join(fixtureRoot, "compiled-assets.json");

  rmSync(fixtureRoot, { recursive: true, force: true });
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, "index.ts"), `const publicAssets = globalThis[Symbol.for("webapp.compiledPublicAssets")];
const outputPath = process.env["TEST_COMPILED_ASSETS_PATH"];

if (!outputPath) {
  throw new Error("TEST_COMPILED_ASSETS_PATH is required");
}

await Bun.write(outputPath, JSON.stringify(publicAssets));
`);
  writeFileSync(join(srcDir, "frontend.tsx"), "export {};\n");
  writeFileSync(join(srcDir, "public-asset-helper.ts"), `export const marker = "embedded-public-asset";\n`);
  writeFileSync(join(srcDir, "public-asset.ts"), `import "./public-asset-sidecar.css";
import { marker } from "./public-asset-helper";
globalThis[Symbol.for("fixture.publicAssetMarker")] = marker;
`);
  writeFileSync(join(srcDir, "public-asset-sidecar.css"), ".fixture-public-asset-sidecar { display: block; }\n");

  try {
    await buildWebAppBinary({
      entrypoint: join(srcDir, "index.ts"),
      outfile,
      web: {
        entry: "./frontend.tsx",
        publicAssets: [{
          path: "/fixture-public-bundle/entry.js",
          entrypoint: join(srcDir, "public-asset.ts"),
          contentType: "text/javascript; charset=utf-8",
          format: "iife",
        }],
      },
    });

    const child = Bun.spawn([outfile], {
      cwd: fixtureRoot,
      env: { ...process.env, TEST_COMPILED_ASSETS_PATH: assetsPath },
      stdout: "ignore",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const compiled = await Bun.file(assetsPath).json() as {
      bundles: Array<{
        entry: string;
        artifacts: Array<{ path: string; kind: string; contentType: string; body: string }>;
      }>;
    };
    expect(compiled.bundles).toHaveLength(1);
    const bundle = compiled.bundles[0];
    expect(bundle?.entry).toBe("/fixture-public-bundle/entry.js");
    expect(bundle?.artifacts.length).toBeGreaterThanOrEqual(2);
    expect(bundle?.artifacts.some((asset) => asset.path === "/fixture-public-bundle/entry.js" && asset.kind === "entry-point")).toBe(true);
    const sidecar = bundle?.artifacts.find((asset) => asset.kind !== "entry-point");
    expect(sidecar?.path).toContain("/fixture-public-bundle/");
    expect(sidecar?.contentType).toContain("text/css");
    expect(Buffer.from(sidecar?.body ?? "", "base64").byteLength).toBeGreaterThan(0);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("buildWebAppBinary rejects duplicate public asset paths", async () => {
  const fixtureRoot = resolve(".cache/tests/build-binary-duplicate-public-assets", crypto.randomUUID());
  const srcDir = join(fixtureRoot, "src");
  const outfile = join(fixtureRoot, "dist", "fixture-app");

  rmSync(fixtureRoot, { recursive: true, force: true });
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, "index.ts"), "export {};\n");
  writeFileSync(join(srcDir, "frontend.tsx"), "export {};\n");
  writeFileSync(join(srcDir, "public-asset.ts"), "export const asset = true;\n");

  try {
    await expect(buildWebAppBinary({
      entrypoint: join(srcDir, "index.ts"),
      outfile,
      web: {
        entry: "./frontend.tsx",
        publicAssets: [
          {
            path: "/duplicate-public-asset.js",
            entrypoint: join(srcDir, "public-asset.ts"),
            contentType: "text/javascript; charset=utf-8",
          },
          {
            path: "/duplicate-public-asset.js",
            entrypoint: join(srcDir, "public-asset.ts"),
            contentType: "text/javascript; charset=utf-8",
          },
        ],
      },
    })).rejects.toThrow('Duplicate public asset path "/duplicate-public-asset.js"');
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("public asset build output validation rejects unsupported kinds", () => {
  expect(() => publicAssetKind({ kind: "bytecode" }, "/fixture.bytecode")).toThrow(
    'Unsupported public asset build output kind "bytecode"',
  );
  expect(() => publicAssetKind({ kind: "unknown" }, "/fixture.unknown")).toThrow(
    'Unsupported public asset build output kind "unknown"',
  );
});

test("public asset paths reject URL-encoded traversal", () => {
  expect(() => normalizePublicAssetPath("/assets/%2e%2e/entry.js")).toThrow("traversal");
  expect(() => normalizePublicAssetPath("/assets/%2E/entry.js")).toThrow("traversal");
});

test("compiled public asset bundles serve the same primary and sidecar paths as development", async () => {
  const fixtureRoot = resolve(".cache/tests/build-binary-public-asset-parity", crypto.randomUUID());
  const srcDir = join(fixtureRoot, "src");
  const outfile = join(fixtureRoot, "dist", "fixture-app");
  const assetsPath = join(fixtureRoot, "compiled-assets.json");
  const dataDir = join(fixtureRoot, "data");
  const publicPath = "/fixture-public-bundle/entry.js";
  const publicAssetModule = resolve(process.cwd(), "src/server/public-assets.ts").replaceAll("\\", "/");
  const publicRouteDispatcherModule = resolve(process.cwd(), "src/server/public-route-dispatch.ts").replaceAll("\\", "/");

  rmSync(fixtureRoot, { recursive: true, force: true });
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, "index.ts"), `import { createWebAppPublicAsset } from ${JSON.stringify(publicAssetModule)};
import { createPublicRouteDispatcher } from ${JSON.stringify(publicRouteDispatcherModule)};

const publicPath = ${JSON.stringify(publicPath)};
const route = createWebAppPublicAsset({
  path: publicPath,
  entrypoint: new URL("./public-asset.ts", import.meta.url),
  contentType: "text/javascript; charset=utf-8",
  headers: { "cache-control": "no-cache" },
});
const dispatch = createPublicRouteDispatcher({
  publicRoutes: { [publicPath]: route },
  generatedRoutePaths: new Set(),
  ensureWebDocument: async () => {
    throw new Error("Compiled parity fixture does not use a web document");
  },
});

const outputPath = process.env["TEST_COMPILED_ASSETS_PATH"];
if (outputPath) {
  await Bun.write(outputPath, JSON.stringify(globalThis[Symbol.for("webapp.compiledPublicAssets")]));
}
const server = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const value = await dispatch(request);
    return value ?? new Response("Not found", { status: 404 });
  },
});
console.log("READY " + server.url.toString());
await new Promise<void>(() => {});
`);
  writeFileSync(join(srcDir, "frontend.tsx"), "export {};\n");
  writeFileSync(join(srcDir, "public-asset-helper.ts"), "export const marker = \"compiled-public-asset-parity\";\n");
  writeFileSync(join(srcDir, "public-asset.ts"), `import "./public-asset-sidecar.css";
import { marker } from "./public-asset-helper";
globalThis[Symbol.for("fixture.publicAssetMarker")] = marker;
`);
  writeFileSync(join(srcDir, "public-asset-sidecar.css"), ".fixture-public-asset-parity { display: block; }\n");

  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const entrypoint = join(srcDir, "public-asset.ts");
    const bundle = await import("../src/server/public-assets").then(({ compileWebAppPublicAsset }) => compileWebAppPublicAsset({
      path: publicPath,
      entrypoint,
      contentType: "text/javascript; charset=utf-8",
      headers: { "cache-control": "no-cache" },
    }));
    const sidecar = bundle.artifacts.find((artifact) => artifact.kind !== "entry-point");
    expect(sidecar).toBeDefined();

    const developmentApp = createWebAppServer({
      appName: "Development Public Asset Parity",
      envPrefix: "TEST_DEVELOPMENT_PUBLIC_ASSET_PARITY",
      store: sqliteWebAppStore({ dataDir: join(dataDir, "development") }),
      auth: { passkeys: false },
      publicRoutes: {
        [publicPath]: createWebAppPublicAsset({
          path: publicPath,
          entrypoint,
          contentType: "text/javascript; charset=utf-8",
          headers: { "cache-control": "no-cache" },
        }),
      },
      routes: defineRoutes({}),
    });
    const developmentPrimary = await developmentApp.handleRequest(new Request(`http://localhost${publicPath}`));
    const developmentSidecar = await developmentApp.handleRequest(new Request(`http://localhost${sidecar!.path}`));
    expect(developmentPrimary?.status).toBe(200);
    expect(developmentSidecar?.status).toBe(200);

    await buildWebAppBinary({
      entrypoint: join(srcDir, "index.ts"),
      outfile,
      web: {
        entry: "./frontend.tsx",
        publicAssets: [{
          path: publicPath,
          entrypoint,
          contentType: "text/javascript; charset=utf-8",
          headers: { "cache-control": "no-cache" },
          format: "iife",
        }],
      },
    });

    child = Bun.spawn([outfile], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        TEST_COMPILED_ASSETS_PATH: assetsPath,
        TEST_DATA_DIR: join(dataDir, "compiled"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (!child.stdout || typeof child.stdout === "number") {
      throw new Error("Compiled parity fixture did not expose stdout");
    }
    const output = await waitForOutput(child.stdout, "READY ");
    const readyLine = output.split("\n").find((line) => line.startsWith("READY "));
    expect(readyLine).toBeDefined();
    const baseUrl = readyLine!.slice("READY ".length).trim();
    const compiledManifest = await Bun.file(assetsPath).json() as {
      bundles: Array<{ entry: string; artifacts: Array<{ path: string; contentType: string; body: string }> }>;
    };
    expect(compiledManifest.bundles[0]?.entry).toBe(publicPath);
    expect(compiledManifest.bundles[0]?.artifacts.some((artifact) => artifact.path === sidecar!.path)).toBe(true);

    const compiledPrimary = await fetch(new URL(publicPath, baseUrl));
    const compiledSidecar = await fetch(new URL(sidecar!.path, baseUrl));
    expect(compiledPrimary.status).toBe(developmentPrimary!.status);
    expect(compiledSidecar.status).toBe(developmentSidecar!.status);
    expect(compiledPrimary.headers.get("content-type")).toBe(developmentPrimary!.headers.get("content-type"));
    expect(compiledSidecar.headers.get("content-type")).toBe(developmentSidecar!.headers.get("content-type"));
    expect(compiledPrimary.headers.get("cache-control")).toBe("no-cache");
    expect(compiledSidecar.headers.get("cache-control")).toBe("no-cache");
    expect(await compiledPrimary.bytes()).toEqual(await developmentPrimary!.bytes());
    expect(await compiledSidecar.bytes()).toEqual(await developmentSidecar!.bytes());
  } finally {
    child?.kill();
    if (child) {
      await child.exited;
    }
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("buildWebAppBinary resolves the renderer from an application-local package export", async () => {
  const fixtureRoot = resolve(".cache/tests/build-binary-package-resolution", crypto.randomUUID());
  const srcDir = join(fixtureRoot, "src");
  const reactDomRoot = join(fixtureRoot, "node_modules", "react-dom");
  const outfile = join(fixtureRoot, "dist", "fixture-app");
  const assetsPath = join(fixtureRoot, "compiled-assets.json");

  rmSync(fixtureRoot, { recursive: true, force: true });
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(reactDomRoot, { recursive: true });
  writeFileSync(join(fixtureRoot, "package.json"), JSON.stringify({
    name: "fixture-app-package",
    private: true,
    dependencies: { react: "19.2.8", "react-dom": "fixture-local" },
  }));
  writeFileSync(join(reactDomRoot, "package.json"), JSON.stringify({
    name: "react-dom",
    version: "fixture-local",
    exports: { "./client": "./client.js" },
  }));
  writeFileSync(join(reactDomRoot, "client.js"), `export function createRoot() {
  globalThis.__fixtureReactDomMarker = "app-local-react-dom";
  return { render() {} };
}
`);
  writeFileSync(join(srcDir, "index.ts"), `const compiledClient = globalThis[Symbol.for("webapp.compiledClient")];
const outputPath = process.env["TEST_COMPILED_ASSETS_PATH"];

if (!outputPath) {
  throw new Error("TEST_COMPILED_ASSETS_PATH is required");
}

await Bun.write(outputPath, JSON.stringify(compiledClient));
`);
  writeFileSync(join(srcDir, "frontend.tsx"), "export {};\n");

  try {
    await buildWebAppBinary({
      entrypoint: join(srcDir, "index.ts"),
      outfile,
      web: { entry: "./frontend.tsx" },
    });

    const child = Bun.spawn([outfile], {
      cwd: fixtureRoot,
      env: { ...process.env, TEST_COMPILED_ASSETS_PATH: assetsPath },
      stdout: "ignore",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const compiled = await Bun.file(assetsPath).json() as {
      assets: Array<{ contentType: string; body: string }>;
    };
    const scripts = compiled.assets
      .filter((asset) => asset.contentType.includes("text/javascript"))
      .map((asset) => Buffer.from(asset.body, "base64").toString("utf8"))
      .join("\n");
    expect(scripts).toContain("app-local-react-dom");
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("buildWebAppBinary reports a missing application react-dom before creating output", async () => {
  const fixtureRoot = join(tmpdir(), `webapp-build-binary-missing-react-dom-${crypto.randomUUID()}`);
  const srcDir = join(fixtureRoot, "src");
  const outfile = join(fixtureRoot, "dist", "fixture-app");

  rmSync(fixtureRoot, { recursive: true, force: true });
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(fixtureRoot, "package.json"), JSON.stringify({
    name: "fixture-missing-react-dom",
    private: true,
  }));
  writeFileSync(join(srcDir, "index.ts"), "export {};\n");

  try {
    await expect(buildWebAppBinary({
      entrypoint: join(srcDir, "index.ts"),
      outfile,
    })).rejects.toThrow(/Unable to resolve "react-dom\/client".*Install "react-dom"/);
    expect(existsSync(dirname(outfile))).toBe(false);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
