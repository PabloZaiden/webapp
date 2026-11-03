import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { createLogger } from "./logger";
import type { RealtimeBus, RealtimeConnectionOptions } from "./realtime/bus";
import type {
  WebAppServerLifecycleHooks,
  WebAppServerOptions,
  WebAppWebSocketData,
  WebAppServerConfig,
} from "./server-types";
import type { RuntimeConfig } from "./runtime-config";
import type { WebDocument, WebDocumentProvider } from "./web-document";
import { registerProcessShutdown } from "./process-shutdown";

export interface ServerLifecycleDependencies<TEvent = unknown> {
  config: RuntimeConfig;
  hooks?: WebAppServerLifecycleHooks;
  idleTimeout: number;
  tls?: Bun.TLSOptions | Bun.TLSOptions[];
  websocket?: WebAppServerOptions["websocket"];
  publicRoutes: Readonly<Record<string, unknown>>;
  appWebsockets: NonNullable<WebAppServerConfig["websockets"]>;
  wsPath: string;
  realtime: RealtimeBus<TEvent>;
  ensurePublicAssetPaths: () => Promise<ReadonlySet<string>>;
  ensureWebDocument?: () => Promise<WebDocument>;
  documentProvider?: WebDocumentProvider;
  documentPaths?: readonly string[];
  connectionOptions?: WeakMap<WebAppWebSocketData, RealtimeConnectionOptions<TEvent>>;
  handleRequest: (req: Request, server?: Server<WebAppWebSocketData>) => Promise<Response | undefined>;
}

const log = createLogger("webapp:server");

export function createServerLifecycle<TEvent = unknown>(dependencies: ServerLifecycleDependencies<TEvent>) {
  const {
    config,
    hooks,
    idleTimeout,
    tls,
    websocket,
    publicRoutes,
    appWebsockets,
    wsPath,
    realtime,
    ensurePublicAssetPaths,
    ensureWebDocument,
    documentProvider,
    handleRequest,
  } = dependencies;
  let activeServer: Server<WebAppWebSocketData> | undefined;
  let startPromise: Promise<Server<WebAppWebSocketData>> | undefined;
  let unregisterProcessShutdown: (() => void) | undefined;

  function customHandler(socket: ServerWebSocket<WebAppWebSocketData>): Partial<WebSocketHandler<WebAppWebSocketData>> | undefined {
    const handlerName = socket.data.webappSocketHandler;
    return handlerName ? appWebsockets[handlerName] : undefined;
  }

  async function start(): Promise<Server<WebAppWebSocketData>> {
    if (activeServer || startPromise) {
      throw new Error("The web app server is already running");
    }
    unregisterProcessShutdown = registerProcessShutdown(async () => {
      if (startPromise) await startPromise;
      await stop(true);
    });
    const startingServer = startServer();
    startPromise = startingServer;
    try {
      return await startingServer;
    } finally {
      startPromise = undefined;
      if (!activeServer) {
        unregisterProcessShutdown?.();
        unregisterProcessShutdown = undefined;
      }
    }
  }

  async function startServer(): Promise<Server<WebAppWebSocketData>> {
    await hooks?.beforeStart?.();
    const webDocument = ensureWebDocument
      ? await ensureWebDocument()
      : undefined;
    const publicAssetPaths = await ensurePublicAssetPaths();
    const dynamicHandler = (req: Request, server: Server<WebAppWebSocketData>) => handleRequest(req, server);
    const publicRoutePaths = new Set([
      ...Object.keys(webDocument?.generatedPublicRoutes ?? {}),
      ...Object.keys(publicRoutes),
      ...publicAssetPaths,
    ]);
    const publicRouteHandlers = Object.fromEntries(
      Array.from(publicRoutePaths, (path) => [path, dynamicHandler]),
    );
    // Mount the bundle at its public entry for Bun's asset/HMR pipeline. Document
    // requests reach that route only after application dispatch.
    const spaDocumentRoute = dynamicHandler;
    const entryRoute = webDocument?.bundle
      ? { [webDocument.entryPublicPath]: webDocument.bundle as never }
      : {};
    const documentRoutes = Object.fromEntries((dependencies.documentPaths ?? []).map(path => [path, spaDocumentRoute]));
    const server = Bun.serve<WebAppWebSocketData>({
      hostname: config.host,
      port: config.port,
      idleTimeout,
      tls,
      routes: {
        ...publicRouteHandlers,
        ...entryRoute,
        "/api/*": dynamicHandler,
        "/.well-known/*": dynamicHandler,
        "/": publicRouteHandlers["/"] ?? spaDocumentRoute,
        "/*": dependencies.documentPaths ? dynamicHandler : spaDocumentRoute,
        [wsPath]: dynamicHandler,
        ...documentRoutes,
      },
      websocket: {
        backpressureLimit: websocket?.backpressureLimit,
        closeOnBackpressureLimit: websocket?.closeOnBackpressureLimit,
        open(socket) {
          const handler = customHandler(socket);
          if (socket.data.webappSocketHandler) {
            if (!handler) { socket.close(1008, "unknown_handler"); return; }
            handler.open?.(socket);
            return;
          }
          realtime.add(socket, dependencies.connectionOptions?.get(socket.data));
        },
        message(socket, message) {
          const handler = customHandler(socket);
          if (socket.data.webappSocketHandler) {
            handler?.message?.(socket, message);
            return;
          }
          realtime.message(socket, message);
        },
        close(socket, code, reason) {
          const handler = customHandler(socket);
          if (socket.data.webappSocketHandler) {
            handler?.close?.(socket, code, reason);
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
    activeServer = server;
    attachServerStop(server, webDocument);
    log.info(`${config.appName} server running`, { url: String(server.url) });
    try {
      await hooks?.afterStart?.(server);
      return server;
    } catch (error) {
      try {
        await server.stop(true);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "The afterStart hook failed and server cleanup also failed",
        );
      }
      throw error;
    }
  }

  function attachServerStop(server: Server<WebAppWebSocketData>, webDocument?: WebDocument): void {
    const originalStop = server.stop.bind(server);
    const releaseProcessOwnership = unregisterProcessShutdown;
    const errors: unknown[] = [];
    let stopPromise: Promise<void> | undefined;
    let closeActiveRequested = false;
    let listenerDraining = false;
    let forcedStop: Promise<void> | undefined;
    let finishForcedStop!: () => void;
    const forcedStopDone = new Promise<void>((resolve) => { finishForcedStop = resolve; });
    const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    };

    server.stop = ((closeActiveConnections?: boolean) => {
      if (closeActiveConnections) closeActiveRequested = true;
      if (stopPromise) {
        if (closeActiveConnections && listenerDraining && !forcedStop) {
          forcedStop = attempt(() => originalStop(true)).finally(finishForcedStop);
        }
        return stopPromise;
      }
      stopPromise = Promise.resolve().then(async () => {
        try {
          await attempt(() => hooks?.beforeStop?.(server));
          listenerDraining = !closeActiveRequested;
          await attempt(async () => {
            try {
              await Promise.race([originalStop(closeActiveRequested), forcedStopDone]);
            } finally {
              listenerDraining = false;
            }
          });
          await forcedStop;
          if (documentProvider && webDocument) {
            await attempt(() => documentProvider.dispose(webDocument));
          }
          await attempt(() => hooks?.afterStop?.(server));
        } finally {
          if (activeServer === server) activeServer = undefined;
          releaseProcessOwnership?.();
          if (unregisterProcessShutdown === releaseProcessOwnership) unregisterProcessShutdown = undefined;
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) {
          throw new AggregateError(errors, "Web app server cleanup failed");
        }
      });
      return stopPromise;
    }) as typeof server.stop;
  }

  async function stop(closeActiveConnections?: boolean): Promise<void> {
    if (!activeServer) return;
    await activeServer.stop(closeActiveConnections);
  }

  return { start, stop };
}
