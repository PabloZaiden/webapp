import { useCallback, useEffect, useMemo, useState } from "react";
import type { SidebarNode, WebAppRoute } from "./sidebar/types";

export type StoredSidebarPin = {
  id: string;
  title: string;
  subtitle?: string;
  badge?: string;
  badgeVariant?: SidebarNode["badgeVariant"];
  route: WebAppRoute;
};

export type SidebarCollapsedState = Record<string, boolean>;

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

export function toStoredPin(node: SidebarNode): StoredSidebarPin | undefined {
  if (!node.route) {
    return undefined;
  }
  return {
    id: node.pinId ?? node.id,
    title: node.title,
    subtitle: node.subtitle,
    badge: node.badge,
    badgeVariant: node.badgeVariant,
    route: node.route,
  };
}

export function useSidebarPins(appName: string, storageKey?: string) {
  const key = pinStorageKey(appName, storageKey);
  const [pins, setPins] = useState<StoredSidebarPin[]>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) as StoredSidebarPin[] : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(pins));
  }, [key, pins]);

  const pinIds = useMemo(() => new Set(pins.map((pin) => pin.id)), [pins]);
  const pin = useCallback((node: SidebarNode) => {
    const stored = toStoredPin(node);
    if (!stored) {
      return;
    }
    setPins((current) => [...current.filter((item) => item.id !== stored.id), stored]);
  }, []);
  const unpin = useCallback((id: string) => {
    setPins((current) => current.filter((item) => item.id !== id));
  }, []);

  return { pins, pinIds, pin, unpin };
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
