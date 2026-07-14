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

export class InvalidRequestContentTypeError extends Error {
  readonly code = "invalid_request_content_type";
  readonly status = 400;

  constructor() {
    super("Request content type must be application/json");
    this.name = "InvalidRequestContentTypeError";
  }
}

export class InvalidRequestContentLengthError extends Error {
  readonly code = "invalid_request_content_length";
  readonly status = 400;

  constructor() {
    super("Request content length must be a non-negative integer");
    this.name = "InvalidRequestContentLengthError";
  }
}

export class RequestBodyTooLargeError extends Error {
  readonly code = "request_body_too_large";
  readonly status = 413;

  constructor() {
    super("Request body is too large");
    this.name = "RequestBodyTooLargeError";
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
  if (
    error instanceof InvalidJsonError
    || error instanceof InvalidRequestContentTypeError
    || error instanceof InvalidRequestContentLengthError
    || error instanceof InvalidRequestBodyError
    || error instanceof RequestBodyTooLargeError
  ) {
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

export interface ParseJsonOptions {
  maxBytes?: number;
  requireContentType?: boolean;
}

function validateParseJsonOptions(options: ParseJsonOptions): void {
  if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)) {
    throw new RangeError("parseJson maxBytes must be a non-negative safe integer");
  }
}

function hasJsonContentType(req: Request): boolean {
  const contentType = req.headers.get("content-type");
  if (!contentType) {
    return false;
  }
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
}

function declaredContentLength(req: Request, maxBytes: number | undefined): void {
  const value = req.headers.get("content-length");
  if (value === null) {
    return;
  }
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new InvalidRequestContentLengthError();
  }
  const length = BigInt(normalized);
  if (maxBytes !== undefined && length > BigInt(maxBytes)) {
    throw new RequestBodyTooLargeError();
  }
}

async function cancelOversizedBody(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  await reader.cancel("Request body is too large");
}

async function readLimitedRequestBody(req: Request, maxBytes: number): Promise<string> {
  declaredContentLength(req, maxBytes);
  if (!req.body) {
    return "";
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    byteLength += value.byteLength;
    if (byteLength > maxBytes) {
      await cancelOversizedBody(reader);
      throw new RequestBodyTooLargeError();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new InvalidJsonError();
  }
}

async function readRequestBody(req: Request, maxBytes: number | undefined): Promise<string> {
  if (maxBytes === undefined) {
    declaredContentLength(req, undefined);
    return await req.text();
  }
  return await readLimitedRequestBody(req, maxBytes);
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidJsonError();
  }
}

export async function parseUnknownJson(req: Request, options: ParseJsonOptions = {}): Promise<unknown> {
  validateParseJsonOptions(options);
  if (options.requireContentType && !hasJsonContentType(req)) {
    throw new InvalidRequestContentTypeError();
  }
  return parseJsonText(await readRequestBody(req, options.maxBytes));
}

export async function parseJson<TSchema extends z.ZodTypeAny>(
  req: Request,
  schema: TSchema,
  options: ParseJsonOptions = {},
): Promise<z.infer<TSchema>> {
  return validateJson(await parseUnknownJson(req, options), schema);
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
