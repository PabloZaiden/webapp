import type { ReactNode } from "react";

export type BadgeVariant =
  | "default"
  | "success"
  | "warning"
  | "error"
  | "info"
  | "disabled"
  | "idle"
  | "planning"
  | "running"
  | "completed"
  | "stopped"
  | "failed"
  | "merged"
  | "pushed"
  | "deleted"
  | "plan_ready";

export type BadgeAppearance = "pill" | "text";
export type SidebarBadgeAppearance = "dot" | "text";
export type SidebarItemLayout = "default" | "subtitle-above-title";

export interface WebAppRoute {
  view: string;
  [key: string]: string | undefined;
}

export interface SidebarAction {
  id: string;
  title: string;
  label?: string;
  icon?: ReactNode;
  disabled?: boolean;
  active?: boolean;
  busy?: boolean;
  route?: WebAppRoute;
  onAction?: () => void;
}

export interface SidebarTab {
  id: string;
  title: string;
  label?: string;
  icon?: ReactNode;
}

export type ActionMenuItem = {
  id?: string;
  label: string;
  disabled?: boolean;
  destructive?: boolean;
} & (
  | { onAction: () => void; form?: never }
  | { form: string; onAction?: never }
);

export type SidebarItemRenderContext = {
  node: SidebarNode;
  active: boolean;
  childrenCollapsed: boolean;
  hasChildren: boolean;
  searchActive: boolean;
  navigate: (route: WebAppRoute) => void;
  toggleCollapsed: () => void;
  actions: ActionMenuItem[];
};

export type SidebarItemRenderer = (context: SidebarItemRenderContext) => ReactNode;

export interface SidebarNode {
  type: "section" | "item";
  id: string;
  title: string;
  subtitle?: string;
  badge?: string;
  badgeVariant?: BadgeVariant;
  badgeAppearance?: SidebarBadgeAppearance;
  itemLayout?: SidebarItemLayout;
  render?: SidebarItemRenderer;
  route?: WebAppRoute;
  /** Synchronously gates the framework-owned row button; returning false prevents navigation. */
  onActivate?: () => boolean;
  action?: SidebarAction;
  actions?: ActionMenuItem[];
  /** Overrides sidebar context-menu and renderer actions; title-bar actions continue to use `actions`. */
  contextActions?: ActionMenuItem[];
  pinnable?: boolean;
  pinId?: string;
  defaultCollapsed?: boolean;
  children?: SidebarNode[];
}

export interface SidebarNodeSnapshot {
  nodes: SidebarNode[];
  ready: boolean;
}

export interface SidebarBuildContext {
  search: string;
  activeTab?: string;
}
