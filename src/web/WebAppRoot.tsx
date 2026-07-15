import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { WebAppConfigResponse } from "../contracts";
import { AppShell } from "./app-shell";
import { DeviceVerificationScreen, PasskeyAuthScreen, UserSetupScreen } from "./auth-screens";
import { EmptyState, Panel } from "./components";
import { useMobileBreakpoint, useMobileSidebarSwipe, useMobileViewportHeight } from "./mobile-hooks";
import { useRoute } from "./routing";
import { flattenSidebarItems, toStoredPin, useSidebarCollapsedState, useSidebarPins } from "./sidebar-state";
import { SettingsView } from "./settings/settings-view";
import type { HeaderContext, WebAppRootProps } from "./root-types";
import type { ActionMenuItem, SidebarNode, WebAppRoute } from "./sidebar/types";
import { ThemeProvider } from "./theme";
import { WebAppConfigProvider, useWebAppConfig } from "./webapp-config";

export { replaceHashRoute, replaceWebAppRoute, routeToHash } from "./routing";
export type {
  HeaderContext,
  SettingsAction,
  SettingsRow,
  SettingsRowContentPlacement,
  SettingsSection,
  WebAppRootProps,
} from "./root-types";

function routeMatches(left: WebAppRoute | undefined, right: WebAppRoute): boolean {
  if (!left) {
    return false;
  }
  return left.view === right.view && Object.entries(left).every(([key, value]) => key === "view" || right[key] === value);
}

function WebAppRootContent({
  appName,
  homeRoute,
  sidebar,
  routes,
  header,
  onRouteChange,
  settings,
  version,
  config,
  error,
  refresh,
}: WebAppRootProps & {
  config?: WebAppConfigResponse;
  error?: Error;
  refresh: () => Promise<void>;
}) {
  const isMobile = useMobileBreakpoint();
  useMobileViewportHeight(isMobile);
  const { route, navigate } = useRoute(homeRoute);
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

  useEffect(() => {
    onRouteChange?.(route);
  }, [onRouteChange, route]);

  if (error && !config) {
    return <main className="wapp-auth-screen"><Panel title="Unable to load app" description={error.message} /></main>;
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
    view = <SettingsView config={config} refresh={refresh} customSections={settings?.sections ?? []} />;
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

function WebAppRootWithConfig(props: WebAppRootProps) {
  const { config, error, refresh } = useWebAppConfig();
  return (
    <ThemeProvider userId={config?.currentUser?.id}>
      <WebAppRootContent {...props} config={config} error={error} refresh={refresh} />
    </ThemeProvider>
  );
}

export function WebAppRoot(props: WebAppRootProps) {
  return (
    <WebAppConfigProvider>
      <WebAppRootWithConfig {...props} />
    </WebAppConfigProvider>
  );
}
