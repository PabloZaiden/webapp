import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncOperationToken {
  generation: number;
  signal: AbortSignal;
}

export interface AsyncOperationOptions {
  /**
   * Abort the active operation when its owner unmounts. Keep this false for
   * mutations whose server-side result must still be observed for cleanup.
   */
  abortOnUnmount?: boolean;
  initialPending?: boolean;
}

export interface AsyncOperationState {
  pending: boolean;
  start: (options?: { replace?: boolean }) => AsyncOperationToken | undefined;
  isCurrent: (token: AsyncOperationToken) => boolean;
  isMounted: () => boolean;
  finish: (token: AsyncOperationToken) => boolean;
  invalidate: () => void;
}

interface ActiveOperation {
  token: AsyncOperationToken;
  controller: AbortController;
}

export function useAsyncOperation({
  abortOnUnmount = true,
  initialPending = false,
}: AsyncOperationOptions = {}): AsyncOperationState {
  const [pending, setPending] = useState(initialPending);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const activeRef = useRef<ActiveOperation | undefined>(undefined);
  const abortOnUnmountRef = useRef(abortOnUnmount);
  abortOnUnmountRef.current = abortOnUnmount;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      if (abortOnUnmountRef.current) {
        activeRef.current?.controller.abort();
      }
      activeRef.current = undefined;
    };
  }, []);

  const start = useCallback((options: { replace?: boolean } = {}) => {
    if (!mountedRef.current) {
      return undefined;
    }
    const active = activeRef.current;
    if (active && !options.replace) {
      return undefined;
    }
    active?.controller.abort();

    const controller = new AbortController();
    const token: AsyncOperationToken = {
      generation: generationRef.current + 1,
      signal: controller.signal,
    };
    generationRef.current = token.generation;
    activeRef.current = { token, controller };
    setPending(true);
    return token;
  }, []);

  const isCurrent = useCallback((token: AsyncOperationToken) => (
    mountedRef.current
    && activeRef.current?.token.generation === token.generation
  ), []);

  const isMounted = useCallback(() => mountedRef.current, []);

  const finish = useCallback((token: AsyncOperationToken) => {
    if (!isCurrent(token)) {
      return false;
    }
    activeRef.current = undefined;
    setPending(false);
    return true;
  }, [isCurrent]);

  const invalidate = useCallback(() => {
    generationRef.current += 1;
    activeRef.current?.controller.abort();
    activeRef.current = undefined;
    if (mountedRef.current) {
      setPending(false);
    }
  }, []);

  return { pending, start, isCurrent, isMounted, finish, invalidate };
}
