import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createElement } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Button, ConfirmModal, Modal } from "../src/web/components";
import { renderWebApp } from "../src/web/render";

GlobalRegistrator.register();

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  document.body.style.overflow = "";
});

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
  }
});

test("modal Enter shortcut does not confirm while an input is focused", () => {
  let confirmations = 0;
  const { getByLabelText } = render(createElement(ConfirmModal, {
    isOpen: true,
    onClose: () => {},
    onConfirm: () => {
      confirmations += 1;
    },
    title: "Confirm",
    message: "Type a value",
  }, createElement("input", { "aria-label": "Value" })));

  const input = getByLabelText("Value");
  input.focus();
  fireEvent.keyDown(input, { key: "Enter" });

  expect(confirmations).toBe(0);
});

test("modal scroll lock remains active until the last stacked modal closes", () => {
  document.body.style.overflow = "auto";
  const modal = (title: string) => createElement(Modal, {
    isOpen: true,
    onClose: () => {},
    title,
    footer: createElement(Button, { type: "button" }, "Close"),
    children: createElement("p", null, title),
  });
  const { rerender, unmount } = render(createElement("div", null, modal("First"), modal("Second")));

  expect(document.body.style.overflow).toBe("hidden");

  rerender(createElement("div", null, modal("First")));
  expect(document.body.style.overflow).toBe("hidden");

  unmount();
  expect(document.body.style.overflow).toBe("auto");
});
