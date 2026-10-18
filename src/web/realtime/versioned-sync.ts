import type { RealtimeActivation } from "./connection";

export class RealtimeResyncRequiredError extends Error {
  override readonly name = "RealtimeResyncRequiredError";
}

export interface VersionedSnapshot<TData> {
  epoch: string;
  revision: number;
  data: TData;
}
export interface RealtimeDeltaVersion {
  epoch: string;
  baseRevision: number;
  revision: number;
}
export interface VersionedSyncState<TData> {
  data?: TData;
  epoch?: string;
  revision?: number;
  status: "idle" | "loading" | "live" | "error";
  error?: Error;
}
export interface VersionedSyncOptions<TData, TEvent> {
  load: (options: { signal: AbortSignal }) => Promise<VersionedSnapshot<TData>>;
  version: (event: TEvent) => RealtimeDeltaVersion;
  reduce: (data: TData, event: TEvent) => TData;
  onChange: (state: VersionedSyncState<TData>) => void;
  maxBufferedEvents?: number;
  maxBufferedBytes?: number;
}
interface Buffered<TEvent> { event: TEvent; version: RealtimeDeltaVersion; bytes: number }

function assertVersion(epoch: string, revision: number): void {
  if (typeof epoch !== "string" || !epoch || !Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError("Authoritative versions require an epoch and a non-negative safe integer revision");
  }
}

/** Serializes authoritative snapshots and domain deltas; it owns no replay history. */
export function createVersionedSyncController<TData, TEvent>(options: VersionedSyncOptions<TData, TEvent>) {
  const maxEvents = options.maxBufferedEvents ?? 512;
  const maxBytes = options.maxBufferedBytes ?? 2 * 1024 * 1024;
  if (!Number.isSafeInteger(maxEvents) || maxEvents <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("Synchronization buffer limits must be positive integers");
  }
  let state: VersionedSyncState<TData> = { status: "idle" };
  let generation: number | undefined;
  let request = 0;
  let abort: AbortController | undefined;
  let buffer: Buffered<TEvent>[] = [];
  let bufferedBytes = 0;
  let disposed = false;
  let recoveryAttempts = 0;
  let expectedEpoch: string | undefined;
  let baselineEstablished = false;
  let lifecycle = 0;
  let running: Promise<void> | undefined;
  let queued = false;

  function emit(next: VersionedSyncState<TData>): void {
    state = next;
    if (!disposed) options.onChange(state);
  }
  function clearBuffer(): void {
    buffer = [];
    bufferedBytes = 0;
  }
  function fail(value: unknown): void {
    abort?.abort();
    request++;
    clearBuffer();
    emit({ ...state, status: "error", error: value instanceof Error ? value : new Error(String(value)) });
  }
  function valid(token: number, activation: number): boolean {
    return !disposed && generation === activation && request === token;
  }

  async function readSnapshot(): Promise<void> {
    if (disposed || generation === undefined) return;
    abort?.abort();
    const controller = new AbortController();
    abort = controller;
    const token = ++request;
    const activation = generation;
    emit({ ...state, status: "loading", error: undefined });
    try {
      const snapshot = await options.load({ signal: controller.signal });
      if (!valid(token, activation)) return;
      if (queued) return;
      assertVersion(snapshot.epoch, snapshot.revision);
      if (expectedEpoch !== undefined && snapshot.epoch !== expectedEpoch) {
        recover("Snapshot epoch does not cover the current stream");
        return;
      }
      if (baselineEstablished && state.epoch === snapshot.epoch && state.revision !== undefined && snapshot.revision < state.revision) {
        recover("Snapshot is older than the installed authoritative state");
        return;
      }
      let data = snapshot.data;
      let revision = snapshot.revision;
      const pending = buffer.filter(item => item.version.epoch === snapshot.epoch && item.version.revision > revision)
        .sort((a, b) => a.version.revision - b.version.revision);
      for (const item of pending) {
        if (item.version.revision <= revision) continue;
        if (item.version.baseRevision !== revision) {
          recover("A buffered delta cannot extend the authoritative snapshot");
          return;
        }
        data = options.reduce(data, item.event);
        revision = item.version.revision;
      }
      clearBuffer();
      expectedEpoch = snapshot.epoch;
      recoveryAttempts = 0;
      baselineEstablished = true;
      // Baseline installation and draining happen in one synchronous state transition.
      emit({ data, epoch: snapshot.epoch, revision, status: "live" });
    } catch (error) {
      if (valid(token, activation)) {
        if (error instanceof RealtimeResyncRequiredError) recover(error.message);
        else fail(error);
      }
    }
  }
  function load(): Promise<void> {
    if (disposed || generation === undefined) return Promise.resolve();
    if (running) {
      queued = true;
      return running;
    }
    const token = lifecycle;
    const task = Promise.resolve().then(async () => {
      do {
        if (token !== lifecycle || disposed || generation === undefined) return;
        queued = false;
        await readSnapshot();
      } while (queued && token === lifecycle && generation !== undefined && !disposed && state.status !== "error");
    }).finally(() => {
      if (running === task) running = undefined;
    });
    running = task;
    emit({ ...state, status: "loading", error: undefined });
    return task;
  }
  function recover(message: string): void {
    if (++recoveryAttempts > 2) {
      fail(new Error(`Realtime synchronization failed: ${message}`));
      return;
    }
    void load();
  }
  function receive(event: TEvent): void {
    if (disposed || generation === undefined || state.status === "error") return;
    try {
      const version = options.version(event);
      assertVersion(version.epoch, version.revision);
      if (!Number.isSafeInteger(version.baseRevision) || version.baseRevision < 0 || version.baseRevision >= version.revision) {
        throw new TypeError("A delta must advance a valid authoritative base revision");
      }
      if (expectedEpoch !== undefined && expectedEpoch !== version.epoch) {
        expectedEpoch = version.epoch;
        clearBuffer();
        recover("The stream epoch changed");
      }
      if (state.status === "live" && state.epoch === version.epoch) {
        if (version.revision <= state.revision!) return;
        if (version.baseRevision === state.revision) {
          const data = options.reduce(state.data as TData, event);
          emit({ data, epoch: version.epoch, revision: version.revision, status: "live" });
          return;
        }
      }
      const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
      if (bytes > maxBytes) {
        fail(new Error("A realtime delta exceeds the synchronization buffer limit"));
        return;
      }
      if (buffer.length >= maxEvents || bufferedBytes + bytes > maxBytes) {
        clearBuffer();
        recover("The synchronization buffer overflowed");
        return;
      }
      buffer.push({ event, version, bytes });
      bufferedBytes += bytes;
      expectedEpoch = version.epoch;
      if (state.status === "live") recover("A delta cannot extend the live projection");
    } catch (error) {
      if (error instanceof RealtimeResyncRequiredError) recover(error.message);
      else fail(error);
    }
  }
  function deactivate(): void {
    generation = undefined;
    lifecycle++;
    request++;
    abort?.abort();
    abort = undefined;
    clearBuffer();
    expectedEpoch = undefined;
    recoveryAttempts = 0;
    running = undefined;
    queued = false;
    baselineEstablished = false;
    if (!disposed) emit({ ...state, status: "idle", error: undefined });
  }
  return {
    activate(activation: RealtimeActivation): void {
      if (disposed) return;
      deactivate();
      generation = activation.generation;
      clearBuffer();
      void load();
    },
    receive,
    refresh(): Promise<void> {
      recoveryAttempts = 0;
      return load();
    },
    deactivate,
    getState(): VersionedSyncState<TData> { return state; },
    dispose(): void {
      disposed = true;
      deactivate();
    },
  };
}
