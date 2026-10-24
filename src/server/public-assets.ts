import { compileWebAppPublicAsset, type WebAppPublicAssetOptions } from "../build/public-assets";
import {
  assertUniquePublicAssetPaths,
  decodePublicAssetBody,
  decodePublicAssetBundle,
  encodePublicAssetBundle,
  normalizePublicAssetPath,
  type SerializedWebAppPublicAssetArtifact,
  type SerializedWebAppPublicAssetBundle,
  type WebAppPublicAssetBundle,
} from "./public-asset-manifest";
import type { PublicRouteDefinition } from "./server-types";

export { compileWebAppPublicAsset, type WebAppPublicAssetOptions } from "../build/public-assets";

const COMPILED_PUBLIC_ASSETS_SYMBOL = Symbol.for("webapp.compiledPublicAssets");
export const WEBAPP_PUBLIC_ASSET_ROUTE = Symbol.for("webapp.publicAssetRoute");

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
      const headers = { "content-type": artifact.contentType };
      if (req.method === "HEAD") {
        return new Response(null, { headers });
      }
      return new Response(artifact.content.slice(), { headers });
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
