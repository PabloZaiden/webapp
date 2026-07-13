import type { Server, WebSocketHandler } from "bun";
import type { LogLevelName, WebAppConfigResponse } from "../contracts";
import type { RealtimeBus, WebSocketData } from "./realtime/bus";
import type { WebAppStore } from "./auth/store";
import type { RuntimeConfig } from "./runtime-config";
import type { RouteTable } from "./routes";

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

export interface WebAppServer<TEvent = unknown> {
  config: RuntimeConfig;
  store: WebAppStore;
  realtime: RealtimeBus<TEvent>;
  handleRequest(req: Request, server?: Server<WebSocketData>): Promise<Response | undefined>;
  start(): Promise<Server<WebSocketData>>;
  runFromCli(argv?: string[]): Promise<void>;
}

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
