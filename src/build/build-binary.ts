import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";

export type BunCompileTarget =
  | "bun-linux-x64"
  | "bun-linux-arm64"
  | "bun-darwin-x64"
  | "bun-darwin-arm64"
  | "bun-windows-x64";

export interface BuildWebAppBinaryOptions {
  entrypoint: string;
  outfile: string;
  target?: BunCompileTarget;
  define?: Record<string, string>;
  web?: {
    entry?: string;
  };
}

export function getBunCompileTargetFromArgs(argv = Bun.argv): BunCompileTarget | undefined {
  const raw = argv.find((arg) => arg.startsWith("--target="))?.slice("--target=".length);
  return raw as BunCompileTarget | undefined;
}

export async function buildWebAppBinary(options: BuildWebAppBinaryOptions): Promise<void> {
  mkdirSync(dirname(options.outfile), { recursive: true });
  const packageRoot = findPackageRoot(dirname(resolve(options.entrypoint)));
  const buildId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const cacheDir = resolve(packageRoot, ".cache", "webapp-build", buildId);
  mkdirSync(cacheDir, { recursive: true });
  const webEntry = resolve(dirname(resolve(options.entrypoint)), options.web?.entry ?? "./web/main.tsx");
  const browserEntry = resolve(cacheDir, "webapp-browser-entry.ts");
  const browserOutDir = resolve(cacheDir, "browser");
  writeFileSync(browserEntry, `import { createRoot } from "react-dom/client";
import { configureWebAppRenderer } from "@pablozaiden/webapp/web";

configureWebAppRenderer(createRoot);
import ${JSON.stringify(webEntry)};
`);
  const browserBuild = await Bun.build({
    entrypoints: [browserEntry],
    outdir: browserOutDir,
    target: "browser",
    minify: true,
    sourcemap: "external",
    define: options.define,
  });
  if (!browserBuild.success) {
    for (const log of browserBuild.logs) {
      console.error(log);
    }
    throw new Error("Browser build failed");
  }
  const assets = browserBuild.outputs
    .map((output) => {
      const ext = extname(output.path).toLowerCase();
      const publicPath = `/webapp-compiled/${basename(output.path)}`;
      return {
        path: publicPath,
        contentType: contentTypeForOutput(ext),
        role: ext === ".css" ? "style" : ext === ".js" ? "script" : "asset",
        body: readFileSync(output.path).toString("base64"),
      };
    });
  const compiledAssetsModule = resolve(cacheDir, "compiled-webapp-assets.ts");
  writeFileSync(compiledAssetsModule, `globalThis[Symbol.for("webapp.compiledClient")] = ${JSON.stringify({ packageRoot, assets })};
`);
  const compiledEntrypoint = resolve(cacheDir, "entrypoint.ts");
  writeFileSync(compiledEntrypoint, `import "./compiled-webapp-assets";
  import ${JSON.stringify(resolve(options.entrypoint))};
`);
  const result = await Bun.build({
    entrypoints: [compiledEntrypoint],
    target: "bun",
    minify: true,
    sourcemap: "external",
    define: options.define,
    compile: options.target ? { target: options.target, outfile: options.outfile } : { outfile: options.outfile },
  });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error("Binary build failed");
  }
  if (process.platform !== "win32" && !options.target?.startsWith("bun-windows")) {
    chmodSync(options.outfile, 0o755);
  }
}

function findPackageRoot(start: string): string {
  let current = start;
  while (true) {
    if (existsSync(resolve(current, "package.json"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

function contentTypeForOutput(ext: string): string {
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".map") return "application/json; charset=utf-8";
  return "application/octet-stream";
}
