import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SidebarNode, SidebarPin, SidebarPinProvider } from "./sidebar/types";
import { readStorage, warnStorageIssue, writeStorage } from "./storage";
import { clientScopedStorageKey } from "./preferences";
import { sidebarPinSchema } from "../contracts/sidebar-pins";
import { useLiveQuery } from "./realtime/useLiveQuery";

export type StoredSidebarPin = SidebarPin;

export type SidebarCollapsedState = Record<string, boolean>;

type StorageDecode<T> = {
  value: T;
  valid: boolean;
};

export function flattenSidebarItems(nodes: SidebarNode[]): SidebarNode[] {
  return nodes.flatMap((node) => [
    node,
    ...(node.children ? flattenSidebarItems(node.children) : []),
  ]).filter((node) => node.type === "item");
}

function pinStorageKey(appName: string, explicitKey?: string): string {
  return clientScopedStorageKey(explicitKey ?? `webapp.${appName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.sidebar.pins`);
}

function sidebarCollapsedStorageKey(appName: string): string {
  return clientScopedStorageKey(`webapp.${appName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.sidebar.collapsed`);
}

function sidebarDesktopCollapsedStorageKey(appName: string): string {
  return `webapp.${appName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.sidebar.desktop-collapsed`;
}

function isSidebarCollapsedState(value: unknown): value is SidebarCollapsedState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "boolean");
}

function decodeStoredCollapsedState(raw: string | null): StorageDecode<SidebarCollapsedState> {
  if (raw === null) {
    return { value: {}, valid: true };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isSidebarCollapsedState(parsed)
      ? { value: parsed, valid: true }
      : { value: {}, valid: false };
  } catch {
    return { value: {}, valid: false };
  }
}

function decodeStoredBoolean(raw: string | null): StorageDecode<boolean> {
  if (raw === null) {
    return { value: false, valid: true };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "boolean"
      ? { value: parsed, valid: true }
      : { value: false, valid: false };
  } catch {
    return { value: false, valid: false };
  }
}

function encodeStoredCollapsedState(value: SidebarCollapsedState): string | undefined {
  if (!isSidebarCollapsedState(value)) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function parseStoredPin(value: unknown): StoredSidebarPin | undefined {
  const parsed = sidebarPinSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function decodeStoredPins(raw: string | null): StorageDecode<StoredSidebarPin[]> {
  if (raw === null) {
    return { value: [], valid: true };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { value: [], valid: false };
  }
  if (!Array.isArray(parsed)) {
    return { value: [], valid: false };
  }

  let valid = true;
  const pins: StoredSidebarPin[] = [];
  for (const value of parsed) {
    const pin = parseStoredPin(value);
    if (!pin) {
      valid = false;
      continue;
    }
    pins.push(pin);
  }
  return { value: pins, valid };
}

function encodeStoredPins(pins: StoredSidebarPin[]): string | undefined {
  try {
    const canonicalPins = pins.map((pin) => parseStoredPin(pin));
    if (canonicalPins.some((pin) => !pin)) {
      return undefined;
    }
    return JSON.stringify(canonicalPins);
  } catch {
    return undefined;
  }
}

function readStoredPins(key: string): StoredSidebarPin[] {
  const result = readStorage(key);
  if (!result.ok) {
    return [];
  }
  const decoded = decodeStoredPins(result.value);
  if (!decoded.valid) {
    warnStorageIssue(key, "invalid-value");
  }
  return decoded.value;
}

function writeStoredPins(key: string, pins: SidebarPin[]): boolean {
  const encoded = encodeStoredPins(pins);
  if (encoded === undefined) throw new Error("Could not encode sidebar pins.");
  const result = writeStorage(key, encoded);
  return result.ok;
}

function createLocalPinProvider(key: string) {
  let memoryPins: SidebarPin[] | undefined;
  const read = () => memoryPins ?? readStoredPins(key);
  const write = (pins: SidebarPin[]) => {
    memoryPins = pins;
    if (writeStoredPins(key, pins)) memoryPins = undefined;
  };
  return {
    async load(signal: AbortSignal) {
      signal.throwIfAborted();
      return read();
    },
    async add(pin: SidebarPin, signal: AbortSignal) {
      signal.throwIfAborted();
      write([...read().filter((item) => item.id !== pin.id), pin]);
    },
    async remove(id: string, signal: AbortSignal) {
      signal.throwIfAborted();
      write(read().filter((pin) => pin.id !== id));
    },
    async reconcile(pins: SidebarPin[], signal: AbortSignal) {
      signal.throwIfAborted();
      write(pins);
    },
    subscribe(invalidate: () => void) {
      const onStorage = (event: StorageEvent) => {
        if (event.key === key || event.key === null) invalidate();
      };
      window.addEventListener("storage", onStorage);
      return () => window.removeEventListener("storage", onStorage);
    },
  } satisfies SidebarPinProvider & {
    reconcile(pins: SidebarPin[], signal: AbortSignal): Promise<void>;
  };
}

export function toStoredPin(node: SidebarNode): StoredSidebarPin | undefined {
  if (node.type !== "item" || !node.route) {
    return undefined;
  }
  return {
    id: node.pinId ?? node.id,
    title: node.title,
    subtitle: node.subtitle,
    badge: node.badge,
    badgeVariant: node.badgeVariant,
    badgeAppearance: node.badgeAppearance,
    itemLayout: node.itemLayout,
    route: node.route,
  };
}

function routesEqual(left: SidebarPin["route"], right: SidebarPin["route"]): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => left[key] === right[key]);
}

function storedPinsEqual(left: StoredSidebarPin, right: StoredSidebarPin): boolean {
  return left.id === right.id
    && left.title === right.title
    && left.subtitle === right.subtitle
    && left.badge === right.badge
    && left.badgeVariant === right.badgeVariant
    && left.badgeAppearance === right.badgeAppearance
    && left.itemLayout === right.itemLayout
    && routesEqual(left.route, right.route);
}

function reconcileStoredPins(pins: StoredSidebarPin[], nodes: SidebarNode[]): StoredSidebarPin[] {
  const currentById = new Map<string, StoredSidebarPin>();
  for (const node of nodes) {
    if (!node.pinnable) {
      continue;
    }
    const current = toStoredPin(node);
    if (current) {
      currentById.set(current.id, current);
    }
  }

  const seen = new Set<string>();
  const reconciled: StoredSidebarPin[] = [];
  let changed = false;
  for (const pin of pins) {
    if (seen.has(pin.id)) {
      changed = true;
      continue;
    }
    seen.add(pin.id);
    const current = currentById.get(pin.id);
    if (!current) {
      changed = true;
      continue;
    }
    if (!storedPinsEqual(pin, current)) {
      changed = true;
      reconciled.push(current);
    } else {
      reconciled.push(pin);
    }
  }
  return changed ? reconciled : pins;
}

type SidebarPinsOptions = {
  enabled: boolean;
  ready: boolean;
  nodes: SidebarNode[];
  provider?: SidebarPinProvider;
};

export function useSidebarPins(appName: string, storageKey: string | undefined, options: SidebarPinsOptions) {
  const key = pinStorageKey(appName, storageKey);
  const local = useMemo(() => createLocalPinProvider(key), [key]);
  const provider = options.provider ?? local;
  const owner = useRef(provider);
  owner.current = provider;
  const [saveError, setSaveError] = useState<Error>();
  const query = useLiveQuery({
    load: async (signal) => sidebarPinSchema.array().parse(await provider.load(signal)),
    deps: [provider],
    enabled: options.enabled,
  });
  const pins = query.data;
  const ready = options.enabled && options.ready && pins !== undefined && !query.loading && !query.error && !saveError;
  const currentPins = useMemo(
    () => pins
      ? options.ready || options.provider ? reconcileStoredPins(pins, options.nodes) : pins
      : [],
    [options.nodes, options.provider, options.ready, pins],
  );

  useEffect(() => provider.subscribe?.(() => { void query.refresh(); }), [provider, query.refresh]);
  useEffect(() => { setSaveError(undefined); }, [provider]);

  const mutate = useCallback(async (operation: (signal: AbortSignal) => Promise<void>) => {
    try {
      await query.mutate(operation);
    } catch (error) {
      // Reloading after an uncertain mutation must not hide its failure.
      if (owner.current === provider) {
        setSaveError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }, [provider, query.mutate]);

  useEffect(() => {
    if (!options.provider && ready && currentPins !== pins) {
      void mutate((signal) => local.reconcile(currentPins, signal));
    }
  }, [currentPins, local, mutate, options.provider, pins, ready]);

  const pinIds = useMemo(() => new Set(pins?.map((pin) => pin.id)), [pins]);
  const pin = useCallback((node: SidebarNode) => {
    if (!ready) {
      return;
    }
    const stored = toStoredPin(node);
    if (!stored) {
      return;
    }
    void mutate((signal) => provider.add(stored, signal));
  }, [mutate, provider, ready]);
  const unpin = useCallback((id: string) => {
    if (!ready) {
      return;
    }
    void mutate((signal) => provider.remove(id, signal));
  }, [mutate, provider, ready]);

  const retry = useCallback(() => {
    setSaveError(undefined);
    return query.refresh();
  }, [query.refresh]);
  return { pins: currentPins, pinIds, pin, unpin, ready, loading: query.loading && !pins, error: saveError ?? query.error, retry };
}

export function useSidebarCollapsedState(appName: string) {
  const key = sidebarCollapsedStorageKey(appName);
  const [collapsed, setCollapsed] = useState<SidebarCollapsedState>(() => {
    const result = readStorage(key);
    if (!result.ok) {
      return {};
    }
    const decoded = decodeStoredCollapsedState(result.value);
    if (!decoded.valid) {
      warnStorageIssue(key, "invalid-value");
    }
    return decoded.value;
  });

  useEffect(() => {
    const encoded = encodeStoredCollapsedState(collapsed);
    if (encoded === undefined) {
      warnStorageIssue(key, "encoding-failed");
      return;
    }
    writeStorage(key, encoded);
  }, [key, collapsed]);

  const toggleCollapsed = useCallback((id: string, isCollapsed: boolean) => {
    setCollapsed((current) => {
      const currentIsCollapsed = current[id] ?? isCollapsed;
      return { ...current, [id]: !currentIsCollapsed };
    });
  }, []);

  return { collapsed, toggleCollapsed };
}

export function useSidebarDesktopCollapsedState(appName: string) {
  const key = sidebarDesktopCollapsedStorageKey(appName);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    const result = readStorage(key);
    if (!result.ok) {
      return false;
    }
    const decoded = decodeStoredBoolean(result.value);
    if (!decoded.valid) {
      warnStorageIssue(key, "invalid-value");
    }
    return decoded.value;
  });

  useEffect(() => {
    writeStorage(key, JSON.stringify(collapsed));
  }, [collapsed, key]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => !current);
  }, []);

  return { collapsed, toggleCollapsed, setCollapsed };
}

function sidebarTabStorageKey(appName: string): string {
  return `webapp.${appName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.sidebar.tab`;
}

function decodeStoredTab(raw: string | null, tabs: Array<{ id: string }>): StorageDecode<string | undefined> {
  if (raw === null) {
    return { value: undefined, valid: true };
  }
  return raw.length > 0 && tabs.some((tab) => tab.id === raw)
    ? { value: raw, valid: true }
    : { value: undefined, valid: false };
}

export function useSidebarTab(appName: string, tabs: Array<{ id: string }>) {
  const key = sidebarTabStorageKey(appName);
  const [selectedTabId, setSelectedTabId] = useState<string | undefined>(() => {
    const result = readStorage(key);
    if (!result.ok) {
      return undefined;
    }
    const decoded = decodeStoredTab(result.value, tabs);
    if (!decoded.valid) {
      warnStorageIssue(key, "invalid-value");
    }
    return decoded.value;
  });
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === selectedTabId)?.id ?? tabs[0]?.id,
    [selectedTabId, tabs],
  );

  useEffect(() => {
    if (activeTab) {
      writeStorage(key, activeTab);
    }
  }, [activeTab, key]);

  const selectTab = useCallback((id: string) => {
    if (tabs.some((tab) => tab.id === id)) {
      setSelectedTabId(id);
    }
  }, [tabs]);

  return { activeTab, selectTab };
}
