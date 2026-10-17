import type { ReactNode } from "react";
import type { ActionMenuItem, SidebarAction, SidebarBuildContext, SidebarNode, SidebarNodeSnapshot, SidebarTab, WebAppRoute } from "./sidebar/types";
import type { ButtonVariant } from "./components";

export type SettingsScope = "user" | "admin" | "owner";

export type SettingsAction = {
  id: string;
  label: string;
  variant?: ButtonVariant;
  tone?: "neutral" | "danger";
  icon?: ReactNode;
  pending?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  confirmation?: { title: string; message: string; confirmLabel?: string; danger?: boolean };
  onAction: () => void | Promise<void>;
};

export type SettingsRowContentPlacement = "below" | "inline";

export type SettingsRow = {
  id: string;
  title: string;
  description?: string;
  scope?: SettingsScope;
  content?: ReactNode;
  contentPlacement?: SettingsRowContentPlacement;
  labelFor?: string;
  feedback?: ReactNode;
  actions?: ReactNode | SettingsAction[];
  danger?: boolean;
};

export type SettingsSection = {
  id: string;
  title: string;
  description?: string;
  scope?: SettingsScope;
  category?: { id: string; title: string };
  collapsible?: boolean;
  defaultExpanded?: boolean;
  actions?: ReactNode;
  rows?: SettingsRow[];
  render?: () => ReactNode;
};

export type HeaderPrimaryAction = ActionMenuItem & {
  icon?: ReactNode;
  loading?: boolean;
};

export type HeaderActionSet = {
  primary?: HeaderPrimaryAction[];
  overflow?: ActionMenuItem[];
};

export type HeaderContext = {
  route: WebAppRoute;
  defaultTitle: string;
};

export interface WebAppRootController {
  sidebar: {
    open: () => void;
    close: () => void;
    focusSearch: () => void;
    selectTab: (id: string) => void;
  };
}

export interface WebAppRootProps {
  appName: string;
  appIcon?: string | URL;
  homeRoute: WebAppRoute;
  sidebar: {
    search?: boolean;
    topActions?: SidebarAction[];
    bottomContent?: ReactNode;
    tabs?: SidebarTab[];
    pinning?: false | {
      sectionTitle?: string;
      storageKey?: string;
    };
    getNodes: (ctx: SidebarBuildContext) => SidebarNode[] | SidebarNodeSnapshot;
  };
  routes: Record<string, ReactNode | ((route: WebAppRoute) => ReactNode)>;
  /** Persistent overlay above main content, outside scrolling and route transitions. */
  mainOverlay?: ReactNode;
  header?: {
    renderTitle?: (ctx: HeaderContext) => ReactNode;
    getActions?: (ctx: HeaderContext) => ActionMenuItem[];
    getHeaderActions?: (ctx: HeaderContext) => HeaderActionSet;
  };
  onRouteChange?: (route: WebAppRoute) => void;
  settings?: {
    sections?: SettingsSection[];
  };
  version?: string;
}
