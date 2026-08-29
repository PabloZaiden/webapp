import { useCallback, useEffect, useMemo, useState } from "react";
import type { SidebarNode, WebAppRoute } from "./sidebar/types";
import { readStorage, warnStorageIssue, writeStorage } from "./storage";

export type StoredSidebarPin = {
  id: string;
  title: string;
  subtitle?: string;
  badge?: string;
  badgeVariant?: SidebarNode["badgeVariant"];
  badgeAppearance?: SidebarNode["badgeAppearance"];
  itemLayout?: SidebarNode["itemLayout"];
  route: WebAppRoute;
};

export type SidebarCollapsedState = Record<string, boolean>;

type SidebarBadgeVariant = Exclude<SidebarNode["badgeVariant"], undefined>;

const SIDEBAR_BADGE_VARIANTS: readonly SidebarBadgeVariant[] = [
  "default",
  "success",
  "warning",
  "error",
  "info",
  "disabled",
  "idle",
  "planning",
  "running",
  "completed",
  "stopped",
  "failed",
  "merged",
  "pushed",
  "deleted",
  "plan_ready",
];

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
  return explicitKey ?? `webapp.${appName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.sidebar.pins`;
}

function sidebarCollapsedStorageKey(appName: string): string {
  return `webapp.${appName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.sidebar.collapsed`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStoredRoute(value: unknown): WebAppRoute | undefined {
  if (!isRecord(value) || typeof value["view"] !== "string") {
    return undefined;
  }

  const route: WebAppRoute = { view: value["view"] };
  for (const [key, entry] of Object.entries(value)) {
    if (key !== "view" && typeof entry === "string") {
      route[key] = entry;
    }
  }
  return route;
}

function isSidebarBadgeVariant(value: unknown): value is SidebarBadgeVariant {
  return typeof value === "string" && SIDEBAR_BADGE_VARIANTS.some((variant) => variant === value);
}

function parseStoredPin(value: unknown): StoredSidebarPin | undefined {
  if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["title"] !== "string") {
    return undefined;
  }
  const route = parseStoredRoute(value["route"]);
  if (!route) {
    return undefined;
  }

  const subtitle = value["subtitle"];
  const badge = value["badge"];
  const badgeVariant = value["badgeVariant"];
  const badgeAppearance = value["badgeAppearance"];
  const itemLayout = value["itemLayout"];
  if (subtitle !== undefined && typeof subtitle !== "string") return undefined;
  if (badge !== undefined && typeof badge !== "string") return undefined;
  if (badgeVariant !== undefined && !isSidebarBadgeVariant(badgeVariant)) return undefined;
  if (badgeAppearance !== undefined && badgeAppearance !== "dot" && badgeAppearance !== "text") return undefined;
  if (itemLayout !== undefined && itemLayout !== "default" && itemLayout !== "subtitle-above-title") return undefined;

  const pin: StoredSidebarPin = {
    id: value["id"],
    title: value["title"],
    route,
  };
  if (typeof subtitle === "string") pin.subtitle = subtitle;
  if (typeof badge === "string") pin.badge = badge;
  if (isSidebarBadgeVariant(badgeVariant)) pin.badgeVariant = badgeVariant;
  if (badgeAppearance === "dot" || badgeAppearance === "text") pin.badgeAppearance = badgeAppearance;
  if (itemLayout === "default" || itemLayout === "subtitle-above-title") pin.itemLayout = itemLayout;
  return pin;
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

function routesEqual(left: WebAppRoute, right: WebAppRoute): boolean {
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
};

export function useSidebarPins(appName: string, storageKey: string | undefined, options: SidebarPinsOptions) {
  const key = pinStorageKey(appName, storageKey);
  const [pins, setPins] = useState<StoredSidebarPin[]>(() => readStoredPins(key));
  const ready = options.enabled && options.ready;
  const currentPins = useMemo(
    () => ready ? reconcileStoredPins(pins, options.nodes) : pins,
    [options.nodes, pins, ready],
  );

  useEffect(() => {
    if (!ready) {
      return;
    }
    if (currentPins !== pins) {
      setPins(currentPins);
    }
    const encoded = encodeStoredPins(currentPins);
    if (encoded === undefined) {
      warnStorageIssue(key, "write-failed");
      return;
    }
    writeStorage(key, encoded);
  }, [currentPins, key, pins, ready]);

  const pinIds = useMemo(() => new Set(currentPins.map((pin) => pin.id)), [currentPins]);
  const pin = useCallback((node: SidebarNode) => {
    if (!ready) {
      return;
    }
    const stored = toStoredPin(node);
    if (!stored) {
      return;
    }
    setPins((current) => [...current.filter((item) => item.id !== stored.id), stored]);
  }, [ready]);
  const unpin = useCallback((id: string) => {
    if (!ready) {
      return;
    }
    setPins((current) => current.filter((item) => item.id !== id));
  }, [ready]);

  return { pins: currentPins, pinIds, pin, unpin };
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
      warnStorageIssue(key, "write-failed");
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
