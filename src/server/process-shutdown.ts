/**
 * Process shutdown waits for every running framework server's lifecycle.
 */

import { createLogger } from "./logger";

const log = createLogger("webapp:shutdown");
const shutdownHandlers = new Set<() => Promise<void>>();
let shutdownPromise: Promise<void> | undefined;
let shutdownTimer: ReturnType<typeof setTimeout> | undefined;

function requestProcessShutdown(): void {
  shutdownPromise ??= (async () => {
    if (shutdownTimer) clearTimeout(shutdownTimer);
    const results = await Promise.allSettled(
      [...shutdownHandlers].map((handler) => Promise.resolve().then(handler)),
    );
    let exitCode = 0;
    for (const result of results) {
      if (result.status === "rejected") {
        exitCode = 1;
        log.error("Web app shutdown failed", result.reason);
      }
    }
    process.exit(exitCode);
  })().catch((error: unknown) => {
    console.error("Web app process shutdown failed", error);
    process.exit(1);
  });
}

export function registerProcessShutdown(handler: () => Promise<void>): () => void {
  if (shutdownPromise || shutdownTimer) {
    throw new Error("The web app process is shutting down");
  }
  shutdownHandlers.add(handler);
  if (shutdownHandlers.size === 1) {
    process.on("SIGINT", requestProcessShutdown);
    process.on("SIGTERM", requestProcessShutdown);
  }
  return () => {
    shutdownHandlers.delete(handler);
    if (shutdownHandlers.size === 0 && !shutdownPromise) {
      process.off("SIGINT", requestProcessShutdown);
      process.off("SIGTERM", requestProcessShutdown);
    }
  };
}

export function scheduleProcessShutdown(): void {
  if (shutdownTimer || shutdownPromise) return;
  // Preserve the HTTP acknowledgement window before closing active connections.
  shutdownTimer = setTimeout(requestProcessShutdown, 100);
}
