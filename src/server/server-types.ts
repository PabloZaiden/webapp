import type { Server, WebSocketHandler } from "bun";
import type { LogLevelName, WebAppConfigResponse } from "../contracts";
import type { RealtimeBus, RealtimeBusOptions, RealtimeConnectionOptions, WebSocketData } from "./realtime/bus";
import type { RuntimeConfig } from "./runtime-config";
import type { HttpMethod, RouteTable, WebAppRouteMiddleware } from "./routes";
import type { WebAppStaticAssetOptions } from "../static-assets";
import type { RouteCatalogEntry } from "./route-catalog";

export const WEBAPP_SOCKET_HANDLER = "webappSocketHandler";

export type WebAppWebSocketData = WebSocketData & {
  webappSocketHandler?: string;
  [key: string]: unknown;
};

export interface RequestIdentity<TIdentity> {
  identity: TIdentity;
  /** Describes transport/CSRF requirements, never additional authority. */
  credential: "ambient" | "explicit";
}

export interface WebAppOperation {
  pattern: string;
  method: HttpMethod;
  params: Readonly<Record<string, string>>;
  policy?: unknown;
}

export interface WebAppIdentityPolicy<TIdentity> {
  authenticate(req: Request): RequestIdentity<TIdentity> | undefined | Promise<RequestIdentity<TIdentity> | undefined>;
  authorize?(req: Request, identity: TIdentity, operation: WebAppOperation): boolean | Promise<boolean>;
}

export type PublicRouteAsset = Response | Blob | ArrayBuffer | Uint8Array | string;
export type PublicRouteHandler = (req: Request) => PublicRouteAsset | undefined | Promise<PublicRouteAsset | undefined>;
export type PublicRouteValue = PublicRouteAsset | PublicRouteHandler;
export type PublicRouteDefinition = PublicRouteValue | {
  GET?: PublicRouteValue;
  HEAD?: PublicRouteValue;
  headers?: HeadersInit;
};

export interface WebAppServerOptions {
  /** Negotiate gzip for textual GET responses of at least 1 KiB. Defaults to false. */
  compression?: boolean;
  /** Inactivity timeout, 0 disables it. Individual handlers may use server.timeout. */
  idleTimeout?: number;
  tls?: Bun.TLSOptions | Bun.TLSOptions[];
  /** Listener-wide Bun buffering options; callbacks remain framework-owned. */
  websocket?: Pick<
    WebSocketHandler<WebAppWebSocketData>,
    "backpressureLimit" | "closeOnBackpressureLimit"
  >;
}

export interface WebAppServerLifecycleHooks {
  beforeStart?: () => void | Promise<void>;
  afterStart?: (server: Server<WebAppWebSocketData>) => void | Promise<void>;
  beforeStop?: (server: Server<WebAppWebSocketData>) => void | Promise<void>;
  afterStop?: (server: Server<WebAppWebSocketData>) => void | Promise<void>;
}

export type WebAppRequestFilter = (request: Request) => boolean | Promise<boolean>;

export interface WebAppRealtimeAdmission<TEvent> {
  data?: WebAppWebSocketData;
  options?: RealtimeConnectionOptions<TEvent>;
  credential?: "ambient" | "explicit";
}

export interface WebAppServerConfig<TEvent = unknown, TIdentity = unknown> {
  appName: string;
  envPrefix: string;
  appDirectoryName?: string;
  runtimeConfig?: RuntimeConfig;
  web?: WebAppDocumentConfig | false;
  requestFilter?: WebAppRequestFilter;
  /** Runs before generic routes and document fallback. A successful upgrade consumes the request. */
  request?: (request: Request, server?: Server<WebAppWebSocketData>) => Response | undefined | Promise<Response | undefined>;
  identity?: WebAppIdentityPolicy<TIdentity>;
  server?: WebAppServerOptions;
  version?: string;
  routes?: RouteTable<TEvent, TIdentity>;
  routeMiddleware?: WebAppRouteMiddleware<TEvent, TIdentity>;
  publicRoutes?: Record<string, PublicRouteDefinition>;
  websockets?: Record<string, Partial<WebSocketHandler<WebAppWebSocketData>>>;
  realtime?: RealtimeBusOptions & {
    path?: string;
    /** A public realtime endpoint must be deliberately enabled. */
    access?: "public";
    authenticate?: (req: Request) => WebAppRealtimeAdmission<TEvent> | undefined | Promise<WebAppRealtimeAdmission<TEvent> | undefined>;
  };
  lifecycle?: WebAppServerLifecycleHooks;
  logLevel?: { onChange?: (level: LogLevelName) => void };
  configResponse?: (req: Request, base: Readonly<WebAppConfigResponse>) => Record<string, unknown>;
}

export interface WebAppServer<TEvent = unknown> {
  config: RuntimeConfig;
  realtime: RealtimeBus<TEvent>;
  readonly routeCatalog: readonly RouteCatalogEntry[];
  handleRequest(req: Request, server?: Server<WebAppWebSocketData>): Promise<Response | undefined>;
  start(): Promise<Server<WebAppWebSocketData>>;
  stop(closeActiveConnections?: boolean): Promise<void>;
}

export interface WebAppDocumentConfig {
  /** Restrict document fallback to these paths; omitted means an application SPA. */
  paths?: readonly string[];
  assets?: WebAppStaticAssetOptions[];
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
