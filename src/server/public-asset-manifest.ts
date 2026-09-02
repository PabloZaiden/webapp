import type { BuildArtifact } from "bun";
import { extname, isAbsolute, relative, sep } from "node:path";
import { posix } from "node:path";

export type WebAppPublicAssetKind = "entry-point" | "chunk" | "asset" | "sourcemap";

export interface WebAppPublicAssetArtifact {
  path: string;
  content: Uint8Array;
  contentType: string;
  kind: WebAppPublicAssetKind;
}

export interface WebAppPublicAssetBundle {
  entry: string;
  artifacts: WebAppPublicAssetArtifact[];
}

export interface SerializedWebAppPublicAssetArtifact {
  path: string;
  contentType: string;
  kind: WebAppPublicAssetKind;
  body: string;
}

export interface SerializedWebAppPublicAssetBundle {
  entry: string;
  artifacts: SerializedWebAppPublicAssetArtifact[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function hasPathTraversal(path: string): boolean {
  return path.split("/").some((segment) => segment === "." || segment === "..");
}

export function normalizePublicAssetPath(path: string): string {
  const trimmed = path.trim();
  let decodedPath: string;
  let canonicalPath: string;
  try {
    decodedPath = decodeURIComponent(trimmed);
    canonicalPath = new URL(trimmed, "http://webapp.invalid").pathname;
  } catch {
    throw new Error(`Public asset path must be an absolute URL path with valid URL encoding: ${path}`);
  }
  if (
    !trimmed.startsWith("/")
    || trimmed.startsWith("//")
    || trimmed.includes("?")
    || trimmed.includes("#")
    || trimmed.includes("\\")
    || hasPathTraversal(trimmed)
    || decodedPath.includes("\\")
    || hasPathTraversal(decodedPath)
    || canonicalPath !== trimmed
  ) {
    throw new Error(`Public asset path must be an absolute URL path without a query, fragment, traversal, or backslash: ${path}`);
  }
  return trimmed;
}

export function normalizeBuildOutputPath(outputDirectory: string, outputPath: string): string {
  const outputRelativePath = relative(outputDirectory, outputPath);
  const normalized = outputRelativePath.split(sep).join("/");
  if (!normalized || normalized === "." || isAbsolute(outputRelativePath) || hasPathTraversal(normalized)) {
    throw new Error(`Bun build output must be a file inside the output directory: ${outputPath}`);
  }
  return normalized;
}

export function publicAssetKind(value: unknown, outputPath: string): WebAppPublicAssetKind {
  if (isRecord(value)) {
    const kind = value["kind"];
    if (kind === "entry-point" || kind === "chunk" || kind === "asset" || kind === "sourcemap") {
      return kind;
    }
    if (kind === "bytecode") {
      throw new Error(`Unsupported public asset build output kind "bytecode": ${outputPath}`);
    }
    if (typeof kind === "string") {
      throw new Error(`Unsupported public asset build output kind "${kind}": ${outputPath}`);
    }
  }
  throw new Error(`Unsupported public asset build output kind for ${outputPath}`);
}

export function publicAssetKindForBuildArtifact(output: Pick<BuildArtifact, "kind" | "path">): WebAppPublicAssetKind {
  return publicAssetKind(output, output.path);
}

export function contentTypeForPublicAssetPath(path: string, kind: WebAppPublicAssetKind): string {
  const extension = extname(path).toLowerCase();
  if (kind === "sourcemap" || extension === ".map") return "application/json; charset=utf-8";
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".html" || extension === ".htm") return "text/html; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".txt") return "text/plain; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml; charset=utf-8";
  if (extension === ".png") return "image/png";
  if (extension === ".gif") return "image/gif";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".avif") return "image/avif";
  if (extension === ".ico") return "image/x-icon";
  if (extension === ".wasm") return "application/wasm";
  if (extension === ".woff") return "font/woff";
  if (extension === ".woff2") return "font/woff2";
  if (extension === ".ttf") return "font/ttf";
  if (extension === ".otf") return "font/otf";
  return "application/octet-stream";
}

export function assertUniquePublicAssetPaths(paths: Iterable<string>, label: string): void {
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) {
      throw new Error(`Duplicate public asset path "${path}" in ${label}`);
    }
    seen.add(path);
  }
}

export function encodePublicAssetBundle(bundle: WebAppPublicAssetBundle): SerializedWebAppPublicAssetBundle {
  return {
    entry: bundle.entry,
    artifacts: bundle.artifacts.map((artifact) => ({
      path: artifact.path,
      contentType: artifact.contentType,
      kind: artifact.kind,
      body: Buffer.from(artifact.content).toString("base64"),
    })),
  };
}

function isBase64CodeUnit(codeUnit: number): boolean {
  return (codeUnit >= 0x41 && codeUnit <= 0x5a)
    || (codeUnit >= 0x61 && codeUnit <= 0x7a)
    || (codeUnit >= 0x30 && codeUnit <= 0x39)
    || codeUnit === 0x2b
    || codeUnit === 0x2f;
}

function isValidBase64Body(body: string): boolean {
  if (body.length % 4 !== 0) return false;

  let paddingStart = body.length;
  for (let index = 0; index < body.length; index += 1) {
    const codeUnit = body.charCodeAt(index);
    if (codeUnit === 0x3d) {
      paddingStart = index;
      break;
    }
    if (!isBase64CodeUnit(codeUnit)) return false;
  }

  const paddingLength = body.length - paddingStart;
  if (paddingLength === 0) return true;
  if (paddingLength > 2) return false;
  for (let index = paddingStart; index < body.length; index += 1) {
    if (body.charCodeAt(index) !== 0x3d) return false;
  }
  return true;
}

export function decodePublicAssetBody(body: string, label: string): Uint8Array {
  if (!isValidBase64Body(body)) {
    throw new Error(`Invalid Base64 body for ${label}`);
  }
  return new Uint8Array(Buffer.from(body, "base64"));
}

function serializedArtifact(value: unknown, index: number, label: string): WebAppPublicAssetArtifact {
  if (!isRecord(value)) {
    throw new Error(`Invalid public asset artifact at ${label}[${index}]`);
  }
  const path = value["path"];
  const contentType = value["contentType"];
  const body = value["body"];
  if (typeof path !== "string" || typeof contentType !== "string" || !contentType.trim() || typeof body !== "string") {
    throw new Error(`Invalid public asset artifact metadata at ${label}[${index}]`);
  }
  const normalizedPath = normalizePublicAssetPath(path);
  if (normalizedPath !== path) {
    throw new Error(`Public asset artifact path is not normalized at ${label}[${index}]: ${path}`);
  }
  const kind = publicAssetKind(value, path);
  return {
    path,
    contentType,
    kind,
    content: decodePublicAssetBody(body, `${label}[${index}].body`),
  };
}

export function decodePublicAssetBundle(value: unknown, label: string): WebAppPublicAssetBundle {
  if (!isRecord(value) || typeof value["entry"] !== "string" || !Array.isArray(value["artifacts"])) {
    throw new Error(`Invalid public asset bundle manifest: ${label}`);
  }
  const entry = normalizePublicAssetPath(value["entry"]);
  const artifacts = value["artifacts"].map((artifact, index) => serializedArtifact(artifact, index, `${label}.artifacts`));
  if (artifacts.length === 0) {
    throw new Error(`Public asset bundle manifest has no artifacts: ${label}`);
  }
  assertUniquePublicAssetPaths(artifacts.map((artifact) => artifact.path), label);
  const primary = artifacts.find((artifact) => artifact.path === entry);
  if (!primary || primary.kind !== "entry-point") {
    throw new Error(`Public asset bundle manifest entry does not identify an entry-point: ${label}`);
  }
  return { entry, artifacts };
}

export function buildOutputRelativePath(outputDirectory: string, output: Pick<BuildArtifact, "path">): string {
  return normalizeBuildOutputPath(outputDirectory, output.path);
}

export function publicAssetSidecarPath(
  configuredEntryPath: string,
  primaryOutputRelativePath: string,
  sidecarOutputRelativePath: string,
): string {
  const configuredDirectory = posix.dirname(configuredEntryPath);
  const primaryOutputDirectory = posix.dirname(primaryOutputRelativePath);
  const relativeSidecarPath = posix.relative(primaryOutputDirectory, sidecarOutputRelativePath);
  return normalizePublicAssetPath(posix.join(configuredDirectory, relativeSidecarPath));
}
