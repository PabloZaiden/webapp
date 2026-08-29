import { useCallback, useEffect, useMemo, useState } from "react";
import type { SidebarNode, WebAppRoute } from "./sidebar/types";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWebAppRoute(value: unknown): value is WebAppRoute {
  return isRecord(value)
    && typeof value["view"] === "string"
    && Object.values(value).every((entry) => entry === undefined || typeof entry === "string");
}

function isSidebarBadgeVariant(value: unknown): value is SidebarBadgeVariant {
  return typeof value === "string" && SIDEBAR_BADGE_VARIANTS.includes(value as SidebarBadgeVariant);
}

function parseStoredPin(value: unknown): StoredSidebarPin | undefined {
  if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["title"] !== "string" || !isWebAppRoute(value["route"])) {
    return undefined;
  }

  const pin: StoredSidebarPin = {
    id: value["id"],
    title: value["title"],
    route: value["route"],
  };
  if (typeof value["subtitle"] === "string") pin.subtitle = value["subtitle"];
  if (typeof value["badge"] === "string") pin.badge = value["badge"];
  if (isSidebarBadgeVariant(value["badgeVariant"])) pin.badgeVariant = value["badgeVariant"];
  if (value["badgeAppearance"] === "dot" || value["badgeAppearance"] === "text") pin.badgeAppearance = value["badgeAppearance"];
  if (value["itemLayout"] === "default" || value["itemLayout"] === "subtitle-above-title") pin.itemLayout = value["itemLayout"];
  return pin;
}

function readStoredPins(key: string): StoredSidebarPin[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.flatMap((value) => {
      const pin = parseStoredPin(value);
      return pin ? [pin] : [];
    }) : [];
  } catch {
    return [];
  }
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
    localStorage.setItem(key, JSON.stringify(currentPins));
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
    try {
      const raw = localStorage.getItem(key);
      if (!raw) {
        return {};
      }
      const parsed: unknown = JSON.parse(raw);
      return isSidebarCollapsedState(parsed) ? parsed : {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(collapsed));
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

export function useSidebarTab(appName: string, tabs: Array<{ id: string }>) {
  const key = sidebarTabStorageKey(appName);
  const [selectedTabId, setSelectedTabId] = useState<string | undefined>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored || undefined;
    } catch {
      return undefined;
    }
  });
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === selectedTabId)?.id ?? tabs[0]?.id,
    [selectedTabId, tabs],
  );

  useEffect(() => {
    if (activeTab) {
      localStorage.setItem(key, activeTab);
    }
  }, [activeTab, key]);

  const selectTab = useCallback((id: string) => {
    if (tabs.some((tab) => tab.id === id)) {
      setSelectedTabId(id);
    }
  }, [tabs]);

  return { activeTab, selectTab };
}
