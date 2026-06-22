import type { Server } from "bun";
import type { AuthenticatedRequestState } from "./auth/types";
import type { RealtimeBus } from "./realtime/bus";

export type RouteAuth = "required" | "public" | "optional";
export type SameOriginMode = "mutations" | "always" | "never";
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteContext<TParams extends Record<string, string> = Record<string, string>, TEvent = unknown> {
  params: TParams;
  auth: AuthenticatedRequestState;
  realtime: RealtimeBus<TEvent>;
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
