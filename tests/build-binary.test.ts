import { afterEach, expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildWebAppBinary } from "../src/build/build-binary";

const runningProcesses: Array<ReturnType<typeof Bun.spawn>> = [];

afterEach(() => {
  for (const process of runningProcesses.splice(0)) {
    process.kill();
  }
});

test("buildWebAppBinary processes Tailwind CSS and app-provided browser plugins", async () => {
  const id = crypto.randomUUID();
  const fixtureRoot = resolve(".cache/tests/build-binary", id);
  const srcDir = join(fixtureRoot, "src");
  const outfile = join(fixtureRoot, "dist", "fixture-app");
  const port = 54000 + Math.floor(Math.random() * 1000);

  rmSync(fixtureRoot, { recursive: true, force: true });
  mkdirSync(srcDir, { recursive: true });

  writeFileSync(join(srcDir, "index.ts"), `import { createWebAppServer, defineRoutes } from "@pablozaiden/webapp/server";

const app = createWebAppServer({
  appName: "Build Fixture",
  envPrefix: "TEST_BINARY_BUILD",
  auth: { passkeys: false },
  web: { entry: "./frontend.tsx" },
  routes: defineRoutes({}),
});

await app.runFromCli();
`);
  writeFileSync(join(srcDir, "frontend.tsx"), `  import { renderWebApp } from "@pablozaiden/webapp/web";
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

    const server = Bun.spawn([outfile, "serve"], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        TEST_BINARY_BUILD_HOST: "127.0.0.1",
        TEST_BINARY_BUILD_PORT: String(port),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    runningProcesses.push(server);

    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForServer(baseUrl);

    const htmlResponse = await fetch(baseUrl);
    expect(htmlResponse.status).toBe(200);
    const html = await htmlResponse.text();
    expect(html).toContain("/webapp-compiled/webapp-client-entry.css");
    const cssPaths = Array.from(html.matchAll(/href="([^"]+\.css)"/g), (match) => match[1]!);
    expect(cssPaths.length).toBeGreaterThan(0);

    const cssResponse = await fetch(`${baseUrl}/webapp-compiled/webapp-client-entry.css`);
    expect(cssResponse.status).toBe(200);
    expect(cssResponse.headers.get("content-type")).toContain("text/css");
    const cssParts = [await cssResponse.text()];
    for (const cssPath of cssPaths) {
      if (cssPath === "/webapp-compiled/webapp-client-entry.css") {
        continue;
      }
      const response = await fetch(`${baseUrl}${cssPath}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/css");
      cssParts.push(await response.text());
    }
    const css = cssParts.join("\n");

    expect(css).toContain("rounded-lg");
    expect(css).toContain("max-w-7xl");
    expect(css).toContain("grid");

    const scriptPaths = Array.from(html.matchAll(/src="([^"]+\.js)"/g), (match) => match[1]!);
    expect(scriptPaths.length).toBeGreaterThan(0);
    const scripts = await Promise.all(scriptPaths.map(async (scriptPath) => {
      const response = await fetch(`${baseUrl}${scriptPath}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/javascript");
      return await response.text();
    }));
    expect(scripts.join("\n")).toContain("customPluginMarker");
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

async function waitForServer(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return;
      }
      lastError = new Error(`Unexpected health status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(50);
  }

  throw new Error(`Server did not become healthy: ${String(lastError)}`);
}
