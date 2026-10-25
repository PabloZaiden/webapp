import type { WebAppDuplex, WebAppDuplexHandlers } from "./external-client";
import { createLogger } from "./logger";

const log = createLogger("webapp:duplex");
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const CLOSE_TIMEOUT_MS = 5_000;

export function nativeWebAppDuplex(socket: WebSocket, signal?: AbortSignal): WebAppDuplex {
  socket.binaryType = "arraybuffer";
  const subscribers = new Set<WebAppDuplexHandlers>();
  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A caller may subscribe before awaiting ready; retain its rejection for both.
  void ready.catch(() => {});
  let closed: { code: number; reason: string } | undefined;
  let closing: Promise<void> | undefined;
  const notify = (callback: (subscriber: WebAppDuplexHandlers) => void): void => {
    for (const subscriber of subscribers) {
      try {
        callback(subscriber);
      } catch (error) {
        log.error("Message channel consumer failed", { error: String(error) });
      }
    }
  };
  const open = (): void => resolveReady();
  const error = (): void => {
    const failure = new Error("Message channel connection failed.");
    rejectReady(failure);
    notify((subscriber) => subscriber.onError(failure));
  };
  const message = (event: MessageEvent<unknown>): void => {
    const data = event.data;
    if (typeof data !== "string" && !(data instanceof ArrayBuffer)) {
      const failure = new Error("Message channel received an unsupported frame.");
      notify((subscriber) => subscriber.onError(failure));
      void close().catch((error) => log.error("Unable to close message channel", { error: String(error) }));
      return;
    }
    notify((subscriber) => subscriber.onMessage(data));
  };
  const cleanup = (): void => {
    socket.removeEventListener("open", open);
    socket.removeEventListener("error", error);
    socket.removeEventListener("message", message);
    socket.removeEventListener("close", ended);
    signal?.removeEventListener("abort", aborted);
  };
  const ended = (event: CloseEvent): void => {
    closed = { code: event.code, reason: event.reason };
    rejectReady(new Error(`Message channel closed before opening (${event.code}).`));
    cleanup();
    notify((subscriber) => subscriber.onClose(closed!));
    subscribers.clear();
  };
  const aborted = (): void => {
    rejectReady(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    void close().catch((error) => log.error("Unable to abort message channel", { error: String(error) }));
  };
  function close(code = 1000, reason = ""): Promise<void> {
    if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    if (closing) return closing;
    if (code !== 1000 && (!Number.isInteger(code) || code < 3000 || code > 4999)) {
      return Promise.reject(new TypeError("A browser channel close code must be 1000 or in the range 3000-4999."));
    }
    if (new TextEncoder().encode(reason).byteLength > 123) {
      return Promise.reject(new TypeError("A browser channel close reason cannot exceed 123 UTF-8 bytes."));
    }
    rejectReady(new Error("Message channel was closed before opening."));
    closing = new Promise<void>((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer);
        socket.removeEventListener("close", done);
        resolve();
      };
      const timer = setTimeout(() => {
        socket.removeEventListener("close", done);
        const failure = new Error("Message channel close timed out.");
        closed = { code: 1006, reason: failure.message };
        notify((subscriber) => subscriber.onError(failure));
        notify((subscriber) => subscriber.onClose(closed!));
        cleanup();
        subscribers.clear();
        reject(failure);
      }, CLOSE_TIMEOUT_MS);
      socket.addEventListener("close", done);
      try {
        socket.close(code, reason);
      } catch (error) {
        clearTimeout(timer);
        socket.removeEventListener("close", done);
        reject(error);
      }
    });
    return closing;
  }
  socket.addEventListener("open", open);
  socket.addEventListener("error", error);
  socket.addEventListener("message", message);
  socket.addEventListener("close", ended);
  signal?.addEventListener("abort", aborted, { once: true });
  if (socket.readyState === WebSocket.OPEN) resolveReady!();
  else if (socket.readyState === WebSocket.CLOSED) {
    cleanup();
    closed = { code: 1006, reason: "Message channel already closed." };
    rejectReady!(new Error(closed.reason));
  }
  if (signal?.aborted) aborted();
  return {
    ready,
    get bufferedAmount() { return socket.bufferedAmount; },
    subscribe(handlers) {
      if (closed) {
        const event = closed;
        let active = true;
        queueMicrotask(() => { if (active) handlers.onClose(event); });
        return () => { active = false; };
      }
      subscribers.add(handlers);
      return () => { subscribers.delete(handlers); };
    },
    async send(data) {
      await ready;
      if (socket.readyState !== WebSocket.OPEN) throw new Error("Message channel is closed.");
      const size = typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
      if (socket.bufferedAmount + size > MAX_BUFFERED_BYTES) {
        throw new Error("Message channel outbound buffer exceeded.");
      }
      socket.send(data instanceof Uint8Array ? new Uint8Array(data) : data);
    },
    close,
  };
}
