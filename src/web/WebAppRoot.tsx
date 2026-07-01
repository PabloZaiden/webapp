import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { ApiKeySummary, AuthSessionSummary, CreatedApiKeyResponse, CreatedUserResponse, DeviceVerificationDetails, PasskeyAuthStatusResponse, ThemePreference, UserSetupDetails, WebAppConfigResponse, WebAppUserRole, WebAppUserSummary } from "../contracts";
import { ActionMenu, Badge, Button, ConfirmDialog, ContextMenu, DangerZone, Dialog, EmptyState, FormSection, IconButton, Panel, SelectField, TextField, type ContextMenuPosition } from "./components";
import type { ActionMenuItem, SidebarAction, SidebarBuildContext, SidebarNode, WebAppRoute } from "./sidebar/types";

type SettingsSection = {
  id: string;
  title: string;
  description?: string;
  scope?: "user" | "admin" | "owner";
  rows?: SettingsRow[];
  render?: () => ReactNode;
};

type SettingsRow = {
  id: string;
  title: string;
  description?: string;
  scope?: "user" | "admin" | "owner";
  content?: ReactNode;
  actions?: ReactNode | SettingsAction[];
  danger?: boolean;
};

type SettingsAction = {
  id: string;
  label: string;
  variant?: "default" | "primary" | "danger" | "ghost";
  disabled?: boolean;
  onAction: () => void;
};

type HeaderContext = {
  route: WebAppRoute;
  defaultTitle: string;
};

export interface WebAppRootProps {
  appName: string;
  homeRoute: WebAppRoute;
  sidebar: {
    search?: boolean;
    topActions?: SidebarAction[];
    pinning?: false | {
      sectionTitle?: string;
      storageKey?: string;
    };
    getNodes: (ctx: SidebarBuildContext) => SidebarNode[];
  };
  routes: Record<string, ReactNode | ((route: WebAppRoute) => ReactNode)>;
  header?: {
    renderTitle?: (ctx: HeaderContext) => ReactNode;
    renderActions?: (ctx: HeaderContext) => ReactNode;
    getActions?: (ctx: HeaderContext) => ActionMenuItem[];
  };
  onRouteChange?: (route: WebAppRoute) => void;
  settings?: {
    sections?: SettingsSection[];
  };
  version?: string;
}

type StoredSidebarPin = {
  id: string;
  title: string;
  subtitle?: string;
  badge?: string;
  badgeVariant?: SidebarNode["badgeVariant"];
  route: WebAppRoute;
};

type SidebarCollapsedState = Record<string, boolean>;

function isSidebarShortcutEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable || target.closest("[contenteditable=''], [contenteditable='true']")) {
    return true;
  }
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement;
}

function routeToHash(route: WebAppRoute): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(route)) {
    if (key !== "view" && value !== undefined) {
      params.set(key, String(value));
    }
  }
  return `#/${route.view}${params.size ? `?${params.toString()}` : ""}`;
}

function parseRoute(defaultRoute: WebAppRoute): WebAppRoute {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (!hash) return defaultRoute;
  const [view = defaultRoute.view, query = ""] = hash.split("?", 2);
  const params = Object.fromEntries(new URLSearchParams(query).entries());
  return { view: view.replace(/^\//, ""), ...params };
}

function useRoute(defaultRoute: WebAppRoute) {
  const [route, setRoute] = useState(() => parseRoute(defaultRoute));
  useEffect(() => {
    const listener = () => setRoute(parseRoute(defaultRoute));
    window.addEventListener("hashchange", listener);
    return () => window.removeEventListener("hashchange", listener);
  }, [defaultRoute]);
  const navigate = useCallback((next: WebAppRoute) => {
    window.location.hash = routeToHash(next);
    setRoute(next);
  }, []);
  return { route, navigate };
}

function useMobileViewportHeight() {
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const root = document.documentElement;
    const mobileQuery = window.matchMedia("(max-width: 900px)");
    const viewport = window.visualViewport;
    const timers = new Set<number>();
    let frame = 0;

    const clearViewportHeight = () => {
      root.style.removeProperty("--wapp-viewport-height");
    };

    const sync = () => {
      frame = 0;
      if (!mobileQuery.matches) {
        clearViewportHeight();
        return;
      }

      const height = Math.round(viewport?.height ?? window.innerHeight);
      if (height > 0) {
        root.style.setProperty("--wapp-viewport-height", `${height}px`);
      }

      const scrollingElement = document.scrollingElement;
      if (scrollingElement && scrollingElement.scrollTop !== 0) {
        scrollingElement.scrollTop = 0;
      }
    };

    const scheduleSync = () => {
      if (frame) {
        return;
      }
      frame = requestAnimationFrame(sync);
    };

    const scheduleDelayedSync = (delay: number) => {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        scheduleSync();
      }, delay);
      timers.add(timer);
    };

    const handleKeyboardBoundary = () => {
      scheduleSync();
      scheduleDelayedSync(120);
      scheduleDelayedSync(320);
    };

    scheduleSync();
    viewport?.addEventListener("resize", scheduleSync);
    viewport?.addEventListener("scroll", scheduleSync);
    window.addEventListener("resize", scheduleSync);
    mobileQuery.addEventListener("change", scheduleSync);
    document.addEventListener("focusin", handleKeyboardBoundary);
    document.addEventListener("focusout", handleKeyboardBoundary);

    return () => {
      if (frame) {
        cancelAnimationFrame(frame);
      }
      for (const timer of timers) {
        clearTimeout(timer);
      }
      viewport?.removeEventListener("resize", scheduleSync);
      viewport?.removeEventListener("scroll", scheduleSync);
      window.removeEventListener("resize", scheduleSync);
      mobileQuery.removeEventListener("change", scheduleSync);
      document.removeEventListener("focusin", handleKeyboardBoundary);
      document.removeEventListener("focusout", handleKeyboardBoundary);
      clearViewportHeight();
    };
  }, []);
}

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { message?: string; error?: string };
    throw new Error(data.message ?? data.error ?? `Request failed with ${response.status}`);
  }
  return await response.json() as T;
}

function useConfig() {
  const [config, setConfig] = useState<WebAppConfigResponse>();
  const [error, setError] = useState<string>();
  const refresh = useCallback(async () => {
    try {
      setConfig(await json<WebAppConfigResponse>("/api/config"));
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);
  return { config, error, refresh };
}

function useTheme() {
  const [theme, setTheme] = useState<ThemePreference>(() => (localStorage.getItem("webapp.theme") as ThemePreference | null) ?? "system");
  useEffect(() => {
    const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("webapp.theme", theme);
  }, [theme]);
  return { theme, setTheme };
}

function routeMatches(left: WebAppRoute | undefined, right: WebAppRoute): boolean {
  if (!left) return false;
  return left.view === right.view && Object.entries(left).every(([key, value]) => key === "view" || right[key] === value);
}

function flattenSidebarItems(nodes: SidebarNode[]): SidebarNode[] {
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

function toStoredPin(node: SidebarNode): StoredSidebarPin | undefined {
  if (!node.route) return undefined;
  return {
    id: node.pinId ?? node.id,
    title: node.title,
    subtitle: node.subtitle,
    badge: node.badge,
    badgeVariant: node.badgeVariant,
    route: node.route,
  };
}

function useSidebarPins(appName: string, storageKey?: string) {
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
    if (!stored) return;
    setPins((current) => [...current.filter((item) => item.id !== stored.id), stored]);
  }, []);
  const unpin = useCallback((id: string) => {
    setPins((current) => current.filter((item) => item.id !== id));
  }, []);

  return { pins, pinIds, pin, unpin };
}

function useSidebarCollapsedState(appName: string) {
  const key = sidebarCollapsedStorageKey(appName);
  const [collapsed, setCollapsed] = useState<SidebarCollapsedState>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return {};
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

function Icon({ name }: { name: "settings" | "sidebar" | "plus" | "home" | "search" | "bolt" | "chat" | "code" | "refresh" }) {
  const common = { "aria-hidden": true, viewBox: "0 0 24 24", className: "wapp-svg" };
  if (name === "settings") return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 .6 1.65 1.65 0 0 0-.33 1.82V22a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-.6-1 1.65 1.65 0 0 0-1.82-.33H2a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-.6 1.65 1.65 0 0 0 .33-1.82V2a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.33.34.64.6 1 .26.36.61.6 1 .6H22a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-2.51.4Z" /></svg>;
  if (name === "sidebar") return <svg {...common}><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M10 5v14" /></svg>;
  if (name === "plus") return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
  if (name === "bolt") return <svg {...common}><path d="m13 2-8 12h7l-1 8 8-12h-7l1-8Z" /></svg>;
  if (name === "chat") return <svg {...common}><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" /><path d="M8 9h8M8 13h5" /></svg>;
  if (name === "code") return <svg {...common}><path d="M8 8 4 12l4 4M16 8l4 4-4 4M14 4l-4 16" /></svg>;
  if (name === "refresh") return <svg {...common}><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16M3 21v-5h5M3 12A9 9 0 0 1 18.5 5.7L21 8M21 3v5h-5" /></svg>;
  return <svg {...common}><path d="M4 10.5 12 4l8 6.5V20H5v-7h14" /></svg>;
}

function ActionIcon({ icon }: { icon?: ReactNode }) {
  if (icon === "+") return <Icon name="plus" />;
  if (icon === "↯") return <Icon name="bolt" />;
  if (icon === "chat") return <Icon name="chat" />;
  if (icon === "code") return <Icon name="code" />;
  if (!icon) return <Icon name="bolt" />;
  return <>{icon}</>;
}

function PasskeyAuthScreen({ status, refresh }: { status: PasskeyAuthStatusResponse; refresh: () => Promise<void> }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState("");
  const description = status.bootstrapRequired
    ? "Choose the username for the owner"
    : status.ownerPasskeySetupRequired
      ? "The owner passkey was removed. Set it up again to continue."
      : "Authenticate to continue.";

  async function register(endpoint: "bootstrap" | "owner-setup") {
    setBusy(true);
    setError(undefined);
    try {
      const body = endpoint === "bootstrap" ? JSON.stringify({ username }) : "{}";
      const options = await json<PublicKeyCredentialCreationOptionsJSON>(`/api/passkey-auth/${endpoint}/options`, { method: "POST", body });
      const credential = await startRegistration({ optionsJSON: options as never });
      await json(`/api/passkey-auth/${endpoint}/verify`, { method: "POST", body: JSON.stringify(credential) });
      await refresh();
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  async function login() {
    setBusy(true);
    setError(undefined);
    try {
      const options = await json<PublicKeyCredentialRequestOptionsJSON>("/api/passkey-auth/authentication/options", { method: "POST", body: "{}" });
      const credential = await startAuthentication({ optionsJSON: options as never });
      await json("/api/passkey-auth/authentication/verify", { method: "POST", body: JSON.stringify(credential) });
      await refresh();
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="wapp-auth-screen">
      <Dialog
        className="wapp-auth-dialog"
        title={status.bootstrapRequired ? "Create owner user" : status.ownerPasskeySetupRequired ? "Set up owner passkey" : "Passkey required"}
        actions={status.bootstrapRequired ? (
          <Button type="button" variant="primary" disabled={busy || !username.trim()} onClick={() => void register("bootstrap")}>Create owner</Button>
        ) : status.ownerPasskeySetupRequired ? (
          <Button type="button" variant="primary" disabled={busy} onClick={() => void register("owner-setup")}>Set up owner passkey</Button>
        ) : (
          <Button type="button" variant="primary" disabled={busy} onClick={() => void login()}>Authenticate</Button>
        )}
      >
        <p>{description}</p>
        {error ? <p className="wapp-error">{error}</p> : null}
        {status.bootstrapRequired ? <><br /><TextField label="Username" value={username} onChange={(event) => setUsername(event.currentTarget.value)} placeholder="owner" /></> : null}
      </Dialog>
    </main>
  );
}

function UserSetupScreen({ refresh }: { refresh: () => Promise<void> }) {
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [details, setDetails] = useState<UserSetupDetails>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setError("Setup token is missing");
      return;
    }
    void json<UserSetupDetails>(`/api/user-setup?token=${encodeURIComponent(token)}`)
      .then(setDetails)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [token]);

  async function setup() {
    setBusy(true);
    setError(undefined);
    try {
      const options = await json<PublicKeyCredentialCreationOptionsJSON>("/api/user-setup/options", { method: "POST", body: JSON.stringify({ token }) });
      const credential = await startRegistration({ optionsJSON: options as never });
      await json("/api/user-setup/verify", { method: "POST", body: JSON.stringify({ token, response: credential }) });
      window.history.replaceState(null, "", "/");
      await refresh();
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="wapp-auth-screen">
      <Dialog
        className="wapp-auth-dialog"
        title={details?.kind === "reset" ? "Reset passkey" : "Finish user setup"}
        actions={<Button type="button" variant="primary" disabled={busy || !details} onClick={() => void setup()}>Set up passkey</Button>}
      >
        <p>{details ? `Username: ${details.username}` : "Loading setup link..."}</p>
        {details ? <p className="wapp-muted">Role: {details.role}. This link expires at {details.expiresAt}.</p> : null}
        {error ? <p className="wapp-error">{error}</p> : null}
      </Dialog>
    </main>
  );
}

function DeviceVerificationScreen() {
  const params = new URLSearchParams(window.location.search);
  const initialCode = params.get("user_code") ?? "";
  const [userCode, setUserCode] = useState(initialCode);
  const [details, setDetails] = useState<DeviceVerificationDetails>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!userCode.trim()) {
      setDetails(undefined);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      setDetails(await json<DeviceVerificationDetails>(`/api/auth/device/verification?user_code=${encodeURIComponent(userCode.trim())}`));
    } catch (err) {
      setDetails(undefined);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [userCode]);

  useEffect(() => void load(), [load]);

  async function decide(action: "approve" | "deny") {
    if (!details) return;
    setBusy(true);
    setError(undefined);
    try {
      setDetails(await json<DeviceVerificationDetails>(`/api/auth/device/${action}`, {
        method: "POST",
        body: JSON.stringify({ user_code: details.userCode }),
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="wapp-device-screen">
      <Panel title="Authorize device" description="Enter the code shown by the CLI or external device.">
        <div className="wapp-device-stack">
          <TextField label="User code" value={userCode} onChange={(event) => setUserCode(event.currentTarget.value.toUpperCase())} placeholder="ABCD-2345" />
          {error ? <p className="wapp-error">{error}</p> : null}
          {details ? (
            <div className="wapp-device-card">
              <div><strong>Client</strong><span>{details.clientId}</span></div>
              <div><strong>Scope</strong><span>{details.scope}</span></div>
              <div><strong>Status</strong><Badge variant={details.status === "approved" ? "success" : details.status === "denied" ? "error" : details.status === "consumed" ? "disabled" : "warning"}>{details.status}</Badge></div>
              <div><strong>Expires</strong><span>{details.expiresAt}</span></div>
            </div>
          ) : null}
          <div className="wapp-row-actions">
            <Button type="button" variant="ghost" disabled={busy || !details || details.status !== "pending"} onClick={() => void decide("deny")}>Deny</Button>
            <Button type="button" variant="primary" disabled={busy || !details || details.status !== "pending"} onClick={() => void decide("approve")}>Approve</Button>
          </div>
        </div>
      </Panel>
    </main>
  );
}

type SidebarTreeParentKind = "root" | "section" | "item";

type SidebarTreeProps = {
  nodes: SidebarNode[];
  route: WebAppRoute;
  navigate: (route: WebAppRoute) => void;
  collapsed: SidebarCollapsedState;
  toggleCollapsed: (id: string, isCollapsed: boolean) => void;
  searchActive: boolean;
  level?: number;
  parentKind?: SidebarTreeParentKind;
};

function sidebarIndentStyle(level: number, parentKind: SidebarTreeParentKind): { marginLeft?: string } | undefined {
  if (level <= 0) {
    return undefined;
  }
  const baseIndentRem = level * 0.375;
  const nestedSectionIndentRem = parentKind === "section" && level > 1 ? 0.875 : 0;
  return { marginLeft: `${baseIndentRem + nestedSectionIndentRem}rem` };
}

function SidebarTree({ nodes, route, navigate, collapsed, toggleCollapsed, searchActive, level = 0, parentKind = "root" }: SidebarTreeProps) {
  const [contextMenu, setContextMenu] = useState<{ position: ContextMenuPosition; items: ActionMenuItem[]; title: string } | null>(null);
  return (
    <>
      {nodes.map((node) => {
        const hasChildren = Boolean(node.children?.length);
        const storedIsCollapsed = collapsed[node.id] ?? node.defaultCollapsed ?? false;
        const isCollapsed = searchActive && hasChildren ? false : storedIsCollapsed;
        const toggleAriaLabel = searchActive ? `Toggling unavailable during search for ${node.title}` : `${isCollapsed ? "Expand" : "Collapse"} ${node.title}`;
        const toggleNodeCollapsed = () => {
          if (!searchActive) {
            toggleCollapsed(node.id, storedIsCollapsed);
          }
        };
        if (node.type === "section") {
          return (
            <section className={`wapp-sidebar-section ${level === 0 ? "top" : "nested"}`} key={node.id}>
              <div className="wapp-sidebar-section-title" style={sidebarIndentStyle(level, parentKind)}>
                {hasChildren ? (
                  <button type="button" aria-expanded={!isCollapsed} aria-label={toggleAriaLabel} disabled={searchActive} onClick={toggleNodeCollapsed}>
                    <span>{isCollapsed ? "▶" : "▼"}</span>{node.title}
                  </button>
                ) : (
                  <div className="wapp-sidebar-section-label">{node.title}</div>
                )}
                {node.action ? <button type="button" className="wapp-sidebar-action" title={node.action.title} aria-label={node.action.title} onClick={node.action.onAction ?? (() => node.action?.route && navigate(node.action.route))}>{node.action.label ?? "New"}</button> : null}
              </div>
              {!isCollapsed && hasChildren ? <SidebarTree nodes={node.children ?? []} route={route} navigate={navigate} collapsed={collapsed} toggleCollapsed={toggleCollapsed} searchActive={searchActive} level={level + 1} parentKind="section" /> : null}
              {!isCollapsed && !hasChildren && level === 0 ? <div className="wapp-sidebar-empty">No items.</div> : null}
            </section>
          );
        }
        const active = node.route?.view === route.view && Object.entries(node.route).every(([key, value]) => key === "view" || route[key] === value);
        return (
          <div className={`wapp-sidebar-item-wrap ${hasChildren ? "has-toggle" : ""}`} key={node.id} style={sidebarIndentStyle(level, parentKind)}>
            {hasChildren ? <button type="button" className="wapp-tree-toggle" aria-expanded={!isCollapsed} aria-label={toggleAriaLabel} disabled={searchActive} onClick={toggleNodeCollapsed}>{isCollapsed ? "▶" : "▼"}</button> : null}
            <button
              type="button"
              className={`wapp-sidebar-item ${active ? "active" : ""}`}
              onClick={() => node.route && navigate(node.route)}
              onContextMenu={(event) => {
                if (!node.actions?.length) return;
                event.preventDefault();
                setContextMenu({ position: { x: event.clientX, y: event.clientY }, items: node.actions, title: node.title });
              }}
            >
              <span>
                <strong>{node.title}</strong>
                {node.subtitle ? <small>{node.subtitle}</small> : null}
              </span>
              {node.badge ? <Badge variant={node.badgeVariant} className="wapp-sidebar-badge" title={node.badge} aria-label={node.badge}> </Badge> : null}
            </button>
            {!isCollapsed && node.children ? <div className="wapp-sidebar-children"><SidebarTree nodes={node.children} route={route} navigate={navigate} collapsed={collapsed} toggleCollapsed={toggleCollapsed} searchActive={searchActive} level={level + 1} parentKind="item" /></div> : null}
          </div>
        );
      })}
      <ContextMenu items={contextMenu?.items ?? []} position={contextMenu?.position ?? null} ariaLabel={contextMenu ? `Actions for ${contextMenu.title}` : "Actions"} onClose={() => setContextMenu(null)} />
    </>
  );
}

function renderSettingsActions(actions: SettingsRow["actions"]): ReactNode {
  if (!actions) return null;
  if (!Array.isArray(actions)) return actions;
  return actions.map((action) => (
    <Button key={action.id} type="button" variant={action.variant} disabled={action.disabled} onClick={action.onAction}>{action.label}</Button>
  ));
}

function StructuredSettingsSection({ section }: { section: SettingsSection }) {
  if (!section.rows?.length && section.render) {
    return <section className="wapp-custom-settings-section">{section.render()}</section>;
  }

  return (
    <FormSection title={section.title} description={section.description}>
      {section.rows?.map((row) => {
        const actions = renderSettingsActions(row.actions);
        if (row.danger) {
          return <DangerZone key={row.id} title={row.title} description={row.description} actions={actions} />;
        }
        return (
          <div className="wapp-settings-row" key={row.id}>
            <div>
              <strong>{row.title}</strong>
              {row.description ? <p>{row.description}</p> : null}
              {row.content ? <div className="wapp-settings-row-content">{row.content}</div> : null}
            </div>
            {actions ? <div className="wapp-row-actions">{actions}</div> : null}
          </div>
        );
      })}
      {section.render?.()}
    </FormSection>
  );
}

function isScopeVisible(scope: "user" | "admin" | "owner" | undefined, config: WebAppConfigResponse): boolean {
  if (!scope || scope === "user") return Boolean(config.currentUser);
  if (scope === "admin") return Boolean(config.currentUser?.isAdmin);
  return Boolean(config.currentUser?.isOwner);
}

function UserManagement({ config }: { config: WebAppConfigResponse }) {
  const [users, setUsers] = useState<WebAppUserSummary[]>([]);
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<WebAppUserRole>("user");
  const [setupLink, setSetupLink] = useState<string>();
  const [userToDelete, setUserToDelete] = useState<WebAppUserSummary>();
  const [error, setError] = useState<string>();

  const refreshUsers = useCallback(async () => {
    if (config.userManagement.canManageUsers) {
      setUsers(await json<WebAppUserSummary[]>("/api/users"));
    }
  }, [config.userManagement.canManageUsers]);

  useEffect(() => void refreshUsers().catch(() => undefined), [refreshUsers]);

  async function createUser() {
    try {
      setError(undefined);
      const result = await json<CreatedUserResponse>("/api/users", { method: "POST", body: JSON.stringify({ username, role }) });
      setUsername("");
      setRole("user");
      setSetupLink(result.setupLink.url);
      await refreshUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function updateRole(user: WebAppUserSummary, nextRole: WebAppUserRole) {
    try {
      setError(undefined);
      await json(`/api/users/${encodeURIComponent(user.id)}/role`, { method: "PATCH", body: JSON.stringify({ role: nextRole }) });
      await refreshUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function resetUser(user: WebAppUserSummary) {
    try {
      setError(undefined);
      const result = await json<CreatedUserResponse>(`/api/users/${encodeURIComponent(user.id)}/reset`, { method: "POST", body: "{}" });
      setSetupLink(result.setupLink.url);
      await refreshUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function deleteUser(user: WebAppUserSummary) {
    try {
      setError(undefined);
      await json(`/api/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
      setUserToDelete(undefined);
      await refreshUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!config.userManagement.canManageUsers) return null;
  return (
    <FormSection title="User management" description="Create users, reset passkeys, and manage admin access.">
      {error ? <p className="wapp-error">{error}</p> : null}
      <br />
      <div className="wapp-settings-row stacked">
        <div>
          <TextField label="Username" value={username} onChange={(event) => setUsername(event.currentTarget.value)} placeholder="new-user" />
          <br />
          <SelectField label="Role" value={role} onChange={(event) => setRole(event.currentTarget.value as WebAppUserRole)}>
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </SelectField>
        </div>
        <br />
        <div className="wapp-row-actions"><Button type="button" variant="primary" disabled={!username.trim()} onClick={() => void createUser()}>Create setup link</Button></div>
        {setupLink ? <code className="wapp-token">{setupLink}</code> : null}
      </div>
      <br />
      <div className="wapp-list">
        {users.map((user) => (
          <div className="wapp-list-row" key={user.id}>
            <span>
              <strong>{user.username}</strong>
              <small>{user.role} · passkey {user.passkeyConfigured ? "configured" : "pending"} · created {user.createdAt}</small>
            </span>
            <div className="wapp-row-actions">
              {user.role !== "owner" ? (
                <select className="wapp-inline-select" aria-label={`Role for ${user.username}`} value={user.role} onChange={(event) => void updateRole(user, event.currentTarget.value as WebAppUserRole)}>
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              ) : <Badge variant="success">Owner</Badge>}
              {user.role !== "owner" ? <Button type="button" onClick={() => void resetUser(user)}>Reset</Button> : null}
              <Button type="button" variant="danger" disabled={user.role === "owner"} onClick={() => setUserToDelete(user)}>Delete</Button>
            </div>
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={Boolean(userToDelete)}
        title="Delete user?"
        message={userToDelete ? `This permanently deletes "${userToDelete.username}" and revokes their setup links, API keys, passkeys and device sessions.` : ""}
        confirmLabel="Delete user"
        danger
        onCancel={() => setUserToDelete(undefined)}
        onConfirm={() => userToDelete && void deleteUser(userToDelete)}
      />
    </FormSection>
  );
}

const KILL_SERVER_COUNTDOWN_SECONDS = 15;

function computeProgressPercent(countdown: number, total: number): number {
  return total <= 0 ? 0 : (countdown / total) * 100;
}

function useCountdownReload(active: boolean, onComplete: () => void, durationSeconds = KILL_SERVER_COUNTDOWN_SECONDS): { countdown: number; progressPercent: number } {
  const [countdown, setCountdown] = useState(durationSeconds);

  useEffect(() => {
    if (!active) {
      setCountdown(durationSeconds);
      return;
    }

    setCountdown(durationSeconds);
    const interval = window.setInterval(() => {
      setCountdown((previous) => {
        const next = previous - 1;
        if (next <= 0) {
          window.clearInterval(interval);
          onComplete();
          return 0;
        }
        return next;
      });
    }, 1000);

    return () => window.clearInterval(interval);
  }, [active, durationSeconds, onComplete]);

  return {
    countdown,
    progressPercent: computeProgressPercent(countdown, durationSeconds),
  };
}

function SettingsView({ config, refresh, customSections, theme, setTheme }: { config: WebAppConfigResponse; refresh: () => Promise<void>; customSections: SettingsSection[]; theme: ThemePreference; setTheme: (theme: ThemePreference) => void }) {
  const [apiKeys, setApiKeys] = useState<ApiKeySummary[]>([]);
  const [authSessions, setAuthSessions] = useState<AuthSessionSummary[]>([]);
  const [createdToken, setCreatedToken] = useState<string>();
  const [apiKeyToDelete, setApiKeyToDelete] = useState<ApiKeySummary>();
  const [authSessionToRevoke, setAuthSessionToRevoke] = useState<AuthSessionSummary>();
  const [confirmDeletePasskey, setConfirmDeletePasskey] = useState(false);
  const [confirmKillServer, setConfirmKillServer] = useState(false);
  const [killRequested, setKillRequested] = useState(false);
  const [error, setError] = useState<string>();
  const reloadPage = useCallback(() => window.location.reload(), []);
  const { countdown, progressPercent } = useCountdownReload(killRequested, reloadPage);

  const refreshApiKeys = useCallback(async () => {
    if (config.apiKeys.enabled) {
      setApiKeys(await json<ApiKeySummary[]>("/api/api-keys"));
    }
  }, [config.apiKeys.enabled]);

  const refreshAuthSessions = useCallback(async () => {
    if (config.deviceAuth.enabled) {
      setAuthSessions(await json<AuthSessionSummary[]>("/api/auth/sessions"));
    }
  }, [config.deviceAuth.enabled]);

  useEffect(() => void refreshApiKeys().catch(() => undefined), [refreshApiKeys]);
  useEffect(() => void refreshAuthSessions().catch(() => undefined), [refreshAuthSessions]);

  async function createKey() {
    const result = await json<CreatedApiKeyResponse>("/api/api-keys", { method: "POST", body: JSON.stringify({ name: "Browser key", scopes: ["*"] }) });
    setCreatedToken(result.token);
    await refreshApiKeys();
  }

  async function deleteKey(id: string) {
    try {
      setError(undefined);
      await json(`/api/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
      setApiKeyToDelete(undefined);
      await refreshApiKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function setupPasskey() {
    try {
      setError(undefined);
      const options = await json<PublicKeyCredentialCreationOptionsJSON>("/api/passkey-auth/owner-setup/options", { method: "POST", body: "{}" });
      const credential = await startRegistration({ optionsJSON: options as never });
      await json("/api/passkey-auth/owner-setup/verify", { method: "POST", body: JSON.stringify(credential) });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function logout() {
    await json("/api/passkey-auth/logout", { method: "POST", body: "{}" });
    await refresh();
  }

  async function deleteConfiguredPasskey() {
    await json("/api/passkey-auth/passkey", { method: "DELETE" });
    setConfirmDeletePasskey(false);
    await refresh();
  }

  async function revokeAuthSession(session: AuthSessionSummary) {
    try {
      setError(undefined);
      await json(`/api/auth/sessions/${session.id}`, { method: "DELETE" });
      setAuthSessionToRevoke(undefined);
      await refreshAuthSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function killServer() {
    setError(undefined);
    setConfirmKillServer(false);
    const response = await fetch("/api/server/kill", { method: "POST" });
    if (!response.ok) {
      throw new Error("Failed to kill server. Please try again.");
    }
    setKillRequested(true);
  }

  return (
    <div className="wapp-settings">
      {error ? <p className="wapp-error">{error}</p> : null}
      {config.currentUser ? (
        <FormSection title="Account">
          <p>Signed in as <strong>{config.currentUser.username}</strong> <Badge variant={config.currentUser.isAdmin ? "success" : "disabled"}>{config.currentUser.role}</Badge></p>
        </FormSection>
      ) : null}
      <FormSection title="Display Settings">
        <SelectField label="Theme" value={theme} onChange={(event) => {
          const next = event.currentTarget.value as ThemePreference;
          setTheme(next);
          void json("/api/preferences/theme", { method: "PUT", body: JSON.stringify({ theme: next }) }).catch((err) => setError(String(err)));
        }}>
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </SelectField>
      </FormSection>

      {config.currentUser?.isAdmin ? (
        <FormSection title="Developer Settings">
          <SelectField label={config.logLevel.fromEnv ? `Log level (${config.logLevel.level}, controlled by env)` : "Log level"} value={config.logLevel.level} disabled={config.logLevel.fromEnv} onChange={(event) => void json("/api/preferences/log-level", { method: "PUT", body: JSON.stringify({ level: event.currentTarget.value }) }).then(refresh)}>
            {["trace", "debug", "info", "warn", "error"].map((level) => <option key={level} value={level}>{level}</option>)}
          </SelectField>
        </FormSection>
      ) : null}

      <FormSection title="Security">
        <div className="wapp-settings-row">
          <div>
            <strong>Passkey</strong>
            <p>{config.passkeyAuth.passkeyConfigured ? "Your passkey protects this account." : "No passkey configured yet."}</p>
          </div>
          <div className="wapp-row-actions">
            {config.passkeyAuth.passkeyConfigured ? (
              <>
                <Button type="button" onClick={() => void logout()}>Logout</Button>
                <Button type="button" variant="danger" onClick={() => setConfirmDeletePasskey(true)}>Delete passkey</Button>
              </>
            ) : (
              config.currentUser?.isOwner ? <Button type="button" variant="primary" onClick={() => void setupPasskey()}>Set up passkey</Button> : null
            )}
          </div>
        </div>
        {config.apiKeys.enabled ? (
          <div className="wapp-settings-row stacked">
            <div>
              <strong>API keys</strong>
              <p>Create bearer tokens for scripts and agents.</p>
            </div>
            <div className="wapp-row-actions"><Button type="button" onClick={() => void createKey().catch((err) => setError(String(err)))}>Create API key</Button></div>
            {createdToken ? <code className="wapp-token">{createdToken}</code> : null}
            {apiKeys.length ? (
              <div className="wapp-list">
                {apiKeys.map((key) => (
                  <div className="wapp-list-row" key={key.id}>
                    <span><strong>{key.name}</strong><small>{key.scopes.join(", ")} · {key.createdAt}</small></span>
                    <Button type="button" variant="danger" onClick={() => setApiKeyToDelete(key)}>Delete</Button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {config.deviceAuth.enabled ? (
          <div className="wapp-settings-row stacked">
            <div>
              <strong>Device auth sessions</strong>
              <p>Refresh-token sessions created through the device flow.</p>
            </div>
            <div className="wapp-list">
              {authSessions.length ? authSessions.map((session) => (
                <div className="wapp-list-row" key={session.id}>
                  <span><strong>{session.clientId}</strong><small>{session.scope} · {session.updatedAt}</small></span>
                  <Button type="button" variant="danger" onClick={() => setAuthSessionToRevoke(session)}>Revoke</Button>
                </div>
              )) : <EmptyState title="No device sessions" />}
            </div>
          </div>
        ) : null}
      </FormSection>

      <UserManagement config={config} />

      {config.currentUser?.isAdmin ? (
        <FormSection title="Server operations">
          <div className="wapp-settings-row">
            <div>
              <strong>Kill server</strong>
              <p>Stop the server process. If your deployment restarts it automatically, the app will come back after a moment.</p>
              {killRequested ? (
                <div className="wapp-shutdown-countdown" aria-live="polite">
                  <div className="wapp-shutdown-message">Server is shutting down... Reloading in {countdown}s</div>
                  <div className="wapp-shutdown-progress" aria-hidden="true">
                    <div className="wapp-shutdown-progress-bar" style={{ width: `${progressPercent}%` }} />
                  </div>
                </div>
              ) : null}
            </div>
            <div className="wapp-row-actions">
              <Button type="button" variant="danger" disabled={killRequested} onClick={() => setConfirmKillServer(true)}>Kill server</Button>
            </div>
          </div>
        </FormSection>
      ) : null}

      {customSections.filter((section) => isScopeVisible(section.scope, config)).map((section) => ({
        ...section,
        rows: section.rows?.filter((row) => isScopeVisible(row.scope, config)),
      })).map((section) => <StructuredSettingsSection key={section.id} section={section} />)}

      <FormSection title="About">
        <p>{config.appName} {config.version}</p>
      </FormSection>

      <ConfirmDialog
        open={Boolean(apiKeyToDelete)}
        title="Delete API key?"
        message={apiKeyToDelete ? `This permanently deletes "${apiKeyToDelete.name}". Scripts and agents using this token will stop working.` : ""}
        confirmLabel="Delete API key"
        danger
        onCancel={() => setApiKeyToDelete(undefined)}
        onConfirm={() => apiKeyToDelete && void deleteKey(apiKeyToDelete.id)}
      />
      <ConfirmDialog open={confirmDeletePasskey} title="Delete passkey?" message="This removes the configured passkey and invalidates browser sessions." confirmLabel="Delete passkey" danger onCancel={() => setConfirmDeletePasskey(false)} onConfirm={() => void deleteConfiguredPasskey()} />
      <ConfirmDialog
        open={Boolean(authSessionToRevoke)}
        title="Revoke device session?"
        message={authSessionToRevoke ? `This revokes the active "${authSessionToRevoke.clientId}" refresh-token session.` : ""}
        confirmLabel="Revoke session"
        danger
        onCancel={() => setAuthSessionToRevoke(undefined)}
        onConfirm={() => authSessionToRevoke && void revokeAuthSession(authSessionToRevoke)}
      />
      <ConfirmDialog
        open={confirmKillServer}
        title="Kill server?"
        message="Are you sure you want to kill the server?"
        confirmLabel="Kill server"
        danger
        onCancel={() => setConfirmKillServer(false)}
        onConfirm={() => void killServer().catch((err) => setError(String(err)))}
      />
    </div>
  );
}

export function WebAppRoot({ appName, homeRoute, sidebar, routes, header, onRouteChange, settings, version }: WebAppRootProps) {
  useMobileViewportHeight();
  const { config, error, refresh } = useConfig();
  const { route, navigate } = useRoute(homeRoute);
  const { theme, setTheme } = useTheme();
  const [search, setSearch] = useState("");
  const sidebarSearchId = useId();
  const sidebarSearchInputRef = useRef<HTMLInputElement>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sidebarTreeState = useSidebarCollapsedState(appName);
  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((current) => {
      const nextCollapsed = !current;
      setSidebarOpen(!nextCollapsed);
      return nextCollapsed;
    });
  }, []);
  const sidebarSearchEnabled = sidebar.search !== false;
  const normalizedSidebarSearch = sidebarSearchEnabled ? search.trim() : "";
  const sidebarSearchActive = normalizedSidebarSearch.length > 0;
  const pinningEnabled = sidebar.pinning !== false;
  const sidebarPins = useSidebarPins(appName, sidebar.pinning ? sidebar.pinning.storageKey : undefined);
  const baseNodes = useMemo(() => sidebar.getNodes({ search: "" }), [sidebar]);
  const filteredNodes = useMemo(() => sidebar.getNodes({ search: normalizedSidebarSearch }), [sidebar, normalizedSidebarSearch]);
  const allPinnableItems = useMemo(() => flattenSidebarItems(baseNodes).filter((node) => node.pinnable && node.route), [baseNodes]);
  const currentPins = useMemo(() => {
    const byId = new Map(allPinnableItems.map((node) => [node.pinId ?? node.id, node]));
    return sidebarPins.pins.map((pin) => {
      const current = byId.get(pin.id);
      return current ? toStoredPin(current) ?? pin : pin;
    });
  }, [allPinnableItems, sidebarPins.pins]);
  const pinningActionFor = useCallback((node: SidebarNode): ActionMenuItem | undefined => {
    if (!pinningEnabled || !node.pinnable || !node.route) return undefined;
    const id = node.pinId ?? node.id;
    const pinned = sidebarPins.pinIds.has(id);
    return pinned
      ? { id: "unpin", label: "Unpin from sidebar", onAction: () => sidebarPins.unpin(id) }
      : { id: "pin", label: "Pin to sidebar", onAction: () => sidebarPins.pin(node) };
  }, [pinningEnabled, sidebarPins]);
  const augmentPinningActions = useCallback((inputNodes: SidebarNode[]): SidebarNode[] => inputNodes.map((node) => {
    const children = node.children ? augmentPinningActions(node.children) : undefined;
    const pinAction = pinningActionFor(node);
    return {
      ...node,
      ...(children ? { children } : {}),
      ...(pinAction ? { actions: [...(node.actions ?? []).filter((action) => action.id !== "pin" && action.id !== "unpin"), pinAction] } : {}),
    };
  }), [pinningActionFor]);
  const nodes = useMemo(() => {
    const augmented = augmentPinningActions(filteredNodes);
    if (!pinningEnabled || sidebarSearchActive || currentPins.length === 0) return augmented;
    const augmentedByPinId = new Map(flattenSidebarItems(augmentPinningActions(baseNodes)).map((node) => [node.pinId ?? node.id, node]));
    const pinnedChildren = currentPins.map((pin) => ({
      ...(augmentedByPinId.get(pin.id) ?? {
        type: "item" as const,
        title: pin.title,
        subtitle: pin.subtitle,
        badge: pin.badge,
        badgeVariant: pin.badgeVariant,
        route: pin.route,
        pinnable: true,
      }),
      id: `pinned:${pin.id}`,
      pinId: pin.id,
      children: undefined,
    } satisfies SidebarNode));
    return [
      { type: "section" as const, id: "framework:pinned", title: sidebar.pinning ? sidebar.pinning.sectionTitle ?? "Pinned" : "Pinned", children: pinnedChildren },
      ...augmented,
    ];
  }, [augmentPinningActions, baseNodes, currentPins, filteredNodes, pinningEnabled, sidebar.pinning, sidebarSearchActive]);
  const activeActionNodes = useMemo(() => augmentPinningActions(baseNodes), [augmentPinningActions, baseNodes]);

  useEffect(() => {
    if (!config?.currentUser) return;
    void json<{ theme: ThemePreference }>("/api/preferences/theme")
      .then((result) => setTheme(result.theme))
      .catch(() => undefined);
  }, [config?.currentUser?.id, setTheme]);

  useEffect(() => {
    function handleSidebarShortcut(event: KeyboardEvent) {
      if (
        event.key.toLowerCase() !== "b"
        || event.altKey
        || event.shiftKey
        || event.ctrlKey === event.metaKey
        || event.isComposing
        || event.repeat
        || isSidebarShortcutEditableTarget(event.target)
      ) {
        return;
      }

      event.preventDefault();
      toggleSidebarCollapsed();
    }

    document.addEventListener("keydown", handleSidebarShortcut);
    return () => document.removeEventListener("keydown", handleSidebarShortcut);
  }, [toggleSidebarCollapsed]);

  useEffect(() => {
    onRouteChange?.(route);
  }, [onRouteChange, route]);

  if (error) {
    return <main className="wapp-auth-screen"><Panel title="Unable to load app" description={error} /></main>;
  }
  if (!config) {
    return <main className="wapp-auth-screen">Loading...</main>;
  }
  if (window.location.pathname === "/setup") {
    return <UserSetupScreen refresh={refresh} />;
  }
  if (config.passkeyAuth.enabled && (config.passkeyAuth.bootstrapRequired || config.passkeyAuth.ownerPasskeySetupRequired || (!config.passkeyAuth.passkeyDisabled && config.passkeyAuth.passkeyRequired && !config.passkeyAuth.authenticated))) {
    return <PasskeyAuthScreen status={config.passkeyAuth} refresh={refresh} />;
  }
  if (config.deviceAuth.enabled && window.location.pathname === "/device") {
    return <DeviceVerificationScreen />;
  }

  const effectiveVersion = version ?? config.version;
  let view: ReactNode;
  if (route.view === "settings") {
    view = <SettingsView config={config} refresh={refresh} customSections={settings?.sections ?? []} theme={theme} setTheme={setTheme} />;
  } else {
    const registeredView = routes[route.view];
    view = typeof registeredView === "function"
      ? registeredView(route)
      : registeredView ?? <EmptyState title="Not found" description={`No view registered for ${route.view}.`} />;
  }

  const topActions = sidebar.topActions?.slice(0, 2) ?? [];
  const defaultTitle = route.view === "settings" ? "Settings" : route.view === homeRoute.view ? appName : route.view.replace(/-/g, " ");
  const headerContext = { route, defaultTitle };
  const activeSidebarNode = flattenSidebarItems(activeActionNodes).find((node) => routeMatches(node.route, route));
  const activeSidebarActions = activeSidebarNode?.actions ?? [];
  const headerActions = [
    ...(header?.getActions?.(headerContext) ?? []),
    ...activeSidebarActions,
  ];
  const headerTitle = header?.renderTitle?.(headerContext) ?? defaultTitle;
  const primaryHeaderActions = header?.renderActions?.(headerContext);
  const headerActionLabel = typeof headerTitle === "string" ? headerTitle : defaultTitle;
  const sidebarToggleLabel = sidebarCollapsed ? "Show sidebar" : "Collapse sidebar";
  const navigateFromSidebarHeader = (nextRoute: WebAppRoute) => {
    navigate(nextRoute);
    setSidebarOpen(false);
  };
  const runSidebarHeaderAction = (action: SidebarAction) => {
    if (action.onAction) {
      action.onAction();
    } else if (action.route) {
      navigate(action.route);
    }
    setSidebarOpen(false);
  };

  return (
    <main className={`wapp-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${sidebarOpen ? "sidebar-open" : ""}`}>
      <div className="wapp-mobile-backdrop" onClick={() => setSidebarOpen(false)} />
      <aside className="wapp-sidebar">
        <div className="wapp-sidebar-header">
          <button type="button" className="wapp-brand" onClick={() => navigateFromSidebarHeader(homeRoute)}>{appName}</button>
          <div className="wapp-sidebar-actions">
            {topActions.map((action) => <IconButton key={action.id} className="wapp-sidebar-top-button" title={action.title} aria-label={action.title} onClick={() => runSidebarHeaderAction(action)}><ActionIcon icon={action.icon} /></IconButton>)}
            <IconButton className="wapp-sidebar-top-button" title="Settings" aria-label="Open settings" active={route.view === "settings"} onClick={() => navigateFromSidebarHeader({ view: "settings" })}><Icon name="settings" /></IconButton>
            <IconButton className="wapp-sidebar-top-button" title={sidebarToggleLabel} aria-label={sidebarToggleLabel} onClick={toggleSidebarCollapsed}><Icon name="sidebar" /></IconButton>
          </div>
        </div>
        <div className="wapp-sidebar-scroll">
          {sidebarSearchEnabled ? (
            <div className="wapp-search">
              <label className="sr-only" htmlFor={sidebarSearchId}>Search</label>
              <div className={`wapp-search-input-wrap${search.length > 0 ? " wapp-search-input-wrap--clearable" : ""}`}>
                <input id={sidebarSearchId} ref={sidebarSearchInputRef} value={search} onInput={(event) => setSearch(event.currentTarget.value)} placeholder="Search" />
                {search.length > 0 ? (
                  <button
                    type="button"
                    className="wapp-search-clear"
                    aria-label="Clear search"
                    onClick={() => {
                      setSearch("");
                      sidebarSearchInputRef.current?.focus();
                    }}
                  >
                    ×
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          <SidebarTree nodes={nodes} route={route} navigate={(next) => { navigate(next); setSidebarOpen(false); }} collapsed={sidebarTreeState.collapsed} toggleCollapsed={sidebarTreeState.toggleCollapsed} searchActive={sidebarSearchActive} />
          <div className="wapp-sidebar-footer">v{effectiveVersion}<button type="button" aria-label="Reload" onClick={() => window.location.reload()}><Icon name="refresh" /></button></div>
        </div>
      </aside>
      <section className="wapp-main">
        <header className="wapp-main-header">
          <div className="wapp-main-header-title">
            {sidebarCollapsed ? <IconButton className="wapp-sidebar-top-button" aria-label={sidebarToggleLabel} title={sidebarToggleLabel} onClick={toggleSidebarCollapsed}><Icon name="sidebar" /></IconButton> : <IconButton className="wapp-mobile-only wapp-sidebar-top-button" aria-label="Show sidebar" title="Show sidebar" onClick={() => setSidebarOpen(true)}><Icon name="sidebar" /></IconButton>}
            <h1>{headerTitle}</h1>
          </div>
          {primaryHeaderActions || headerActions.length ? (
            <div className="wapp-main-header-actions">
              {primaryHeaderActions}
              {headerActions.length ? <ActionMenu items={headerActions} ariaLabel={`Actions for ${headerActionLabel}`} /> : null}
            </div>
          ) : null}
        </header>
        <div className="wapp-main-content">{view}</div>
      </section>
    </main>
  );
}
