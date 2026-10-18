import { createLogger } from "../logger";

const log = createLogger("webapp:realtime-refresh");

/** One cancellable authoritative read, plus one coalesced follow-up when dirtied. */
export function createRefreshController<TEvent>(options: {
  refresh: (event: TEvent | undefined, signal: AbortSignal) => void | Promise<void>;
  onError: (error: Error) => void;
}) {
  let active = false;
  let request = 0;
  let controller: AbortController | undefined;
  let running: Promise<void> | undefined;
  let queued = false;
  let latestEvent: TEvent | undefined;

  async function drain(token: number): Promise<void> {
    if (!active || token !== request) return;
    do {
      queued = false;
      const event = latestEvent;
      const abort = new AbortController();
      controller = abort;
      try {
        await options.refresh(event, abort.signal);
      } catch (value) {
        if (active && token === request) {
          const error = value instanceof Error ? value : new Error(String(value));
          try {
            options.onError(error);
          } catch (callbackError) {
            log.error("Realtime refresh error handler failed", { error: String(callbackError), cause: error.message });
          }
        }
      }
      if (!active || token !== request) return;
    } while (queued);
  }
  function invalidate(event?: TEvent): Promise<void> {
    if (!active) return Promise.resolve();
    latestEvent = event;
    if (running) {
      queued = true;
      return running;
    }
    const token = request;
    // Install running before calling consumer code, including synchronous invalidations.
    running = Promise.resolve().then(() => drain(token)).finally(() => {
      if (token === request) {
        running = undefined;
        controller = undefined;
      }
    });
    return running;
  }
  function deactivate(): void {
    active = false;
    request++;
    controller?.abort();
    controller = undefined;
    running = undefined;
    queued = false;
    latestEvent = undefined;
  }
  return {
    activate(): Promise<void> {
      deactivate();
      active = true;
      return invalidate();
    },
    invalidate,
    deactivate,
  };
}
