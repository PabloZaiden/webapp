import type { Server } from "bun";
import type { RuntimeConfig } from "./runtime-config";
import { checkSameOrigin } from "./same-origin";
import type { RealtimeBus } from "./realtime/bus";
import { errorResponse, invalidPath, methodNotAllowed } from "./responses";
import { HTTP_METHODS, matchCompiledRouteTable, type CompiledRouteTable, type HttpMethod, type RouteContext, type RouteDefinition, type WebAppRouteMiddleware } from "./routes";
import type { WebAppIdentityPolicy, WebAppOperation, WebAppWebSocketData } from "./server-types";

export class IdentityRequiredError extends Error {
  constructor() { super("An authenticated identity is required"); }
}

export interface RouteDispatchResult { matched: boolean; response?: Response }

export function createRouteDispatcher<TEvent = unknown, TIdentity = unknown>(dependencies: {
  config: RuntimeConfig;
  routes: CompiledRouteTable<RouteDefinition<TEvent, TIdentity>>;
  identity?: WebAppIdentityPolicy<TIdentity>;
  realtime: RealtimeBus<TEvent>;
  middleware?: WebAppRouteMiddleware<TEvent, TIdentity>;
}) {
  return {
    async dispatch(req: Request, server?: Server<WebAppWebSocketData>): Promise<RouteDispatchResult> {
      const result = matchCompiledRouteTable(dependencies.routes, new URL(req.url).pathname);
      if (result.kind === "no-match") return { matched: false };
      if (result.kind === "invalid-encoding") return { matched: true, response: invalidPath() };
      const { route, pattern, params, compiled } = result.match;
      const method = req.method === "HEAD" ? "GET" : req.method;
      if (!HTTP_METHODS.includes(method as HttpMethod) || !route[method as HttpMethod]) {
        return { matched: true, response: methodNotAllowed(compiled.methods) };
      }
      const policy = route.auth ?? "required";
      const authentication = policy === "public" ? undefined : await dependencies.identity?.authenticate(req);
      if (policy !== "public" && policy !== "optional" && !authentication) {
        return { matched: true, response: errorResponse(401, "authentication_required", "An authenticated identity is required") };
      }
      const operation: WebAppOperation = { pattern, method: method as HttpMethod, params: Object.freeze({ ...params }), policy: route.policy };
      if (route.policy !== undefined && (!authentication || !dependencies.identity?.authorize)) {
        return { matched: true, response: errorResponse(403, "authorization_required", "Operation access was not granted") };
      }
      if (authentication && dependencies.identity?.authorize
        && !await dependencies.identity.authorize(req, authentication.identity, operation)) {
        return { matched: true, response: errorResponse(403, "authorization_required", "Operation access was not granted") };
      }
      const originFailure = checkSameOrigin(req, dependencies.config, authentication ?? { credential: "ambient" }, route.sameOrigin);
      if (originFailure) return { matched: true, response: originFailure };
      const context: RouteContext<Record<string, string>, TEvent, TIdentity> = {
        params, identity: authentication?.identity, realtime: dependencies.realtime, server,
        requireIdentity() {
          if (!authentication) throw new IdentityRequiredError();
          return authentication.identity;
        },
      };
      const invoke = async () => await route[method as HttpMethod]!(req, context);
      try {
        const response = dependencies.middleware
          ? await dependencies.middleware(req, context, operation, invoke)
          : await invoke();
        return { matched: true, response };
      } catch (error) {
        if (error instanceof IdentityRequiredError) return { matched: true, response: errorResponse(401, "authentication_required", error.message) };
        throw error;
      }
    },
  };
}
