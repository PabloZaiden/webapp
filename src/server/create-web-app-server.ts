import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
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
  index: unknown;
  version?: string;
  store?: WebAppStore;
  routes?: RouteTable<TEvent>;
  publicRoutes?: Record<string, PublicRouteDefinition>;
  pwa?: WebAppPwaConfig;
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

export type WebAppPwaDisplay = "fullscreen" | "standalone" | "minimal-ui" | "browser";

export interface WebAppPwaIcon {
  src: string;
  sizes?: string;
  type?: string;
  purpose?: string;
}

export interface WebAppPwaAppleTouchIcon {
  href: string;
  sizes?: string;
}

export interface WebAppPwaConfig {
  enabled?: boolean;
  manifestPath?: string;
  appName?: string;
  shortName?: string;
  themeColor?: string;
  backgroundColor?: string;
  display?: WebAppPwaDisplay;
  icons?: WebAppPwaIcon[];
  appleTouchIcon?: string | WebAppPwaAppleTouchIcon | WebAppPwaAppleTouchIcon[];
  startUrl?: string;
  scope?: string;
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
  start(): Server<WebSocketData>;
  runFromCli(argv?: string[]): Promise<void>;
}

const log = createLogger("webapp:server");
const LOG_LEVELS = new Set<LogLevelName>(["trace", "debug", "info", "warn", "error"]);
const DEFAULT_PWA_THEME_COLOR = "#111827";
const DEFAULT_PWA_BACKGROUND_COLOR = "#ffffff";

type HtmlBundleIndex = { index: string };

interface NormalizedPwaConfig {
  manifestPath: string;
  appName: string;
  shortName: string;
  themeColor: string;
  backgroundColor: string;
  display: WebAppPwaDisplay;
  icons: WebAppPwaIcon[];
  appleTouchIcons: WebAppPwaAppleTouchIcon[];
  startUrl: string;
  scope: string;
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

function normalizePath(path: string, field: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error(`PWA ${field} cannot be empty`);
  }
  return trimmed;
}

function normalizeServerPath(path: string, field: string): string {
  const normalized = normalizePath(path, field);
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function normalizePwaIcon(icon: WebAppPwaIcon): WebAppPwaIcon {
  const src = normalizePath(icon.src, "icon src");
  return {
    src,
    ...(icon.sizes ? { sizes: icon.sizes } : {}),
    ...(icon.type ? { type: icon.type } : {}),
    ...(icon.purpose ? { purpose: icon.purpose } : {}),
  };
}

function normalizeAppleTouchIcon(icon: string | WebAppPwaAppleTouchIcon): WebAppPwaAppleTouchIcon {
  if (typeof icon === "string") {
    return { href: normalizePath(icon, "appleTouchIcon") };
  }
  return {
    href: normalizePath(icon.href, "appleTouchIcon href"),
    ...(icon.sizes ? { sizes: icon.sizes } : {}),
  };
}

function normalizePwaConfig(appName: string, input?: WebAppPwaConfig): NormalizedPwaConfig | undefined {
  if (input?.enabled === false) {
    return undefined;
  }
  const icons = input?.icons?.map(normalizePwaIcon) ?? [
    { src: "/web-app-manifest-192x192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
    { src: "/web-app-manifest-512x512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ];
  const appleTouchIconInput = input?.appleTouchIcon;
  const appleTouchIcons = Array.isArray(appleTouchIconInput)
    ? appleTouchIconInput.map(normalizeAppleTouchIcon)
    : appleTouchIconInput
      ? [normalizeAppleTouchIcon(appleTouchIconInput)]
      : [{ href: "/apple-touch-icon.png" }];
  return {
    manifestPath: normalizeServerPath(input?.manifestPath ?? "/manifest.webmanifest", "manifestPath"),
    appName: input?.appName ?? appName,
    shortName: input?.shortName ?? input?.appName ?? appName,
    themeColor: input?.themeColor ?? DEFAULT_PWA_THEME_COLOR,
    backgroundColor: input?.backgroundColor ?? DEFAULT_PWA_BACKGROUND_COLOR,
    display: input?.display ?? "standalone",
    icons,
    appleTouchIcons,
    startUrl: normalizeServerPath(input?.startUrl ?? "/", "startUrl"),
    scope: normalizeServerPath(input?.scope ?? "/", "scope"),
  };
}

function pwaManifestJson(pwa: NormalizedPwaConfig): string {
  return JSON.stringify({
    name: pwa.appName,
    short_name: pwa.shortName,
    start_url: pwa.startUrl,
    scope: pwa.scope,
    display: pwa.display,
    background_color: pwa.backgroundColor,
    theme_color: pwa.themeColor,
    icons: pwa.icons,
  });
}

function pwaManifestResponse(pwa: NormalizedPwaConfig): Response {
  return withSecurityHeaders(new Response(pwaManifestJson(pwa), {
    headers: { "content-type": "application/manifest+json; charset=utf-8" },
  }));
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function hasHeadTag(html: string, pattern: RegExp): boolean {
  return pattern.test(html);
}

function hasLinkRel(html: string, rel: string): boolean {
  const links = html.matchAll(/<link\b[^>]*\brel\s*=\s*(["'])(.*?)\1[^>]*>/gi);
  for (const link of links) {
    const relValue = link[2]?.toLowerCase();
    if (relValue?.split(/\s+/).includes(rel)) {
      return true;
    }
  }
  return false;
}

function pwaHeadTags(html: string, pwa: NormalizedPwaConfig): string {
  const tags: string[] = [];
  if (!hasLinkRel(html, "manifest")) {
    tags.push(`<link rel="manifest" href="${escapeHtmlAttribute(pwa.manifestPath)}" />`);
  }
  if (!hasLinkRel(html, "icon")) {
    for (const icon of pwa.icons) {
      const attributes = [
        `rel="icon"`,
        `href="${escapeHtmlAttribute(icon.src)}"`,
        icon.type ? `type="${escapeHtmlAttribute(icon.type)}"` : undefined,
        icon.sizes ? `sizes="${escapeHtmlAttribute(icon.sizes)}"` : undefined,
      ].filter(Boolean);
      tags.push(`<link ${attributes.join(" ")} />`);
    }
  }
  if (!hasLinkRel(html, "apple-touch-icon")) {
    for (const icon of pwa.appleTouchIcons) {
      const attributes = [
        `rel="apple-touch-icon"`,
        icon.sizes ? `sizes="${escapeHtmlAttribute(icon.sizes)}"` : undefined,
        `href="${escapeHtmlAttribute(icon.href)}"`,
      ].filter(Boolean);
      tags.push(`<link ${attributes.join(" ")} />`);
    }
  }
  if (!hasHeadTag(html, /<meta\b[^>]*\bname=["']mobile-web-app-capable["']/i)) {
    tags.push(`<meta name="mobile-web-app-capable" content="yes" />`);
  }
  if (!hasHeadTag(html, /<meta\b[^>]*\bname=["']apple-mobile-web-app-capable["']/i)) {
    tags.push(`<meta name="apple-mobile-web-app-capable" content="yes" />`);
  }
  if (!hasHeadTag(html, /<meta\b[^>]*\bname=["']apple-mobile-web-app-title["']/i)) {
    tags.push(`<meta name="apple-mobile-web-app-title" content="${escapeHtmlAttribute(pwa.shortName)}" />`);
  }
  if (!hasHeadTag(html, /<meta\b[^>]*\bname=["']theme-color["']/i)) {
    tags.push(`<meta name="theme-color" content="${escapeHtmlAttribute(pwa.themeColor)}" />`);
  }
  return tags.length > 0 ? `\n    ${tags.join("\n    ")}\n` : "";
}

function injectPwaHeadTags(html: string, pwa?: NormalizedPwaConfig): string {
  if (!pwa) {
    return html;
  }
  const tags = pwaHeadTags(html, pwa);
  if (!tags) {
    return html;
  }
  const headClose = /<\/head\s*>/i;
  if (headClose.test(html)) {
    return html.replace(headClose, `${tags}</head>`);
  }
  return `${html}${tags}`;
}

async function htmlResponse(index: unknown, pwa?: NormalizedPwaConfig, req?: Request): Promise<Response> {
  if (isHtmlBundleIndex(index)) {
    if (requestLooksLikeNavigation(req)) {
      const html = await Bun.file(index.index).text();
      return withSecurityHeaders(new Response(injectPwaHeadTags(html, pwa), { headers: { "content-type": "text/html; charset=utf-8" } }));
    }
    return index as unknown as Response;
  }
  if (index instanceof Response) {
    const contentType = index.headers.get("content-type");
    if (pwa && (!contentType || contentType.includes("text/html"))) {
      const headers = new Headers(index.headers);
      if (!headers.has("content-type")) {
        headers.set("content-type", "text/html; charset=utf-8");
      }
      return withSecurityHeaders(new Response(injectPwaHeadTags(await index.clone().text(), pwa), {
        status: index.status,
        statusText: index.statusText,
        headers,
      }));
    }
    return withSecurityHeaders(index);
  }
  if (typeof index === "string") {
    return withSecurityHeaders(new Response(injectPwaHeadTags(index, pwa), { headers: { "content-type": "text/html; charset=utf-8" } }));
  }
  if (index instanceof Blob) {
    if (pwa && (!index.type || index.type.includes("text/html"))) {
      return withSecurityHeaders(new Response(injectPwaHeadTags(await index.text(), pwa), { headers: { "content-type": index.type || "text/html; charset=utf-8" } }));
    }
    return withSecurityHeaders(new Response(index));
  }
  return index as Response;
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

function canRespondWithIndex(index: unknown): boolean {
  return index instanceof Response || typeof index === "string" || index instanceof Blob || isHtmlBundleIndex(index);
}

function hasOwnPublicRoute(publicRoutes: Record<string, PublicRouteDefinition>, path: string): boolean {
  return Object.prototype.hasOwnProperty.call(publicRoutes, path);
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
  const pwa = normalizePwaConfig(config.appName, input.pwa);
  const appWebsockets = input.websockets ?? {};
  const passkeysEnabled = input.auth?.passkeys !== false;
  const apiKeysEnabled = input.auth?.apiKeys ?? false;
  const deviceAuthEnabled = input.auth?.deviceAuth ?? false;

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
        return htmlResponse(input.index, pwa, req);
      }
    } catch (error) {
      return authErrorResponse(error);
    }
    return undefined;
  }

  async function handlePublicRoute(req: Request): Promise<Response | undefined> {
    const url = new URL(req.url);
    if (!hasOwnPublicRoute(publicRoutes, url.pathname)) {
      return undefined;
    }
    const route = publicRoutes[url.pathname];
    if (!route) {
      return undefined;
    }
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

  function handlePwaManifest(req: Request): Response | undefined {
    if (!pwa || new URL(req.url).pathname !== pwa.manifestPath || hasOwnPublicRoute(publicRoutes, pwa.manifestPath)) {
      return undefined;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return withSecurityHeaders(methodNotAllowed());
    }
    const response = pwaManifestResponse(pwa);
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
    const manifest = handlePwaManifest(req);
    if (manifest) {
      return manifest;
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
    return htmlResponse(input.index, pwa, req);
  }

  function customHandler(socket: ServerWebSocket<WebAppWebSocketData>): Partial<WebSocketHandler<WebAppWebSocketData>> | undefined {
    const handlerName = socket.data.webappSocketHandler;
    return handlerName ? appWebsockets[handlerName] : undefined;
  }

  function start(): Server<WebAppWebSocketData> {
    const dynamicHandler = (req: Request, server: Server<WebAppWebSocketData>) => handleRequest(req, server);
    const publicRouteHandlers = Object.fromEntries(Object.keys(publicRoutes).map((path) => [path, dynamicHandler]));
    const pwaRouteHandlers = pwa && !hasOwnPublicRoute(publicRoutes, pwa.manifestPath) ? { [pwa.manifestPath]: dynamicHandler } : {};
    const indexCanRespond = canRespondWithIndex(input.index);
    const indexIsHtmlBundle = isHtmlBundleIndex(input.index);
    const server = Bun.serve<WebAppWebSocketData>({
      hostname: config.host,
      port: config.port,
      routes: {
        ...publicRouteHandlers,
        ...pwaRouteHandlers,
        "/api/*": dynamicHandler,
        "/.well-known/*": dynamicHandler,
        "/device": deviceAuthEnabled && (!indexCanRespond || indexIsHtmlBundle) ? input.index as never : dynamicHandler,
        "/setup": passkeysEnabled && (!indexCanRespond || indexIsHtmlBundle) ? input.index as never : dynamicHandler,
        "/*": indexCanRespond && !indexIsHtmlBundle ? dynamicHandler : input.index as never,
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
    log.info(`${config.appName} server running`, { url: String(server.url) });
    return server;
  }

  async function runFromCli(argv = Bun.argv.slice(2)): Promise<void> {
    const command = argv[0] ?? "serve";
    if (command === "serve") {
      start();
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
