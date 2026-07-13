import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { createLogger } from "./logger";
import type { RealtimeBus } from "./realtime/bus";
import type { WebAppWebSocketData, WebAppServerConfig } from "./server-types";
import type { RuntimeConfig } from "./runtime-config";
import { safeRuntimeConfig } from "./runtime-config";
import type { WebDocument, WebDocumentProvider } from "./web-document";

export interface ServerLifecycleDependencies<TEvent = unknown> {
  config: RuntimeConfig;
  version: string;
  deviceAuthEnabled: boolean;
  publicRoutes: Readonly<Record<string, unknown>>;
  appWebsockets: NonNullable<WebAppServerConfig["websockets"]>;
  realtime: RealtimeBus<TEvent>;
  ensureWebDocument: () => Promise<WebDocument>;
  documentProvider: WebDocumentProvider;
  handleRequest: (req: Request, server?: Server<WebAppWebSocketData>) => Promise<Response | undefined>;
}

const log = createLogger("webapp:server");

export function createServerLifecycle<TEvent = unknown>(dependencies: ServerLifecycleDependencies<TEvent>) {
  const {
    config,
    version,
    deviceAuthEnabled,
    publicRoutes,
    appWebsockets,
    realtime,
    ensureWebDocument,
    documentProvider,
    handleRequest,
  } = dependencies;

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
    // Bun only transforms HTMLBundle modules/HMR when the bundle is mounted directly.
    // Wrapping it in a handler or Response, or adding route-level headers, serves
    // untransformed module paths and breaks generated document routes.
    const spaDocumentRoute = webDocument.bundle ? {
      ...spaFallbackRoute,
      GET: webDocument.bundle as never,
      HEAD: webDocument.bundle as never,
    } : spaFallbackRoute;
    const entryRoute = webDocument.bundle ? { [webDocument.entryPublicPath]: webDocument.bundle as never } : {};
    const server = Bun.serve<WebAppWebSocketData>({
      hostname: config.host,
      port: config.port,
      routes: {
        ...publicRouteHandlers,
        ...entryRoute,
        "/api/*": dynamicHandler,
        "/.well-known/*": dynamicHandler,
        "/device": deviceAuthEnabled ? spaDocumentRoute : dynamicHandler,
        "/setup": spaDocumentRoute,
        "/*": spaDocumentRoute,
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
      documentProvider.dispose(webDocument);
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

  return { start, runFromCli };
}
