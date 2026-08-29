import type { Server } from "bun";
import type { CurrentUser } from "../contracts";
import type { AuthenticatedRequestState } from "./auth/types";
import type { RealtimeBus, ResourceRealtimeEvent, RealtimeTarget } from "./realtime/bus";

export type RouteAuth = "required" | "user" | "admin" | "owner" | "public" | "optional";
export type SameOriginMode = "mutations" | "always" | "never";
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export const HTTP_METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
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

export interface RouteMetadata {
  description?: string;
  cliPath?: string;
  tags?: string[];
  requestSchema?: unknown;
  querySchema?: unknown;
  responseSchema?: unknown;
  catalog?: boolean;
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

export type CompiledRouteSegment =
  | {
      readonly kind: "static";
      readonly value: string;
    }
  | {
      readonly kind: "param";
      readonly name: string;
      readonly captureIndex: number;
    }
  | {
      readonly kind: "wildcard";
      readonly name: "*";
      readonly captureIndex: number;
    };

export interface CompiledRouteCapture {
  readonly kind: "param" | "wildcard";
  readonly name: string;
  readonly captureIndex: number;
}

export interface CompiledRoutePattern {
  readonly source: string;
  readonly normalizedSource: string;
  readonly segments: readonly CompiledRouteSegment[];
  readonly captures: readonly CompiledRouteCapture[];
  readonly specificity: number;
  readonly specificityKey: readonly number[];
}

export interface CompiledRoutePatterns {
  readonly api: CompiledRoutePattern;
  readonly cli: CompiledRoutePattern;
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

export interface RouteCaptureValue {
  readonly value: string;
  readonly segments: readonly string[];
}

export type CompiledRoutePatternMatch =
  | {
      readonly kind: "matched";
      readonly params: Record<string, string>;
      readonly captures: readonly RouteCaptureValue[];
    }
  | {
      readonly kind: "invalid-encoding";
    }
  | {
      readonly kind: "no-match";
    };

// Route event types are compile-time-only, so use never for the erased cache value.
const compiledRouteTables = new WeakMap<object, CompiledRouteTable<never>>();

function splitPath(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

function invalidRouteDefinition(pattern: string, message: string): never {
  throw new Error(`Invalid route definition "${pattern}": ${message}`);
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function defaultCliPath(path: string): string {
  return trimSlashes(path.startsWith("/api/") ? path.slice("/api/".length) : path);
}

function isValidParameterName(name: string): boolean {
  return name.length > 0 && !/[/:*?#]/.test(name);
}

function segmentSpecificity(segment: CompiledRouteSegment): number {
  if (segment.kind === "static") return 3;
  if (segment.kind === "param") return 2;
  return 0;
}

function normalizedSegment(segment: CompiledRouteSegment): string {
  if (segment.kind === "static") return segment.value;
  if (segment.kind === "param") return `:${segment.name}`;
  return "*";
}

function compileRoutePattern(source: string, label: string): CompiledRoutePattern {
  if (source.includes("?") || source.includes("#")) {
    invalidRouteDefinition(label, "query strings and fragments are not allowed in route patterns");
  }
  const parts = splitPath(source);
  const names = new Set<string>();
  const captures: CompiledRouteCapture[] = [];
  const segments: CompiledRouteSegment[] = [];
  for (const [index, part] of parts.entries()) {
    if (part === "*") {
      if (index !== parts.length - 1) {
        invalidRouteDefinition(label, "a wildcard is only valid as the trailing segment");
      }
      const capture = { kind: "wildcard", name: "*", captureIndex: captures.length } as const;
      captures.push(capture);
      segments.push(capture);
      continue;
    }
    if (part.startsWith(":")) {
      const name = part.slice(1);
      if (!isValidParameterName(name)) {
        invalidRouteDefinition(label, `parameter "${part}" has an invalid name`);
      }
      if (names.has(name)) {
        invalidRouteDefinition(label, `parameter "${name}" is declared more than once`);
      }
      names.add(name);
      const capture = { kind: "param", name, captureIndex: captures.length } as const;
      captures.push(capture);
      segments.push(capture);
      continue;
    }
    segments.push({ kind: "static", value: part });
  }
  const specificityKey = segments.map(segmentSpecificity);
  return {
    source,
    normalizedSource: `/${segments.map(normalizedSegment).join("/")}`,
    segments,
    captures,
    specificity: specificityKey.reduce((score, value) => score + value, 0),
    specificityKey,
  };
}

function captureKinds(pattern: CompiledRoutePattern): string {
  return pattern.captures.map((capture) => capture.kind).join(",");
}

function validateAliasMapping(pattern: string, patterns: CompiledRoutePatterns): void {
  if (patterns.api.captures.length !== patterns.cli.captures.length || captureKinds(patterns.api) !== captureKinds(patterns.cli)) {
    invalidRouteDefinition(pattern, "cliPath must contain the same ordered parameter and wildcard captures as the API path");
  }
}

function hasTrailingWildcard(pattern: CompiledRoutePattern): boolean {
  return pattern.segments.at(-1)?.kind === "wildcard";
}

function segmentsCompatible(left: CompiledRouteSegment, right: CompiledRouteSegment): boolean {
  return left.kind !== "static" || right.kind !== "static" || left.value === right.value;
}

function patternsOverlap(left: CompiledRoutePattern, right: CompiledRoutePattern): boolean {
  const leftFixedLength = hasTrailingWildcard(left) ? left.segments.length - 1 : left.segments.length;
  const rightFixedLength = hasTrailingWildcard(right) ? right.segments.length - 1 : right.segments.length;
  const sharedLength = Math.min(leftFixedLength, rightFixedLength);
  for (let index = 0; index < sharedLength; index += 1) {
    if (!segmentsCompatible(left.segments[index]!, right.segments[index]!)) {
      return false;
    }
  }
  if (leftFixedLength === rightFixedLength) {
    return true;
  }
  return leftFixedLength < rightFixedLength ? hasTrailingWildcard(left) : hasTrailingWildcard(right);
}

function compareSpecificity(left: CompiledRoutePattern, right: CompiledRoutePattern): number {
  const length = Math.max(left.specificityKey.length, right.specificityKey.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left.specificityKey[index] ?? 3;
    const rightValue = right.specificityKey[index] ?? 3;
    if (leftValue !== rightValue) {
      return rightValue - leftValue;
    }
  }
  return left.specificityKey.length - right.specificityKey.length;
}

export function compareRoutePatterns(left: CompiledRoutePattern, right: CompiledRoutePattern): number {
  return compareSpecificity(left, right);
}

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

export function compileRoutePatterns(path: string, cliPath: string): CompiledRoutePatterns {
  const patterns = {
    api: compileRoutePattern(path, path),
    cli: compileRoutePattern(cliPath, `cliPath "${cliPath}"`),
  };
  validateAliasMapping(path, patterns);
  return patterns;
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

function decodeRouteSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    if (error instanceof URIError) {
      return undefined;
    }
    throw error;
  }
}

export function matchCompiledRoutePattern(pattern: CompiledRoutePattern, pathname: string): CompiledRoutePatternMatch {
  const requestParts = splitPath(pathname);
  const fixedLength = hasTrailingWildcard(pattern) ? pattern.segments.length - 1 : pattern.segments.length;
  if ((!hasTrailingWildcard(pattern) && requestParts.length !== fixedLength) || (hasTrailingWildcard(pattern) && requestParts.length < fixedLength)) {
    return { kind: "no-match" };
  }
  const params: Record<string, string> = {};
  const captures: RouteCaptureValue[] = [];
  for (let index = 0; index < fixedLength; index += 1) {
    const segment = pattern.segments[index]!;
    const requestPart = requestParts[index]!;
    if (segment.kind === "static") {
      if (segment.value !== requestPart) {
        return { kind: "no-match" };
      }
      continue;
    }
    const decoded = decodeRouteSegment(requestPart);
    if (decoded === undefined) {
      return { kind: "invalid-encoding" };
    }
    params[segment.name] = decoded;
    captures[segment.captureIndex] = { value: decoded, segments: [decoded] };
  }
  if (hasTrailingWildcard(pattern)) {
    const wildcard = pattern.segments[pattern.segments.length - 1]!;
    if (wildcard.kind !== "wildcard") {
      throw new Error(`Invalid compiled wildcard pattern "${pattern.source}"`);
    }
    const decodedSegments: string[] = [];
    for (const requestPart of requestParts.slice(fixedLength)) {
      const decoded = decodeRouteSegment(requestPart);
      if (decoded === undefined) {
        return { kind: "invalid-encoding" };
      }
      decodedSegments.push(decoded);
    }
    params[wildcard.name] = decodedSegments.join("/");
    captures[wildcard.captureIndex] = { value: params[wildcard.name]!, segments: decodedSegments };
  }
  return { kind: "matched", params, captures };
}

export function buildCompiledRoutePath(pattern: CompiledRoutePattern, captures: readonly RouteCaptureValue[]): string {
  const parts: string[] = [];
  for (const segment of pattern.segments) {
    if (segment.kind === "static") {
      parts.push(segment.value);
      continue;
    }
    const capture = captures[segment.captureIndex];
    if (!capture) {
      throw new Error(`Missing capture ${String(segment.captureIndex)} while generating "${pattern.source}"`);
    }
    if (segment.kind === "param") {
      parts.push(encodeURIComponent(capture.value));
      continue;
    }
    parts.push(...capture.segments.map((value) => encodeURIComponent(value)));
  }
  return `/${parts.join("/")}`;
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
