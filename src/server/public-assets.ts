import type { BunPlugin } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertUniquePublicAssetPaths,
  buildOutputRelativePath,
  contentTypeForPublicAssetPath,
  decodePublicAssetBody,
  decodePublicAssetBundle,
  encodePublicAssetBundle,
  normalizePublicAssetPath,
  publicAssetKindForBuildArtifact,
  publicAssetSidecarPath,
  type SerializedWebAppPublicAssetArtifact,
  type SerializedWebAppPublicAssetBundle,
  type WebAppPublicAssetBundle,
} from "./public-asset-manifest";
import type { PublicRouteDefinition } from "./server-types";

const COMPILED_PUBLIC_ASSETS_SYMBOL = Symbol.for("webapp.compiledPublicAssets");
export const WEBAPP_PUBLIC_ASSET_ROUTE = Symbol.for("webapp.publicAssetRoute");

export interface WebAppPublicAssetOptions {
  path: string;
  entrypoint: string | URL;
  contentType: string;
  headers?: HeadersInit;
  format?: "iife" | "esm";
  define?: Record<string, string>;
  plugins?: BunPlugin[];
}

export interface WebAppPublicAssetRouteMetadata {
  primaryPath: string;
  getBundle: () => Promise<WebAppPublicAssetBundle>;
}

type PublicAssetRoute = PublicRouteDefinition & {
  readonly [WEBAPP_PUBLIC_ASSET_ROUTE]: WebAppPublicAssetRouteMetadata;
};

interface LegacyCompiledPublicAsset {
  path: string;
  body: string;
}

interface EmbeddedPublicAssets {
  bundles: WebAppPublicAssetBundle[];
  legacyAssets: LegacyCompiledPublicAsset[];
}

function hasCompiledPublicAssetsSymbol(): boolean {
  return Object.prototype.hasOwnProperty.call(globalThis, COMPILED_PUBLIC_ASSETS_SYMBOL);
}

function readLegacyCompiledPublicAssets(value: unknown): LegacyCompiledPublicAsset[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid compiled public asset manifest: assets must be an array");
  }
  return value.map((candidate, index) => {
    if (typeof candidate !== "object" || candidate === null) {
      throw new Error(`Invalid compiled public asset at assets[${index}]`);
    }
    const asset = candidate as Partial<LegacyCompiledPublicAsset>;
    if (typeof asset.path !== "string" || typeof asset.body !== "string") {
      throw new Error(`Invalid compiled public asset metadata at assets[${index}]`);
    }
    const path = normalizePublicAssetPath(asset.path);
    if (path !== asset.path) {
      throw new Error(`Compiled public asset path is not normalized at assets[${index}]: ${asset.path}`);
    }
    decodePublicAssetBody(asset.body, `assets[${index}].body`);
    return { path, body: asset.body };
  });
}

function resolveEntrypoint(entrypoint: string | URL): string {
  if (entrypoint instanceof URL) {
    if (entrypoint.protocol !== "file:") {
      throw new Error(`Public asset entrypoint must be a local file path or file URL; received ${entrypoint.protocol} URL`);
    }
    return fileURLToPath(entrypoint);
  }
  if (isAbsolute(entrypoint)) {
    return entrypoint;
  }
  return resolve(dirname(Bun.main || process.argv[1] || "."), entrypoint);
}

function customResponseHeaders(options: WebAppPublicAssetOptions): Record<string, string> {
  const headers = new Headers(options.headers);
  headers.delete("content-type");
  return Object.fromEntries(headers.entries());
}

function readEmbeddedPublicAssets(): EmbeddedPublicAssets | undefined {
  const value = (globalThis as { [key: symbol]: unknown })[COMPILED_PUBLIC_ASSETS_SYMBOL];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid compiled public asset manifest");
  }
  const manifest = value as {
    bundles?: unknown;
    assets?: unknown;
  };
  if (manifest.bundles !== undefined) {
    if (!Array.isArray(manifest.bundles)) {
      throw new Error("Invalid compiled public asset manifest: bundles must be an array");
    }
    const bundles = manifest.bundles.map((bundle, index) => decodePublicAssetBundle(bundle, `bundles[${index}]`));
    assertUniquePublicAssetPaths(bundles.map((bundle) => bundle.entry), "compiled public asset bundle entries");
    return { bundles, legacyAssets: [] };
  }
  return { bundles: [], legacyAssets: readLegacyCompiledPublicAssets(manifest.assets) };
}

function embeddedPublicAssetBundle(path: string, contentType: string): WebAppPublicAssetBundle | undefined {
  const embedded = readEmbeddedPublicAssets();
  if (!embedded) return undefined;
  const bundle = embedded.bundles.find((candidate) => candidate.entry === path);
  if (bundle) return bundle;
  const legacy = embedded.legacyAssets.find((candidate) => candidate.path === path);
  if (!legacy) return undefined;
  return {
    entry: path,
    artifacts: [{
      path,
      contentType,
      kind: "entry-point",
      content: decodePublicAssetBody(legacy.body, `assets.${path}.body`),
    }],
  };
}

export async function compileWebAppPublicAsset(options: WebAppPublicAssetOptions): Promise<WebAppPublicAssetBundle> {
  const path = normalizePublicAssetPath(options.path);
  if (!options.contentType.trim()) {
    throw new Error(`Public asset content type must not be empty for ${path}`);
  }
  const entrypoint = resolveEntrypoint(options.entrypoint);
  const outputDirectory = mkdtempSync(join(tmpdir(), "webapp-public-asset-"));
  try {
    const result = await Bun.build({
      entrypoints: [entrypoint],
      outdir: outputDirectory,
      target: "browser",
      format: options.format ?? "iife",
      splitting: false,
      minify: true,
      sourcemap: "none",
      define: options.define,
      plugins: options.plugins,
    });
    if (!result.success) {
      for (const log of result.logs) {
        console.error(log);
      }
      throw new Error(`Public asset build failed for ${entrypoint}`);
    }
    if (result.outputs.length === 0) {
      throw new Error(`Public asset build produced no output for ${entrypoint}`);
    }
    const outputs = result.outputs.map((output) => ({
      output,
      kind: publicAssetKindForBuildArtifact(output),
      relativePath: buildOutputRelativePath(outputDirectory, output),
    }));
    const primaryOutputs = outputs.filter(({ kind }) => kind === "entry-point");
    if (primaryOutputs.length !== 1) {
      throw new Error(`Public asset build must produce exactly one entry-point for ${entrypoint}; received ${String(primaryOutputs.length)}`);
    }
    const primaryOutput = primaryOutputs[0];
    if (!primaryOutput) {
      throw new Error(`Public asset build produced no entry-point for ${entrypoint}`);
    }
    const artifacts = await Promise.all(outputs.map(async ({ output, kind, relativePath }) => {
      const artifactPath = relativePath === primaryOutput.relativePath
        ? path
        : publicAssetSidecarPath(path, primaryOutput.relativePath, relativePath);
      return {
        path: artifactPath,
        contentType: artifactPath === path ? options.contentType : contentTypeForPublicAssetPath(artifactPath, kind),
        kind,
        content: new Uint8Array(await output.arrayBuffer()),
      };
    }));
    assertUniquePublicAssetPaths(artifacts.map((artifact) => artifact.path), `public asset build ${entrypoint}`);
    return { entry: path, artifacts };
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
}

export function createWebAppPublicAsset(options: WebAppPublicAssetOptions): PublicRouteDefinition {
  const path = normalizePublicAssetPath(options.path);
  const headers = customResponseHeaders(options);
  let assetPromise: Promise<WebAppPublicAssetBundle> | undefined;
  const getBundle = async (): Promise<WebAppPublicAssetBundle> => {
    const embedded = embeddedPublicAssetBundle(path, options.contentType);
    if (embedded) return embedded;
    if (hasCompiledPublicAssetsSymbol()) {
      throw new Error(`Compiled public asset manifest does not contain configured entry ${path}`);
    }
    assetPromise ??= compileWebAppPublicAsset({ ...options, path });
    return await assetPromise;
  };

  const route: PublicAssetRoute = {
    [WEBAPP_PUBLIC_ASSET_ROUTE]: { primaryPath: path, getBundle },
    headers,
    GET: async (req) => {
      const bundle = await getBundle();
      const requestedPath = new URL(req.url).pathname;
      const artifact = bundle.artifacts.find((candidate) => candidate.path === requestedPath);
      if (!artifact) {
        return undefined;
      }
      return new Response(artifact.content.slice(), {
        headers: { "content-type": artifact.contentType },
      });
    },
  };
  return route;
}

export function webAppPublicAssetRouteMetadata(value: unknown): WebAppPublicAssetRouteMetadata | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const metadata = (value as Partial<PublicAssetRoute>)[WEBAPP_PUBLIC_ASSET_ROUTE];
  if (
    typeof metadata !== "object"
    || metadata === null
    || typeof metadata.primaryPath !== "string"
    || typeof metadata.getBundle !== "function"
  ) {
    return undefined;
  }
  return metadata;
}

export function serializePublicAssetBundles(
  bundles: WebAppPublicAssetBundle[],
): { bundles: SerializedWebAppPublicAssetBundle[] } {
  return { bundles: bundles.map(encodePublicAssetBundle) };
}

export type { SerializedWebAppPublicAssetArtifact, SerializedWebAppPublicAssetBundle };
