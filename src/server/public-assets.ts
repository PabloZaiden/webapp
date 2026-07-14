import type { BunPlugin } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PublicRouteDefinition } from "./server-types";

const COMPILED_PUBLIC_ASSETS_SYMBOL = Symbol.for("webapp.compiledPublicAssets");

export interface WebAppPublicAssetOptions {
  path: string;
  entrypoint: string | URL;
  contentType: string;
  headers?: HeadersInit;
  format?: "iife" | "esm";
  define?: Record<string, string>;
  plugins?: BunPlugin[];
}

interface CompiledPublicAsset {
  path: string;
  body: string;
}

interface CompiledPublicAssets {
  assets: CompiledPublicAsset[];
}

function normalizePublicAssetPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith("/") || trimmed.includes("?") || trimmed.includes("#")) {
    throw new Error(`Public asset path must be an absolute URL path without a query or fragment: ${path}`);
  }
  return trimmed;
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

function responseHeaders(options: WebAppPublicAssetOptions): Record<string, string> {
  const headers = new Headers(options.headers);
  headers.set("content-type", options.contentType);
  return Object.fromEntries(headers.entries());
}

function compiledPublicAsset(path: string): Uint8Array | undefined {
  const value = (globalThis as { [key: symbol]: unknown })[COMPILED_PUBLIC_ASSETS_SYMBOL];
  if (!value || typeof value !== "object" || !("assets" in value) || !Array.isArray(value.assets)) {
    return undefined;
  }
  const asset = (value as CompiledPublicAssets).assets.find((candidate) => candidate.path === path);
  if (!asset || typeof asset.body !== "string") {
    return undefined;
  }
  return new Uint8Array(Buffer.from(asset.body, "base64"));
}

export async function compileWebAppPublicAsset(options: WebAppPublicAssetOptions): Promise<Uint8Array> {
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
    const output = result.outputs[0];
    if (!output) {
      throw new Error(`Public asset build produced no output for ${entrypoint}`);
    }
    return new Uint8Array(await output.arrayBuffer());
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
}

export function createWebAppPublicAsset(options: WebAppPublicAssetOptions): PublicRouteDefinition {
  const path = normalizePublicAssetPath(options.path);
  const headers = responseHeaders(options);
  let assetPromise: Promise<Uint8Array> | undefined;

  return {
    headers,
    GET: async () => {
      const embedded = compiledPublicAsset(path);
      if (embedded) {
        return embedded;
      }
      assetPromise ??= compileWebAppPublicAsset(options);
      return await assetPromise;
    },
  };
}
