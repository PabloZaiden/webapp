import type { Server } from "bun";
import type { CurrentUser } from "../contracts";
import type { AuthenticatedRequestState } from "./auth/types";
import type { RealtimeBus, ResourceRealtimeEvent, RealtimeTarget } from "./realtime/bus";

export type RouteAuth = "required" | "user" | "admin" | "owner" | "public" | "optional";
export type SameOriginMode = "mutations" | "always" | "never";
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type UserOwnedResource = { userId: string };
export type UserIdSelector<TResource> = (resource: TResource) => string | undefined;

export interface UserScopedRealtimePublisher<TEvent = unknown> {
  publishChanged<TPayload = unknown>(resource: string, options?: Omit<ResourceRealtimeEvent<TPayload>, "type" | "resource" | "action"> & { target?: RealtimeTarget }): void;
  publishEntityChanged<TPayload = unknown>(resource: string, id: string, options?: Omit<ResourceRealtimeEvent<TPayload>, "type" | "resource" | "action" | "id"> & { target?: RealtimeTarget }): void;
  publishDeleted<TPayload = unknown>(resource: string, id: string, options?: Omit<ResourceRealtimeEvent<TPayload>, "type" | "resource" | "action" | "id"> & { target?: RealtimeTarget }): void;
  publishSettingsChanged<TPayload = unknown>(options?: Omit<ResourceRealtimeEvent<TPayload>, "type" | "resource" | "action"> & { target?: RealtimeTarget }): void;
}

export interface RouteContext<TParams extends Record<string, string> = Record<string, string>, TEvent = unknown> {
  params: TParams;
  auth: AuthenticatedRequestState;
  user?: CurrentUser;
  requireUser(): CurrentUser;
  requireAdmin(): CurrentUser;
  requireOwner(): CurrentUser;
  assertUser(userId: string): CurrentUser;
  filterOwned<TResource extends UserOwnedResource>(resources: readonly TResource[]): TResource[];
  filterOwned<TResource>(resources: readonly TResource[], getUserId: UserIdSelector<TResource>): TResource[];
  requireOwned<TResource extends UserOwnedResource>(resource: TResource | null | undefined): TResource;
  requireOwned<TResource>(resource: TResource | null | undefined, getUserId: UserIdSelector<TResource>): TResource;
  realtime: RealtimeBus<TEvent>;
  userRealtime: UserScopedRealtimePublisher<TEvent>;
  server?: Server<unknown>;
}

export type WebAppRouteHandler<TParams extends Record<string, string> = Record<string, string>, TEvent = unknown> = (
  req: Request,
  ctx: RouteContext<TParams, TEvent>,
) => Response | Promise<Response>;

export type RouteDefinition<TEvent = unknown> = {
  auth?: RouteAuth;
  sameOrigin?: SameOriginMode;
  scopes?: string[];
  userParam?: string;
} & Partial<Record<HttpMethod, WebAppRouteHandler<Record<string, string>, TEvent>>>;

export type RouteTable<TEvent = unknown> = Record<string, RouteDefinition<TEvent>>;

export function defineRoutes<TEvent = unknown>(routes: RouteTable<TEvent>): RouteTable<TEvent> {
  return routes;
}

export interface MatchedRoute<TEvent = unknown> {
  pattern: string;
  route: RouteDefinition<TEvent>;
  params: Record<string, string>;
}

function splitPath(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

export function matchRoute<TEvent>(routes: RouteTable<TEvent>, pathname: string): MatchedRoute<TEvent> | undefined {
  const requestParts = splitPath(pathname);
  for (const [pattern, route] of Object.entries(routes)) {
    const patternParts = splitPath(pattern);
    if (patternParts.length !== requestParts.length) {
      continue;
    }
    const params: Record<string, string> = {};
    let matched = true;
    for (let index = 0; index < patternParts.length; index += 1) {
      const patternPart = patternParts[index]!;
      const requestPart = requestParts[index]!;
      if (patternPart.startsWith(":")) {
        params[patternPart.slice(1)] = decodeURIComponent(requestPart);
      } else if (patternPart !== requestPart) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return { pattern, route, params };
    }
  }
  return undefined;
}
