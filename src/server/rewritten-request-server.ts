import type { Server } from "bun";
import type { WebAppWebSocketData } from "./server-types";

/** Bun's socket/timeout APIs require the native listener Request, not its sanitized clone. */
export function serverForRewrittenRequest(
  server: Server<WebAppWebSocketData> | undefined,
  original: Request,
  rewritten: Request,
): Server<WebAppWebSocketData> | undefined {
  if (!server || original === rewritten) return server;
  return new Proxy(server, {
    get(target, property) {
      if (property === "upgrade") {
        return (request: Request, options: Parameters<typeof server.upgrade>[1]) =>
          target.upgrade(request === rewritten ? original : request, options);
      }
      if (property === "timeout") {
        return (request: Request, seconds: number) =>
          target.timeout(request === rewritten ? original : request, seconds);
      }
      if (property === "requestIP") {
        return (request: Request) => target.requestIP(request === rewritten ? original : request);
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
