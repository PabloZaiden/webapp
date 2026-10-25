export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export const HTTP_METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

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



function splitPath(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

export function invalidRouteDefinition(pattern: string, message: string): never {
  throw new Error(`Invalid route definition "${pattern}": ${message}`);
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

export function defaultCliPath(path: string): string {
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

export function compileRoutePattern(source: string, label: string): CompiledRoutePattern {
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

export function patternsOverlap(left: CompiledRoutePattern, right: CompiledRoutePattern): boolean {
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

export function compareSpecificity(left: CompiledRoutePattern, right: CompiledRoutePattern): number {
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

export function compileRoutePatterns(path: string, cliPath: string): CompiledRoutePatterns {
  const patterns = {
    api: compileRoutePattern(path, path),
    cli: compileRoutePattern(cliPath, `cliPath "${cliPath}"`),
  };
  validateAliasMapping(path, patterns);
  return patterns;
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
