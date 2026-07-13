import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  PublicRouteDefinition,
  WebAppDocumentConfig,
  WebAppIconConfig,
  WebAppPwaConfig,
} from "./server-types";
import { withBunBuildLock } from "../bun-build-lock";
import { findPackageRoot, resolveReactDomClient } from "../package-resolution";
import { MOBILE_MEDIA_QUERY, MOBILE_STATE_ATTRIBUTE } from "../web/mobile";
import { notFound, withSecurityHeaders } from "./responses";
import type { RuntimeConfig } from "./runtime-config";

type HtmlBundleIndex = { index: string };

interface WebDocumentResolution {
  entryFile?: string;
  packageRoot: string;
  reactDomClientPath?: string;
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
  role: "script" | "style" | "asset";
  scriptOrder?: number;
  body: string;
};

type CompiledClient = {
  packageRoot: string;
  assets: CompiledClientAsset[];
};

const DEFAULT_WEB_ENTRY = "./web/main.tsx";
const DEFAULT_THEME_COLOR = "#111827";
const DEFAULT_BACKGROUND_COLOR = "#ffffff";
const WEBAPP_DOCUMENT_CACHE_PREFIX = "webapp-document-";
const documentCacheDirs = new Set<string>();
let documentCacheCleanupRegistered = false;

function cleanupDocumentCacheDir(cacheDir: string): void {
  if (!documentCacheDirs.delete(cacheDir)) return;
  rmSync(cacheDir, { recursive: true, force: true });
}

function cleanupDocumentCacheDirs(): void {
  for (const cacheDir of Array.from(documentCacheDirs)) {
    cleanupDocumentCacheDir(cacheDir);
  }
}

function safeCachePathSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "app";
}

function createDocumentCacheDir(envPrefix: string): string {
  const root = join(tmpdir(), "webapp", safeCachePathSegment(envPrefix));
  mkdirSync(root, { recursive: true });
  const cacheDir = realpathSync(mkdtempSync(join(root, WEBAPP_DOCUMENT_CACHE_PREFIX)));
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
  if (!req) {
    return true;
  }
  const url = new URL(req.url);
  const lastSegment = url.pathname.split("/").pop() ?? "";
  const hasFileExtension = /\.[A-Za-z0-9]+$/.test(lastSegment);
  if (hasFileExtension) {
    return false;
  }
  const accept = req.headers.get("accept");
  return !accept || accept.includes("text/html") || accept.includes("*/*");
}

export async function htmlResponse(document: WebDocument, req?: Request): Promise<Response> {
  if (!requestLooksLikeNavigation(req)) {
    return withSecurityHeaders(notFound());
  }
  return withSecurityHeaders(new Response(document.html, { headers: { "content-type": "text/html; charset=utf-8" } }));
}

function hasOwnPublicRoute(publicRoutes: Record<string, PublicRouteDefinition>, path: string): boolean {
  return Object.prototype.hasOwnProperty.call(publicRoutes, path);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function normalizePublicPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function toWebPath(path: string): string {
  return path.split(sep).join("/");
}

function localFileUrlPath(url: URL, label: string): string {
  if (url.protocol !== "file:") {
    throw new Error(`${label} must be a local file path or file: URL; received ${url.protocol} URL`);
  }
  return fileURLToPath(url);
}

function resolveMaybeUrlString(value: string, label: string): string | undefined {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    return undefined;
  }
  return localFileUrlPath(new URL(value), label);
}

function resolveWebEntry(entry: string | URL | undefined): string {
  if (entry instanceof URL) {
    return localFileUrlPath(entry, "web.entry");
  }
  const value = entry ?? DEFAULT_WEB_ENTRY;
  const urlPath = resolveMaybeUrlString(value, "web.entry");
  if (urlPath) {
    return urlPath;
  }
  if (isAbsolute(value)) {
    return value;
  }
  const mainDir = dirname(resolve(Bun.main || process.argv[1] || "."));
  return resolve(mainDir, value);
}

function resolveWebAsset(src: string | URL, packageRoot: string): string {
  if (src instanceof URL) {
    return localFileUrlPath(src, "web.icons src");
  }
  const urlPath = resolveMaybeUrlString(src, "web.icons src");
  if (urlPath) {
    return urlPath;
  }
  if (isAbsolute(src)) {
    return src;
  }
  return resolve(packageRoot, src);
}

async function copyWebAsset(src: string, dest: string): Promise<void> {
  await Bun.write(dest, Bun.file(src));
}

function webEntryPublicPath(entryFile: string, packageRoot: string): string {
  const relativeEntry = relative(packageRoot, entryFile);
  if (relativeEntry.startsWith("..") || isAbsolute(relativeEntry)) {
    throw new Error(`web.entry must resolve inside the app package root: ${packageRoot}`);
  }
  return normalizePublicPath(toWebPath(relativeEntry));
}

function initialsForAppName(appName: string): string {
  const words = appName.match(/[A-Za-z0-9]+/g) ?? [];
  const initials = words.slice(0, 2).map((word) => word[0]?.toUpperCase()).join("");
  return initials || "W";
}

function generatedIcon(appName: string, themeColor: string, backgroundColor: string): string {
  const initials = escapeHtml(initialsForAppName(appName));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="${escapeAttribute(appName)}">
  <rect width="512" height="512" rx="112" fill="${escapeAttribute(themeColor)}"/>
  <circle cx="256" cy="256" r="178" fill="${escapeAttribute(backgroundColor)}" opacity="0.14"/>
  <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" fill="${escapeAttribute(backgroundColor)}" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="176" font-weight="800">${initials}</text>
</svg>
`;
}

function pathExtension(path: string): string {
  const pathname = path.includes("://") ? new URL(path).pathname : path;
  const match = pathname.match(/\.([A-Za-z0-9]+)$/);
  return match ? `.${match[1]}` : "";
}

function contentTypeForIcon(path: string, explicit?: string): string {
  if (explicit) return explicit;
  const ext = pathExtension(path).toLowerCase();
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".ico") return "image/x-icon";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

function themeBootScript(themeColor: string | undefined): string {
  const themeColorUpdate = themeColor
    ? `
  const metaThemeColor = document.querySelector('meta[name="theme-color"]');
  if (metaThemeColor instanceof HTMLMetaElement) metaThemeColor.content = resolved === "dark" ? ${JSON.stringify(themeColor)} : ${JSON.stringify(DEFAULT_BACKGROUND_COLOR)};`
    : "";
  return `(() => {
  const key = "webapp.theme";
  const root = document.documentElement;
  const stored = window.localStorage.getItem(key);
  const preference = stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = preference === "system" ? (systemDark ? "dark" : "light") : preference;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
  root.dataset.theme = preference;
  root.dataset.resolvedTheme = resolved;
${themeColorUpdate}
})();`;
}

function mobileStateBootScript(): string {
  return `(() => {
  const root = document.documentElement;
  const query = window.matchMedia(${JSON.stringify(MOBILE_MEDIA_QUERY)});
  root.toggleAttribute(${JSON.stringify(MOBILE_STATE_ATTRIBUTE)}, query.matches);
})();`;
}

function pwaEnabled(web: WebAppDocumentConfig): boolean {
  return typeof web.pwa === "object" ? web.pwa.enabled !== false : web.pwa !== false;
}

function pwaConfig(web: WebAppDocumentConfig): WebAppPwaConfig {
  return typeof web.pwa === "object" ? web.pwa : {};
}

function generatedManifest(config: RuntimeConfig, web: WebAppDocumentConfig, backgroundColor: string, icons: WebAppIconConfig[]): string {
  const pwa = pwaConfig(web);
  return JSON.stringify({
    name: config.appName,
    short_name: web.shortName ?? config.appName,
    start_url: pwa.startUrl ?? "./",
    scope: pwa.scope ?? "./",
    display: pwa.display ?? "standalone",
    background_color: backgroundColor,
    ...(web.themeColor ? { theme_color: web.themeColor } : {}),
    icons,
  }, null, 2);
}

function iconConfig(value: string | URL | WebAppIconConfig | undefined): WebAppIconConfig | undefined {
  if (!value) return undefined;
  return typeof value === "object" && !(value instanceof URL) && "src" in value ? value : { src: value };
}

function compiledClient(): CompiledClient | undefined {
  const value = (globalThis as { [key: symbol]: unknown })[Symbol.for("webapp.compiledClient")];
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<CompiledClient>;
  return typeof candidate.packageRoot === "string" && Array.isArray(candidate.assets) ? candidate as CompiledClient : undefined;
}

function generatedHtml(
  config: RuntimeConfig,
  web: WebAppDocumentConfig,
  relativeEntry: string | undefined,
  relativePrelude: string | undefined,
  themeColor: string | undefined,
  faviconPath: string,
  appleTouchPath: string,
  compiledAssets?: CompiledClientAsset[],
): string {
  const title = escapeHtml(web.title ?? config.appName);
  const shortName = escapeAttribute(web.shortName ?? config.appName);
  const htmlFaviconPath = faviconPath.replace(/^\//, "./");
  const htmlAppleTouchPath = appleTouchPath.replace(/^\//, "./");
  const themeMetaTag = themeColor ? `    <meta name="theme-color" content="${escapeAttribute(themeColor)}" />\n` : "";
  const styleTags = compiledAssets?.filter((asset) => asset.role === "style").map((asset) => `    <link rel="stylesheet" href="${escapeAttribute(asset.path)}" />`).join("\n") ?? "";
  const scriptTags = compiledAssets
    ? compiledAssets
        .filter((asset) => asset.role === "script")
        .sort((left, right) => (left.scriptOrder ?? 0) - (right.scriptOrder ?? 0))
        .map((asset) => `    <script type="module" src="${escapeAttribute(asset.path)}"></script>`)
        .join("\n")
    : `    <script type="module" src="${escapeAttribute(relativePrelude ?? "")}"></script>
    <script type="module" src="${escapeAttribute(relativeEntry ?? "")}"></script>`;
  const manifestTags = pwaEnabled(web)
    ? `    <link rel="icon" href="${escapeAttribute(htmlFaviconPath)}" />
    <link rel="apple-touch-icon" href="${escapeAttribute(htmlAppleTouchPath)}" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-title" content="${shortName}" />
    <script>(() => {
      const manifest = document.createElement("link");
      manifest.rel = "manifest";
      manifest.href = "/site.webmanifest";
      document.head.appendChild(manifest);
    })();</script>
`
    : "";
  return `<!doctype html>
<html lang="${escapeAttribute(web.lang ?? "en")}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
${themeMetaTag}\
${manifestTags}    <title>${title}</title>
    <script>${mobileStateBootScript()}</script>
    <script>${themeBootScript(themeColor)}</script>
${styleTags}
  </head>
  <body>
    <div id="root"></div>
${scriptTags}
  </body>
</html>
`;
}

async function bundleNativeRenderer(preludePath: string, outputDir: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [preludePath],
    outdir: outputDir,
    target: "browser",
    format: "esm",
    minify: true,
  });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error("Native web renderer build failed");
  }
  const [renderer] = result.outputs;
  if (!renderer) {
    throw new Error("Native web renderer build produced no output");
  }
  return renderer.path;
}

async function createWebDocument(
  config: RuntimeConfig,
  webInput: WebAppDocumentConfig | undefined,
  resolution: WebDocumentResolution,
): Promise<WebDocument> {
  return await withBunBuildLock(
    () => createWebDocumentUnlocked(config, webInput, resolution),
    resolution.packageRoot,
  );
}

async function createWebDocumentUnlocked(
  config: RuntimeConfig,
  webInput: WebAppDocumentConfig | undefined,
  resolution: WebDocumentResolution,
): Promise<WebDocument> {
  const web = webInput ?? {};
  const compiled = compiledClient();
  const entryFile = compiled ? undefined : resolution.entryFile;
  const iconThemeColor = web.themeColor ?? DEFAULT_THEME_COLOR;
  const backgroundColor = web.backgroundColor ?? DEFAULT_BACKGROUND_COLOR;
  const packageRoot = resolution.packageRoot;
  const publicEntry = entryFile ? webEntryPublicPath(entryFile, packageRoot) : "";
  const cacheDir = createDocumentCacheDir(config.envPrefix);
  const htmlPath = resolve(cacheDir, `${config.envPrefix.toLowerCase()}-index.html`);
  const icon = generatedIcon(config.appName, iconThemeColor, backgroundColor);
  const favicon = iconConfig(web.icons?.favicon);
  const appleTouch = iconConfig(web.icons?.appleTouch) ?? favicon;
  const manifestIconConfigs = web.icons?.manifest?.length ? web.icons.manifest : undefined;
  const manifestIcons = manifestIconConfigs
    ? manifestIconConfigs.map((manifestIcon, index) => {
        const srcPath = resolveWebAsset(manifestIcon.src, packageRoot);
        const ext = pathExtension(srcPath) || ".png";
        return {
          src: `./webapp-icon-${index + 1}${ext}`,
          sizes: manifestIcon.sizes ?? "any",
          type: contentTypeForIcon(srcPath, manifestIcon.type),
          purpose: manifestIcon.purpose ?? "any maskable",
        };
      })
    : [{ src: "./webapp-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }];
  const manifest = pwaEnabled(web) ? generatedManifest(config, web, backgroundColor, manifestIcons) : "";
  writeFileSync(resolve(cacheDir, "webapp-icon.svg"), icon);
  if (manifest) {
    writeFileSync(resolve(cacheDir, "site.webmanifest"), manifest);
  }
  const preludePath = resolve(cacheDir, "webapp-prelude.ts");
  let rendererPath: string | undefined;
  if (!compiled) {
    const reactDomClientPath = resolution.reactDomClientPath;
    if (!reactDomClientPath) {
      throw new Error("Native web document resolution is missing the resolved react-dom/client module.");
    }
    const frameworkWebPath = toWebPath(fileURLToPath(new URL("../web/renderer-config.ts", import.meta.url)));
    writeFileSync(preludePath, `import { createRoot } from ${JSON.stringify(toWebPath(reactDomClientPath))};
import { configureWebAppRenderer } from ${JSON.stringify(frameworkWebPath)};

configureWebAppRenderer(createRoot);
`);
    rendererPath = await bundleNativeRenderer(preludePath, cacheDir);
  }
  const relativeEntry = entryFile ? toWebPath(relative(cacheDir, entryFile)) : undefined;
  const relativePrelude = rendererPath ? toWebPath(relative(cacheDir, rendererPath)) : undefined;
  const faviconPath = favicon ? `/webapp-favicon${pathExtension(resolveWebAsset(favicon.src, packageRoot)) || ".png"}` : "/webapp-icon.svg";
  const appleTouchPath = appleTouch ? `/webapp-apple-touch-icon${pathExtension(resolveWebAsset(appleTouch.src, packageRoot)) || ".png"}` : faviconPath;
  if (favicon) {
    await copyWebAsset(resolveWebAsset(favicon.src, packageRoot), resolve(cacheDir, faviconPath.slice(1)));
  }
  if (appleTouch) {
    await copyWebAsset(resolveWebAsset(appleTouch.src, packageRoot), resolve(cacheDir, appleTouchPath.slice(1)));
  }
  if (manifestIconConfigs) {
    for (const [index, manifestIcon] of manifestIconConfigs.entries()) {
      const manifestIconFile = resolveWebAsset(manifestIcon.src, packageRoot);
      const ext = pathExtension(manifestIconFile) || ".png";
      await copyWebAsset(manifestIconFile, resolve(cacheDir, `webapp-icon-${index + 1}${ext}`));
    }
  }
  const compiledAssets = compiled?.assets;
  writeFileSync(htmlPath, generatedHtml(config, web, relativeEntry, relativePrelude, web.themeColor, faviconPath, appleTouchPath, compiledAssets));
  const bundle = compiledAssets ? undefined : (await import(`${pathToFileURL(htmlPath).href}?v=${Date.now()}-${Math.random()}`)).default;
  if (!compiledAssets && !isHtmlBundleIndex(bundle)) {
    throw new Error("Generated web document did not produce a Bun HTMLBundle");
  }
  const html = bundle ? await Bun.file(bundle.index).text() : await Bun.file(htmlPath).text();
  const generatedPublicRoutes: Record<string, PublicRouteDefinition> = {
    "/webapp-icon.svg": {
      headers: { "content-type": "image/svg+xml; charset=utf-8" },
      GET: icon,
    },
  };
  if (compiledAssets) {
    for (const asset of compiledAssets) {
      const body = Buffer.from(asset.body, "base64");
      generatedPublicRoutes[asset.path] = {
        headers: { "content-type": asset.contentType },
        GET: () => body,
      };
    }
  }
  if (favicon) {
    const faviconFile = resolveWebAsset(favicon.src, packageRoot);
    generatedPublicRoutes[faviconPath] = {
      headers: { "content-type": contentTypeForIcon(faviconFile, favicon.type) },
      GET: () => Bun.file(faviconFile),
    };
  }
  if (appleTouch) {
    const appleTouchFile = resolveWebAsset(appleTouch.src, packageRoot);
    generatedPublicRoutes[appleTouchPath] = {
      headers: { "content-type": contentTypeForIcon(appleTouchFile, appleTouch.type) },
      GET: () => Bun.file(appleTouchFile),
    };
  }
  if (manifestIconConfigs) {
    manifestIconConfigs.forEach((manifestIcon, index) => {
      const manifestIconFile = resolveWebAsset(manifestIcon.src, packageRoot);
      const ext = pathExtension(manifestIconFile) || ".png";
      generatedPublicRoutes[`/webapp-icon-${index + 1}${ext}`] = {
        headers: { "content-type": contentTypeForIcon(manifestIconFile, manifestIcon.type) },
        GET: () => Bun.file(manifestIconFile),
      };
    });
  }
  if (pwaEnabled(web)) {
    generatedPublicRoutes["/site.webmanifest"] = {
      headers: { "content-type": "application/manifest+json; charset=utf-8" },
      GET: manifest,
    };
    generatedPublicRoutes["/manifest.webmanifest"] = {
      headers: { "content-type": "application/manifest+json; charset=utf-8" },
      GET: manifest,
    };
    return { bundle, entryPublicPath: publicEntry, cacheDir, html, manifest, icon, generatedPublicRoutes };
  }
  return { bundle, entryPublicPath: publicEntry, cacheDir, html, manifest: "", icon, generatedPublicRoutes };
}

function resolveWebDocumentResolution(web: WebAppDocumentConfig | undefined): WebDocumentResolution {
  const compiled = compiledClient();
  if (compiled) {
    return { packageRoot: compiled.packageRoot };
  }
  const webEntryFile = resolveWebEntry(web?.entry);
  const packageRoot = findPackageRoot(dirname(webEntryFile));
  return {
    entryFile: webEntryFile,
    packageRoot,
    reactDomClientPath: resolveReactDomClient(packageRoot, webEntryFile),
  };
}

export function createWebDocumentProvider(
  config: RuntimeConfig,
  webInput: WebAppDocumentConfig | undefined,
  publicRoutes: Record<string, PublicRouteDefinition>,
): WebDocumentProvider {
  const resolution = resolveWebDocumentResolution(webInput);
  const configuredFavicon = iconConfig(webInput?.icons?.favicon);
  const configuredAppleTouch = iconConfig(webInput?.icons?.appleTouch) ?? configuredFavicon;
  const configuredManifestIcons = webInput?.icons?.manifest ?? [];
  const compiled = compiledClient();
  const webEntryFile = resolution.entryFile;
  const webPackageRoot = resolution.packageRoot;
  const generatedRoutePaths = new Set([
    ...(webEntryFile ? [webEntryPublicPath(webEntryFile, webPackageRoot)] : []),
    ...(compiled?.assets.map((asset) => asset.path) ?? []),
    "/webapp-icon.svg",
    ...(configuredFavicon ? [`/webapp-favicon${pathExtension(resolveWebAsset(configuredFavicon.src, webPackageRoot)) || ".png"}`] : []),
    ...(configuredAppleTouch ? [`/webapp-apple-touch-icon${pathExtension(resolveWebAsset(configuredAppleTouch.src, webPackageRoot)) || ".png"}`] : []),
    ...configuredManifestIcons.map((manifestIcon, index) => `/webapp-icon-${index + 1}${pathExtension(resolveWebAsset(manifestIcon.src, webPackageRoot)) || ".png"}`),
    ...(pwaEnabled(webInput ?? {}) ? ["/site.webmanifest", "/manifest.webmanifest"] : []),
  ]);
  let documentPromise: Promise<WebDocument> | undefined;

  return {
    generatedRoutePaths,
    async ensure(): Promise<WebDocument> {
      documentPromise ??= createWebDocument(config, webInput, resolution).then((document) => {
        for (const path of Object.keys(document.generatedPublicRoutes)) {
          if (hasOwnPublicRoute(publicRoutes, path)) {
            throw new Error(`publicRoutes cannot override framework-owned web route: ${path}`);
          }
        }
        if (document.entryPublicPath && hasOwnPublicRoute(publicRoutes, document.entryPublicPath)) {
          throw new Error(`publicRoutes cannot override framework-owned web route: ${document.entryPublicPath}`);
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
