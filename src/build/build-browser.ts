import type { BunPlugin } from "bun";
import tailwindPlugin from "bun-plugin-tailwind";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findPackageRoot, resolveReactDomClient } from "../package-resolution";
import { collectWebAppStaticAssets, readWebAppStaticAssets, type WebAppStaticAssetOptions } from "../static-assets";
export type { WebAppStaticAssetOptions } from "../static-assets";
import {
  assertUniquePublicAssetPaths,
  buildOutputRelativePath,
  contentTypeForPublicAssetPath,
  normalizePublicAssetPath,
  publicAssetKindForBuildArtifact,
  type WebAppPublicAssetArtifact,
  type WebAppPublicAssetBundle,
} from "../server/public-asset-manifest";
import { compileWebAppPublicAsset, type WebAppPublicAssetOptions } from "./public-assets";

export interface WebAppBrowserBuildOptions {
  plugins?: BunPlugin[];
  define?: Record<string, string>;
  disableDefaultPlugins?: boolean;
}

export interface WebAppBrowserAsset extends WebAppPublicAssetArtifact {
  role: "script" | "style" | "asset";
  scriptOrder?: number;
}

interface BuildBrowserOptions {
  entry: string;
  define?: Record<string, string>;
  build?: WebAppBrowserBuildOptions;
  publicAssets?: WebAppPublicAssetOptions[];
  assets?: WebAppStaticAssetOptions[];
}

export interface WebAppBrowserBuild {
  packageRoot: string;
  assets: WebAppBrowserAsset[];
  publicAssetBundles: WebAppPublicAssetBundle[];
}

export function localBuildPath(value: string | URL): string {
  if (value instanceof URL) {
    if (value.protocol !== "file:") throw new Error(`Build input must be a local file: ${value.href}`);
    return fileURLToPath(value);
  }
  return resolve(value);
}

export async function buildWebAppBrowser(options: BuildBrowserOptions): Promise<WebAppBrowserBuild> {
  const entry = resolve(options.entry);
  const packageRoot = findPackageRoot(dirname(entry));
  const reactDomClientPath = resolveReactDomClient(packageRoot, entry);
  const cacheRoot = resolve(packageRoot, ".cache", "webapp-build");
  mkdirSync(cacheRoot, { recursive: true });
  const cacheDir = mkdtempSync(join(cacheRoot, "browser-"));
  const outdir = resolve(cacheDir, "output");
  const renderer = resolve(cacheDir, "webapp-renderer-prelude.ts");
  try {
    writeFileSync(renderer, `import { createRoot } from ${JSON.stringify(reactDomClientPath)};
import { configureWebAppRenderer, initializeWebAppClient } from "@pablozaiden/webapp/web";
configureWebAppRenderer(createRoot);
await initializeWebAppClient();
await import(${JSON.stringify(entry)});
`);
    const result = await Bun.build({
      entrypoints: [renderer],
      outdir,
      target: "browser",
      format: "esm",
      splitting: true,
      publicPath: "./",
      minify: true,
      sourcemap: "external",
      define: { ...options.define, ...options.build?.define },
      plugins: [
        ...(options.build?.plugins ?? []),
        ...(options.build?.disableDefaultPlugins ? [] : [tailwindPlugin]),
      ],
    });
    if (!result.success) {
      for (const log of result.logs) console.error(log);
      throw new Error("Browser build failed");
    }
    const assets: WebAppBrowserAsset[] = await Promise.all(result.outputs.map(async (output) => {
      const relativePath = buildOutputRelativePath(outdir, output);
      // Bun file-loader values resolve against the document, so keep outputs beside index.html.
      const path = normalizePublicAssetPath(`/${relativePath}`);
      const kind = publicAssetKindForBuildArtifact(output);
      const name = basename(output.path);
      const scriptOrder = name === "webapp-renderer-prelude.js" ? 0 : undefined;
      return {
        path,
        kind,
        contentType: contentTypeForPublicAssetPath(path, kind),
        role: extname(path) === ".css" ? "style" : scriptOrder !== undefined ? "script" : "asset",
        ...(scriptOrder !== undefined ? { scriptOrder } : {}),
        content: new Uint8Array(await output.arrayBuffer()),
      };
    }));
    const staticAssets = await readWebAppStaticAssets(collectWebAppStaticAssets(options.assets ?? [], packageRoot));
    assets.push(...staticAssets.map((asset) => ({ ...asset, role: "asset" as const })));
    const publicAssetBundles: WebAppPublicAssetBundle[] = [];
    for (const asset of options.publicAssets ?? []) {
      publicAssetBundles.push(await compileWebAppPublicAsset({
        ...asset,
        define: { ...options.define, ...asset.define },
      }));
    }
    assertUniquePublicAssetPaths([
      ...assets.map((asset) => asset.path),
      ...publicAssetBundles.flatMap((bundle) => bundle.artifacts.map((asset) => asset.path)),
    ], "compiled webapp assets");
    return { packageRoot, assets, publicAssetBundles };
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}
