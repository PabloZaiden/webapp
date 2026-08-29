import type { Server } from "bun";
import { assertScopes } from "./auth/api-keys";
import { AuthError } from "./auth/types";
import { authErrorResponse, enforceRouteAuth, requiresAuth, scopesFromBearer, type Authentication } from "./authentication";
import type { RuntimeConfig } from "./runtime-config";
import { createLogger } from "./logger";
import { checkSameOrigin } from "./same-origin";
import type { RealtimeBus } from "./realtime/bus";
import { invalidPath, errorResponse, requestBodyErrorResponse, methodNotAllowed, responseForRequest, withSecurityHeaders } from "./responses";
import { matchCompiledRouteTable, type CompiledRouteTable, type HttpMethod, type UserScopedRealtimePublisher } from "./routes";
import type { WebAppWebSocketData } from "./server-types";

export interface RouteDispatchResult {
  matched: boolean;
  response?: Response;
}

export interface RouteDispatcherDependencies<TEvent = unknown> {
  config: RuntimeConfig;
  routes: CompiledRouteTable<TEvent>;
  authentication: Authentication;
  realtime: RealtimeBus<TEvent>;
}

const log = createLogger("webapp:routes");

function method(req: Request): HttpMethod | undefined {
  switch (req.method.toUpperCase()) {
    case "GET":
      return "GET";
    case "POST":
      return "POST";
    case "PUT":
      return "PUT";
    case "PATCH":
      return "PATCH";
    case "DELETE":
      return "DELETE";
    default:
      return undefined;
  }
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

function routeResponse(req: Request, response: Response): Response {
  return responseForRequest(req, withSecurityHeaders(response));
}

export function createRouteDispatcher<TEvent = unknown>(dependencies: RouteDispatcherDependencies<TEvent>) {
  const { config, routes, authentication, realtime } = dependencies;

  return {
    async dispatch(req: Request, server?: Server<WebAppWebSocketData>): Promise<RouteDispatchResult> {
      const routeMatch = matchCompiledRouteTable(routes, new URL(req.url).pathname);
      if (routeMatch.kind === "no-match") {
        return { matched: false };
      }
      if (routeMatch.kind === "invalid-encoding") {
        return { matched: true, response: routeResponse(req, invalidPath()) };
      }
      const matched = routeMatch.match;
      const requestMethod = method(req);
      const handler = req.method.toUpperCase() === "HEAD"
        ? matched.route.GET
        : requestMethod
          ? matched.route[requestMethod]
          : undefined;
      if (!handler) {
        return { matched: true, response: routeResponse(req, methodNotAllowed(matched.compiled.methods)) };
      }
      const routeAuth = matched.route.auth ?? "required";
      const auth = await authentication.authorize(req, requiresAuth(routeAuth));
      if (auth instanceof Response) {
        return { matched: true, response: routeResponse(req, auth) };
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
        return { matched: true, response: routeResponse(req, authErrorResponse(error)) };
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
        return { matched: true, response: routeResponse(req, originFailure) };
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
        return { matched: true, response: response ? routeResponse(req, response) : undefined };
      } catch (error) {
        return { matched: true, response: routeResponse(req, routeHandlerErrorResponse(error)) };
      }
    },
  };
}
