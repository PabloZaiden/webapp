import {
  compileRoutePatterns, compareRoutePatterns, compareSpecificity, defaultCliPath,
  invalidRouteDefinition, matchCompiledRoutePattern, patternsOverlap, HTTP_METHODS,
  type CompiledRoutePatterns, type HttpMethod,
} from "../routing/patterns";
import type { Server } from "bun";
import type { PartialResultMetadata } from "../contracts";
import type { RealtimeBus } from "./realtime/bus";
import type { WebAppOperation, WebAppWebSocketData } from "./server-types";
export * from "../routing";

export type RouteAuth = "required" | "public" | "optional";
export type SameOriginMode = "mutations" | "always" | "never";

export interface RouteContext<TParams extends Record<string, string> = Record<string, string>, TEvent = unknown, TIdentity = unknown> {
  params: TParams;
  identity?: TIdentity;
  requireIdentity(): TIdentity;
  realtime: RealtimeBus<TEvent>;
  server?: Server<WebAppWebSocketData>;
}

export type WebAppRouteHandler<TParams extends Record<string, string> = Record<string, string>, TEvent = unknown, TIdentity = unknown> = (
  req: Request, ctx: RouteContext<TParams, TEvent, TIdentity>,
) => Response | undefined | Promise<Response | undefined>;

export type WebAppRouteMiddleware<TEvent = unknown, TIdentity = unknown> = (
  req: Request,
  ctx: RouteContext<Record<string, string>, TEvent, TIdentity>,
  operation: WebAppOperation,
  invoke: () => Promise<Response | undefined>,
) => Response | undefined | Promise<Response | undefined>;

export interface RouteOperationMetadata {
  description?: string;
  requestSchema?: unknown;
  querySchema?: unknown;
  responseSchema?: unknown;
  partialResults?: PartialResultMetadata;
}

export interface RouteMetadata extends RouteOperationMetadata {
  cliPath?: string;
  tags?: string[];
  operations?: Partial<Record<HttpMethod, RouteOperationMetadata>>;
  catalog?: boolean;
}

/** Routing algorithms accept app-owned handlers and metadata without interpreting policy. */
export type RoutePatternDefinition = {
  cliPath?: string;
  catalog?: boolean;
  operations?: Partial<Record<HttpMethod, unknown>>;
} & Partial<Record<HttpMethod, (...args: never[]) => unknown>>;

export type RouteDefinition<TEvent = unknown, TIdentity = unknown> = {
  auth?: RouteAuth;
  sameOrigin?: SameOriginMode;
  policy?: unknown;
} & RouteMetadata & Partial<Record<HttpMethod, WebAppRouteHandler<Record<string, string>, TEvent, TIdentity>>>;

export type RouteTable<TEvent = unknown, TIdentity = unknown> = Record<string, RouteDefinition<TEvent, TIdentity>>;

export function defineRoutes<TEvent = unknown, TIdentity = unknown>(routes: RouteTable<TEvent, TIdentity>): RouteTable<TEvent, TIdentity> {
  return routes;
}

export function resolveRouteOperationMetadata<T extends RouteOperationMetadata & { operations?: Partial<Record<HttpMethod, unknown>> }>(
  route: T, method: HttpMethod,
): Omit<T, "operations"> & RouteOperationMetadata {
  const { operations, ...metadata } = route;
  return { ...metadata, ...(operations?.[method] as object | undefined) };
}

export interface CompiledRoute<TRoute extends RoutePatternDefinition = RoutePatternDefinition> {
  readonly pattern: string;
  readonly cliPath: string;
  readonly route: TRoute;
  readonly patterns: CompiledRoutePatterns;
  readonly methods: readonly HttpMethod[];
  readonly specificity: number;
  readonly specificityKey: readonly number[];
}

export interface CompiledRouteTable<TRoute extends RoutePatternDefinition = RoutePatternDefinition> {
  readonly routes: readonly CompiledRoute<TRoute>[];
}

export interface MatchedRoute<TRoute extends RoutePatternDefinition = RoutePatternDefinition> {
  pattern: string;
  route: TRoute;
  params: Record<string, string>;
}

export interface MatchedCompiledRoute<TRoute extends RoutePatternDefinition = RoutePatternDefinition> extends MatchedRoute<TRoute> {
  readonly compiled: CompiledRoute<TRoute>;
}

export type CompiledRouteMatch<TRoute extends RoutePatternDefinition = RoutePatternDefinition> =
  | { readonly kind: "matched"; readonly match: MatchedCompiledRoute<TRoute> }
  | { readonly kind: "invalid-encoding" }
  | { readonly kind: "no-match" };

const compiledRouteTables = new WeakMap<object, unknown>();

function compareRoutes<TRoute extends RoutePatternDefinition>(left: CompiledRoute<TRoute>, right: CompiledRoute<TRoute>): number {
  return compareRoutePatterns(left.patterns.api, right.patterns.api) || left.pattern.localeCompare(right.pattern);
}

function validateRouteAmbiguity<TRoute extends RoutePatternDefinition>(routes: readonly CompiledRoute<TRoute>[]): void {
  const apiPatterns = new Map<string, CompiledRoute<TRoute>>();
  const catalogPatterns = new Map<string, CompiledRoute<TRoute>>();
  for (const current of routes) {
    const existing = apiPatterns.get(current.patterns.api.normalizedSource);
    if (existing) invalidRouteDefinition(current.pattern, `normalizes to the same API pattern as "${existing.pattern}"`);
    apiPatterns.set(current.patterns.api.normalizedSource, current);
    if (current.route.catalog !== false) {
      const previous = catalogPatterns.get(current.patterns.cli.normalizedSource);
      if (previous) invalidRouteDefinition(current.pattern, `normalizes to the same catalog path as "${previous.pattern}"`);
      catalogPatterns.set(current.patterns.cli.normalizedSource, current);
    }
  }
  for (let i = 0; i < routes.length; i++) {
    const left = routes[i]!;
    for (const right of routes.slice(i + 1)) {
      if (patternsOverlap(left.patterns.api, right.patterns.api) && compareSpecificity(left.patterns.api, right.patterns.api) === 0) {
        invalidRouteDefinition(left.pattern, `is ambiguous with "${right.pattern}"`);
      }
      if (left.route.catalog !== false && right.route.catalog !== false
        && patternsOverlap(left.patterns.cli, right.patterns.cli) && compareSpecificity(left.patterns.cli, right.patterns.cli) === 0) {
        invalidRouteDefinition(left.pattern, `catalog path is ambiguous with "${right.pattern}"`);
      }
    }
  }
}

function compileRoute<TRoute extends RoutePatternDefinition>(pattern: string, route: TRoute): CompiledRoute<TRoute> {
  if (!route || typeof route !== "object") invalidRouteDefinition(pattern, "route metadata must be an object");
  const cliPath = route.cliPath ?? defaultCliPath(pattern);
  const patterns = compileRoutePatterns(pattern, cliPath);
  const methods = HTTP_METHODS.filter(method => typeof route[method] === "function");
  if (!methods.length) invalidRouteDefinition(pattern, "at least one supported HTTP method handler is required");
  for (const method of Object.keys(route.operations ?? {})) {
    if (!methods.includes(method as HttpMethod)) invalidRouteDefinition(pattern, `operation metadata "${method}" requires a handler`);
  }
  return { pattern, cliPath, route, patterns, methods, specificity: patterns.api.specificity, specificityKey: patterns.api.specificityKey };
}

export function compileRouteTable<TRoute extends RoutePatternDefinition>(routes: Record<string, TRoute>): CompiledRouteTable<TRoute> {
  const cached = compiledRouteTables.get(routes);
  if (cached) return cached as CompiledRouteTable<TRoute>;
  const compiled = Object.entries(routes).map(([pattern, route]) => compileRoute(pattern, route));
  validateRouteAmbiguity(compiled);
  const result = { routes: compiled.sort(compareRoutes) };
  compiledRouteTables.set(routes, result);
  return result;
}

export function matchCompiledRouteTable<TRoute extends RoutePatternDefinition>(
  routes: CompiledRouteTable<TRoute>, pathname: string,
): CompiledRouteMatch<TRoute> {
  let invalidEncoding = false;
  for (const compiled of routes.routes) {
    const result = matchCompiledRoutePattern(compiled.patterns.api, pathname);
    if (result.kind === "matched") return { kind: "matched", match: { compiled, pattern: compiled.pattern, route: compiled.route, params: result.params } };
    if (result.kind === "invalid-encoding") invalidEncoding = true;
  }
  return invalidEncoding ? { kind: "invalid-encoding" } : { kind: "no-match" };
}

export function matchRoute<TRoute extends RoutePatternDefinition>(routes: Record<string, TRoute>, pathname: string): MatchedRoute<TRoute> | undefined {
  const result = matchCompiledRouteTable(compileRouteTable(routes), pathname);
  return result.kind === "matched" ? result.match : undefined;
}
