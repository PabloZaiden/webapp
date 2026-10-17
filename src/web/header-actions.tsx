import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { HeaderActionSet, HeaderPrimaryAction } from "./root-types";
import type { ActionMenuItem } from "./sidebar/types";

interface HeaderActionEntry {
  primary: HeaderPrimaryStore;
  hasPrimary: boolean;
  overflow: ActionMenuItem[];
}

interface HeaderActionRegistry {
  entries: Map<symbol, HeaderActionEntry>;
  snapshot: HeaderActionEntry[];
  listeners: Set<() => void>;
  getSnapshot: () => HeaderActionEntry[];
  subscribe: (listener: () => void) => () => void;
  register: (owner: symbol, entry: HeaderActionEntry) => void;
  update: (owner: symbol, entry: HeaderActionEntry) => void;
  unregister: (owner: symbol) => void;
}

export interface HeaderPrimaryStore {
  value: HeaderPrimaryAction[];
  listeners: Set<() => void>;
  getSnapshot: () => HeaderPrimaryAction[];
  subscribe: (listener: () => void) => () => void;
}

interface HeaderActionsContextValue {
  register: (owner: symbol, entry: HeaderActionEntry) => void;
  update: (owner: symbol, entry: HeaderActionEntry) => void;
  unregister: (owner: symbol) => void;
}

const HeaderActionsContext = createContext<HeaderActionsContextValue | null>(null);
interface HeaderActionsSnapshot {
  primary: HeaderPrimaryStore;
  overflow: ActionMenuItem[];
}
const HeaderActionsSnapshotContext = createContext<HeaderActionsSnapshot | null>(null);
const EMPTY_OVERFLOW: ActionMenuItem[] = [];
const EMPTY_PRIMARY: HeaderPrimaryAction[] = [];

function createHeaderPrimaryStore(initialValue: HeaderPrimaryAction[]): HeaderPrimaryStore {
  const store: HeaderPrimaryStore = {
    value: initialValue,
    listeners: new Set(),
    getSnapshot: () => store.value,
    subscribe: (listener) => {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
  };
  return store;
}

function sameActionMenuShape(first: ActionMenuItem[], second: ActionMenuItem[]): boolean {
  if (first.length !== second.length) {
    return false;
  }
  return first.every((item, index) => {
    const other = second[index];
    if (!other) {
      return false;
    }
    return item.id === other.id
      && item.label === other.label
      && item.form === other.form
      && item.disabled === other.disabled
      && item.destructive === other.destructive;
  });
}

function createStableOverflow(
  overflow: ActionMenuItem[],
  latestOverflowRef: { current: ActionMenuItem[] },
): ActionMenuItem[] {
  return overflow.map((item, index) => {
    if (item.form !== undefined) return item;
    return {
      ...item,
      onAction: () => {
        const latestItem = item.id
          ? latestOverflowRef.current.find((candidate) => candidate.id === item.id)
          : latestOverflowRef.current[index];
        latestItem?.onAction?.();
      },
    };
  });
}

function hasPrimaryAction(primary: HeaderPrimaryAction[] | undefined): boolean {
  return primary !== undefined;
}

function notify(listeners: Set<() => void>): void {
  listeners.forEach((listener) => listener());
}

function createHeaderActionRegistry(): HeaderActionRegistry {
  const registry: HeaderActionRegistry = {
    entries: new Map(),
    snapshot: [],
    listeners: new Set(),
    getSnapshot: () => registry.snapshot,
    subscribe: (listener) => {
      registry.listeners.add(listener);
      return () => registry.listeners.delete(listener);
    },
    register: (owner, entry) => {
      registry.entries.set(owner, entry);
      registry.snapshot = [...registry.entries.values()];
      notify(registry.listeners);
    },
    update: (owner, entry) => {
      const current = registry.entries.get(owner);
      if (
        current
        && current.hasPrimary === entry.hasPrimary
        && sameActionMenuShape(current.overflow, entry.overflow)
      ) {
        return;
      }
      registry.entries.set(owner, entry);
      registry.snapshot = [...registry.entries.values()];
      notify(registry.listeners);
    },
    unregister: (owner) => {
      if (!registry.entries.delete(owner)) {
        return;
      }
      registry.snapshot = [...registry.entries.values()];
      notify(registry.listeners);
    },
  };
  return registry;
}

function mergeHeaderActions(
  base: HeaderActionSet,
  entries: HeaderActionEntry[],
  basePrimary: HeaderPrimaryStore,
): HeaderActionsSnapshot {
  let primary = basePrimary;
  for (const entry of entries) {
    if (entry.hasPrimary) {
      primary = entry.primary;
    }
  }
  return {
    primary,
    overflow: [
      ...(base.overflow ?? EMPTY_OVERFLOW),
      ...entries.flatMap((entry) => entry.overflow),
    ],
  };
}

export function HeaderActionsProvider({
  base,
  children,
}: {
  base: HeaderActionSet;
  children: ReactNode;
}) {
  const registryRef = useRef<HeaderActionRegistry | null>(null);
  if (!registryRef.current) {
    registryRef.current = createHeaderActionRegistry();
  }
  const registry = registryRef.current;
  const entries = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
  const basePrimaryRef = useRef<HeaderPrimaryStore | null>(null);
  if (!basePrimaryRef.current) basePrimaryRef.current = createHeaderPrimaryStore(base.primary ?? EMPTY_PRIMARY);
  const basePrimary = basePrimaryRef.current;
  useLayoutEffect(() => {
    basePrimary.value = base.primary ?? EMPTY_PRIMARY;
    notify(basePrimary.listeners);
  }, [base.primary, basePrimary]);
  const contextValue = useMemo<HeaderActionsContextValue>(() => ({
    register: registry.register,
    update: registry.update,
    unregister: registry.unregister,
  }), [registry]);
  const snapshot = useMemo(
    () => mergeHeaderActions(base, entries, basePrimary),
    [base, entries, basePrimary],
  );

  return (
    <HeaderActionsContext.Provider value={contextValue}>
      <HeaderActionsSnapshotContext.Provider value={snapshot}>
        {children}
      </HeaderActionsSnapshotContext.Provider>
    </HeaderActionsContext.Provider>
  );
}

export function useHeaderActions(actions: HeaderActionSet = {}): void {
  const context = useContext(HeaderActionsContext);
  if (!context) {
    throw new Error("useHeaderActions must be used within HeaderActionsProvider.");
  }

  const ownerRef = useRef<symbol | null>(null);
  const primaryStoreRef = useRef<HeaderPrimaryStore | null>(null);
  const latestOverflowRef = useRef<ActionMenuItem[]>(actions.overflow ?? EMPTY_OVERFLOW);
  const registeredOverflowRef = useRef<ActionMenuItem[]>(EMPTY_OVERFLOW);
  const stableOverflowRef = useRef<ActionMenuItem[] | null>(null);
  const registeredHasPrimaryRef = useRef(false);
  const overflow = actions.overflow ?? EMPTY_OVERFLOW;
  latestOverflowRef.current = overflow;
  if (!stableOverflowRef.current || !sameActionMenuShape(stableOverflowRef.current, overflow)) {
    stableOverflowRef.current = createStableOverflow(overflow, latestOverflowRef);
  }
  if (!ownerRef.current) {
    ownerRef.current = Symbol("webapp-header-actions");
  }
  if (!primaryStoreRef.current) {
    primaryStoreRef.current = createHeaderPrimaryStore(actions.primary ?? EMPTY_PRIMARY);
  }

  useEffect(() => {
    const owner = ownerRef.current;
    const primaryStore = primaryStoreRef.current;
    if (!owner || !primaryStore) {
      return;
    }
    const stableOverflow = stableOverflowRef.current ?? EMPTY_OVERFLOW;
    const hasPrimary = hasPrimaryAction(actions.primary);
    registeredOverflowRef.current = stableOverflow;
    registeredHasPrimaryRef.current = hasPrimary;
    context.register(owner, {
      primary: primaryStore,
      hasPrimary,
      overflow: stableOverflow,
    });
    return () => context.unregister(owner);
  }, [context]);

  useLayoutEffect(() => {
    const primaryStore = primaryStoreRef.current;
    if (!primaryStore) {
      return;
    }
    primaryStore.value = actions.primary ?? EMPTY_PRIMARY;
    notify(primaryStore.listeners);
  }, [actions.primary]);

  useEffect(() => {
    const owner = ownerRef.current;
    const primaryStore = primaryStoreRef.current;
    if (!owner || !primaryStore) {
      return;
    }
    const stableOverflow = stableOverflowRef.current ?? EMPTY_OVERFLOW;
    const hasPrimary = hasPrimaryAction(actions.primary);
    if (
      hasPrimary === registeredHasPrimaryRef.current
      && sameActionMenuShape(registeredOverflowRef.current, overflow)
    ) {
      return;
    }
    registeredOverflowRef.current = stableOverflow;
    registeredHasPrimaryRef.current = hasPrimary;
    context.update(owner, {
      primary: primaryStore,
      hasPrimary,
      overflow: stableOverflow,
    });
  }, [actions.primary, context, overflow]);
}

export function useHeaderActionsSnapshot(): HeaderActionsSnapshot {
  const snapshot = useContext(HeaderActionsSnapshotContext);
  if (!snapshot) {
    throw new Error("useHeaderActionsSnapshot must be used within HeaderActionsProvider.");
  }
  return snapshot;
}
