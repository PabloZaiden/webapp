import type { WebAppErrorResponse } from "../contracts";

export function jsonResponse<T>(data: T, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function successResponse<T extends object = { success: true }>(data = { success: true } as T, init: ResponseInit = {}): Response {
  return jsonResponse(data, init);
}

export function errorResponse(status: number, error: string, message: string, details?: unknown, init: ResponseInit = {}): Response {
  return jsonResponse<WebAppErrorResponse>(
    { error, message, ...(details === undefined ? {} : { details }) },
    { ...init, status },
  );
}

export function notFound(): Response {
  return errorResponse(404, "not_found", "The requested resource was not found");
}

export function methodNotAllowed(): Response {
  return errorResponse(405, "method_not_allowed", "Method not allowed");
}

export async function parseJson<T>(req: Request): Promise<T> {
  try {
    return await req.json() as T;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

export function applySecurityHeaders(headers: Headers): Headers {
  if (!headers.has("referrer-policy")) {
    headers.set("referrer-policy", "strict-origin-when-cross-origin");
  }
  if (!headers.has("x-frame-options")) {
    headers.set("x-frame-options", "DENY");
  }
  if (!headers.has("content-security-policy")) {
    headers.set("content-security-policy", "frame-ancestors 'none'");
  }
  return headers;
}

export function withSecurityHeaders(response: Response): Response {
  applySecurityHeaders(response.headers);
  return response;
}
