import {
  compareRoutePatterns,
  compileRoutePattern,
  matchCompiledRoutePattern,
  patternsOverlap,
  type CompiledRoutePattern,
  type HttpMethod,
  type RouteCaptureValue,
  HTTP_METHODS,
} from "./patterns";

export type { RouteDelegationMetadata, RouteResourceReference } from "./metadata";

export {
  buildCompiledRoutePath,
  compareRoutePatterns,
  compileRoutePatterns,
  matchCompiledRoutePattern,
  HTTP_METHODS,
} from "./patterns";
export type {
  CompiledRouteCapture,
  CompiledRoutePattern,
  CompiledRoutePatternMatch,
  CompiledRoutePatterns,
  CompiledRouteSegment,
  HttpMethod,
  RouteCaptureValue,
} from "./patterns";

export interface RouteOperation<TMetadata> {
  readonly path: string;
  readonly method: HttpMethod;
  readonly metadata: TMetadata;
}

export interface CompiledRouteOperation<TMetadata> extends RouteOperation<TMetadata> {
  readonly pattern: CompiledRoutePattern;
}

export type RouteOperationMatch<TMetadata> =
  | {
      readonly kind: "matched";
      readonly operation: CompiledRouteOperation<TMetadata>;
      readonly params: Record<string, string>;
      readonly captures: readonly RouteCaptureValue[];
    }
  | { readonly kind: "invalid-encoding" }
  | { readonly kind: "method-not-allowed"; readonly allowedMethods: readonly HttpMethod[] }
  | { readonly kind: "no-match" };

/** Match public operation metadata without importing handlers or server state. */
export function compileRouteOperations<TMetadata>(
  operations: readonly RouteOperation<TMetadata>[],
): readonly CompiledRouteOperation<TMetadata>[] {
  const compiled = operations.map((operation) => {
    if (!HTTP_METHODS.includes(operation.method)) {
      throw new TypeError(`Unsupported route method "${operation.method}".`);
    }
    return { ...operation, pattern: compileRoutePattern(operation.path, operation.path) };
  });
  for (let index = 0; index < compiled.length; index += 1) {
    const current = compiled[index]!;
    for (const other of compiled.slice(index + 1)) {
      if (current.path === other.path && current.method !== other.method) continue;
      if (patternsOverlap(current.pattern, other.pattern)
        && compareRoutePatterns(current.pattern, other.pattern) === 0) {
        throw new TypeError(`Ambiguous route operations "${current.path}" and "${other.path}".`);
      }
    }
  }
  return compiled.sort((left, right) =>
    compareRoutePatterns(left.pattern, right.pattern) || left.path.localeCompare(right.path));
}

export function matchRouteOperations<TMetadata>(
  operations: readonly CompiledRouteOperation<TMetadata>[],
  pathname: string,
  method: string,
): RouteOperationMatch<TMetadata> {
  const effectiveMethod = method === "HEAD" ? "GET" : method;
  let invalidEncoding = false;
  for (const operation of operations) {
    const result = matchCompiledRoutePattern(operation.pattern, pathname);
    if (result.kind === "matched") {
      const methods = operations.filter((candidate) => candidate.path === operation.path);
      const selected = methods.find((candidate) => candidate.method === effectiveMethod);
      return selected
        ? { ...result, operation: selected }
        : { kind: "method-not-allowed", allowedMethods: methods.map((candidate) => candidate.method) };
    }
    if (result.kind === "invalid-encoding") invalidEncoding = true;
  }
  return { kind: invalidEncoding ? "invalid-encoding" : "no-match" };
}
