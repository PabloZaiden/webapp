import { useEffect, useMemo, useReducer, useRef, useState, type RefObject } from "react";
import type { ThemePreference } from "../contracts";
import { isDestructiveActionMenuItem, submitActionMenuForm } from "./action-menu-item";
import type { ActionMenuItem } from "./sidebar/types";
import { useToast } from "./toast";
import { useBlockingOverlay } from "./overlay";

export interface NativeToolbarItem {
  id: string;
  label: string;
  systemImage?: string;
  imageURL?: string;
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

let lastPublication: Promise<boolean> | undefined;

function publishToolbar(host: NativeToolbarHost, snapshot: NativeToolbarSnapshot | null): Promise<boolean> {
  const previous = lastPublication;
  const update = async () => {
    try {
      return await host.update(snapshot);
    } catch (error) {
      if (snapshot !== null) {
        try {
          await host.update(null);
        } catch (clearError) {
          throw new AggregateError([error, clearError], `Unable to revoke native controls: ${String(error)}; ${String(clearError)}`);
        }
      }
      throw error;
    }
  };
  // Replacement adapters can address the same native toolbar. Each caller reports its own failure.
  const next = previous ? previous.then(update, update) : Promise.resolve().then(update);
  lastPublication = next;
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
  const [activeScope, setActiveScope] = useState<string>();
  const [, refreshHost] = useReducer((version: number) => version + 1, 0);
  const blocked = useBlockingOverlay(actions.sidebarRef);
  const pageBlocked = useBlockingOverlay();
  const block = (items: NativeToolbarAction[], disabled: boolean) => items.map((item) => ({
    ...item, disabled: item.disabled || disabled,
  }));
  const sidebar = block(actions.sidebar, blocked);
  const primary = block(actions.primary, pageBlocked);
  const menu = block(actions.menu, pageBlocked);
  const registry = useRef({ scope, items: new Map<string, NativeToolbarAction>() });
  registry.current = {
    scope,
    items: new Map([...sidebar, ...primary, ...menu].map((item) => [item.id, item])),
  };
  const describe = (items: NativeToolbarAction[]): NativeToolbarItem[] => items.map(({ invoke, ...item }) => item);
  const snapshot: NativeToolbarSnapshot = {
    version: 1, scope, theme,
    sidebar: describe(sidebar), primary: describe(primary),
    menu: describe([...menu.filter((item) => !item.destructive), ...menu.filter((item) => item.destructive)]),
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
      if (item.disabled || item.busy) throw new Error("This toolbar action is disabled.");
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
      if (window.webappNativeToolbar !== host) {
        refreshHost();
        return;
      }
      const request = ++generation;
      const published = currentSnapshot.current;
      void publishToolbar(host, published).then((supported) => {
        if (!disposed && request === generation) setActiveScope(supported ? published.scope : undefined);
      }).catch((error: unknown) => {
        if (!disposed && request === generation) {
          setActiveScope(undefined);
          notifyError(`Unable to present the native toolbar: ${String(error)}`);
        }
      });
    };
    const unsubscribe = host.subscribe(publish);
    publish();
    return () => { disposed = true; unsubscribe(); };
  }, [host, serialized, notifyError]);

  return host !== undefined && activeScope === scope;
}
