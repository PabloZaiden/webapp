import { createLogger } from "../logger";

const log = createLogger("webapp:realtime");
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;

export type RealtimeStatus = "connecting" | "open" | "closed";

interface RealtimeConnectionOptions {
  url: string;
  heartbeat: boolean;
  onOpen: () => void;
  onMessage: (data: unknown) => void;
  onStatus: (status: RealtimeStatus) => void;
}

export function connectRealtime({ url, heartbeat, onOpen, onMessage, onStatus }: RealtimeConnectionOptions): () => void {
  let stopped = false;
  let socket: WebSocket | undefined;
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let pongTimer: ReturnType<typeof setTimeout> | undefined;

  function clearHeartbeat(): void {
    clearTimeout(heartbeatTimer);
    clearTimeout(pongTimer);
    heartbeatTimer = undefined;
    pongTimer = undefined;
  }

  function retireSocket(): void {
    clearHeartbeat();
    const previous = socket;
    socket = undefined;
    if (!previous) return;
    previous.onopen = null;
    previous.onmessage = null;
    previous.onclose = null;
    previous.close();
  }

  function scheduleRetry(): void {
    retireSocket();
    onStatus("closed");
    if (stopped || retryTimer !== undefined) return;
    const delay = Math.min(1000 * 2 ** retries, 10_000);
    retries += 1;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      connect();
    }, delay);
  }

  function sendHeartbeat(): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send("ping");
    pongTimer = setTimeout(() => {
      log.warn("Realtime heartbeat timed out; reconnecting");
      scheduleRetry();
    }, HEARTBEAT_TIMEOUT_MS);
  }

  function receiveMessage(message: MessageEvent): void {
    let data: unknown;
    try {
      data = JSON.parse(String(message.data));
    } catch (error) {
      log.warn("Ignoring malformed realtime JSON", { error: String(error) });
      return;
    }
    if (typeof data === "object" && data !== null && "type" in data && data.type === "pong") {
      if (pongTimer !== undefined) {
        clearTimeout(pongTimer);
        pongTimer = undefined;
        heartbeatTimer = setTimeout(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
      }
      return;
    }
    onMessage(data);
  }

  function connect(): void {
    if (stopped) return;
    const current = new WebSocket(url);
    socket = current;
    onStatus("connecting");
    heartbeatTimer = setTimeout(() => {
      log.warn("Realtime connection opening timed out; reconnecting");
      scheduleRetry();
    }, HEARTBEAT_TIMEOUT_MS);
    current.onopen = () => {
      if (stopped || socket !== current) return;
      clearTimeout(heartbeatTimer);
      heartbeatTimer = undefined;
      retries = 0;
      onStatus("open");
      if (heartbeat) sendHeartbeat();
      onOpen();
    };
    current.onmessage = (message) => {
      if (!stopped && socket === current) receiveMessage(message);
    };
    current.onclose = () => {
      if (!stopped && socket === current) scheduleRetry();
    };
  }

  function reconnect(): void {
    if (stopped) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    retireSocket();
    connect();
  }

  function handleVisibility(): void {
    if (document.visibilityState === "visible") reconnect();
  }

  function handlePageShow(event: PageTransitionEvent): void {
    if (event.persisted) reconnect();
  }

  window.addEventListener("online", reconnect);
  window.addEventListener("pageshow", handlePageShow);
  document.addEventListener("visibilitychange", handleVisibility);
  connect();

  return () => {
    stopped = true;
    window.removeEventListener("online", reconnect);
    window.removeEventListener("pageshow", handlePageShow);
    document.removeEventListener("visibilitychange", handleVisibility);
    clearTimeout(retryTimer);
    retireSocket();
  };
}
