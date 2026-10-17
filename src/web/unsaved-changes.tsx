import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ConfirmModal } from "./components";
import { replaceHashRoute, ROUTE_CHANGE_REQUEST } from "./routing";

type RegisterGuard = (discard: () => void) => () => void;
const GuardContext = createContext<RegisterGuard | null>(null);

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const guards = useRef(new Map<symbol, () => void>());
  const allowing = useRef(false);
  const [pendingHash, setPendingHash] = useState<string>();
  const register = useCallback<RegisterGuard>((discard) => {
    const id = Symbol();
    guards.current.set(id, discard);
    return () => { guards.current.delete(id); };
  }, []);

  useEffect(() => {
    function request(event: Event) {
      if (allowing.current || guards.current.size === 0 || !(event instanceof CustomEvent) || typeof event.detail !== "string") return;
      event.preventDefault();
      setPendingHash(event.detail);
    }
    function unload(event: BeforeUnloadEvent) {
      if (guards.current.size === 0) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener(ROUTE_CHANGE_REQUEST, request);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener(ROUTE_CHANGE_REQUEST, request);
      window.removeEventListener("beforeunload", unload);
    };
  }, []);

  function discard() {
    for (const [id, reset] of guards.current) {
      reset();
      guards.current.delete(id);
    }
    const hash = pendingHash;
    setPendingHash(undefined);
    if (hash === undefined) return;
    allowing.current = true;
    try {
      replaceHashRoute(hash);
    } finally {
      allowing.current = false;
    }
  }

  return <GuardContext.Provider value={register}>
    {children}
    <ConfirmModal isOpen={pendingHash !== undefined} onClose={() => setPendingHash(undefined)}
      onConfirm={discard} title="Discard unsaved changes?" message="Your changes will not be saved."
      confirmLabel="Discard changes" variant="danger" />
  </GuardContext.Provider>;
}

export function useUnsavedChanges(dirty: boolean, onDiscard: () => void): () => void {
  const register = useContext(GuardContext);
  const reset = useRef(onDiscard);
  const unregister = useRef<(() => void) | undefined>(undefined);
  const release = useCallback(() => {
    unregister.current?.();
    unregister.current = undefined;
  }, []);
  reset.current = onDiscard;
  if (!register) throw new Error("useUnsavedChanges requires WebAppRoot");
  useLayoutEffect(() => {
    if (!dirty) return;
    unregister.current = register(() => reset.current());
    return release;
  }, [dirty, register, release]);
  return release;
}
