import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CurrentUser, LogLevelName, ThemePreference, WebAppConfigResponse, WebAppUserRole } from "../contracts";
import { authenticateApiKey, assertScopes, createApiKey, deleteApiKey, listApiKeys } from "./auth/api-keys";
import {
  approveDevice,
  createDeviceAuthorization,
  denyDevice,
  discovery,
  exchangeDeviceCode,
  exchangeRefreshToken,
  getDeviceVerificationDetails,
  jwks,
  listAuthSessions,
  revokeAuthSession,
  revokeRefreshToken,
  verifyAccessToken,
} from "./auth/device-auth";
import {
  beginAuthentication,
  beginBootstrapRegistration,
  beginOwnerPasskeySetup,
  beginSetupRegistration,
  completeAuthentication,
  completeBootstrapRegistration,
  completeOwnerPasskeySetup,
  completeSetupRegistration,
  deletePasskey,
  getPasskeySessionUser,
  getSetupDetails,
  isPasskeyAuthRequired,
  logoutHeaders,
  passkeyStatus,
} from "./auth/passkeys";
import { sqliteWebAppStore } from "./auth/sqlite-store";
import type { WebAppStore } from "./auth/store";
import { AuthError, type AuthenticatedRequestState } from "./auth/types";
import { audit, assertValidUsername, createSetupLinkRecord, createUserRecord, summarizeUser } from "./auth/users";
import { nowIso, randomToken } from "./auth/crypto";
import { createLogger, setLogLevel } from "./logger";
import { createRealtimeBus, type RealtimeBus, type WebSocketData } from "./realtime/bus";
import { readRuntimeConfig, safeRuntimeConfig, type RuntimeConfig } from "./runtime-config";
import { matchRoute, type RouteAuth, type RouteTable, type UserIdSelector, type UserOwnedResource, type UserScopedRealtimePublisher } from "./routes";
import { checkSameOrigin } from "./same-origin";
import { errorResponse, jsonResponse, methodNotAllowed, notFound, parseJson, successResponse, withSecurityHeaders } from "./responses";

export interface WebAppServerConfig<TEvent = unknown> {
  appName: string;
  envPrefix: string;
  web?: WebAppDocumentConfig;
  version?: string;
  store?: WebAppStore;
  routes?: RouteTable<TEvent>;
  publicRoutes?: Record<string, PublicRouteDefinition>;
  websockets?: Record<string, Partial<WebSocketHandler<WebAppWebSocketData>>>;
  auth?: {
    passkeys?: boolean | { rpName?: string; userName?: string; userDisplayName?: string };
    apiKeys?: boolean;
    deviceAuth?: boolean;
  };
  realtime?: {
    path?: string;
  };
  logLevel?: {
    onChange?: (level: LogLevelName) => void;
  };
  configResponse?: (req: Request, base: Readonly<WebAppConfigResponse>) => Record<string, unknown>;
}

export const WEBAPP_SOCKET_HANDLER = "webappSocketHandler";

export type WebAppWebSocketData = WebSocketData & {
  webappSocketHandler?: string;
  [key: string]: unknown;
};

export type PublicRouteAsset = Response | Blob | ArrayBuffer | Uint8Array | string;
export type PublicRouteHandler = (req: Request) => PublicRouteAsset | undefined | Promise<PublicRouteAsset | undefined>;
export type PublicRouteValue = PublicRouteAsset | PublicRouteHandler;
export type PublicRouteDefinition =
  | PublicRouteValue
  | {
      GET?: PublicRouteValue;
      HEAD?: PublicRouteValue;
      headers?: HeadersInit;
    };

export interface WebAppServer<TEvent = unknown> {
  config: RuntimeConfig;
  store: WebAppStore;
  realtime: RealtimeBus<TEvent>;
  handleRequest(req: Request, server?: Server<WebSocketData>): Promise<Response | undefined>;
  start(): Promise<Server<WebSocketData>>;
  runFromCli(argv?: string[]): Promise<void>;
}

const log = createLogger("webapp:server");
const LOG_LEVELS = new Set<LogLevelName>(["trace", "debug", "info", "warn", "error"]);

type HtmlBundleIndex = { index: string };

export interface WebAppDocumentConfig {
  entry?: string | URL;
  title?: string;
  shortName?: string;
  lang?: string;
  pwa?: boolean | WebAppPwaConfig;
  themeColor?: string;
  backgroundColor?: string;
  icons?: WebAppIconsConfig;
}

export interface WebAppPwaConfig {
  enabled?: boolean;
  display?: "standalone" | "fullscreen" | "minimal-ui" | "browser";
  startUrl?: string;
  scope?: string;
}

export interface WebAppIconConfig {
  src: string | URL;
  sizes?: string;
  type?: string;
  purpose?: string;
}

export interface WebAppIconsConfig {
  favicon?: string | URL | WebAppIconConfig;
  appleTouch?: string | URL | WebAppIconConfig;
  manifest?: WebAppIconConfig[];
}

type WebDocument = {
  bundle: HtmlBundleIndex;
  entryPublicPath: string;
  cacheDir: string;
  html: string;
  manifest: string;
  icon: string;
  generatedPublicRoutes: Record<string, PublicRouteDefinition>;
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

function createDocumentCacheDir(envPrefix: string): string {
  const root = join(tmpdir(), "webapp", envPrefix.toLowerCase());
  mkdirSync(root, { recursive: true });
  const cacheDir = mkdtempSync(join(root, WEBAPP_DOCUMENT_CACHE_PREFIX));
  documentCacheDirs.add(cacheDir);
  if (!documentCacheCleanupRegistered) {
    documentCacheCleanupRegistered = true;
    process.once("exit", cleanupDocumentCacheDirs);
  }
  return cacheDir;
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.get("authorization")?.trim();
  if (!header) {
    return undefined;
  }
  const [scheme, token] = header.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" ? token : undefined;
}

function method(req: Request): "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | undefined {
  const value = req.method.toUpperCase();
  return value === "GET" || value === "POST" || value === "PUT" || value === "PATCH" || value === "DELETE" ? value : undefined;
}

function tokenError(error: unknown): Response {
  if (error instanceof AuthError) {
    return jsonResponse({ error: error.code, error_description: error.message }, { status: error.status });
  }
  return jsonResponse({ error: "server_error", error_description: "An unexpected auth error occurred" }, { status: 500 });
}

function authErrorResponse(error: unknown): Response {
  if (error instanceof AuthError) {
    return errorResponse(error.status, error.code, error.message);
  }
  return errorResponse(500, "request_failed", "Request failed");
}

function routeHandlerErrorResponse(error: unknown): Response {
  if (error instanceof AuthError) {
    return errorResponse(error.status, error.code, error.message);
  }
  log.error("Unhandled route handler error", { error: error instanceof Error ? error.message : String(error) });
  return errorResponse(500, "request_failed", "Request failed");
}

function addHeaders(response: Response, headers: Headers): Response {
  for (const [name, value] of headers) {
    response.headers.append(name, value);
  }
  return response;
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


async function htmlResponse(document: WebDocument, req?: Request): Promise<Response> {
  if (!requestLooksLikeNavigation(req)) {
    return withSecurityHeaders(notFound());
  }
  return withSecurityHeaders(new Response(document.html, { headers: { "content-type": "text/html; charset=utf-8" } }));
}

function publicAssetResponse(asset: PublicRouteAsset, extraHeaders?: HeadersInit): Response {
  const response = asset instanceof Response
    ? asset
    : typeof asset === "string"
      ? new Response(asset, { headers: { "content-type": "text/plain; charset=utf-8" } })
      : new Response(asset as BodyInit);
  if (extraHeaders) {
    for (const [name, value] of new Headers(extraHeaders)) {
      response.headers.set(name, value);
    }
  }
  return withSecurityHeaders(response);
}

function secureDynamicResponse(response: Response): Response {
  return response instanceof Response ? withSecurityHeaders(response) : response;
}

function canUseSpaFallback(req: Request): boolean {
  return req.method === "GET" || req.method === "HEAD";
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

function findPackageRoot(start: string): string {
  let current = start;
  while (true) {
    if (existsSync(resolve(current, "package.json"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return start;
    }
    current = parent;
  }
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

function themeBootScript(themeColor: string): string {
  return `(() => {
  const key = "webapp.theme";
  const root = document.documentElement;
  const metaThemeColor = document.querySelector('meta[name="theme-color"]');
  const stored = window.localStorage.getItem(key);
  const preference = stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = preference === "system" ? (systemDark ? "dark" : "light") : preference;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
  root.dataset.theme = preference;
  root.dataset.resolvedTheme = resolved;
  if (metaThemeColor instanceof HTMLMetaElement) metaThemeColor.content = resolved === "dark" ? "${escapeAttribute(themeColor)}" : "${escapeAttribute(DEFAULT_BACKGROUND_COLOR)}";
})();`;
}

function pwaEnabled(web: WebAppDocumentConfig): boolean {
  return typeof web.pwa === "object" ? web.pwa.enabled !== false : web.pwa !== false;
}

function pwaConfig(web: WebAppDocumentConfig): WebAppPwaConfig {
  return typeof web.pwa === "object" ? web.pwa : {};
}

function generatedManifest(config: RuntimeConfig, web: WebAppDocumentConfig, themeColor: string, backgroundColor: string, icons: WebAppIconConfig[]): string {
  const pwa = pwaConfig(web);
  return JSON.stringify({
    name: config.appName,
    short_name: web.shortName ?? config.appName,
    start_url: pwa.startUrl ?? "./",
    scope: pwa.scope ?? "./",
    display: pwa.display ?? "standalone",
    background_color: backgroundColor,
    theme_color: themeColor,
    icons,
  }, null, 2);
}

function iconConfig(value: string | URL | WebAppIconConfig | undefined): WebAppIconConfig | undefined {
  if (!value) return undefined;
  return typeof value === "object" && !(value instanceof URL) && "src" in value ? value : { src: value };
}

function generatedHtml(config: RuntimeConfig, web: WebAppDocumentConfig, relativeEntry: string, relativePrelude: string, themeColor: string, faviconPath: string, appleTouchPath: string): string {
  const title = escapeHtml(web.title ?? config.appName);
  const shortName = escapeAttribute(web.shortName ?? config.appName);
  const htmlFaviconPath = faviconPath.replace(/^\//, "./");
  const htmlAppleTouchPath = appleTouchPath.replace(/^\//, "./");
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
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="${escapeAttribute(themeColor)}" />
${manifestTags}    <title>${title}</title>
    <script>${themeBootScript(themeColor)}</script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${escapeAttribute(relativePrelude)}"></script>
    <script type="module" src="${escapeAttribute(relativeEntry)}"></script>
  </body>
</html>
`;
}

async function createWebDocument(config: RuntimeConfig, webInput: WebAppDocumentConfig | undefined): Promise<WebDocument> {
  const web = webInput ?? {};
  const entryFile = resolveWebEntry(web.entry);
  const themeColor = web.themeColor ?? DEFAULT_THEME_COLOR;
  const backgroundColor = web.backgroundColor ?? DEFAULT_BACKGROUND_COLOR;
  const packageRoot = findPackageRoot(dirname(resolve(Bun.main || process.argv[1] || entryFile)));
  const publicEntry = webEntryPublicPath(entryFile, packageRoot);
  const cacheDir = createDocumentCacheDir(config.envPrefix);
  const htmlPath = resolve(cacheDir, `${config.envPrefix.toLowerCase()}-index.html`);
  const icon = generatedIcon(config.appName, themeColor, backgroundColor);
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
  const manifest = pwaEnabled(web) ? generatedManifest(config, web, themeColor, backgroundColor, manifestIcons) : "";
  writeFileSync(resolve(cacheDir, "webapp-icon.svg"), icon);
  if (manifest) {
    writeFileSync(resolve(cacheDir, "site.webmanifest"), manifest);
  }
  const preludePath = resolve(cacheDir, "webapp-prelude.ts");
  const reactDomClientPath = toWebPath(resolve(packageRoot, "node_modules/react-dom/client.js"));
  const frameworkWebPath = toWebPath(fileURLToPath(new URL("../web/index.ts", import.meta.url)));
  writeFileSync(preludePath, `import { createRoot } from ${JSON.stringify(reactDomClientPath)};
import { configureWebAppRenderer } from ${JSON.stringify(frameworkWebPath)};

configureWebAppRenderer(createRoot);
`);
  const relativeEntry = toWebPath(relative(cacheDir, entryFile));
  const relativePrelude = toWebPath(relative(cacheDir, preludePath));
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
  writeFileSync(htmlPath, generatedHtml(config, web, relativeEntry, relativePrelude, themeColor, faviconPath, appleTouchPath));
  const bundle = (await import(`${pathToFileURL(htmlPath).href}?v=${Date.now()}-${Math.random()}`)).default;
  if (!isHtmlBundleIndex(bundle)) {
    throw new Error("Generated web document did not produce a Bun HTMLBundle");
  }
  const html = await Bun.file(bundle.index).text();
  const generatedPublicRoutes: Record<string, PublicRouteDefinition> = {
    "/webapp-icon.svg": {
      headers: { "content-type": "image/svg+xml; charset=utf-8" },
      GET: icon,
    },
  };
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

function scopesFromBearer(claims: { scope: string }): string[] {
  return claims.scope.split(/\s+/).filter(Boolean);
}

function currentUser(auth: AuthenticatedRequestState): CurrentUser | undefined {
  return auth.kind === "anonymous" ? undefined : auth.user;
}

function toCurrentUserRecord(user: { id: string; username: string; role: "owner" | "admin" | "user" }): CurrentUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    isOwner: user.role === "owner",
    isAdmin: user.role === "owner" || user.role === "admin",
  };
}

function requireUser(auth: AuthenticatedRequestState): CurrentUser {
  const user = currentUser(auth);
  if (!user) {
    throw new AuthError("authentication_required", "Authentication is required", 401);
  }
  return user;
}

function requireAdmin(auth: AuthenticatedRequestState): CurrentUser {
  const user = requireUser(auth);
  if (!user.isAdmin) {
    throw new AuthError("admin_required", "Admin permissions are required", 403);
  }
  return user;
}

function requireOwner(auth: AuthenticatedRequestState): CurrentUser {
  const user = requireUser(auth);
  if (!user.isOwner) {
    throw new AuthError("owner_required", "Owner permissions are required", 403);
  }
  return user;
}

function assertUser(auth: AuthenticatedRequestState, userId: string): CurrentUser {
  const user = requireUser(auth);
  if (user.id !== userId) {
    throw new AuthError("forbidden", "You cannot access another user's resource", 403);
  }
  return user;
}

function ownedUserId<TResource>(resource: TResource, getUserId?: UserIdSelector<TResource>): string | undefined {
  if (getUserId) {
    return getUserId(resource);
  }
  if (typeof resource === "object" && resource !== null && "userId" in resource && typeof resource.userId === "string") {
    return resource.userId;
  }
  throw new AuthError("route_misconfigured", "Owned resource helpers require a string userId field or a getUserId selector", 500);
}

function requireOwned<TResource extends UserOwnedResource>(auth: AuthenticatedRequestState, resource: TResource | null | undefined): TResource;
function requireOwned<TResource>(auth: AuthenticatedRequestState, resource: TResource | null | undefined, getUserId: UserIdSelector<TResource>): TResource;
function requireOwned<TResource>(auth: AuthenticatedRequestState, resource: TResource | null | undefined, getUserId?: UserIdSelector<TResource>): TResource {
  const user = requireUser(auth);
  const resourceUserId = resource ? ownedUserId(resource, getUserId) : undefined;
  if (!resource || resourceUserId !== user.id) {
    throw new AuthError("not_found", "Resource not found", 404);
  }
  return resource;
}

function filterOwned<TResource extends UserOwnedResource>(auth: AuthenticatedRequestState, resources: readonly TResource[]): TResource[];
function filterOwned<TResource>(auth: AuthenticatedRequestState, resources: readonly TResource[], getUserId: UserIdSelector<TResource>): TResource[];
function filterOwned<TResource>(auth: AuthenticatedRequestState, resources: readonly TResource[], getUserId?: UserIdSelector<TResource>): TResource[] {
  const user = requireUser(auth);
  return resources.filter((resource) => ownedUserId(resource, getUserId) === user.id);
}

function createFilterOwned(auth: AuthenticatedRequestState) {
  function contextFilterOwned<TResource extends UserOwnedResource>(resources: readonly TResource[]): TResource[];
  function contextFilterOwned<TResource>(resources: readonly TResource[], getUserId: UserIdSelector<TResource>): TResource[];
  function contextFilterOwned<TResource>(resources: readonly TResource[], getUserId?: UserIdSelector<TResource>): TResource[] {
    return filterOwned(auth, resources, getUserId as UserIdSelector<TResource>);
  }
  return contextFilterOwned;
}

function createRequireOwned(auth: AuthenticatedRequestState) {
  function contextRequireOwned<TResource extends UserOwnedResource>(resource: TResource | null | undefined): TResource;
  function contextRequireOwned<TResource>(resource: TResource | null | undefined, getUserId: UserIdSelector<TResource>): TResource;
  function contextRequireOwned<TResource>(resource: TResource | null | undefined, getUserId?: UserIdSelector<TResource>): TResource {
    return requireOwned(auth, resource, getUserId as UserIdSelector<TResource>);
  }
  return contextRequireOwned;
}

function requiresAuth(routeAuth: RouteAuth): boolean {
  return routeAuth !== "public" && routeAuth !== "optional";
}

function enforceRouteAuth(routeAuth: RouteAuth, auth: AuthenticatedRequestState): void {
  if (routeAuth === "user") {
    requireUser(auth);
  } else if (routeAuth === "admin") {
    requireAdmin(auth);
  } else if (routeAuth === "owner") {
    requireOwner(auth);
  }
}

export function createWebAppServer<TEvent = unknown>(input: WebAppServerConfig<TEvent>): WebAppServer<TEvent> {
  const config = readRuntimeConfig({ appName: input.appName, envPrefix: input.envPrefix });
  const store = input.store ?? sqliteWebAppStore({ dataDir: config.dataDir });
  store.initialize();
  const savedLogLevel = store.getLogLevelPreference();
  const activeLogLevel = config.logLevelFromEnv ? config.logLevel : savedLogLevel ?? config.logLevel;
  setLogLevel(activeLogLevel);
  input.logLevel?.onChange?.(activeLogLevel);
  const realtime = createRealtimeBus<TEvent>();
  const version = input.version ?? "0.0.0-development";
  const wsPath = input.realtime?.path ?? "/api/ws";
  const routes = input.routes ?? {};
  const publicRoutes = input.publicRoutes ?? {};
  const appWebsockets = input.websockets ?? {};
  const passkeysEnabled = input.auth?.passkeys !== false;
  const apiKeysEnabled = input.auth?.apiKeys ?? false;
  const deviceAuthEnabled = input.auth?.deviceAuth ?? false;
  const configuredFavicon = iconConfig(input.web?.icons?.favicon);
  const configuredAppleTouch = iconConfig(input.web?.icons?.appleTouch) ?? configuredFavicon;
  const configuredManifestIcons = input.web?.icons?.manifest ?? [];
  const webEntryFile = resolveWebEntry(input.web?.entry);
  const webPackageRoot = findPackageRoot(dirname(resolve(Bun.main || process.argv[1] || webEntryFile)));
  const generatedRoutePaths = new Set([
    webEntryPublicPath(webEntryFile, webPackageRoot),
    "/webapp-icon.svg",
    ...(configuredFavicon ? [`/webapp-favicon${pathExtension(resolveWebAsset(configuredFavicon.src, webPackageRoot)) || ".png"}`] : []),
    ...(configuredAppleTouch ? [`/webapp-apple-touch-icon${pathExtension(resolveWebAsset(configuredAppleTouch.src, webPackageRoot)) || ".png"}`] : []),
    ...configuredManifestIcons.map((manifestIcon, index) => `/webapp-icon-${index + 1}${pathExtension(resolveWebAsset(manifestIcon.src, webPackageRoot)) || ".png"}`),
    ...(pwaEnabled(input.web ?? {}) ? ["/site.webmanifest", "/manifest.webmanifest"] : []),
  ]);
  let webDocumentPromise: Promise<WebDocument> | undefined;

  async function ensureWebDocument(): Promise<WebDocument> {
    webDocumentPromise ??= createWebDocument(config, input.web).then((document) => {
      for (const path of Object.keys(document.generatedPublicRoutes)) {
        if (hasOwnPublicRoute(publicRoutes, path)) {
          throw new Error(`publicRoutes cannot override framework-owned web route: ${path}`);
        }
      }
      if (hasOwnPublicRoute(publicRoutes, document.entryPublicPath)) {
        throw new Error(`publicRoutes cannot override framework-owned web route: ${document.entryPublicPath}`);
      }
      return document;
    });
    return await webDocumentPromise;
  }

  function disabledAuthOwner(): CurrentUser {
    const existing = store.getOwnerUser();
    if (existing) {
      return toCurrentUserRecord(existing);
    }
    const owner = createUserRecord({ username: "admin", role: "owner" });
    store.createUser(owner);
    return toCurrentUserRecord(owner);
  }

  async function authorize(req: Request, required: boolean): Promise<AuthenticatedRequestState | Response> {
    const token = bearerToken(req);
    if (token) {
      if (deviceAuthEnabled) {
        try {
          const claims = await verifyAccessToken(store, config, token);
          const user = store.getUserById(claims.sub);
          if (user) {
            return { kind: "bearer", claims, user: {
              id: user.id,
              username: user.username,
              role: user.role,
              isOwner: user.role === "owner",
              isAdmin: user.role === "owner" || user.role === "admin",
            } };
          }
        } catch {
          // Fall through to API keys. Both use Bearer by design.
        }
      }
      if (apiKeysEnabled) {
        const apiKey = authenticateApiKey(store, token);
        if (apiKey) {
          return { kind: "api-key", ...apiKey };
        }
      }
      return errorResponse(401, "invalid_token", "Bearer token is invalid");
    }
    if (passkeysEnabled) {
      if (config.passkeyDisabled) {
        return { kind: "passkey", user: disabledAuthOwner() };
      }
      const user = getPasskeySessionUser(req, store, config);
      if (user) {
        return { kind: "passkey", user };
      }
    }
    if (passkeysEnabled && isPasskeyAuthRequired(store, config)) {
      const user = getPasskeySessionUser(req, store, config);
      if (!user) {
        return required ? errorResponse(401, "authentication_required", "Passkey authentication is required", undefined, {
          headers: { "x-webapp-passkey-required": "true" },
        }) : { kind: "anonymous" };
      }
    }
    if (required && passkeysEnabled && !config.passkeyDisabled && store.countUsers() === 0) {
      return errorResponse(401, "authentication_required", "Passkey authentication is required", undefined, {
        headers: { "x-webapp-passkey-required": "true" },
      });
    }
    return { kind: "anonymous" };
  }

  function configResponse(req: Request): WebAppConfigResponse & Record<string, unknown> {
    const user = passkeysEnabled && config.passkeyDisabled ? disabledAuthOwner() : passkeysEnabled ? getPasskeySessionUser(req, store, config) : undefined;
    const base = {
      appName: config.appName,
      version,
      currentUser: user,
      passkeyAuth: passkeyStatus(req, store, config, passkeysEnabled),
      userManagement: {
        enabled: passkeysEnabled,
        canManageUsers: Boolean(user?.isAdmin),
      },
      logLevel: {
        level: (config.logLevelFromEnv ? config.logLevel : store.getLogLevelPreference() ?? config.logLevel) as LogLevelName,
        fromEnv: config.logLevelFromEnv,
      },
      apiKeys: { enabled: Boolean(apiKeysEnabled) },
      deviceAuth: { enabled: Boolean(deviceAuthEnabled) },
    } satisfies WebAppConfigResponse;
    return { ...(input.configResponse?.(req, base) ?? {}), ...base };
  }

  function setupUrl(req: Request, token: string): string {
    const url = new URL(req.url);
    url.pathname = "/setup";
    url.search = `?token=${encodeURIComponent(token)}`;
    url.hash = "";
    return url.toString();
  }

  function createSetupLink(req: Request, userId: string, kind: "invite" | "reset" | "owner-reset", actorUserId?: string) {
    const token = randomToken(32);
    const record = createSetupLinkRecord({ userId, token, kind, createdByUserId: actorUserId });
    store.createSetupLink(record);
    return { url: setupUrl(req, token), expiresAt: record.expiresAt };
  }

  function ensureAdmin(auth: AuthenticatedRequestState): CurrentUser {
    return requireAdmin(auth);
  }

  function sanitizeRole(role: WebAppUserRole | undefined): WebAppUserRole {
    return role === "admin" ? "admin" : "user";
  }

  async function handleBuiltIn(req: Request, server?: Server<WebSocketData>): Promise<Response | undefined> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === "/api/health" && req.method === "GET") {
        return successResponse({ ok: true, version });
      }
      if (path === "/api/config" && req.method === "GET") {
        return jsonResponse(configResponse(req));
      }
      if (path === wsPath) {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        const originFailure = checkSameOrigin(req, config, auth, "always");
        if (originFailure) return originFailure;
        if (!server) return errorResponse(400, "websocket_unavailable", "WebSocket server is unavailable");
        const filters = Object.fromEntries(url.searchParams.entries());
        const upgraded = server.upgrade(req, { data: { filters, userId: currentUser(auth)?.id } });
        return upgraded ? undefined : errorResponse(400, "websocket_upgrade_failed", "WebSocket upgrade failed");
      }
      if (path === "/api/auth/status" && req.method === "GET") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        const user = currentUser(auth);
        return jsonResponse({
          authenticated: auth.kind !== "anonymous",
          authKind: auth.kind,
          subject: user?.id ?? null,
          clientId: auth.kind === "bearer" ? auth.claims.clientId : null,
          scope: auth.kind === "bearer" ? auth.claims.scope : null,
        });
      }
      if (path === "/api/passkey-auth/status" && req.method === "GET") {
        return jsonResponse(passkeyStatus(req, store, config, passkeysEnabled));
      }
      if (passkeysEnabled && path === "/api/passkey-auth/bootstrap/options" && req.method === "POST") {
        const body = await parseJson<{ username?: string }>(req);
        const result = await beginBootstrapRegistration(req, store, config, body.username ?? "");
        return addHeaders(jsonResponse(result.options), result.headers);
      }
      if (passkeysEnabled && path === "/api/passkey-auth/bootstrap/verify" && req.method === "POST") {
        const headers = await completeBootstrapRegistration(req, store, config, await parseJson(req));
        return addHeaders(successResponse(), headers);
      }
      if (passkeysEnabled && path === "/api/passkey-auth/owner-setup/options" && req.method === "POST") {
        const result = await beginOwnerPasskeySetup(req, store, config);
        return addHeaders(jsonResponse(result.options), result.headers);
      }
      if (passkeysEnabled && path === "/api/passkey-auth/owner-setup/verify" && req.method === "POST") {
        const headers = await completeOwnerPasskeySetup(req, store, config, await parseJson(req));
        return addHeaders(successResponse(), headers);
      }
      if (passkeysEnabled && path === "/api/user-setup" && req.method === "GET") {
        const token = url.searchParams.get("token") ?? "";
        return jsonResponse(getSetupDetails(store, token));
      }
      if (passkeysEnabled && path === "/api/user-setup/options" && req.method === "POST") {
        const body = await parseJson<{ token?: string }>(req);
        const result = await beginSetupRegistration(req, store, config, body.token ?? "");
        return addHeaders(jsonResponse(result.options), result.headers);
      }
      if (passkeysEnabled && path === "/api/user-setup/verify" && req.method === "POST") {
        const body = await parseJson<{ token?: string; response?: unknown }>(req);
        const headers = await completeSetupRegistration(req, store, config, body.token ?? "", body.response as never);
        return addHeaders(successResponse(), headers);
      }
      if (passkeysEnabled && path === "/api/passkey-auth/authentication/options" && req.method === "POST") {
        const result = await beginAuthentication(req, store, config);
        return addHeaders(jsonResponse(result.options), result.headers);
      }
      if (passkeysEnabled && path === "/api/passkey-auth/authentication/verify" && req.method === "POST") {
        const headers = await completeAuthentication(req, store, config, await parseJson(req));
        return addHeaders(successResponse(), headers);
      }
      if (passkeysEnabled && path === "/api/passkey-auth/logout" && req.method === "POST") {
        return addHeaders(successResponse(), logoutHeaders(req, config));
      }
      if (passkeysEnabled && path === "/api/passkey-auth/passkey" && req.method === "DELETE") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        return addHeaders(successResponse(), deletePasskey(req, store, config, requireUser(auth).id));
      }
      if (apiKeysEnabled && path === "/api/api-keys" && req.method === "GET") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        return jsonResponse(listApiKeys(store, requireUser(auth).id));
      }
      if (apiKeysEnabled && path === "/api/api-keys" && req.method === "POST") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        return jsonResponse(createApiKey(store, requireUser(auth), await parseJson(req)));
      }
      const apiKeyDelete = /^\/api\/api-keys\/([^/]+)$/.exec(path);
      if (apiKeysEnabled && apiKeyDelete && req.method === "DELETE") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        deleteApiKey(store, requireUser(auth).id, decodeURIComponent(apiKeyDelete[1]!));
        return successResponse();
      }
      if (deviceAuthEnabled && path === "/api/auth/device" && req.method === "POST") {
        const body = await parseJson<{ client_id?: string; clientId?: string; scope?: string }>(req).catch((): { client_id?: string; clientId?: string; scope?: string } => ({}));
        return jsonResponse(createDeviceAuthorization(req, store, config, { clientId: body.client_id ?? body.clientId, scope: body.scope }));
      }
      if (deviceAuthEnabled && path === "/api/auth/device/verification" && req.method === "GET") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        const userCode = url.searchParams.get("user_code")?.trim();
        if (!userCode) return errorResponse(400, "invalid_user_code", "user_code is required");
        return jsonResponse(getDeviceVerificationDetails(store, userCode, passkeysEnabled && isPasskeyAuthRequired(store, config)));
      }
      if (deviceAuthEnabled && path === "/api/auth/device/approve" && req.method === "POST") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        const body = await parseJson<{ userCode?: string; user_code?: string }>(req);
        return jsonResponse(approveDevice(store, body.userCode ?? body.user_code ?? "", requireUser(auth).id));
      }
      if (deviceAuthEnabled && path === "/api/auth/device/deny" && req.method === "POST") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        const body = await parseJson<{ userCode?: string; user_code?: string }>(req);
        return jsonResponse(denyDevice(store, body.userCode ?? body.user_code ?? ""));
      }
      if (deviceAuthEnabled && (path === "/api/auth/token" || path === "/api/auth/refresh") && req.method === "POST") {
        const body = await parseJson<{ grant_type?: string; device_code?: string; refresh_token?: string; client_id?: string }>(req);
        try {
          if (body.grant_type === "urn:ietf:params:oauth:grant-type:device_code" || body.device_code) {
            return jsonResponse(await exchangeDeviceCode(store, config, body.device_code ?? "", body.client_id));
          }
          return jsonResponse(await exchangeRefreshToken(store, config, body.refresh_token ?? "", body.client_id));
        } catch (error) {
          return tokenError(error);
        }
      }
      if (deviceAuthEnabled && path === "/api/auth/revoke" && req.method === "POST") {
        const body = await parseJson<{ refreshToken?: string; refresh_token?: string }>(req);
        revokeRefreshToken(store, body.refreshToken ?? body.refresh_token ?? "");
        return successResponse();
      }
      if (deviceAuthEnabled && path === "/api/auth/sessions" && req.method === "GET") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        return jsonResponse(listAuthSessions(store, requireUser(auth).id));
      }
      const sessionDelete = /^\/api\/auth\/sessions\/([^/]+)$/.exec(path);
      if (deviceAuthEnabled && sessionDelete && req.method === "DELETE") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        return revokeAuthSession(store, requireUser(auth).id, decodeURIComponent(sessionDelete[1]!)) ? successResponse() : notFound();
      }
      if (deviceAuthEnabled && path === "/.well-known/jwks.json" && req.method === "GET") {
        return jsonResponse(await jwks(store));
      }
      if (deviceAuthEnabled && path === "/.well-known/openid-configuration" && req.method === "GET") {
        return jsonResponse(discovery(req, config));
      }
      if (passkeysEnabled && path === "/api/users" && req.method === "GET") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        ensureAdmin(auth);
        return jsonResponse(store.listUsers().map(summarizeUser));
      }
      if (passkeysEnabled && path === "/api/users" && req.method === "POST") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        const actor = ensureAdmin(auth);
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        const body = await parseJson<{ username?: string; role?: WebAppUserRole }>(req);
        const username = assertValidUsername(body.username ?? "");
        if (store.getUserByUsername(username)) {
          return errorResponse(409, "username_exists", "Username already exists");
        }
        const user = createUserRecord({ username, role: sanitizeRole(body.role) });
        store.createUser(user);
        const setupLink = createSetupLink(req, user.id, "invite", actor.id);
        audit(store, { eventType: "user_created", actorUserId: actor.id, targetUserId: user.id, metadata: { role: user.role } });
        return jsonResponse({ user: summarizeUser(store.getUserById(user.id) ?? user), setupLink }, { status: 201 });
      }
      const userRolePatch = /^\/api\/users\/([^/]+)\/role$/.exec(path);
      if (passkeysEnabled && userRolePatch && req.method === "PATCH") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        const actor = ensureAdmin(auth);
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        const userId = decodeURIComponent(userRolePatch[1]!);
        const target = store.getUserById(userId);
        if (!target) return notFound();
        if (target.role === "owner") return errorResponse(409, "owner_immutable", "Owner role cannot be changed");
        const body = await parseJson<{ role?: WebAppUserRole }>(req);
        const role = sanitizeRole(body.role);
        store.setUserRole(userId, role, nowIso());
        audit(store, { eventType: "user_role_changed", actorUserId: actor.id, targetUserId: userId, metadata: { role } });
        return jsonResponse(summarizeUser(store.getUserById(userId) ?? target));
      }
      const userReset = /^\/api\/users\/([^/]+)\/reset$/.exec(path);
      if (passkeysEnabled && userReset && req.method === "POST") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        const actor = ensureAdmin(auth);
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        const userId = decodeURIComponent(userReset[1]!);
        const target = store.getUserById(userId);
        if (!target) return notFound();
        if (target.role === "owner") return errorResponse(409, "owner_immutable", "Owner cannot be reset");
        const timestamp = nowIso();
        store.deletePendingSetupLinksForUser(userId, timestamp);
        store.deletePasskeysForUser(userId);
        store.deleteApiKeysForUser(userId);
        store.revokeRefreshSessionsForUser(userId, timestamp);
        store.incrementUserAuthVersion(userId, timestamp);
        const setupLink = createSetupLink(req, userId, "reset", actor.id);
        audit(store, { eventType: "user_reset", actorUserId: actor.id, targetUserId: userId });
        return jsonResponse({ user: summarizeUser(store.getUserById(userId) ?? target), setupLink });
      }
      const userDelete = /^\/api\/users\/([^/]+)$/.exec(path);
      if (passkeysEnabled && userDelete && req.method === "DELETE") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        const actor = ensureAdmin(auth);
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        const userId = decodeURIComponent(userDelete[1]!);
        const target = store.getUserById(userId);
        if (!target) return notFound();
        if (target.role === "owner") return errorResponse(409, "owner_immutable", "Owner cannot be deleted");
        if (!store.deleteUser(userId)) return notFound();
        audit(store, { eventType: "user_deleted", actorUserId: actor.id, metadata: { deletedUserId: userId, username: target.username } });
        return successResponse();
      }
      if (passkeysEnabled && path === "/api/audit-events" && req.method === "GET") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        ensureAdmin(auth);
        return jsonResponse(store.listAuditEvents(100));
      }
      if (path === "/api/preferences/theme") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        const user = requireUser(auth);
        if (req.method === "GET") {
          return jsonResponse({ theme: store.getThemePreference(user.id) ?? "system" });
        }
        if (req.method === "PUT") {
          const originFailure = checkSameOrigin(req, config, auth, "mutations");
          if (originFailure) return originFailure;
          const body = await parseJson<{ theme: ThemePreference }>(req);
          store.setThemePreference(body.theme, user.id);
          return successResponse({ theme: body.theme });
        }
      }
      if (path === "/api/preferences/log-level") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        ensureAdmin(auth);
        if (req.method === "GET") {
          return jsonResponse({ level: store.getLogLevelPreference() ?? config.logLevel, fromEnv: config.logLevelFromEnv });
        }
        if (req.method === "PUT") {
          const originFailure = checkSameOrigin(req, config, auth, "mutations");
          if (originFailure) return originFailure;
          if (config.logLevelFromEnv) return errorResponse(409, "log_level_from_env", "Log level is controlled by environment");
          const body = await parseJson<{ level: LogLevelName }>(req);
          if (!LOG_LEVELS.has(body.level)) {
            return errorResponse(400, "invalid_log_level", "Log level must be one of trace, debug, info, warn, error");
          }
          store.setLogLevelPreference(body.level);
          setLogLevel(body.level);
          input.logLevel?.onChange?.(body.level);
          return successResponse({ level: body.level });
        }
      }
      if (path === "/api/server/kill" && req.method === "POST") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        ensureAdmin(auth);
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        setTimeout(() => process.exit(0), 100);
        return successResponse({ success: true, message: "Server is shutting down" });
      }
      if (deviceAuthEnabled && path === "/device" && req.method === "GET") {
        return htmlResponse(await ensureWebDocument(), req);
      }
    } catch (error) {
      return authErrorResponse(error);
    }
    return undefined;
  }

  async function handlePublicRoute(req: Request): Promise<Response | undefined> {
    const url = new URL(req.url);
    if (generatedRoutePaths.has(url.pathname)) {
      const webDocument = await ensureWebDocument();
      const generatedRoute = webDocument.generatedPublicRoutes[url.pathname];
      if (generatedRoute) {
        return handlePublicRouteValue(req, generatedRoute);
      }
    }
    if (!hasOwnPublicRoute(publicRoutes, url.pathname)) {
      return undefined;
    }
    const route = publicRoutes[url.pathname];
    if (!route) {
      return undefined;
    }
    return handlePublicRouteValue(req, route);
  }

  async function handlePublicRouteValue(req: Request, route: PublicRouteDefinition): Promise<Response | undefined> {
    const methodName = req.method === "HEAD" ? "HEAD" : req.method === "GET" ? "GET" : undefined;
    if (!methodName) {
      return withSecurityHeaders(methodNotAllowed());
    }
    const definition = typeof route === "object" && route !== null && !(route instanceof Response) && !(route instanceof Blob) && !(route instanceof ArrayBuffer) && !(route instanceof Uint8Array) && ("GET" in route || "HEAD" in route || "headers" in route)
      ? route
      : undefined;
    const value = definition ? definition[methodName] ?? (methodName === "HEAD" ? definition.GET : undefined) : route as PublicRouteValue;
    if (!value) {
      return withSecurityHeaders(methodNotAllowed());
    }
    const asset = typeof value === "function" ? await value(req) : value;
    if (!asset) {
      return withSecurityHeaders(notFound());
    }
    const response = publicAssetResponse(asset, definition?.headers);
    if (req.method === "HEAD") {
      return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    return response;
  }

  async function handleMatchedRoute(req: Request, matched: NonNullable<ReturnType<typeof matchRoute<TEvent>>>, server?: Server<WebAppWebSocketData>): Promise<Response | undefined> {
    const handler = matched.route[method(req) ?? "GET"];
    if (!handler) {
      return withSecurityHeaders(methodNotAllowed());
    }
    const routeAuth = matched.route.auth ?? "required";
    const required = requiresAuth(routeAuth);
    const auth = await authorize(req, required);
    if (auth instanceof Response) {
      return withSecurityHeaders(auth);
    }
    try {
      enforceRouteAuth(routeAuth, auth);
      if (matched.route.userParam) {
        const paramValue = matched.params[matched.route.userParam];
        if (!paramValue) {
          throw new AuthError("route_misconfigured", `Route userParam "${matched.route.userParam}" is missing from matched params`, 500);
        }
        assertUser(auth, paramValue);
      }
      if (routeAuth !== "public" && (auth.kind === "api-key" || auth.kind === "bearer")) {
        assertScopes(auth.kind === "api-key" ? auth.scopes : scopesFromBearer(auth.claims), matched.route.scopes ?? []);
      }
    } catch (error) {
      return withSecurityHeaders(authErrorResponse(error));
    }
    const current = () => requireUser(auth);
    const userRealtime = {
      publishChanged: (resource, options = {}) => realtime.publishChanged(resource, { ...options, target: { ...options.target, userId: current().id } }),
      publishEntityChanged: (resource, id, options = {}) => realtime.publishEntityChanged(resource, id, { ...options, target: { ...options.target, userId: current().id } }),
      publishDeleted: (resource, id, options = {}) => realtime.publishDeleted(resource, id, { ...options, target: { ...options.target, userId: current().id } }),
      publishSettingsChanged: (options = {}) => realtime.publishSettingsChanged({ ...options, target: { ...options.target, userId: current().id } }),
    } satisfies UserScopedRealtimePublisher<TEvent>;
    const originFailure = checkSameOrigin(req, config, auth, matched.route.sameOrigin ?? "mutations");
    if (originFailure) {
      return withSecurityHeaders(originFailure);
    }
    try {
      const response = await handler(req, {
        params: matched.params,
        auth,
        user: currentUser(auth),
        requireUser: () => requireUser(auth),
        requireAdmin: () => requireAdmin(auth),
        requireOwner: () => requireOwner(auth),
        assertUser: (userId) => assertUser(auth, userId),
        filterOwned: createFilterOwned(auth),
        requireOwned: createRequireOwned(auth),
        realtime,
        userRealtime,
        server,
      });
      return response ? withSecurityHeaders(response) : undefined;
    } catch (error) {
      return withSecurityHeaders(routeHandlerErrorResponse(error));
    }
  }

  async function handleRequest(req: Request, server?: Server<WebAppWebSocketData>): Promise<Response | undefined> {
    const url = new URL(req.url);
    const publicRoute = await handlePublicRoute(req);
    if (publicRoute) {
      return publicRoute;
    }
    const matched = matchRoute(routes, url.pathname);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/.well-known/") || url.pathname === "/device") {
      const builtIn = await handleBuiltIn(req, server);
      if (builtIn) {
        return secureDynamicResponse(builtIn);
      }
      if (!matched) {
        return withSecurityHeaders(notFound());
      }
      return handleMatchedRoute(req, matched, server);
    }
    if (matched) {
      return handleMatchedRoute(req, matched, server);
    }
    if (!canUseSpaFallback(req)) {
      return withSecurityHeaders(notFound());
    }
    return htmlResponse(await ensureWebDocument(), req);
  }

  function customHandler(socket: ServerWebSocket<WebAppWebSocketData>): Partial<WebSocketHandler<WebAppWebSocketData>> | undefined {
    const handlerName = socket.data.webappSocketHandler;
    return handlerName ? appWebsockets[handlerName] : undefined;
  }

  async function start(): Promise<Server<WebAppWebSocketData>> {
    const webDocument = await ensureWebDocument();
    const dynamicHandler = (req: Request, server: Server<WebAppWebSocketData>) => handleRequest(req, server);
    const publicRouteHandlers = Object.fromEntries([
      ...Object.keys(webDocument.generatedPublicRoutes),
      ...Object.keys(publicRoutes),
    ].map((path) => [path, dynamicHandler]));
    const spaFallbackRoute = {
      GET: dynamicHandler,
      HEAD: dynamicHandler,
      POST: dynamicHandler,
      PUT: dynamicHandler,
      PATCH: dynamicHandler,
      DELETE: dynamicHandler,
      OPTIONS: dynamicHandler,
    };
    const server = Bun.serve<WebAppWebSocketData>({
      hostname: config.host,
      port: config.port,
      routes: {
        ...publicRouteHandlers,
        [webDocument.entryPublicPath]: webDocument.bundle as never,
        "/api/*": dynamicHandler,
        "/.well-known/*": dynamicHandler,
        "/device": dynamicHandler,
        "/setup": dynamicHandler,
        "/*": {
          ...spaFallbackRoute,
          // Bun only transforms HTMLBundle modules/HMR when the bundle is mounted directly.
          GET: webDocument.bundle as never,
          HEAD: webDocument.bundle as never,
        },
      },
      websocket: {
        open(socket) {
          const handler = customHandler(socket);
          if (handler?.open) {
            handler.open(socket);
            return;
          }
          realtime.add(socket);
        },
        message(socket, message) {
          const handler = customHandler(socket);
          if (handler?.message) {
            handler.message(socket, message);
            return;
          }
          if (message === "ping") {
            socket.send(JSON.stringify({ type: "pong" }));
          }
        },
        close(socket, code, reason) {
          const handler = customHandler(socket);
          if (handler?.close) {
            handler.close(socket, code, reason);
            return;
          }
          realtime.remove(socket);
        },
        drain(socket) {
          customHandler(socket)?.drain?.(socket);
        },
      },
      development: config.development,
    });
    const stop = server.stop.bind(server);
    server.stop = ((closeActiveConnections?: boolean) => {
      stop(closeActiveConnections);
      cleanupDocumentCacheDir(webDocument.cacheDir);
    }) as typeof server.stop;
    log.info(`${config.appName} server running`, { url: String(server.url) });
    return server;
  }

  async function runFromCli(argv = Bun.argv.slice(2)): Promise<void> {
    const command = argv[0] ?? "serve";
    if (command === "serve") {
      await start();
      return await new Promise(() => undefined);
    }
    if (command === "version") {
      console.log(version);
      return;
    }
    if (command === "config") {
      console.log(JSON.stringify(safeRuntimeConfig(config), null, 2));
      return;
    }
    throw new Error(`Unknown command: ${command}`);
  }

  return { config, store, realtime, handleRequest, start, runFromCli };
}
