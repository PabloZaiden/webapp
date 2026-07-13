import type {
  PublicRouteAsset,
  PublicRouteDefinition,
  PublicRouteValue,
} from "./server-types";
import type { WebDocument } from "./web-document";
import { methodNotAllowed, notFound, withSecurityHeaders } from "./responses";

export interface PublicRouteDispatcherDependencies {
  publicRoutes: Readonly<Record<string, PublicRouteDefinition>>;
  generatedRoutePaths: ReadonlySet<string>;
  ensureWebDocument: () => Promise<WebDocument>;
}

function hasOwnPublicRoute(publicRoutes: Readonly<Record<string, PublicRouteDefinition>>, path: string): boolean {
  return Object.prototype.hasOwnProperty.call(publicRoutes, path);
}

function publicAssetResponse(asset: PublicRouteAsset, extraHeaders?: HeadersInit): Response {
  const response = asset instanceof Response
    ? asset
    : typeof asset === "string"
      ? new Response(asset, { headers: { "content-type": "text/plain; charset=utf-8" } })
      : new Response(asset as BodyInit);
  if (extraHeaders) {
    for (const [name, value] of new Headers(extraHeaders)) {
      response.headers.set(name, value);
    }
  }
  return withSecurityHeaders(response);
}

async function handlePublicRouteValue(req: Request, route: PublicRouteDefinition): Promise<Response> {
  const methodName = req.method === "HEAD" ? "HEAD" : req.method === "GET" ? "GET" : undefined;
  if (!methodName) {
    return withSecurityHeaders(methodNotAllowed());
  }
  const definition = typeof route === "object"
    && route !== null
    && !(route instanceof Response)
    && !(route instanceof Blob)
    && !(route instanceof ArrayBuffer)
    && !(route instanceof Uint8Array)
    && ("GET" in route || "HEAD" in route || "headers" in route)
    ? route
    : undefined;
  const value = definition
    ? definition[methodName] ?? (methodName === "HEAD" ? definition.GET : undefined)
    : route as PublicRouteValue;
  if (!value) {
    return withSecurityHeaders(methodNotAllowed());
  }
  const asset = typeof value === "function" ? await value(req) : value;
  if (!asset) {
    return withSecurityHeaders(notFound());
  }
  const response = publicAssetResponse(asset, definition?.headers);
  if (req.method === "HEAD") {
    return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  return response;
}

export function createPublicRouteDispatcher(dependencies: PublicRouteDispatcherDependencies): (req: Request) => Promise<Response | undefined> {
  const { publicRoutes, generatedRoutePaths, ensureWebDocument } = dependencies;

  return async function dispatchPublicRoute(req: Request): Promise<Response | undefined> {
    const url = new URL(req.url);
    if (generatedRoutePaths.has(url.pathname)) {
      const webDocument = await ensureWebDocument();
      const generatedRoute = webDocument.generatedPublicRoutes[url.pathname];
      if (generatedRoute) {
        return handlePublicRouteValue(req, generatedRoute);
      }
    }
    if (!hasOwnPublicRoute(publicRoutes, url.pathname)) {
      return undefined;
    }
    const route = publicRoutes[url.pathname];
    if (!route) {
      return undefined;
    }
    return handlePublicRouteValue(req, route);
  };
}
