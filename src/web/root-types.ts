import type { ReactNode } from "react";
import type { ActionMenuItem, SidebarAction, SidebarBuildContext, SidebarNode, WebAppRoute } from "./sidebar/types";

export type SettingsScope = "user" | "admin" | "owner";

export type SettingsAction = {
  id: string;
  label: string;
  variant?: "default" | "primary" | "danger" | "ghost";
  disabled?: boolean;
  onAction: () => void;
};

export type SettingsRow = {
  id: string;
  title: string;
  description?: string;
  scope?: SettingsScope;
  content?: ReactNode;
  actions?: ReactNode | SettingsAction[];
  danger?: boolean;
};

export type SettingsSection = {
  id: string;
  title: string;
  description?: string;
  scope?: SettingsScope;
  rows?: SettingsRow[];
  render?: () => ReactNode;
};

export type HeaderContext = {
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
