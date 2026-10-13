import { z } from "zod";

export interface RouteSchemaJsonOptions {
  io?: "input" | "output";
}

function copyJsonValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Route JSON schemas must contain only JSON values");
  }
  if (ancestors.has(value)) {
    throw new TypeError("Route JSON schemas must not contain circular references");
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Route JSON schemas must contain only plain objects");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item: unknown) => copyJsonValue(item, ancestors));
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("Route JSON schemas must not contain symbol properties");
    }
    return Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(value)).map(([key, descriptor]) => {
      if (!("value" in descriptor)) {
        throw new TypeError("Route JSON schemas must not contain accessors");
      }
      return [key, copyJsonValue(descriptor.value, ancestors)];
    }));
  } finally {
    ancestors.delete(value);
  }
}

/** Convert public schemas deliberately; unsupported schemas throw instead of exposing their internals. */
export function routeSchemaToJsonSchema(
  schema: unknown,
  options: RouteSchemaJsonOptions = {},
): Record<string, unknown> | undefined {
  if (schema === undefined || schema === null) {
    return undefined;
  }
  if (schema instanceof z.ZodType) {
    return z.toJSONSchema(schema, { io: options.io ?? "input", unrepresentable: "throw" });
  }
  if (typeof schema !== "object" || Array.isArray(schema)) {
    throw new TypeError("A route schema must be a Zod schema or a plain JSON schema object");
  }
  return copyJsonValue(schema, new Set<object>()) as Record<string, unknown>;
}
