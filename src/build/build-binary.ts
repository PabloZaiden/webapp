import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { findPackageRoot } from "../package-resolution";
import { serializePublicAssetBundles } from "../server/public-assets";
import type { WebAppPublicAssetOptions } from "./public-assets";
import {
  buildWebAppBrowser,
  type WebAppBrowserBuildOptions,
  type WebAppStaticAssetOptions,
} from "./build-browser";

export const BUN_COMPILE_TARGETS = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
  "bun-windows-x64",
  "bun-windows-arm64",
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
    publicAssets?: WebAppPublicAssetOptions[];
    assets?: WebAppStaticAssetOptions[];
    build?: WebAppBrowserBuildOptions;
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
  mkdirSync(dirname(options.outfile), { recursive: true });
  const buildId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const cacheDir = resolve(packageRoot, ".cache", "webapp-build", buildId);
  try {
    mkdirSync(cacheDir, { recursive: true });
    const webEntry = resolve(dirname(resolve(options.entrypoint)), options.web?.entry ?? "./web/main.tsx");
    const browser = await buildWebAppBrowser({
      entry: webEntry,
      define: options.define,
      build: options.web?.build,
      publicAssets: options.web?.publicAssets,
      assets: options.web?.assets,
    });
    const assets = browser.assets.map(({ content, ...asset }) => ({
      ...asset,
      body: Buffer.from(content).toString("base64"),
    }));
    const compiledAssetsModule = resolve(cacheDir, "compiled-webapp-assets.ts");
    writeFileSync(compiledAssetsModule, `globalThis[Symbol.for("webapp.compiledClient")] = ${JSON.stringify({ packageRoot, assets })};
globalThis[Symbol.for("webapp.compiledPublicAssets")] = ${JSON.stringify(serializePublicAssetBundles(browser.publicAssetBundles))};
`);
    const compiledEntrypoint = resolve(cacheDir, "entrypoint.ts");
    writeFileSync(compiledEntrypoint, `import "./compiled-webapp-assets";
import ${JSON.stringify(entrypoint)};
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
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}
