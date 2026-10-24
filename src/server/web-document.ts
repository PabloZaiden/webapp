import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PublicRouteDefinition, WebAppDocumentConfig } from "./server-types";
import { findPackageRoot, resolveReactDomClient } from "../package-resolution";
import { collectWebAppStaticAssets, readWebAppStaticAssets, type WebAppStaticAssetFile } from "../static-assets";
import {
  generateWebAppDocumentAssets,
  generateWebAppHtml,
  iconConfig,
  pathExtension,
  pwaEnabled,
  resolveDocumentAsset,
} from "../web-document";
import { notFound, withSecurityHeaders } from "./responses";
import type { RuntimeConfig } from "./runtime-config";
import { WEB_APP_CLIENT_CONFIG_PATH, type WebAppClientBootstrap } from "../contracts/client-bootstrap";
import { getRequestOriginInfo } from "./auth/request-origin";
import {
  assertUniquePublicAssetPaths,
  decodePublicAssetBody,
  normalizePublicAssetPath,
  publicAssetKind,
  type WebAppPublicAssetKind,
  type WebAppPublicAssetArtifact,
} from "./public-asset-manifest";

type HtmlBundleIndex = { index: string };

interface WebDocumentResolution {
  entryFile?: string;
  packageRoot: string;
  reactDomClientPath?: string;
  staticAssets?: WebAppStaticAssetFile[];
}

export interface WebDocument {
  bundle?: HtmlBundleIndex;
  entryPublicPath: string;
  cacheDir: string;
  html: string;
  manifest: string;
  icon: string;
  generatedPublicRoutes: Record<string, PublicRouteDefinition>;
}

export interface WebDocumentProvider {
  readonly generatedRoutePaths: ReadonlySet<string>;
  ensure(): Promise<WebDocument>;
  dispose(document: WebDocument): void;
}

type CompiledClientAsset = {
  path: string;
  contentType: string;
  kind: WebAppPublicAssetKind;
  role: "script" | "style" | "asset";
  scriptOrder?: number;
  content: Uint8Array;
};

type CompiledClient = {
  packageRoot: string;
  assets: CompiledClientAsset[];
};

const DEFAULT_WEB_ENTRY = "./web/main.tsx";
const documentCacheDirs = new Set<string>();
let documentCacheCleanupRegistered = false;

function cleanupDocumentCacheDir(cacheDir: string): void {
  if (!documentCacheDirs.delete(cacheDir)) return;
  rmSync(cacheDir, { recursive: true, force: true });
}

function cleanupDocumentCacheDirs(): void {
  for (const cacheDir of Array.from(documentCacheDirs)) cleanupDocumentCacheDir(cacheDir);
}

function createDocumentCacheDir(envPrefix: string): string {
  const segment = envPrefix.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "app";
  const root = join(tmpdir(), "webapp", segment);
  mkdirSync(root, { recursive: true });
  const cacheDir = realpathSync(mkdtempSync(join(root, "webapp-document-")));
  documentCacheDirs.add(cacheDir);
  if (!documentCacheCleanupRegistered) {
    documentCacheCleanupRegistered = true;
    process.once("exit", cleanupDocumentCacheDirs);
  }
  return cacheDir;
}

function isHtmlBundleIndex(index: unknown): index is HtmlBundleIndex {
  return typeof index === "object"
    && index !== null
    && "index" in index
    && typeof (index as { index?: unknown }).index === "string"
    && String(index) === "[object HTMLBundle]";
}

function requestLooksLikeNavigation(req?: Request): boolean {
  if (!req) return true;
  const lastSegment = new URL(req.url).pathname.split("/").pop() ?? "";
  if (/\.[A-Za-z0-9]+$/.test(lastSegment)) return false;
  const accept = req.headers.get("accept");
  return !accept || accept.includes("text/html") || accept.includes("*/*");
}

export async function htmlResponse(document: WebDocument, req?: Request): Promise<Response> {
  if (!requestLooksLikeNavigation(req)) return withSecurityHeaders(notFound());
  return withSecurityHeaders(new Response(document.html, { headers: { "content-type": "text/html; charset=utf-8" } }));
}

function hasOwnPublicRoute(publicRoutes: Record<string, PublicRouteDefinition>, path: string): boolean {
  return Object.prototype.hasOwnProperty.call(publicRoutes, path);
}

function toWebPath(path: string): string {
  return path.split(sep).join("/");
}

function resolveWebEntry(entry: string | URL | undefined): string {
  const value = entry ?? DEFAULT_WEB_ENTRY;
  if (value instanceof URL || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    const url = value instanceof URL ? value : new URL(value);
    if (url.protocol !== "file:") {
      throw new Error(`web.entry must be a local file path or file: URL; received ${url.protocol} URL`);
    }
    return fileURLToPath(url);
  }
  return isAbsolute(value) ? value : resolve(dirname(resolve(Bun.main || process.argv[1] || ".")), value);
}

function webEntryPublicPath(entryFile: string, packageRoot: string): string {
  const relativeEntry = relative(packageRoot, entryFile);
  if (relativeEntry.startsWith("..") || isAbsolute(relativeEntry)) {
    throw new Error(`web.entry must resolve inside the app package root: ${packageRoot}`);
  }
  return `/${toWebPath(relativeEntry)}`;
}

function compiledClient(): CompiledClient | undefined {
  const value = (globalThis as { [key: symbol]: unknown })[Symbol.for("webapp.compiledClient")];
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) throw new Error("Invalid compiled client manifest");
  const candidate = value as { packageRoot?: unknown; assets?: unknown };
  if (typeof candidate.packageRoot !== "string" || !candidate.packageRoot || !Array.isArray(candidate.assets)) {
    throw new Error("Invalid compiled client manifest metadata");
  }
  const assets = candidate.assets.map((asset, index) => {
    if (typeof asset !== "object" || asset === null) {
      throw new Error(`Invalid compiled client asset at assets[${index}]`);
    }
    const record = asset as Record<string, unknown>;
    const path = record["path"];
    const contentType = record["contentType"];
    const roleValue = record["role"];
    const body = record["body"];
    if (
      typeof path !== "string"
      || typeof contentType !== "string"
      || !contentType.trim()
      || (roleValue !== "script" && roleValue !== "style" && roleValue !== "asset")
      || typeof body !== "string"
    ) throw new Error(`Invalid compiled client asset metadata at assets[${index}]`);
    const role: CompiledClientAsset["role"] = roleValue;
    if (normalizePublicAssetPath(path) !== path) {
      throw new Error(`Compiled client asset path is not normalized at assets[${index}]: ${path}`);
    }
    const kind = record["kind"] === undefined ? "asset" : publicAssetKind(record, path);
    const scriptOrderValue = record["scriptOrder"];
    let scriptOrder: number | undefined;
    if (scriptOrderValue !== undefined) {
      if (typeof scriptOrderValue !== "number" || !Number.isInteger(scriptOrderValue) || scriptOrderValue < 0) {
        throw new Error(`Invalid compiled client script order at assets[${index}]`);
      }
      scriptOrder = scriptOrderValue;
    }
    return {
      path, contentType, kind, role,
      ...(scriptOrder === undefined ? {} : { scriptOrder }),
      content: decodePublicAssetBody(body, `compiledClient.assets[${index}].body`),
    };
  });
  assertUniquePublicAssetPaths(assets.map((asset) => asset.path), "compiled client assets");
  return { packageRoot: candidate.packageRoot, assets };
}

function assetRoutes(
  config: RuntimeConfig,
  artifacts: WebAppPublicAssetArtifact[],
): Record<string, PublicRouteDefinition> {
  assertUniquePublicAssetPaths(artifacts.map((asset) => asset.path), "web document assets");
  const routes: Record<string, PublicRouteDefinition> = {};
  for (const artifact of artifacts) {
    routes[artifact.path] = {
      headers: { "content-type": artifact.contentType },
      GET: () => artifact.content.slice(),
    };
  }
  routes[WEB_APP_CLIENT_CONFIG_PATH] = {
    GET: (req) => Response.json({
      mode: "integrated",
      publicBasePath: getRequestOriginInfo(req, config).pathPrefix,
    } satisfies WebAppClientBootstrap, { headers: { "cache-control": "no-store" } }),
  };
  return routes;
}

function prebuiltDocument(compiled: CompiledClient, config: RuntimeConfig, cacheDir: string): WebDocument | undefined {
  const html = compiled.assets.find((asset) => asset.path === "/index.html");
  if (!html) return undefined;
  const icon = compiled.assets.find((asset) => asset.path === "/webapp-icon.svg");
  if (!icon) throw new Error("Prebuilt client document is missing its default icon.");
  const manifest = compiled.assets.find((asset) => asset.path === "/site.webmanifest");
  const decoder = new TextDecoder();
  return {
    entryPublicPath: "",
    cacheDir,
    html: decoder.decode(html.content),
    icon: decoder.decode(icon.content),
    manifest: manifest ? decoder.decode(manifest.content) : "",
    generatedPublicRoutes: assetRoutes(config, compiled.assets),
  };
}

async function createWebDocument(
  config: RuntimeConfig,
  webInput: WebAppDocumentConfig | undefined,
  resolution: WebDocumentResolution,
): Promise<WebDocument> {
  const web = webInput ?? {};
  const compiled = compiledClient();
  const entryFile = compiled ? undefined : resolution.entryFile;
  const packageRoot = resolution.packageRoot;
  const publicEntry = entryFile ? webEntryPublicPath(entryFile, packageRoot) : "";
  const cacheDir = createDocumentCacheDir(config.envPrefix);
  try {
    const prebuilt = compiled ? prebuiltDocument(compiled, config, cacheDir) : undefined;
    if (prebuilt) return prebuilt;
    const htmlPath = resolve(cacheDir, `${config.envPrefix.toLowerCase()}-index.html`);
    const documentAssets = await generateWebAppDocumentAssets(config.appName, web, packageRoot);
    for (const artifact of documentAssets.artifacts) {
      await Bun.write(resolve(cacheDir, artifact.path.slice(1)), artifact.content);
    }
    const preludePath = resolve(cacheDir, "webapp-prelude.ts");
    if (!compiled) {
      if (!resolution.reactDomClientPath) {
        throw new Error("Native web document resolution is missing the resolved react-dom/client module.");
      }
      const frameworkWebPath = toWebPath(fileURLToPath(new URL("../web/index.ts", import.meta.url)));
      writeFileSync(preludePath, `import { createRoot } from ${JSON.stringify(toWebPath(resolution.reactDomClientPath))};
import { configureWebAppRenderer } from ${JSON.stringify(frameworkWebPath)};
configureWebAppRenderer(createRoot);
`);
    }
    const scripts = compiled
      ? compiled.assets.filter((asset) => asset.role === "script")
          .sort((left, right) => (left.scriptOrder ?? 0) - (right.scriptOrder ?? 0))
          .map((asset) => asset.path)
      : [toWebPath(relative(cacheDir, preludePath)), toWebPath(relative(cacheDir, entryFile!))];
    const sourceHtml = generateWebAppHtml({
      appName: config.appName,
      web,
      ...documentAssets,
      scripts,
      nativeBundle: !compiled,
      styles: compiled?.assets.filter((asset) => asset.role === "style").map((asset) => asset.path),
    });
    writeFileSync(htmlPath, sourceHtml);
    const bundle = compiled ? undefined : (await import(`${pathToFileURL(htmlPath).href}?v=${crypto.randomUUID()}`)).default;
    if (!compiled && !isHtmlBundleIndex(bundle)) {
      throw new Error("Generated web document did not produce a Bun HTMLBundle");
    }
    const html = bundle ? await Bun.file(bundle.index).text() : sourceHtml;
    const staticAssets = await readWebAppStaticAssets(resolution.staticAssets ?? []);
    const artifacts = [...documentAssets.artifacts, ...(compiled?.assets ?? []), ...staticAssets];
    return {
      bundle,
      entryPublicPath: publicEntry,
      cacheDir,
      html,
      manifest: documentAssets.manifest,
      icon: documentAssets.icon,
      generatedPublicRoutes: assetRoutes(config, artifacts),
    };
  } catch (error) {
    cleanupDocumentCacheDir(cacheDir);
    throw error;
  }
}

function resolveWebDocumentResolution(web: WebAppDocumentConfig | undefined): WebDocumentResolution {
  const compiled = compiledClient();
  if (compiled) return { packageRoot: compiled.packageRoot };
  const entryFile = resolveWebEntry(web?.entry);
  const packageRoot = findPackageRoot(dirname(entryFile));
  return {
    entryFile,
    packageRoot,
    reactDomClientPath: resolveReactDomClient(packageRoot, entryFile),
    staticAssets: collectWebAppStaticAssets(web?.assets ?? [], packageRoot),
  };
}

export function createWebDocumentProvider(
  config: RuntimeConfig,
  webInput: WebAppDocumentConfig | undefined,
  publicRoutes: Record<string, PublicRouteDefinition>,
): WebDocumentProvider {
  const resolution = resolveWebDocumentResolution(webInput);
  const favicon = iconConfig(webInput?.icons?.favicon);
  const appleTouch = iconConfig(webInput?.icons?.appleTouch) ?? favicon;
  const iconPath = (src: string | URL): string => pathExtension(resolveDocumentAsset(src, resolution.packageRoot)) || ".png";
  const generatedRoutePaths = new Set([
    WEB_APP_CLIENT_CONFIG_PATH,
    ...(resolution.entryFile ? [webEntryPublicPath(resolution.entryFile, resolution.packageRoot)] : []),
    ...(compiledClient()?.assets.map((asset) => asset.path) ?? []),
    ...(resolution.staticAssets?.map((asset) => asset.path) ?? []),
    "/webapp-icon.svg",
    ...(favicon ? [`/webapp-favicon${iconPath(favicon.src)}`] : []),
    ...(appleTouch ? [`/webapp-apple-touch-icon${iconPath(appleTouch.src)}`] : []),
    ...(webInput?.icons?.manifest ?? []).map((icon, index) => `/webapp-icon-${index + 1}${iconPath(icon.src)}`),
    ...(pwaEnabled(webInput ?? {}) ? ["/site.webmanifest", "/manifest.webmanifest"] : []),
  ]);
  let documentPromise: Promise<WebDocument> | undefined;
  return {
    generatedRoutePaths,
    async ensure(): Promise<WebDocument> {
      documentPromise ??= createWebDocument(config, webInput, resolution).then((document) => {
        for (const path of [...Object.keys(document.generatedPublicRoutes), document.entryPublicPath].filter(Boolean)) {
          if (hasOwnPublicRoute(publicRoutes, path)) {
            cleanupDocumentCacheDir(document.cacheDir);
            throw new Error(`publicRoutes cannot override framework-owned web route: ${path}`);
          }
        }
        return document;
      });
      return await documentPromise;
    },
    dispose(document: WebDocument): void {
      cleanupDocumentCacheDir(document.cacheDir);
    },
  };
}
