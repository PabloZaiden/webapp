import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ApiKeySummary, AuthSessionSummary, CreatedApiKeyResponse, DeviceVerificationDetails, PasskeyAuthStatusResponse, ThemePreference, WebAppConfigResponse } from "../contracts";
import { ActionMenu, Badge, Button, ConfirmDialog, ContextMenu, DangerZone, EmptyState, FormSection, IconButton, Panel, SelectField, TextField, type ContextMenuPosition } from "./components";
import type { ActionMenuItem, SidebarAction, SidebarBuildContext, SidebarNode, WebAppRoute } from "./sidebar/types";

type SettingsSection = {
  id: string;
  title: string;
  description?: string;
  rows?: SettingsRow[];
  render?: () => ReactNode;
};

type SettingsRow = {
  id: string;
  title: string;
  description?: string;
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
    getActions?: (ctx: HeaderContext) => ActionMenuItem[];
  };
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

function Icon({ name }: { name: "settings" | "sidebar" | "plus" | "home" | "search" | "bolt" | "chat" | "code" | "refresh" }) {
  const common = { "aria-hidden": true, viewBox: "0 0 24 24", className: "wapp-svg" };
  if (name === "settings") return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 .6 1.65 1.65 0 0 0-.33 1.82V22a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-.6-1 1.65 1.65 0 0 0-1.82-.33H2a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-.6 1.65 1.65 0 0 0 .33-1.82V2a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.33.34.64.6 1 .26.36.61.6 1 .6H22a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-2.51.4Z" /></svg>;
  if (name === "sidebar") return <svg {...common}><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M10 5v14" /></svg>;
  if (name === "plus") return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
  if (name === "bolt") return <svg {...common}><path d="m13 2-8 12h7l-1 8 8-12h-7l1-8Z" /></svg>;
  if (name === "chat") return <svg {...common}><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" /><path d="M8 9h8M8 13h5" /></svg>;
  if (name === "code") return <svg {...common}><path d="m16 18 6-6-6-6M8 6l-6 6 6 6" /></svg>;
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
  async function register() {
    setBusy(true);
    setError(undefined);
    try {
      const options = await json<PublicKeyCredentialCreationOptionsJSON>("/api/passkey-auth/registration/options", { method: "POST", body: "{}" });
      const credential = await startRegistration({ optionsJSON: options as never });
      await json("/api/passkey-auth/registration/verify", { method: "POST", body: JSON.stringify(credential) });
      await refresh();
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="wapp-auth-screen">
      <Panel title="Passkey required" description={status.passkeyConfigured ? "Authenticate to continue." : "Set up the first passkey for this app."}>
        {error ? <p className="wapp-error">{error}</p> : null}
        <div className="wapp-row-actions">
          {status.passkeyConfigured ? <Button type="button" variant="primary" disabled={busy} onClick={() => void login()}>Authenticate</Button> : <Button type="button" variant="primary" disabled={busy} onClick={() => void register()}>Set up passkey</Button>}
        </div>
      </Panel>
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

function SidebarTree({ nodes, route, navigate, level = 0 }: { nodes: SidebarNode[]; route: WebAppRoute; navigate: (route: WebAppRoute) => void; level?: number }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [contextMenu, setContextMenu] = useState<{ position: ContextMenuPosition; items: ActionMenuItem[]; title: string } | null>(null);
  return (
    <>
      {nodes.map((node) => {
        const hasChildren = Boolean(node.children?.length);
        const isCollapsed = collapsed[node.id] ?? node.defaultCollapsed ?? false;
        if (node.type === "section") {
          return (
            <section className="wapp-sidebar-section" key={node.id}>
              <div className="wapp-sidebar-section-title" style={{ marginLeft: level ? `${level * 0.375}rem` : undefined }}>
                <button type="button" aria-expanded={!isCollapsed} aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${node.title}`} onClick={() => setCollapsed((current) => ({ ...current, [node.id]: !isCollapsed }))}>
                  <span>{isCollapsed ? "▶" : "▼"}</span>{node.title}
                </button>
                {node.action ? <button type="button" className="wapp-sidebar-action" onClick={node.action.onAction ?? (() => node.action?.route && navigate(node.action.route))}>{node.action.label ?? "New"}</button> : null}
              </div>
              {!isCollapsed && node.children ? <SidebarTree nodes={node.children} route={route} navigate={navigate} level={level + 1} /> : null}
              {!isCollapsed && !node.children?.length ? <div className="wapp-sidebar-empty">No items.</div> : null}
            </section>
          );
        }
        const active = node.route?.view === route.view && Object.entries(node.route).every(([key, value]) => key === "view" || route[key] === value);
        return (
          <div className={`wapp-sidebar-item-wrap ${hasChildren ? "has-toggle" : ""}`} key={node.id} style={{ marginLeft: level ? `${level * 0.375}rem` : undefined }}>
            {hasChildren ? <button type="button" className="wapp-tree-toggle" aria-expanded={!isCollapsed} aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${node.title}`} onClick={() => setCollapsed((current) => ({ ...current, [node.id]: !isCollapsed }))}>{isCollapsed ? "▶" : "▼"}</button> : null}
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
              {node.badge ? <Badge variant={node.badgeVariant}>{node.badge}</Badge> : null}
            </button>
            {!isCollapsed && node.children ? <div className="wapp-sidebar-children"><SidebarTree nodes={node.children} route={route} navigate={navigate} level={level + 1} /></div> : null}
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

function SettingsView({ config, refresh, customSections, theme, setTheme }: { config: WebAppConfigResponse; refresh: () => Promise<void>; customSections: SettingsSection[]; theme: ThemePreference; setTheme: (theme: ThemePreference) => void }) {
  const [apiKeys, setApiKeys] = useState<ApiKeySummary[]>([]);
  const [authSessions, setAuthSessions] = useState<AuthSessionSummary[]>([]);
  const [createdToken, setCreatedToken] = useState<string>();
  const [apiKeyToDelete, setApiKeyToDelete] = useState<ApiKeySummary>();
  const [confirmDeletePasskey, setConfirmDeletePasskey] = useState(false);
  const [killRequested, setKillRequested] = useState(false);
  const [error, setError] = useState<string>();

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
      const options = await json<PublicKeyCredentialCreationOptionsJSON>("/api/passkey-auth/registration/options", { method: "POST", body: "{}" });
      const credential = await startRegistration({ optionsJSON: options as never });
      await json("/api/passkey-auth/registration/verify", { method: "POST", body: JSON.stringify(credential) });
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

  async function killServer() {
    setKillRequested(true);
    await fetch("/api/server/kill", { method: "POST" });
    setTimeout(() => window.location.reload(), 3500);
  }

  return (
    <div className="wapp-settings">
      {error ? <p className="wapp-error">{error}</p> : null}
      <FormSection title="Display Settings">
        <SelectField label="Theme" value={theme} onChange={(event) => setTheme(event.currentTarget.value as ThemePreference)}>
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </SelectField>
      </FormSection>

      <FormSection title="Developer Settings">
        <SelectField label={config.logLevel.fromEnv ? `Log level (${config.logLevel.level}, controlled by env)` : "Log level"} value={config.logLevel.level} disabled={config.logLevel.fromEnv} onChange={(event) => void json("/api/preferences/log-level", { method: "PUT", body: JSON.stringify({ level: event.currentTarget.value }) }).then(refresh)}>
          {["trace", "debug", "info", "warn", "error"].map((level) => <option key={level} value={level}>{level}</option>)}
        </SelectField>
      </FormSection>

      <FormSection title="Security">
        <div className="wapp-settings-row">
          <div>
            <strong>Passkey</strong>
            <p>{config.passkeyAuth.passkeyConfigured ? "Passkey protection is configured." : "No passkey configured yet."}</p>
          </div>
          <div className="wapp-row-actions">
            {config.passkeyAuth.passkeyConfigured ? (
              <>
                <Button type="button" onClick={() => void logout()}>Logout</Button>
                <Button type="button" variant="danger" onClick={() => setConfirmDeletePasskey(true)}>Delete passkey</Button>
              </>
            ) : (
              <Button type="button" variant="primary" onClick={() => void setupPasskey()}>Set up passkey</Button>
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
                  <span><strong>{session.clientId}</strong><small>{session.scope} · {session.active ? "active" : "inactive"} · {session.updatedAt}</small></span>
                  <Button type="button" variant="danger" disabled={!session.active} onClick={() => void json(`/api/auth/sessions/${session.id}`, { method: "DELETE" }).then(refreshAuthSessions)}>Revoke</Button>
                </div>
              )) : <EmptyState title="No device sessions" />}
            </div>
          </div>
        ) : null}
      </FormSection>

      <FormSection title="Server operations">
        {killRequested ? <p className="wapp-notice">Server is shutting down. Reloading soon...</p> : null}
        <Button type="button" variant="danger" onClick={() => void killServer().catch((err) => setError(String(err)))}>Kill server</Button>
      </FormSection>

      {customSections.map((section) => <StructuredSettingsSection key={section.id} section={section} />)}

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
    </div>
  );
}

export function WebAppRoot({ appName, homeRoute, sidebar, routes, header, settings, version }: WebAppRootProps) {
  const { config, error, refresh } = useConfig();
  const { route, navigate } = useRoute(homeRoute);
  const { theme, setTheme } = useTheme();
  const [search, setSearch] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const pinningEnabled = sidebar.pinning !== false;
  const sidebarPins = useSidebarPins(appName, sidebar.pinning ? sidebar.pinning.storageKey : undefined);
  const baseNodes = useMemo(() => sidebar.getNodes({ search: "" }), [sidebar]);
  const filteredNodes = useMemo(() => sidebar.getNodes({ search }), [sidebar, search]);
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
    if (!pinningEnabled || search.trim() || currentPins.length === 0) return augmented;
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
  }, [augmentPinningActions, baseNodes, currentPins, filteredNodes, pinningEnabled, search, sidebar.pinning]);

  if (error) {
    return <main className="wapp-auth-screen"><Panel title="Unable to load app" description={error} /></main>;
  }
  if (!config) {
    return <main className="wapp-auth-screen">Loading...</main>;
  }
  if (config.passkeyAuth.enabled && !config.passkeyAuth.passkeyDisabled && (!config.passkeyAuth.passkeyConfigured || (config.passkeyAuth.passkeyRequired && !config.passkeyAuth.authenticated))) {
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
  const activePinnableNode = allPinnableItems.find((node) => routeMatches(node.route, route));
  const activePinningAction = activePinnableNode ? pinningActionFor(activePinnableNode) : undefined;
  const headerActions = [
    ...(header?.getActions?.(headerContext) ?? []),
    ...(activePinningAction ? [activePinningAction] : []),
  ];
  const headerTitle = header?.renderTitle?.(headerContext) ?? defaultTitle;

  return (
    <main className={`wapp-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${sidebarOpen ? "sidebar-open" : ""}`}>
      <div className="wapp-mobile-backdrop" onClick={() => setSidebarOpen(false)} />
      <aside className="wapp-sidebar">
        <div className="wapp-sidebar-header">
          <button type="button" className="wapp-brand" onClick={() => navigate(homeRoute)}>{appName}</button>
          <div className="wapp-sidebar-actions">
            {topActions.map((action) => <IconButton key={action.id} className="wapp-sidebar-top-button" title={action.title} aria-label={action.title} onClick={action.onAction ?? (() => action.route && navigate(action.route))}><ActionIcon icon={action.icon} /></IconButton>)}
            <IconButton className="wapp-sidebar-top-button" title="Settings" aria-label="Open settings" active={route.view === "settings"} onClick={() => navigate({ view: "settings" })}><Icon name="settings" /></IconButton>
            <IconButton className="wapp-sidebar-top-button" title="Collapse sidebar" aria-label="Collapse sidebar" onClick={() => { setSidebarCollapsed(true); setSidebarOpen(false); }}><Icon name="sidebar" /></IconButton>
          </div>
        </div>
        <div className="wapp-sidebar-scroll">
          <label className="wapp-search"><span className="sr-only">Search</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search" /></label>
          <SidebarTree nodes={nodes} route={route} navigate={(next) => { navigate(next); setSidebarOpen(false); }} />
        </div>
        <div className="wapp-sidebar-footer">v{effectiveVersion}<button type="button" aria-label="Reload" onClick={() => window.location.reload()}><Icon name="refresh" /></button></div>
      </aside>
      <section className="wapp-main">
        <header className="wapp-main-header">
          <div className="wapp-main-header-title">
            {sidebarCollapsed ? <IconButton className="wapp-sidebar-top-button" aria-label="Show sidebar" title="Show sidebar" onClick={() => { setSidebarCollapsed(false); setSidebarOpen(true); }}><Icon name="sidebar" /></IconButton> : <IconButton className="wapp-mobile-only wapp-sidebar-top-button" aria-label="Show sidebar" title="Show sidebar" onClick={() => setSidebarOpen(true)}><Icon name="sidebar" /></IconButton>}
            <h1>{headerTitle}</h1>
          </div>
          {headerActions.length ? (
            <div className="wapp-main-header-actions">
              <ActionMenu items={headerActions} ariaLabel={`Actions for ${defaultTitle}`} />
            </div>
          ) : null}
        </header>
        <div className="wapp-main-content">{view}</div>
      </section>
    </main>
  );
}
