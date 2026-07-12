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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

test("getBunCompileTargetFromArgs accepts every supported target and no target", () => {
  expect(getBunCompileTargetFromArgs(["bun", "src/build.ts"])).toBeUndefined();

  for (const target of BUN_COMPILE_TARGETS) {
    expect(getBunCompileTargetFromArgs(["bun", "src/build.ts", `--target=${target}`])).toBe(target);
  }
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
    const css = compiled.assets
      .filter((asset) => asset.contentType.includes("text/css"))
      .map((asset) => Buffer.from(asset.body, "base64").toString("utf8"))
      .join("\n");

    expect(css).toContain("rounded-lg");
    expect(css).toContain("max-w-7xl");
    expect(css).toContain("grid");

    const scripts = compiled.assets
      .filter((asset) => asset.contentType.includes("text/javascript"))
      .map((asset) => Buffer.from(asset.body, "base64").toString("utf8"))
      .join("\n");
    expect(scripts).toContain("customPluginMarker");
  } finally {
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
    dependencies: { react: "19.2.7", "react-dom": "fixture-local" },
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
