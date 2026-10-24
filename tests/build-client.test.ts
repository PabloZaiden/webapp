import { expect, test } from "bun:test";
import { readdirSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildWebAppClient } from "@pablozaiden/webapp/build";
import { fetchClientArtifacts } from "./support/client-artifacts";

test("publishes one complete client directory at root and nested static-host paths", async () => {
  const directory = resolve(".cache/tests", `static-client-${crypto.randomUUID()}`);
  const output = join(directory, "public");
  const fixture = join(directory, "input");
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    await Bun.write(join(fixture, "main.ts"), `import "./main.css";
import("./lazy").then(({ label }) => { document.title = label; });
`);
    await Bun.write(join(fixture, "lazy.ts"), `export const label = PUBLIC_LABEL;`);
    await Bun.write(join(fixture, "main.css"), `@font-face { font-family: Test; src: url("./test.woff2"); }
body { font-family: Test; }`);
    await Bun.write(join(fixture, "test.woff2"), new Uint8Array([119, 79, 70, 50]));
    const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12"/></svg>`;
    await Bun.write(join(fixture, "icon.svg"), icon);
    await Bun.write(join(fixture, "worker.ts"), `self.onmessage = () => self.postMessage("ready");`);
    await Bun.write(join(fixture, "editor", "worker.js"), `self.onmessage = () => self.postMessage("editor");`);
    await Bun.write(join(fixture, "editor", "worker.js.map"), JSON.stringify({ version: 3, sources: [], names: [], mappings: "" }));
    await buildWebAppClient({
      entry: pathToFileURL(join(fixture, "main.ts")),
      outdir: output,
      appName: "Portable Client",
      title: "Portable <Client>",
      apiBaseUrl: "https://api.example.test",
      define: { PUBLIC_LABEL: JSON.stringify("Portable Client") },
      icons: {
        favicon: pathToFileURL(join(fixture, "icon.svg")),
        manifest: [{ src: pathToFileURL(join(fixture, "icon.svg")), sizes: "any" }],
      },
      publicAssets: [{
        path: "/workers/app.js",
        entrypoint: pathToFileURL(join(fixture, "worker.ts")),
        contentType: "text/javascript",
      }],
      assets: [{ path: "vendor/editor", src: join(fixture, "editor") }],
    });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const pathname = decodeURIComponent(new URL(req.url).pathname);
        const mount = pathname.startsWith("/nested/client/") ? "/nested/client/" : "/";
        const path = pathname.slice(mount.length);
        if (path.split("/").some((part) => part === "..")) return new Response(null, { status: 404 });
        const file = Bun.file(join(output, path || "index.html"));
        if (!await file.exists()) return new Response(null, { status: 404 });
        return new Response(file, {
          headers: path.endsWith(".webmanifest") ? { "content-type": "application/manifest+json" } : undefined,
        });
      },
    });
    const origin = `http://127.0.0.1:${server.port}`;
    for (const mount of ["/", "/nested/client/"]) {
      const documentUrl = `${origin}${mount}`;
      const graph = await fetchClientArtifacts(documentUrl);
      expect([...graph.keys()].every((url) => url.startsWith(documentUrl))).toBe(true);
      expect([...graph.keys()].some((url) => url.endsWith(".css"))).toBe(true);
      expect([...graph.entries()].some(([url, body]) => url.endsWith(".woff2")
        || (url.endsWith(".css") && /url\(["']?data:font\/woff2/.test(body)))).toBe(true);
      const manifestResponse = await fetch(`${documentUrl}site.webmanifest`);
      expect(await manifestResponse.json()).toMatchObject({
        name: "Portable Client",
        start_url: "./",
        scope: "./",
      });
      for (const entry of readdirSync(output, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const filePath = join(entry.parentPath, entry.name);
        const publicPath = relative(output, filePath).replaceAll("\\", "/");
        const response = await fetch(new URL(publicPath, documentUrl), { signal: AbortSignal.timeout(5_000) });
        expect(response.status, publicPath).toBe(200);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(await Bun.file(filePath).arrayBuffer()));
      }
      const favicon = await fetch(`${documentUrl}webapp-favicon.svg`);
      expect(await favicon.text()).toBe(icon);
    }
  } finally {
    await server?.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
