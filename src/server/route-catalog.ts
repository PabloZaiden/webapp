import type { HttpMethod, RouteAuth, RouteDefinition, RouteTable, SameOriginMode } from "./routes";

const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export interface RouteCatalogEntry {
  path: string;
  cliPath: string;
  methods: HttpMethod[];
  auth: RouteAuth;
  sameOrigin: SameOriginMode;
  scopes: string[];
  description?: string;
  tags: string[];
  requestSchema?: unknown;
  querySchema?: unknown;
  responseSchema?: unknown;
}

export interface RouteCatalogMatch {
  entry: RouteCatalogEntry;
  path: string;
  params: Record<string, string>;
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function defaultCliPath(path: string): string {
  return trimSlashes(path.startsWith("/api/") ? path.slice("/api/".length) : path);
}

function methodsFor(route: RouteDefinition): HttpMethod[] {
  return HTTP_METHODS.filter((method) => typeof route[method] === "function");
}

export function createRouteCatalog<TEvent = unknown>(routes: RouteTable<TEvent>): RouteCatalogEntry[] {
  return Object.entries(routes)
    .filter(([, route]) => route.catalog !== false)
    .map(([path, route]) => ({
      path,
      cliPath: route.cliPath ?? defaultCliPath(path),
      methods: methodsFor(route),
      auth: route.auth ?? "required",
      sameOrigin: route.sameOrigin ?? "mutations",
      scopes: route.scopes ?? [],
      description: route.description,
      tags: route.tags ?? [],
      requestSchema: route.requestSchema,
      querySchema: route.querySchema,
      responseSchema: route.responseSchema,
    }))
    .filter((entry) => entry.methods.length > 0)
    .sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeApiPath(input: string): string {
  const [path = ""] = input.trim().split(/[?#]/);
  if (!path) {
    throw new Error("API endpoint is required");
  }
  if (path.startsWith("/api/") || path === "/api") {
    return path;
  }
  if (path.startsWith("api/")) {
    return `/${path}`;
  }
  if (path.startsWith("/")) {
    return path;
  }
  return `/api/${path}`;
}

function normalizeCliPath(input: string): string {
  const [path = ""] = input.trim().split(/[?#]/);
  return trimSlashes(path.startsWith("/api/") ? path.slice("/api/".length) : path);
}

function decodePathPart(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function matchPattern(pattern: string, value: string): Record<string, string> | undefined {
  const patternParts = trimSlashes(pattern).split("/").filter(Boolean);
  const valueParts = trimSlashes(value).split("/").filter(Boolean);
  if (patternParts.length !== valueParts.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index]!;
    const valuePart = valueParts[index]!;
    if (patternPart.startsWith(":")) {
      const decoded = decodePathPart(valuePart);
      if (decoded === undefined) {
        return undefined;
      }
      params[patternPart.slice(1)] = decoded;
      continue;
    }
    if (patternPart !== valuePart) {
      return undefined;
    }
  }
  return params;
}

function concretePath(pattern: string, params: Record<string, string>): string {
  return trimSlashes(pattern)
    .split("/")
    .map((part) => part.startsWith(":") ? encodeURIComponent(params[part.slice(1)] ?? "") : part)
    .join("/")
    .replace(/^/, "/");
}

function specificity(entry: RouteCatalogEntry): number {
  return entry.path.split("/").reduce((score, part) => score + (part && !part.startsWith(":") ? 2 : 1), 0);
}

export function findRouteCatalogEntry(catalog: readonly RouteCatalogEntry[], input: string): RouteCatalogMatch | undefined {
  const apiPath = normalizeApiPath(input);
  const cliPath = normalizeCliPath(input);
  const sorted = [...catalog].sort((left, right) => specificity(right) - specificity(left));
  for (const entry of sorted) {
    if (entry.path === apiPath) {
      return { entry, path: apiPath, params: {} };
    }
    if (entry.cliPath === cliPath) {
      return { entry, path: entry.path, params: {} };
    }
  }
  for (const entry of sorted) {
    const apiParams = matchPattern(entry.path, apiPath);
    if (apiParams) {
      return { entry, path: apiPath, params: apiParams };
    }
    const cliParams = matchPattern(entry.cliPath, cliPath);
    if (cliParams) {
      return { entry, path: concretePath(entry.path, cliParams), params: cliParams };
    }
  }
  return undefined;
}
