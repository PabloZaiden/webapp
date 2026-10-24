import { readdirSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  contentTypeForPublicAssetPath,
  normalizePublicAssetPath,
  type WebAppPublicAssetArtifact,
} from "./server/public-asset-manifest";

export interface WebAppStaticAssetOptions {
  /** Local file or directory. Directory contents are copied recursively. */
  src: string | URL;
  /** Destination relative to the client directory, or an integrated public path. */
  path: string;
}

export interface WebAppStaticAssetFile {
  src: string;
  path: string;
}

export function collectWebAppStaticAssets(
  options: WebAppStaticAssetOptions[],
  baseDirectory: string,
): WebAppStaticAssetFile[] {
  const files: WebAppStaticAssetFile[] = [];
  const visit = (src: string, path: string, ancestors: Set<string>): void => {
    const stat = statSync(src);
    if (stat.isDirectory()) {
      const real = realpathSync(src);
      if (ancestors.has(real)) throw new Error(`Static asset directory contains a symbolic-link cycle: ${src}`);
      const nextAncestors = new Set([...ancestors, real]);
      for (const entry of readdirSync(src).sort()) visit(join(src, entry), `${path.replace(/\/$/, "")}/${entry}`, nextAncestors);
      return;
    }
    if (!stat.isFile()) throw new Error(`Static asset must be a file or directory: ${src}`);
    files.push({ src, path: normalizePublicAssetPath(path) });
  };
  for (const option of options) {
    if (option.src instanceof URL && option.src.protocol !== "file:") {
      throw new Error(`Static asset must be a local file: ${option.src.href}`);
    }
    const src = option.src instanceof URL
      ? fileURLToPath(option.src)
      : isAbsolute(option.src) ? option.src : resolve(baseDirectory, option.src);
    const path = normalizePublicAssetPath(option.path.startsWith("/") ? option.path : `/${option.path}`);
    visit(src, path, new Set());
  }
  return files;
}

export async function readWebAppStaticAssets(files: WebAppStaticAssetFile[]): Promise<WebAppPublicAssetArtifact[]> {
  return await Promise.all(files.map(async ({ src, path }) => {
    const kind = extname(path) === ".map" ? "sourcemap" : "asset";
    return {
      path,
      kind,
      contentType: contentTypeForPublicAssetPath(path, kind),
      content: new Uint8Array(await Bun.file(src).arrayBuffer()),
    };
  }));
}
