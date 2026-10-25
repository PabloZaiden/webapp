import {
  compileRoutePatterns, compareRoutePatterns, compareSpecificity, defaultCliPath,
  invalidRouteDefinition, matchCompiledRoutePattern, patternsOverlap, HTTP_METHODS,
  type CompiledRoutePatterns, type HttpMethod,
} from "../routing/patterns";
export {
  buildCompiledRoutePath, compareRoutePatterns, compileRoutePatterns,
  matchCompiledRoutePattern, HTTP_METHODS,
} from "../routing";
export type {
  CompiledRouteCapture, CompiledRoutePattern, CompiledRoutePatternMatch,
  CompiledRoutePatterns, CompiledRouteSegment, HttpMethod, RouteCaptureValue,
} from "../routing";
import type { Server } from "bun";
import type { CurrentUser, PartialResultMetadata } from "../contracts";
import type { AuthenticatedRequestState } from "./auth/types";
import type { RealtimeBus, ResourceRealtimeEvent, RealtimeTarget } from "./realtime/bus";
import type { DelegatedInvocation, MatchedRouteOperation, RouteDelegationMetadata } from "./delegation";

export type RouteAuth = "required" | "user" | "admin" | "owner" | "public" | "optional";
export type SameOriginMode = "mutations" | "always" | "never";
export type UserOwnedResource = { userId: string };
export type UserIdSelector<TResource> = (resource: TResource) => string | undefined;

export interface UserScopedRealtimePublisher<TEvent = unknown> {
  readonly _eventType?: TEvent;
  publishChanged<TPayload = unknown>(resource: string, options?: Omit<ResourceRealtimeEvent<TPayload>, "type" | "resource" | "action"> & { target?: RealtimeTarget }): void;
  publishEntityChanged<TPayload = unknown>(resource: string, id: string, options?: Omit<ResourceRealtimeEvent<TPayload>, "type" | "resource" | "action" | "id"> & { target?: RealtimeTarget }): void;
  publishDeleted<TPayload = unknown>(resource: string, id: string, options?: Omit<ResourceRealtimeEvent<TPayload>, "type" | "resource" | "action" | "id"> & { target?: RealtimeTarget }): void;
  publishSettingsChanged<TPayload = unknown>(options?: Omit<ResourceRealtimeEvent<TPayload>, "type" | "resource" | "action"> & { target?: RealtimeTarget }): void;
}

export interface RouteContext<TParams extends Record<string, string> = Record<string, string>, TEvent = unknown> {
  params: TParams;
  auth: AuthenticatedRequestState;
  user?: CurrentUser;
  delegation?: DelegatedInvocation;
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
) => Response | undefined | Promise<Response | undefined>;

/** Runs after route authentication and policy checks, including delegated grants. */
export type WebAppRouteMiddleware<TEvent = unknown> = (
  req: Request,
  ctx: RouteContext<Record<string, string>, TEvent>,
  operation: MatchedRouteOperation,
  invoke: () => Promise<Response | undefined>,
) => Response | undefined | Promise<Response | undefined>;

export interface RouteAutomationCredentialResource {
  name: string;
  idParameter?: string;
  purpose: string;
}

export type RouteAutomationCredential = {
  kind: "ssh";
  input?: string;
  header?: string;
  mapInput?: string;
  unavailableInput?: string;
} & (
  | {
      serverParameter: string;
      hostInput?: never;
      resource?: never;
    }
  | {
      serverParameter?: never;
      hostInput: string;
      resource?: never;
    }
  | {
      serverParameter?: never;
      hostInput?: never;
      resource: RouteAutomationCredentialResource;
    }
);

export interface RouteAutomationMetadata {
  policy: "read" | "write" | "confirm" | "excluded";
  reason?: string;
  hiddenInputs?: readonly string[];
  hiddenQuery?: readonly string[];
  completion?: "admission" | "completed";
  credential?: RouteAutomationCredential;
}

export interface RouteOperationMetadata {
  description?: string;
  requestSchema?: unknown;
  querySchema?: unknown;
  responseSchema?: unknown;
  automation?: RouteAutomationMetadata;
  /** Default deny; an operation may explicitly override an inherited grant with false. */
  delegation?: RouteDelegationMetadata | false;
  partialResults?: PartialResultMetadata;
}

export interface RouteMetadata extends RouteOperationMetadata {
  cliPath?: string;
  tags?: string[];
  operations?: Partial<Record<HttpMethod, RouteOperationMetadata>>;
  catalog?: boolean;
}

export function resolveRouteOperationMetadata(route: RouteMetadata, method: HttpMethod): RouteOperationMetadata {
  return {
    description: route.description,
    requestSchema: route.requestSchema,
    querySchema: route.querySchema,
    responseSchema: route.responseSchema,
    automation: route.automation,
    delegation: route.delegation,
    partialResults: route.partialResults,
    ...route.operations?.[method],
  };
}

export type RouteDefinition<TEvent = unknown> = {
  auth?: RouteAuth;
  sameOrigin?: SameOriginMode;
  scopes?: string[];
  userParam?: string;
} & RouteMetadata & Partial<Record<HttpMethod, WebAppRouteHandler<Record<string, string>, TEvent>>>;

export type RouteTable<TEvent = unknown> = Record<string, RouteDefinition<TEvent>>;

export function defineRoutes<TEvent = unknown>(routes: RouteTable<TEvent>): RouteTable<TEvent> {
  return routes;
}

export interface CompiledRoute<TEvent = unknown> {
  readonly pattern: string;
  readonly cliPath: string;
  readonly route: RouteDefinition<TEvent>;
  readonly patterns: CompiledRoutePatterns;
  readonly methods: readonly HttpMethod[];
  readonly specificity: number;
  readonly specificityKey: readonly number[];
}

export interface CompiledRouteTable<TEvent = unknown> {
  readonly routes: readonly CompiledRoute<TEvent>[];
}

export interface MatchedRoute<TEvent = unknown> {
  pattern: string;
  route: RouteDefinition<TEvent>;
  params: Record<string, string>;
}

export interface MatchedCompiledRoute<TEvent = unknown> {
  readonly compiled: CompiledRoute<TEvent>;
  readonly pattern: string;
  readonly route: RouteDefinition<TEvent>;
  readonly params: Record<string, string>;
}

export type CompiledRouteMatch<TEvent = unknown> =
  | {
      readonly kind: "matched";
      readonly match: MatchedCompiledRoute<TEvent>;
    }
  | {
      readonly kind: "invalid-encoding";
    }
  | {
      readonly kind: "no-match";
    };

// A table's key preserves its event type; erase only the heterogeneous cache.
const compiledRouteTables = new WeakMap<object, unknown>();

function compareRoutes<TEvent>(left: CompiledRoute<TEvent>, right: CompiledRoute<TEvent>): number {
  const specificity = compareRoutePatterns(left.patterns.api, right.patterns.api);
  return specificity || left.pattern.localeCompare(right.pattern);
}

function validateRouteAmbiguity<TEvent>(routes: readonly CompiledRoute<TEvent>[]): void {
  const apiPatterns = new Map<string, CompiledRoute<TEvent>>();
  const cliPatterns = new Map<string, CompiledRoute<TEvent>>();
  for (const current of routes) {
    const existingApi = apiPatterns.get(current.patterns.api.normalizedSource);
    if (existingApi) {
      invalidRouteDefinition(current.pattern, `normalizes to the same API pattern as "${existingApi.pattern}"`);
    }
    apiPatterns.set(current.patterns.api.normalizedSource, current);
    if (current.route.catalog !== false) {
      const existingCli = cliPatterns.get(current.patterns.cli.normalizedSource);
      if (existingCli) {
        invalidRouteDefinition(current.pattern, `normalizes to the same cliPath as "${existingCli.pattern}"`);
      }
      cliPatterns.set(current.patterns.cli.normalizedSource, current);
    }
  }
  for (let leftIndex = 0; leftIndex < routes.length; leftIndex += 1) {
    const left = routes[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < routes.length; rightIndex += 1) {
      const right = routes[rightIndex]!;
      if (patternsOverlap(left.patterns.api, right.patterns.api) && compareSpecificity(left.patterns.api, right.patterns.api) === 0) {
        invalidRouteDefinition(left.pattern, `is ambiguous with "${right.pattern}"`);
      }
      if (
        left.route.catalog !== false
        && right.route.catalog !== false
        && patternsOverlap(left.patterns.cli, right.patterns.cli)
        && compareSpecificity(left.patterns.cli, right.patterns.cli) === 0
      ) {
        invalidRouteDefinition(left.pattern, `cliPath "${left.cliPath}" is ambiguous with "${right.cliPath}"`);
      }
    }
  }
}

function methodsFor<TEvent>(route: RouteDefinition<TEvent>): HttpMethod[] {
  return HTTP_METHODS.filter((method) => typeof route[method] === "function");
}

function compileRoute<TEvent>(pattern: string, route: RouteDefinition<TEvent>): CompiledRoute<TEvent> {
  if (!route || typeof route !== "object") {
    invalidRouteDefinition(pattern, "route metadata must be an object");
  }
  const cliPath = route.cliPath ?? defaultCliPath(pattern);
  const patterns = compileRoutePatterns(pattern, cliPath);
  const methods = methodsFor(route);
  if (methods.length === 0) {
    invalidRouteDefinition(pattern, "at least one supported HTTP method handler is required");
  }
  for (const method of Object.keys(route.operations ?? {})) {
    if (!methods.includes(method as HttpMethod)) {
      invalidRouteDefinition(pattern, `operation metadata "${method}" requires a registered supported method handler`);
    }
  }
  if (route.userParam !== undefined && !patterns.api.captures.some((capture) => capture.name === route.userParam)) {
    invalidRouteDefinition(pattern, `userParam "${route.userParam}" is not declared in the API path`);
  }
  return {
    pattern,
    cliPath,
    route,
    patterns,
    methods,
    specificity: patterns.api.specificity,
    specificityKey: patterns.api.specificityKey,
  };
}

function compileRouteTableUncached<TEvent = unknown>(routes: RouteTable<TEvent>): CompiledRouteTable<TEvent> {
  const compiled = Object.entries(routes).map(([pattern, route]) => compileRoute(pattern, route));
  validateRouteAmbiguity(compiled);
  return { routes: [...compiled].sort(compareRoutes) };
}

export function compileRouteTable<TEvent = unknown>(routes: RouteTable<TEvent>): CompiledRouteTable<TEvent> {
  const cached = compiledRouteTables.get(routes);
  if (cached) {
    return cached as CompiledRouteTable<TEvent>;
  }
  const compiled = compileRouteTableUncached(routes);
  compiledRouteTables.set(routes, compiled);
  return compiled;
}

export function matchCompiledRouteTable<TEvent>(
  compiledRoutes: CompiledRouteTable<TEvent>,
  pathname: string,
): CompiledRouteMatch<TEvent> {
  let invalidEncoding = false;
  for (const compiled of compiledRoutes.routes) {
    const result = matchCompiledRoutePattern(compiled.patterns.api, pathname);
    if (result.kind === "matched") {
      return {
        kind: "matched",
        match: {
          compiled,
          pattern: compiled.pattern,
          route: compiled.route,
          params: result.params,
        },
      };
    }
    if (result.kind === "invalid-encoding") {
      invalidEncoding = true;
    }
  }
  return invalidEncoding ? { kind: "invalid-encoding" } : { kind: "no-match" };
}

export function matchRoute<TEvent>(routes: RouteTable<TEvent>, pathname: string): MatchedRoute<TEvent> | undefined {
  const result = matchCompiledRouteTable(compileRouteTable(routes), pathname);
  if (result.kind !== "matched") {
    return undefined;
  }
  return {
    pattern: result.match.pattern,
    route: result.match.route,
    params: result.match.params,
  };
}
