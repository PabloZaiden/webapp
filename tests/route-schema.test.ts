import { expect, test } from "bun:test";
import { routeSchemaToJsonSchema } from "../src/server/route-schema";

test("copies dense JSON schema arrays and rejects unsafe array properties", () => {
  expect(routeSchemaToJsonSchema({ enum: ["ready", "done"] })).toEqual({
    enum: ["ready", "done"],
  });

  let getterCalls = 0;
  const accessorArray: unknown[] = [];
  Object.defineProperty(accessorArray, "0", {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      return "unsafe";
    },
  });
  const sparseArray: unknown[] = new Array(1);
  const symbolArray: unknown[] = ["ready"];
  Object.defineProperty(symbolArray, Symbol("schema"), { value: "unsafe" });

  expect(() => routeSchemaToJsonSchema({ enum: accessorArray })).toThrow();
  expect(getterCalls).toBe(0);
  expect(() => routeSchemaToJsonSchema({ enum: sparseArray })).toThrow();
  expect(() => routeSchemaToJsonSchema({ enum: symbolArray })).toThrow();
});
