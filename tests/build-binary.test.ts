import { expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildWebAppBinary } from "../src/build/build-binary";

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
