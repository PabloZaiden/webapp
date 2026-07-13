import type { BunPlugin } from "bun";
import tailwindPlugin from "bun-plugin-tailwind";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withBunBuildLock } from "../bun-build-lock";
import { findPackageRoot, resolveReactDomClient } from "../package-resolution";

export const BUN_COMPILE_TARGETS = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
  "bun-windows-x64",
] as const;

export type BunCompileTarget = (typeof BUN_COMPILE_TARGETS)[number];

const BUN_COMPILE_TARGET_SET = new Set<string>(BUN_COMPILE_TARGETS);

export function isBunCompileTarget(value: unknown): value is BunCompileTarget {
  return typeof value === "string" && BUN_COMPILE_TARGET_SET.has(value);
}

export interface BuildWebAppBinaryOptions {
  entrypoint: string;
  outfile: string;
  target?: BunCompileTarget;
  define?: Record<string, string>;
  web?: {
    entry?: string;
    build?: {
      plugins?: BunPlugin[];
      define?: Record<string, string>;
      disableDefaultPlugins?: boolean;
    };
  };
}

function formatTargetValue(value: unknown): string {
  if (value === undefined) return "<missing>";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function supportedTargetMessage(): string {
  return `Supported Bun compile targets: ${BUN_COMPILE_TARGETS.join(", ")}.`;
}

export function assertBunCompileTarget(value: unknown): asserts value is BunCompileTarget {
  if (!isBunCompileTarget(value)) {
    throw new Error(`Invalid Bun compile target ${formatTargetValue(value)}. ${supportedTargetMessage()}`);
  }
}

export function getBunCompileTargetFromArgs(argv = Bun.argv): BunCompileTarget | undefined {
  const targetArguments: Array<{ argument: string; value: string }> = [];
  for (const [index, argument] of argv.entries()) {
    if (argument === undefined) continue;
    if (argument === "--target" || (argument.startsWith("--target") && !argument.startsWith("--target="))) {
      const nextArgument = argv[index + 1];
      const received = argument === "--target" && nextArgument && !nextArgument.startsWith("--")
        ? `${argument} ${nextArgument}`
        : argument;
      throw new Error(`Malformed Bun compile target option ${formatTargetValue(received)}. Expected --target=<target>. ${supportedTargetMessage()}`);
    }
    if (argument.startsWith("--target=")) {
      targetArguments.push({
        argument,
        value: argument.slice("--target=".length),
      });
    }
  }
  if (targetArguments.length === 0) return undefined;
  if (targetArguments.length > 1) {
    throw new Error(`Duplicate Bun compile target options are not allowed: ${targetArguments.map(({ argument }) => argument).join(", ")}. ${supportedTargetMessage()}`);
  }
  const targetArgument = targetArguments[0];
  if (targetArgument === undefined) return undefined;
  const { value } = targetArgument;
  assertBunCompileTarget(value);
  return value;
}

export async function buildWebAppBinary(options: BuildWebAppBinaryOptions): Promise<void> {
  if (options.target !== undefined) {
    assertBunCompileTarget(options.target);
  }
  const entrypoint = resolve(options.entrypoint);
  const packageRoot = findPackageRoot(dirname(entrypoint));
  const reactDomClientPath = resolveReactDomClient(packageRoot, entrypoint);
  mkdirSync(dirname(options.outfile), { recursive: true });
  const buildId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const cacheDir = resolve(packageRoot, ".cache", "webapp-build", buildId);
  try {
    mkdirSync(cacheDir, { recursive: true });
    const webEntry = resolve(dirname(resolve(options.entrypoint)), options.web?.entry ?? "./web/main.tsx");
    const rendererEntry = resolve(cacheDir, "webapp-renderer-prelude.ts");
    const clientEntry = resolve(cacheDir, "webapp-client-entry.ts");
    const browserOutDir = resolve(cacheDir, "browser");
    const frameworkWebPath = fileURLToPath(new URL("../web/renderer-config.ts", import.meta.url)).replaceAll("\\", "/");
    writeFileSync(rendererEntry, `import { createRoot } from ${JSON.stringify(reactDomClientPath.replaceAll("\\", "/"))};
import { configureWebAppRenderer } from ${JSON.stringify(frameworkWebPath)};

configureWebAppRenderer(createRoot);
`);
    writeFileSync(clientEntry, `import ${JSON.stringify(webEntry)};
`);
    const browserPlugins = [
      ...(options.web?.build?.plugins ?? []),
      ...(options.web?.build?.disableDefaultPlugins ? [] : [tailwindPlugin]),
    ];
    const browserBuild = await withBunBuildLock(() => Bun.build({
      entrypoints: [rendererEntry, clientEntry],
      outdir: browserOutDir,
      target: "browser",
      format: "esm",
      splitting: true,
      publicPath: "/webapp-compiled/",
      minify: true,
      sourcemap: "external",
      define: { ...options.define, ...options.web?.build?.define },
      plugins: browserPlugins,
    }), packageRoot);
    if (!browserBuild.success) {
      for (const log of browserBuild.logs) {
        console.error(log);
      }
      throw new Error("Browser build failed");
    }
    const assets = browserBuild.outputs
      .filter((output) => extname(output.path).toLowerCase() !== ".map")
      .map((output) => {
        const ext = extname(output.path).toLowerCase();
        const fileName = basename(output.path);
        const publicPath = `/webapp-compiled/${basename(output.path)}`;
        const scriptKind = ext === ".js" ? compiledScriptKind(fileName) : undefined;
        return {
          path: publicPath,
          contentType: contentTypeForOutput(ext),
          role: ext === ".css" ? "style" : scriptKind ? "script" : "asset",
          ...(scriptKind ? { scriptOrder: scriptKind === "renderer" ? 0 : 1 } : {}),
          body: readFileSync(output.path).toString("base64"),
        };
      });
    const compiledAssetsModule = resolve(cacheDir, "compiled-webapp-assets.ts");
    writeFileSync(compiledAssetsModule, `globalThis[Symbol.for("webapp.compiledClient")] = ${JSON.stringify({ packageRoot, assets })};
`);
    const compiledEntrypoint = resolve(cacheDir, "entrypoint.ts");
    writeFileSync(compiledEntrypoint, `import "./compiled-webapp-assets";
import ${JSON.stringify(entrypoint)};
`);
    const result = await withBunBuildLock(() => Bun.build({
      entrypoints: [compiledEntrypoint],
      target: "bun",
      minify: true,
      sourcemap: "external",
      define: options.define,
      compile: options.target ? { target: options.target, outfile: options.outfile } : { outfile: options.outfile },
    }), packageRoot);
    if (!result.success) {
      for (const log of result.logs) {
        console.error(log);
      }
      throw new Error("Binary build failed");
    }
    if (process.platform !== "win32" && !options.target?.startsWith("bun-windows")) {
      chmodSync(options.outfile, 0o755);
    }
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
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

function compiledScriptKind(fileName: string): "renderer" | "client" | undefined {
  if (/^webapp-renderer-prelude(?:[-.][\w-]+)?\.(?:mjs|js)$/.test(fileName)) return "renderer";
  if (/^webapp-client-entry(?:[-.][\w-]+)?\.(?:mjs|js)$/.test(fileName)) return "client";
  return undefined;
}
