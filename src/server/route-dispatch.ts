import type { Server } from "bun";
import { assertScopes } from "./auth/api-keys";
import { AuthError } from "./auth/types";
import { authErrorResponse, enforceRouteAuth, requiresAuth, scopesFromBearer, type Authentication } from "./authentication";
import type { RuntimeConfig } from "./runtime-config";
import { createLogger } from "./logger";
import { checkSameOrigin } from "./same-origin";
import type { RealtimeBus } from "./realtime/bus";
import { matchRoute, type HttpMethod, type RouteTable, type UserScopedRealtimePublisher } from "./routes";
import type { WebAppWebSocketData } from "./server-types";
import { errorResponse, requestBodyErrorResponse, withSecurityHeaders, methodNotAllowed } from "./responses";

export interface RouteDispatchResult {
  matched: boolean;
  response?: Response;
}

export interface RouteDispatcherDependencies<TEvent = unknown> {
  config: RuntimeConfig;
  routes: RouteTable<TEvent>;
  authentication: Authentication;
  realtime: RealtimeBus<TEvent>;
}

const log = createLogger("webapp:routes");

function method(req: Request): HttpMethod | undefined {
  const value = req.method.toUpperCase();
  return value === "GET" || value === "POST" || value === "PUT" || value === "PATCH" || value === "DELETE" ? value : undefined;
}

function routeHandlerErrorResponse(error: unknown): Response {
  const requestBodyFailure = requestBodyErrorResponse(error);
  if (requestBodyFailure) {
    return requestBodyFailure;
  }
  if (error instanceof AuthError) {
    return errorResponse(error.status, error.code, error.message);
  }
  log.error("Unhandled route handler error", { error: error instanceof Error ? error.message : String(error) });
  return errorResponse(500, "request_failed", "Request failed");
}

export function createRouteDispatcher<TEvent = unknown>(dependencies: RouteDispatcherDependencies<TEvent>) {
  const { config, routes, authentication, realtime } = dependencies;

  return {
    async dispatch(req: Request, server?: Server<WebAppWebSocketData>): Promise<RouteDispatchResult> {
      const matched = matchRoute(routes, new URL(req.url).pathname);
      if (!matched) {
        return { matched: false };
      }
      const handler = matched.route[method(req) ?? "GET"];
      if (!handler) {
        return { matched: true, response: withSecurityHeaders(methodNotAllowed()) };
      }
      const routeAuth = matched.route.auth ?? "required";
      const auth = await authentication.authorize(req, requiresAuth(routeAuth));
      if (auth instanceof Response) {
        return { matched: true, response: withSecurityHeaders(auth) };
      }
      try {
        enforceRouteAuth(routeAuth, auth, authentication);
        if (matched.route.userParam) {
          const paramValue = matched.params[matched.route.userParam];
          if (!paramValue) {
            throw new AuthError("route_misconfigured", `Route userParam "${matched.route.userParam}" is missing from matched params`, 500);
          }
          authentication.assertUser(auth, paramValue);
        }
        if (routeAuth !== "public" && (auth.kind === "api-key" || auth.kind === "bearer")) {
          assertScopes(auth.kind === "api-key" ? auth.scopes : scopesFromBearer(auth.claims), matched.route.scopes ?? []);
        }
      } catch (error) {
        return { matched: true, response: withSecurityHeaders(authErrorResponse(error)) };
      }
      const current = () => authentication.requireUser(auth);
      const userRealtime = {
        publishChanged: (resource, options = {}) => realtime.publishChanged(resource, { ...options, target: { ...options.target, userId: current().id } }),
        publishEntityChanged: (resource, id, options = {}) => realtime.publishEntityChanged(resource, id, { ...options, target: { ...options.target, userId: current().id } }),
        publishDeleted: (resource, id, options = {}) => realtime.publishDeleted(resource, id, { ...options, target: { ...options.target, userId: current().id } }),
        publishSettingsChanged: (options = {}) => realtime.publishSettingsChanged({ ...options, target: { ...options.target, userId: current().id } }),
      } satisfies UserScopedRealtimePublisher<TEvent>;
      const originFailure = checkSameOrigin(req, config, auth, matched.route.sameOrigin ?? "mutations");
      if (originFailure) {
        return { matched: true, response: withSecurityHeaders(originFailure) };
      }
      try {
        const response = await handler(req, {
          params: matched.params,
          auth,
          user: authentication.currentUser(auth),
          requireUser: () => authentication.requireUser(auth),
          requireAdmin: () => authentication.requireAdmin(auth),
          requireOwner: () => authentication.requireOwner(auth),
          assertUser: (userId) => authentication.assertUser(auth, userId),
          filterOwned: authentication.createFilterOwned(auth),
          requireOwned: authentication.createRequireOwned(auth),
          realtime,
          userRealtime,
          server,
        });
        return { matched: true, response: response ? withSecurityHeaders(response) : undefined };
      } catch (error) {
        return { matched: true, response: withSecurityHeaders(routeHandlerErrorResponse(error)) };
      }
    },
  };
}
