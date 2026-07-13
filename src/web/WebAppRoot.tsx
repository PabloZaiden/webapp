import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { ThemePreference, WebAppConfigResponse } from "../contracts";
import { appJson } from "./api-client";
import { AppShell } from "./app-shell";
import { DeviceVerificationScreen, PasskeyAuthScreen, UserSetupScreen } from "./auth-screens";
import { EmptyState, Panel } from "./components";
import { useMobileBreakpoint, useMobileSidebarSwipe, useMobileViewportHeight } from "./mobile-hooks";
import { useRoute } from "./routing";
import { flattenSidebarItems, toStoredPin, useSidebarCollapsedState, useSidebarPins } from "./sidebar-state";
import { SettingsView } from "./settings/settings-view";
import type { HeaderContext, WebAppRootProps } from "./root-types";
import type { ActionMenuItem, SidebarNode, WebAppRoute } from "./sidebar/types";

export { replaceHashRoute, replaceWebAppRoute, routeToHash } from "./routing";
export type { HeaderContext, SettingsAction, SettingsRow, SettingsSection, WebAppRootProps } from "./root-types";

function useConfig() {
  const [config, setConfig] = useState<WebAppConfigResponse>();
  const [error, setError] = useState<string>();
  const refresh = useCallback(async () => {
    try {
      setConfig(await appJson<WebAppConfigResponse>("/api/config"));
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
  if (!left) {
    return false;
  }
  return left.view === right.view && Object.entries(left).every(([key, value]) => key === "view" || right[key] === value);
}

export function WebAppRoot({ appName, homeRoute, sidebar, routes, header, onRouteChange, settings, version }: WebAppRootProps) {
  const isMobile = useMobileBreakpoint();
  useMobileViewportHeight(isMobile);
  const { config, error, refresh } = useConfig();
  const { route, navigate } = useRoute(homeRoute);
  const { theme, setTheme } = useTheme();
  const [themeLoading, setThemeLoading] = useState(false);
  const [themeLoadError, setThemeLoadError] = useState<Error>();
  const [search, setSearch] = useState("");
  const sidebarSearchId = useId();
  const sidebarSearchInputRef = useRef<HTMLInputElement>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sidebarTreeState = useSidebarCollapsedState(appName);
  useMobileSidebarSwipe(isMobile, sidebarOpen, setSidebarOpen);
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

  const retryThemeLoad = useCallback(async () => {
    if (!config?.currentUser) {
      setThemeLoading(false);
      setThemeLoadError(undefined);
      return;
    }

    setThemeLoading(true);
    setThemeLoadError(undefined);
    try {
      const result = await appJson<{ theme: ThemePreference }>("/api/preferences/theme");
      setTheme(result.theme);
    } catch (err) {
      setThemeLoadError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setThemeLoading(false);
    }
  }, [config?.currentUser?.id, setTheme]);

  useEffect(() => {
    void retryThemeLoad();
  }, [retryThemeLoad]);

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
    view = <SettingsView config={config} refresh={refresh} customSections={settings?.sections ?? []} theme={theme} setTheme={setTheme} themeLoading={themeLoading} themeLoadError={themeLoadError} retryThemeLoad={retryThemeLoad} />;
  } else {
    const registeredView = routes[route.view];
    view = typeof registeredView === "function"
      ? registeredView(route)
      : registeredView ?? <EmptyState title="Not found" description={`No view registered for ${route.view}.`} />;
  }

  const defaultTitle = route.view === "settings" ? "Settings" : route.view === homeRoute.view ? appName : route.view.replace(/-/g, " ");
  const headerContext: HeaderContext = { route, defaultTitle };
  const activeSidebarNode = flattenSidebarItems(activeActionNodes).find((node) => routeMatches(node.route, route));
  const activeSidebarActions = activeSidebarNode?.actions ?? [];
  const headerActions = [
    ...(header?.getActions?.(headerContext) ?? []),
    ...activeSidebarActions,
  ];
  const headerTitle = header?.renderTitle?.(headerContext) ?? defaultTitle;
  const primaryHeaderActions = header?.renderActions?.(headerContext);
  const headerActionLabel = typeof headerTitle === "string" ? headerTitle : defaultTitle;

  return (
    <AppShell
      appName={appName}
      homeRoute={homeRoute}
      topActions={sidebar.topActions ?? []}
      nodes={nodes}
      route={route}
      navigate={navigate}
      sidebarSearchEnabled={sidebarSearchEnabled}
      search={search}
      onSearchChange={setSearch}
      sidebarSearchId={sidebarSearchId}
      sidebarSearchInputRef={sidebarSearchInputRef}
      sidebarOpen={sidebarOpen}
      setSidebarOpen={setSidebarOpen}
      sidebarCollapsed={sidebarCollapsed}
      toggleSidebarCollapsed={toggleSidebarCollapsed}
      collapsed={sidebarTreeState.collapsed}
      toggleCollapsed={sidebarTreeState.toggleCollapsed}
      searchActive={sidebarSearchActive}
      effectiveVersion={effectiveVersion}
      headerTitle={headerTitle}
      headerActionLabel={headerActionLabel}
      primaryHeaderActions={primaryHeaderActions}
      headerActions={headerActions}
      view={view}
    />
  );
}
