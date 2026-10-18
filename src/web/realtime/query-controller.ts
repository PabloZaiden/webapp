import { createLogger } from "../logger";

const log = createLogger("webapp:live-query");

export interface LiveQueryState<TData> {
  data?: TData;
  error?: Error;
  loading: boolean;
}
export interface LiveQueryControllerOptions<TData> {
  load: (signal: AbortSignal, previous?: TData) => Promise<TData>;
  initialData?: TData;
  onChange: (state: LiveQueryState<TData>) => void;
  onError?: (error: Error) => void;
}

/** Owns reads and mutation barriers for an invalidation-only authoritative projection. */
export function createLiveQueryController<TData>(options: LiveQueryControllerOptions<TData>) {
  let state: LiveQueryState<TData> = { data: options.initialData, loading: options.initialData === undefined };
  let active = false;
  let readable = false;
  let lifecycle = 0;
  let read = 0;
  let dirty = false;
  let mutations = 0;
  let nextMutation = 0;
  let committedMutation = 0;
  let reading: AbortController | undefined;
  let running: Promise<void> | undefined;
  const operations = new Set<AbortController>();

  function emit(next: LiveQueryState<TData>): void {
    state = next;
    options.onChange(state);
  }
  function report(value: unknown): void {
    const error = value instanceof Error ? value : new Error(String(value));
    emit({ ...state, error, loading: false });
    try {
      options.onError?.(error);
    } catch (callbackError) {
      log.error("Live query error handler failed", { error: String(callbackError), cause: error.message });
    }
  }
  function cancelRead(): void {
    read++;
    reading?.abort();
    reading = undefined;
    running = undefined;
  }
  function current(token: number): boolean {
    return active && lifecycle === token;
  }
  function invalidate(): Promise<void> {
    dirty = true;
    if (!active || !readable || mutations) return Promise.resolve();
    if (running) return running;
    const token = lifecycle;
    const task = Promise.resolve().then(async () => {
      while (dirty && current(token) && readable && !mutations) {
        dirty = false;
        const generation = ++read;
        const abort = new AbortController();
        reading = abort;
        emit({ ...state, loading: true });
        try {
          const data = await options.load(abort.signal, state.data);
          if (!current(token) || generation !== read) return;
          // A newer invalidation during this read requires another authoritative cut.
          if (!dirty) emit({ data, loading: false });
        } catch (error) {
          if (!current(token) || generation !== read) return;
          report(error);
          // Persistent read failures are visible, not an unbounded retry loop.
          dirty = false;
          return;
        }
      }
    }).finally(() => {
      if (running === task) {
        running = undefined;
        reading = undefined;
      }
    });
    running = task;
    return task;
  }
  function deactivate(): void {
    active = false;
    readable = false;
    lifecycle++;
    cancelRead();
    for (const operation of operations) operation.abort();
    operations.clear();
    mutations = 0;
    dirty = false;
  }
  return {
    prepare(): void {
      if (!active) active = true;
    },
    suspend(): void {
      readable = false;
      cancelRead();
      dirty = true;
    },
    reset(data?: TData): void {
      deactivate();
      emit({ data, loading: data === undefined });
    },
    activate(input: { reset?: boolean; initialData?: TData } = {}): Promise<void> {
      if (input.reset) {
        deactivate();
        emit({ data: input.initialData, loading: input.initialData === undefined });
      }
      active = true;
      readable = true;
      return invalidate();
    },
    invalidate,
    deactivate,
    async mutate<TResult>(
      operation: (signal: AbortSignal) => Promise<TResult>,
      reconcile?: (previous: TData | undefined, result: TResult) => TData | undefined,
    ): Promise<TResult> {
      if (!active) throw new Error("Cannot mutate an inactive live query");
      const token = lifecycle;
      const mutation = ++nextMutation;
      const abort = new AbortController();
      operations.add(abort);
      mutations++;
      cancelRead();
      dirty = true;
      try {
        const result = await operation(abort.signal);
        if (current(token) && mutation >= committedMutation && reconcile) {
          committedMutation = mutation;
          emit({ ...state, data: reconcile(state.data, result), error: undefined });
        }
        return result;
      } catch (error) {
        if (current(token)) report(error);
        throw error;
      } finally {
        operations.delete(abort);
        if (current(token)) {
          mutations--;
          dirty = true;
          if (!mutations) await invalidate();
        }
      }
    },
    getState(): LiveQueryState<TData> { return state; },
  };
}
