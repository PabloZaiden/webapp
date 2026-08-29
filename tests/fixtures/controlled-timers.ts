type TimerCallback = Parameters<typeof globalThis.setTimeout>[0];
type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

interface PendingTimer {
  dueAt: number;
  callback: () => void;
}

export interface ControlledTimers {
  advanceBy(milliseconds: number): void;
  flushAnimationFrames(): void;
  restore(): void;
}

export function installControlledTimers(): ControlledTimers {
  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  const previousRequestAnimationFrame = window.requestAnimationFrame;
  const previousCancelAnimationFrame = window.cancelAnimationFrame;
  const timers = new Map<TimerHandle, PendingTimer>();
  const animationFrames = new Map<number, FrameRequestCallback>();
  let now = 0;
  let nextAnimationFrameHandle = 0;
  let restored = false;

  const createTimerHandle = (): TimerHandle => {
    const handle = previousSetTimeout(() => undefined, 2_147_483_647);
    previousClearTimeout(handle);
    return handle;
  };

  const controlledSetTimeout = ((
    callback: TimerCallback,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (typeof callback !== "function") {
      throw new TypeError("Controlled timers only support function callbacks.");
    }
    const handle = createTimerHandle();
    const milliseconds = typeof delay === "number" && Number.isFinite(delay)
      ? Math.max(0, delay)
      : 0;
    timers.set(handle, {
      dueAt: now + milliseconds,
      callback: () => Reflect.apply(callback, undefined, args),
    });
    return handle;
  }) as typeof globalThis.setTimeout;

  const controlledClearTimeout = ((handle: TimerHandle | undefined) => {
    if (handle !== undefined) {
      timers.delete(handle);
    }
  }) as typeof globalThis.clearTimeout;

  const controlledRequestAnimationFrame = ((callback: FrameRequestCallback) => {
    nextAnimationFrameHandle += 1;
    animationFrames.set(nextAnimationFrameHandle, callback);
    return nextAnimationFrameHandle;
  }) as typeof window.requestAnimationFrame;

  const controlledCancelAnimationFrame = ((handle: number) => {
    animationFrames.delete(handle);
  }) as typeof window.cancelAnimationFrame;

  globalThis.setTimeout = controlledSetTimeout;
  globalThis.clearTimeout = controlledClearTimeout;
  window.requestAnimationFrame = controlledRequestAnimationFrame;
  window.cancelAnimationFrame = controlledCancelAnimationFrame;

  const advanceBy = (milliseconds: number): void => {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new RangeError("Controlled timer advancement must be finite and non-negative.");
    }
    const target = now + milliseconds;
    while (true) {
      let nextHandle: TimerHandle | undefined;
      let nextTimer: PendingTimer | undefined;
      for (const [handle, timer] of timers) {
        if (timer.dueAt > target || (nextTimer && timer.dueAt >= nextTimer.dueAt)) {
          continue;
        }
        nextHandle = handle;
        nextTimer = timer;
      }
      if (!nextHandle || !nextTimer) {
        break;
      }
      timers.delete(nextHandle);
      now = nextTimer.dueAt;
      nextTimer.callback();
    }
    now = target;
  };

  const flushAnimationFrames = (): void => {
    while (animationFrames.size > 0) {
      const frames = Array.from(animationFrames.entries());
      animationFrames.clear();
      for (const [, callback] of frames) {
        callback(now);
      }
    }
  };

  return {
    advanceBy,
    flushAnimationFrames,
    restore() {
      if (restored) {
        return;
      }
      restored = true;
      timers.clear();
      animationFrames.clear();
      globalThis.setTimeout = previousSetTimeout;
      globalThis.clearTimeout = previousClearTimeout;
      window.requestAnimationFrame = previousRequestAnimationFrame;
      window.cancelAnimationFrame = previousCancelAnimationFrame;
    },
  };
}
