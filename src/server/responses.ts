import { z } from "zod";
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

export class InvalidJsonError extends Error {
  readonly code = "invalid_json";
  readonly status = 400;

  constructor() {
    super("Request body must be valid JSON");
    this.name = "InvalidJsonError";
  }
}

export interface RequestBodyValidationIssue {
  path: Array<string | number>;
  code: string;
  message: string;
}

export class InvalidRequestBodyError extends Error {
  readonly code = "invalid_request_body";
  readonly status = 400;
  readonly details: RequestBodyValidationIssue[];

  constructor(error: z.ZodError) {
    super("Request body failed validation");
    this.name = "InvalidRequestBodyError";
    this.details = error.issues.map((issue) => ({
      path: issue.path.map((segment) => typeof segment === "symbol" ? String(segment) : segment),
      code: issue.code,
      message: issue.message,
    }));
  }
}

export function requestBodyErrorResponse(error: unknown): Response | undefined {
  if (error instanceof InvalidJsonError || error instanceof InvalidRequestBodyError) {
    return errorResponse(error.status, error.code, error.message, "details" in error ? error.details : undefined);
  }
  return undefined;
}

function validateJson<TSchema extends z.ZodTypeAny>(value: unknown, schema: TSchema): z.infer<TSchema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new InvalidRequestBodyError(result.error);
  }
  return result.data;
}

export async function parseUnknownJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new InvalidJsonError();
  }
}

export async function parseJson<TSchema extends z.ZodTypeAny>(req: Request, schema: TSchema): Promise<z.infer<TSchema>> {
  return validateJson(await parseUnknownJson(req), schema);
}

export async function parseOptionalJson<TSchema extends z.ZodTypeAny>(req: Request, schema: TSchema): Promise<z.infer<TSchema> | undefined> {
  const text = await req.text();
  if (text.length === 0) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InvalidJsonError();
  }
  return validateJson(value, schema);
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
