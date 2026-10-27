import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ThemePreference } from "../contracts";
import { isDestructiveActionMenuItem, submitActionMenuForm } from "./action-menu-item";
import type { ActionMenuItem } from "./sidebar/types";
import { useToast } from "./toast";
import { useBlockingOverlay } from "./overlay";

export interface NativeToolbarItem {
  id: string;
  label: string;
  systemImage?: string;
  disabled: boolean;
  active: boolean;
  busy: boolean;
  destructive: boolean;
}

export interface NativeToolbarSnapshot {
  version: 1;
  scope: string;
  theme: ThemePreference;
  sidebar: NativeToolbarItem[];
  primary: NativeToolbarItem[];
  menu: NativeToolbarItem[];
}

export interface NativeToolbarHost {
  update(snapshot: NativeToolbarSnapshot | null): Promise<boolean>;
  subscribe(listener: () => void): () => void;
  setActionHandler(handler: (scope: string, id: string) => void | Promise<void>): () => void;
}

declare global {
  interface Window {
    webappNativeToolbar?: NativeToolbarHost;
  }
}

export interface NativeToolbarAction extends NativeToolbarItem {
  invoke: () => unknown;
}

const publications = new WeakMap<NativeToolbarHost, Promise<boolean>>();

function publishToolbar(host: NativeToolbarHost, snapshot: NativeToolbarSnapshot | null): Promise<boolean> {
  const previous = publications.get(host);
  const update = () => host.update(snapshot);
  // Each caller reports its own failure; a failed update must not block later publications.
  const next = previous ? previous.then(update, update) : Promise.resolve().then(update);
  publications.set(host, next);
  return next;
}

export function nativeMenuAction(item: ActionMenuItem & { systemImage?: string; loading?: boolean }, id: string): NativeToolbarAction {
  return {
    id, label: item.label, systemImage: item.systemImage,
    disabled: item.disabled === true, active: false, busy: item.loading === true,
    destructive: isDestructiveActionMenuItem(item),
    invoke: () => {
      if (item.form !== undefined) submitActionMenuForm(item);
      else return item.onAction();
    },
  };
}

export function useNativeToolbar(routeKey: string, theme: ThemePreference, actions: {
  sidebar: NativeToolbarAction[];
  primary: NativeToolbarAction[];
  menu: NativeToolbarAction[];
  sidebarRef: RefObject<HTMLElement | null>;
}): boolean {
  const host = typeof window === "undefined" ? undefined : window.webappNativeToolbar;
  const scope = useMemo(() => host ? crypto.randomUUID() : "", [host, routeKey]);
  const { error: notifyError } = useToast();
  const [active, setActive] = useState(false);
  const blocked = useBlockingOverlay(actions.sidebarRef);
  const registry = useRef({ scope, blocked, items: new Map<string, NativeToolbarAction>() });
  registry.current = {
    scope, blocked,
    items: new Map([...actions.sidebar, ...actions.primary, ...actions.menu].map((item) => [item.id, item])),
  };
  const describe = (items: NativeToolbarAction[]): NativeToolbarItem[] => items.map(({ invoke, ...item }) => ({
    ...item, disabled: item.disabled || blocked,
  }));
  const snapshot: NativeToolbarSnapshot = {
    version: 1, scope, theme,
    sidebar: describe(actions.sidebar), primary: describe(actions.primary),
    menu: describe([...actions.menu.filter((item) => !item.destructive), ...actions.menu.filter((item) => item.destructive)]),
  };
  const currentSnapshot = useRef(snapshot);
  currentSnapshot.current = snapshot;
  const serialized = JSON.stringify(snapshot);

  useEffect(() => {
    if (!host) return;
    const removeHandler = host.setActionHandler(async (scope, id) => {
      const current = registry.current;
      const item = current.items.get(id);
      if (scope !== current.scope || !item) throw new Error("This toolbar action is no longer available.");
      if (current.blocked || item.disabled || item.busy) throw new Error("This toolbar action is disabled.");
      await item.invoke();
    });
    return () => {
      removeHandler();
      void publishToolbar(host, null).catch((error: unknown) => notifyError(`Unable to clear the native toolbar: ${String(error)}`));
    };
  }, [host, notifyError]);

  useEffect(() => {
    if (!host) return;
    let disposed = false;
    let generation = 0;
    const publish = () => {
      const request = ++generation;
      void publishToolbar(host, currentSnapshot.current).then((supported) => {
        if (!disposed && request === generation) setActive(supported);
      }).catch((error: unknown) => {
        if (!disposed && request === generation) {
          setActive(false);
          notifyError(`Unable to present the native toolbar: ${String(error)}`);
        }
      });
    };
    const unsubscribe = host.subscribe(publish);
    publish();
    return () => { disposed = true; unsubscribe(); };
  }, [host, serialized, notifyError]);

  return active;
}
