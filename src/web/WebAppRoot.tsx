import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useMemo, useReducer, useRef, useState, type ForwardedRef, type ReactNode } from "react";
import type { WebAppConfigResponse } from "../contracts";
import { AppShell } from "./app-shell";
import { DeviceVerificationScreen, PasskeyAuthScreen, UserSetupScreen } from "./auth-screens";
import { EmptyState, Panel } from "./components";
import { useMobileBreakpoint, useMobileSidebarSwipe, useMobileViewportHeight } from "./mobile-hooks";
import { routeToHash, supportsViewTransitions, useRoute } from "./routing";
import { flattenSidebarItems, toStoredPin, useSidebarCollapsedState, useSidebarPins, useSidebarTab } from "./sidebar-state";
import { SettingsView } from "./settings/settings-view";
import type { HeaderContext, WebAppRootController, WebAppRootProps } from "./root-types";
import type { ActionMenuItem, SidebarNode, SidebarTab, WebAppRoute } from "./sidebar/types";
import { ThemeProvider } from "./theme";
import { WebAppConfigProvider, useWebAppConfig } from "./webapp-config";
import { setLogLevel } from "./logger";
import { useReducedMotion } from "./motion";

const EMPTY_SIDEBAR_TABS: SidebarTab[] = [];

type SidebarVisibilityState = {
  open: boolean;
  collapsed: boolean;
};

type SidebarVisibilityAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "toggle-collapsed" };

const INITIAL_SIDEBAR_VISIBILITY: SidebarVisibilityState = {
  open: false,
  collapsed: false,
};

function reduceSidebarVisibility(state: SidebarVisibilityState, action: SidebarVisibilityAction): SidebarVisibilityState {
  switch (action.type) {
    case "open":
      return { open: true, collapsed: false };
    case "close":
      return { ...state, open: false };
    case "toggle-collapsed": {
      const collapsed = !state.collapsed;
      return { open: !collapsed, collapsed };
    }
  }
}

export { replaceHashRoute, replaceWebAppRoute, routeToHash } from "./routing";
export type {
  HeaderContext,
  SettingsAction,
  SettingsRow,
  SettingsRowContentPlacement,
  SettingsSection,
  WebAppRootController,
  WebAppRootProps,
} from "./root-types";

function routeMatches(left: WebAppRoute | undefined, right: WebAppRoute): boolean {
  if (!left) {
    return false;
  }
  return left.view === right.view && Object.entries(left).every(([key, value]) => key === "view" || right[key] === value);
}

function sidebarNodeKey(node: SidebarNode): string {
  return node.pinId ?? node.id;
}

function uniqueSidebarItems(nodeTrees: SidebarNode[][]): SidebarNode[] {
  const itemsById = new Map<string, SidebarNode>();
  for (const node of nodeTrees.flatMap((tree) => flattenSidebarItems(tree))) {
    const key = sidebarNodeKey(node);
    if (!itemsById.has(key)) {
      itemsById.set(key, node);
    }
  }
  return [...itemsById.values()];
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
  controllerRef,
}: WebAppRootProps & {
  config?: WebAppConfigResponse;
  error?: Error;
  refresh: () => Promise<void>;
  controllerRef: ForwardedRef<WebAppRootController>;
}) {
  const isMobile = useMobileBreakpoint();
  const reducedMotion = useReducedMotion();
  useMobileViewportHeight(isMobile);
  const { route, navigate } = useRoute(homeRoute);
  const sidebarSearchEnabled = sidebar.search !== false;
  const [search, setSearch] = useState("");
  const sidebarSearchId = useId();
  const sidebarSearchInputRef = useRef<HTMLInputElement>(null);
  const [sidebarSearchFocusRequested, setSidebarSearchFocusRequested] = useState(false);
  const [sidebarVisibility, dispatchSidebarVisibility] = useReducer(reduceSidebarVisibility, INITIAL_SIDEBAR_VISIBILITY);
  const { open: sidebarOpen, collapsed: sidebarCollapsed } = sidebarVisibility;
  const sidebarTreeState = useSidebarCollapsedState(appName);
  const sidebarTabs = sidebar.tabs ?? EMPTY_SIDEBAR_TABS;
  const { activeTab, selectTab } = useSidebarTab(appName, sidebarTabs);
  const setSidebarOpen = useCallback((open: boolean) => {
    dispatchSidebarVisibility({ type: open ? "open" : "close" });
  }, []);
  useMobileSidebarSwipe(isMobile, sidebarOpen, setSidebarOpen);
  const openSidebar = useCallback(() => {
    setSidebarOpen(true);
  }, [setSidebarOpen]);
  const focusSidebarSearch = useCallback(() => {
    if (!sidebarSearchEnabled) {
      return;
    }
    setSidebarSearchFocusRequested(true);
    openSidebar();
  }, [openSidebar, sidebarSearchEnabled]);
  const toggleSidebarCollapsed = useCallback(() => {
    dispatchSidebarVisibility({ type: "toggle-collapsed" });
  }, []);
  const normalizedSidebarSearch = sidebarSearchEnabled ? search.trim() : "";
  const sidebarSearchActive = normalizedSidebarSearch.length > 0;
  const pinningEnabled = sidebar.pinning !== false;
  const sidebarPins = useSidebarPins(appName, sidebar.pinning ? sidebar.pinning.storageKey : undefined);
  const baseNodes = useMemo(() => sidebar.getNodes({ search: "", activeTab }), [activeTab, sidebar]);
  const filteredNodes = useMemo(() => sidebar.getNodes({ search: normalizedSidebarSearch, activeTab }), [activeTab, normalizedSidebarSearch, sidebar]);
  const baseItems = useMemo(() => uniqueSidebarItems([baseNodes]), [baseNodes]);
  const activeRouteIsInBaseNodes = useMemo(
    () => baseItems.some((node) => routeMatches(node.route, route)),
    [baseItems, route],
  );
  const hasPinOutsideActiveTab = useMemo(() => {
    const baseItemIds = new Set(baseItems.map(sidebarNodeKey));
    return sidebarPins.pins.some((pin) => !baseItemIds.has(pin.id));
  }, [baseItems, sidebarPins.pins]);
  const actionLookupTrees = useMemo(() => {
    if (sidebarTabs.length === 0 || (activeRouteIsInBaseNodes && !hasPinOutsideActiveTab)) {
      return [baseNodes];
    }
    // Header actions and pinned items must resolve nodes outside the selected tab.
    return [
      baseNodes,
      ...sidebarTabs
        .filter((tab) => tab.id !== activeTab)
        .map((tab) => sidebar.getNodes({ search: "", activeTab: tab.id })),
    ];
  }, [activeRouteIsInBaseNodes, activeTab, baseNodes, hasPinOutsideActiveTab, sidebar, sidebarTabs]);
  const actionLookupItems = useMemo(() => uniqueSidebarItems(actionLookupTrees), [actionLookupTrees]);
  const allPinnableItems = useMemo(() => flattenSidebarItems(baseNodes).filter((node) => node.pinnable && node.route), [baseNodes]);
  const currentPins = useMemo(() => {
    const byId = new Map(allPinnableItems.map((node) => [sidebarNodeKey(node), node]));
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
  const addPinningAction = useCallback((node: SidebarNode): SidebarNode => {
    const pinAction = pinningActionFor(node);
    return {
      ...node,
      ...(pinAction ? { actions: [...(node.actions ?? []).filter((action) => action.id !== "pin" && action.id !== "unpin"), pinAction] } : {}),
    };
  }, [pinningActionFor]);
  const augmentPinningActions = useCallback((inputNodes: SidebarNode[]): SidebarNode[] => inputNodes.map((node) => {
    const children = node.children ? augmentPinningActions(node.children) : undefined;
    return addPinningAction({
      ...node,
      ...(children ? { children } : {}),
    });
  }), [addPinningAction]);
  const actionItemsWithPinning = useMemo(() => actionLookupItems.map(addPinningAction), [actionLookupItems, addPinningAction]);
  const nodes = useMemo(() => {
    const augmented = augmentPinningActions(filteredNodes);
    if (!pinningEnabled || sidebarSearchActive || currentPins.length === 0) return augmented;
    const augmentedByPinId = new Map(actionItemsWithPinning.map((node) => [sidebarNodeKey(node), node]));
    const pinnedChildren = currentPins.map((pin) => {
      const actionNode = augmentedByPinId.get(pin.id);
      return {
        ...(actionNode ?? {
          type: "item" as const,
          title: pin.title,
          subtitle: pin.subtitle,
          badge: pin.badge,
          badgeVariant: pin.badgeVariant,
          badgeAppearance: pin.badgeAppearance,
          itemLayout: pin.itemLayout,
          route: pin.route,
          pinnable: true,
        }),
        ...(actionNode ? {
          title: pin.title,
          subtitle: pin.subtitle,
          badge: pin.badge,
          badgeVariant: pin.badgeVariant,
          badgeAppearance: pin.badgeAppearance,
          itemLayout: pin.itemLayout,
          route: pin.route,
        } : {}),
        id: `pinned:${pin.id}`,
        pinId: pin.id,
        children: undefined,
      } satisfies SidebarNode;
    });
    return [
      { type: "section" as const, id: "framework:pinned", title: sidebar.pinning ? sidebar.pinning.sectionTitle ?? "Pinned" : "Pinned", children: pinnedChildren },
      ...augmented,
    ];
  }, [actionItemsWithPinning, augmentPinningActions, currentPins, filteredNodes, pinningEnabled, sidebar.pinning, sidebarSearchActive]);

  useEffect(() => {
    onRouteChange?.(route);
  }, [onRouteChange, route]);

  useEffect(() => {
    if (!sidebarSearchFocusRequested) {
      return;
    }
    if (!sidebarSearchEnabled || (error && !config)) {
      setSidebarSearchFocusRequested(false);
      return;
    }
    if (!config) {
      return;
    }
    const input = sidebarSearchInputRef.current;
    if (!input) {
      return;
    }
    input.focus();
    setSidebarSearchFocusRequested(false);
  }, [
    config,
    error,
    sidebarCollapsed,
    sidebarOpen,
    sidebarSearchEnabled,
    sidebarSearchFocusRequested,
  ]);

  useImperativeHandle(controllerRef, () => ({
    sidebar: {
      open: openSidebar,
      focusSearch: focusSidebarSearch,
      selectTab,
    },
  }), [focusSidebarSearch, openSidebar, selectTab]);

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
    return <PasskeyAuthScreen status={config.passkeyAuth} apiKeysEnabled={config.apiKeys.enabled} refresh={refresh} />;
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
  const activeSidebarNode = actionItemsWithPinning.find((node) => routeMatches(node.route, route));
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
      sidebarTabs={sidebarTabs}
      activeSidebarTab={activeTab}
      onSidebarTabChange={selectTab}
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
      routeKey={routeToHash(route)}
      nativeRouteTransitions={supportsViewTransitions() && !reducedMotion}
      view={view}
    />
  );
}

function WebAppRootWithConfig({
  controllerRef,
  ...props
}: WebAppRootProps & {
  controllerRef: ForwardedRef<WebAppRootController>;
}) {
  const { config, error, refresh } = useWebAppConfig();

  useEffect(() => {
    if (config) {
      setLogLevel(config.logLevel.level);
    }
  }, [config?.logLevel.level]);

  return (
    <ThemeProvider userId={config?.currentUser?.id}>
      <WebAppRootContent {...props} config={config} error={error} refresh={refresh} controllerRef={controllerRef} />
    </ThemeProvider>
  );
}

export const WebAppRoot = forwardRef<WebAppRootController, WebAppRootProps>(function WebAppRoot(props, controllerRef) {
  return (
    <WebAppConfigProvider>
      <WebAppRootWithConfig {...props} controllerRef={controllerRef} />
    </WebAppConfigProvider>
  );
});
