import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createElement } from "react";
import { renderWebApp } from "../src/web/render";

GlobalRegistrator.register();

test("renderWebApp reuses the existing React root for the same container", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };

  try {
    const firstRoot = renderWebApp(createElement("div", null, "first"), container);
    const secondRoot = renderWebApp(createElement("div", null, "second"), container);

    expect(secondRoot).toBe(firstRoot);
    expect(messages.some((message) => message.includes("createRoot() on a container"))).toBe(false);
  } finally {
    console.error = originalError;
    document.body.innerHTML = "";
  }
});
