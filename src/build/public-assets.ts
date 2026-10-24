import type { BunPlugin } from "bun";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertUniquePublicAssetPaths,
  buildOutputRelativePath,
  contentTypeForPublicAssetPath,
  normalizePublicAssetPath,
  publicAssetKindForBuildArtifact,
  publicAssetSidecarPath,
  type WebAppPublicAssetBundle,
} from "../server/public-asset-manifest";

export interface WebAppPublicAssetOptions {
  path: string;
  entrypoint: string | URL;
  contentType: string;
  headers?: HeadersInit;
  format?: "iife" | "esm";
  define?: Record<string, string>;
  plugins?: BunPlugin[];
}

function resolveEntrypoint(entrypoint: string | URL): string {
  if (entrypoint instanceof URL) {
    if (entrypoint.protocol !== "file:") {
      throw new Error(`Public asset entrypoint must be a local file path or file URL; received ${entrypoint.protocol} URL`);
    }
    return fileURLToPath(entrypoint);
  }
  return isAbsolute(entrypoint) ? entrypoint : resolve(dirname(Bun.main || process.argv[1] || "."), entrypoint);
}

export async function compileWebAppPublicAsset(options: WebAppPublicAssetOptions): Promise<WebAppPublicAssetBundle> {
  const path = normalizePublicAssetPath(options.path);
  if (!options.contentType.trim()) {
    throw new Error(`Public asset content type must not be empty for ${path}`);
  }
  const entrypoint = resolveEntrypoint(options.entrypoint);
  const cacheRoot = resolve(".cache", "webapp-public-assets");
  mkdirSync(cacheRoot, { recursive: true });
  const outputDirectory = mkdtempSync(join(cacheRoot, "build-"));
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
      for (const log of result.logs) console.error(log);
      throw new Error(`Public asset build failed for ${entrypoint}`);
    }
    const outputs = result.outputs.map((output) => ({
      output,
      kind: publicAssetKindForBuildArtifact(output),
      relativePath: buildOutputRelativePath(outputDirectory, output),
    }));
    const primaryOutputs = outputs.filter(({ kind }) => kind === "entry-point");
    if (primaryOutputs.length !== 1) {
      throw new Error(`Public asset build must produce exactly one entry-point for ${entrypoint}; received ${primaryOutputs.length}`);
    }
    const primaryOutput = primaryOutputs[0]!;
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
